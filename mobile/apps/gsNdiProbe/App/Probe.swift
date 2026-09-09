import CNDI
import Foundation

/// Receives NDI cameras and does nothing else with them.
///
/// This exists to answer one question: when the app dies with a NULL write inside
/// `ndi::reference::recv::tcp_udp_stream::push` on the SDK's own QUIC worker thread, is that the
/// SDK failing, or Director provoking it? A crash report with no frames of ours on the faulting
/// stack is evidence and not proof — a library can be crashed from outside by misuse, and Director
/// is doing a great deal around the receive path.
///
/// So this holds the receive half still and removes everything else. There is no pixel conversion,
/// no encoder, no archive, no delay line, no display of the video: a frame is captured, counted,
/// and freed. If it crashes in the same place, nothing Director does is required to reach it. If it
/// runs all night at a load Director dies under, the fault is ours and this says where to look.
///
/// The receiver settings are deliberately identical to `NDIFrameSource`'s — colour format,
/// bandwidth, field handling, the 100 ms capture timeout, and a separate audio capture thread.
/// A probe configured differently would prove nothing about the app.
final class Probe: @unchecked Sendable {
  struct Reading: Sendable {
    var name: String
    var videoFrames: UInt64
    var audioFrames: UInt64
    var framesPerSecond: Double
    var width: Int
    var height: Int
    var connections: Int
    var droppedBySDK: UInt64
  }

  struct Snapshot: Sendable {
    var startedAt: Date
    var sourcesFound: Int
    var receivers: [Reading]
    var note: String

    var uptime: TimeInterval { Date().timeIntervalSince(startedAt) }
  }

  /// Whether each captured frame's pixels are touched. Off by default, because the point is to
  /// leave the SDK as alone as possible; on, it copies one byte per row so the buffer is actually
  /// read, which is the cheapest way to rule out "the frame was never looked at" as the difference
  /// from Director.
  let readsPixels: Bool
  /// How many receivers to run. Fewer than the sources found is allowed, so the same build can be
  /// stepped 2 → 3 → 4 against the same farm.
  let wantedReceivers: Int
  let lowBandwidth: Bool
  /// Only connect to sources whose name contains this. The finder returns sources in whatever
  /// order it learned them, so without it "the first three" is a different three between runs and
  /// the experiment is not repeatable.
  let nameFilter: String
  /// Whether NDI reliable-UDP receiving is turned off before the SDK starts.
  let disableRUDP: Bool

  private let lock = NSLock()
  private var readings: [Int: Reading] = [:]
  private var sourcesFound = 0
  private var note = "starting"
  private var startedAt = Date()
  private var running = false
  private var receivers: [NDIlib_recv_instance_t?] = []

  init(
    wantedReceivers: Int,
    readsPixels: Bool,
    lowBandwidth: Bool,
    nameFilter: String,
    disableRUDP: Bool
  ) {
    self.disableRUDP = disableRUDP
    self.wantedReceivers = wantedReceivers
    self.readsPixels = readsPixels
    self.lowBandwidth = lowBandwidth
    self.nameFilter = nameFilter
  }

  var snapshot: Snapshot {
    lock.lock()
    defer { lock.unlock() }
    return Snapshot(
      startedAt: startedAt,
      sourcesFound: sourcesFound,
      receivers: readings.keys.sorted().compactMap { readings[$0] },
      note: note
    )
  }

  /// Writes `$HOME/.ndi/ndi-config.v1.json` before the SDK starts, turning off the transport the
  /// crash lives in.
  ///
  /// NDI's reliable UDP — the `NDI_quic` / `ntk_quic` code in the faulting stack — is the default
  /// connection type, and the documentation says it can be force-disabled per side, falling back
  /// to multi-TCP and then to plain TCP. On iOS the SDK reads this file from the app's own
  /// container, so this needs no device-wide setting and no environment variable.
  private func writeConfiguration() {
    guard disableRUDP else { return }
    // Into Application Support, and pointed at with `NDI_CONFIG_DIR`. The documented location is
    // `$HOME/.ndi/`, which on iOS is the root of the app container and is not writable — creating
    // it fails with "Operation not permitted", silently leaving the SDK on its defaults. The
    // documentation says the environment variable is honoured on every platform if it is set
    // before the library is initialized, which is the only way in from inside a sandbox.
    let directory = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support"))
      .appendingPathComponent("ndi")
    let file = directory.appendingPathComponent("ndi-config.v1.json")
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try #"{ "ndi": { "rudp": { "recv": { "enable": false } } } }"#.write(to: file, atomically: true, encoding: .utf8)
      setenv("NDI_CONFIG_DIR", directory.path, 1)
      setNote("rudp receive disabled via " + directory.path)
    } catch {
      setNote("could not write NDI config: \(error)")
    }
  }

  func start() {
    lock.lock()
    guard !running else {
      lock.unlock()
      return
    }
    running = true
    startedAt = Date()
    lock.unlock()

    writeConfiguration()

    guard NDIlib_initialize() else {
      setNote("NDIlib_initialize failed")
      return
    }

    Thread.detachNewThread { [self] in findAndConnect() }
    // One line a second on stdout, so `devicectl --console` leaves a timeline that ends at the
    // moment of the crash. A crash tells you when it happened; this tells you what it was doing.
    Thread.detachNewThread { [self] in report() }
  }

  private func findAndConnect() {
    var findSettings = NDIlib_find_create_t()
    findSettings.show_local_sources = true
    guard let finder = NDIlib_find_create_v2(&findSettings) else {
      setNote("NDIlib_find_create_v2 failed")
      return
    }

    // Waits indefinitely rather than giving up. On a device this app has never run on, iOS puts a
    // local-network permission dialog in front of everything and finds nothing until someone taps
    // Allow — which can be a while when nobody is at the bench. A finder that expired after thirty
    // seconds meant the grant then needed a relaunch to take effect.
    var found: [NDIlib_source_t] = []
    while isRunning {
      _ = NDIlib_find_wait_for_sources(finder, 2_000)
      var count: UInt32 = 0
      guard let list = NDIlib_find_get_current_sources(finder, &count) else { continue }
      found = (0 ..< Int(count)).map { list[$0] }
      if !nameFilter.isEmpty {
        found = found.filter {
          ($0.p_ndi_name.map { String(cString: $0) } ?? "").contains(nameFilter)
        }
      }
      found.sort { name(of: $0) < name(of: $1) }
      setSourcesFound(found.count)
      setNote(found.isEmpty ? "waiting for sources — is local network allowed?" : "found \(found.count)")
      if found.count >= wantedReceivers { break }
    }
    guard isRunning, !found.isEmpty else {
      NDIlib_find_destroy(finder)
      return
    }

    let chosen = Array(found.prefix(wantedReceivers))
    setNote("connecting \(chosen.count) of \(found.count)")

    for (index, source) in chosen.enumerated() {
      let name = source.p_ndi_name.map { String(cString: $0) } ?? "?"
      let url = source.p_url_address.map { String(cString: $0) } ?? ""

      var settings = NDIlib_recv_create_v3_t()
      var connectTo = NDIlib_source_t()
      settings.color_format = NDIlib_recv_color_format_fastest
      settings.bandwidth = lowBandwidth ? NDIlib_recv_bandwidth_lowest : NDIlib_recv_bandwidth_highest
      settings.allow_video_fields = false

      let receiver: NDIlib_recv_instance_t? = name.withCString { namePointer in
        url.withCString { urlPointer in
          connectTo.p_ndi_name = namePointer
          connectTo.p_url_address = url.isEmpty ? nil : urlPointer
          settings.source_to_connect_to = connectTo
          return "gs-ndi-probe-\(index)".withCString { receiverName in
            settings.p_ndi_recv_name = receiverName
            return NDIlib_recv_create_v3(&settings)
          }
        }
      }

      guard let receiver else {
        setNote("receiver \(index) could not be created")
        continue
      }

      lock.lock()
      receivers.append(receiver)
      readings[index] = Reading(
        name: name,
        videoFrames: 0,
        audioFrames: 0,
        framesPerSecond: 0,
        width: 0,
        height: 0,
        connections: 0,
        droppedBySDK: 0
      )
      lock.unlock()

      // Two threads per receiver, as `NDIFrameSource` runs them: the SDK documents
      // `NDIlib_recv_capture_v3` as safe to call from several threads at once, and audio arriving
      // on its own thread is part of the shape being tested.
      Thread.detachNewThread { [self] in captureVideo(receiver, index: index) }
      Thread.detachNewThread { [self] in captureAudio(receiver, index: index) }
    }

    NDIlib_find_destroy(finder)
    setNote("running")
  }

  private func name(of source: NDIlib_source_t) -> String {
    source.p_ndi_name.map { String(cString: $0) } ?? ""
  }

  private func captureVideo(_ receiver: NDIlib_recv_instance_t, index: Int) {
    Thread.current.name = "probe.video.\(index)"
    var frames: UInt64 = 0
    var windowStart = Date()
    var windowFrames: UInt64 = 0

    while isRunning {
      var frame = NDIlib_video_frame_v2_t()
      let type = NDIlib_recv_capture_v3(receiver, &frame, nil, nil, 100)
      guard type == NDIlib_frame_type_video else {
        if type == NDIlib_frame_type_error { setNote("receiver \(index) reported an error") }
        continue
      }

      frames += 1
      windowFrames += 1
      if readsPixels, let data = frame.p_data {
        // One byte a row. Enough to fault if the SDK handed us a buffer it should not have, and
        // cheap enough not to become the thing under test.
        var checksum: UInt64 = 0
        let stride = Int(frame.line_stride_in_bytes)
        for row in 0 ..< Int(frame.yres) where stride > 0 {
          checksum &+= UInt64(data[row * stride])
        }
        readPixelChecksum &+= checksum
      }

      let elapsed = Date().timeIntervalSince(windowStart)
      if elapsed >= 1 {
        var performance = NDIlib_recv_performance_t()
        var dropped = NDIlib_recv_performance_t()
        NDIlib_recv_get_performance(receiver, &performance, &dropped)
        let connections = Int(NDIlib_recv_get_no_connections(receiver))
        lock.lock()
        readings[index]?.videoFrames = frames
        readings[index]?.framesPerSecond = Double(windowFrames) / elapsed
        readings[index]?.width = Int(frame.xres)
        readings[index]?.height = Int(frame.yres)
        readings[index]?.connections = connections
        readings[index]?.droppedBySDK = UInt64(max(0, dropped.video_frames))
        lock.unlock()
        windowStart = Date()
        windowFrames = 0
      }

      NDIlib_recv_free_video_v2(receiver, &frame)
    }
  }

  private func captureAudio(_ receiver: NDIlib_recv_instance_t, index: Int) {
    Thread.current.name = "probe.audio.\(index)"
    var frames: UInt64 = 0
    while isRunning {
      var frame = NDIlib_audio_frame_v3_t()
      let type = NDIlib_recv_capture_v3(receiver, nil, &frame, nil, 100)
      guard type == NDIlib_frame_type_audio else { continue }
      frames += 1
      if frames % 50 == 0 {
        lock.lock()
        readings[index]?.audioFrames = frames
        lock.unlock()
      }
      NDIlib_recv_free_audio_v3(receiver, &frame)
    }
  }

  private func report() {
    while isRunning {
      Thread.sleep(forTimeInterval: 1)
      let now = snapshot
      let rows = now.receivers
        .map { "\($0.name.prefix(18)) \($0.width)x\($0.height) \(String(format: "%.1f", $0.framesPerSecond))fps n=\($0.videoFrames) conn=\($0.connections) sdkDropped=\($0.droppedBySDK)" }
        .joined(separator: " | ")
      print("PROBE +\(Int(now.uptime))s found=\(now.sourcesFound) \(now.note) | \(rows)")
      fflush(stdout)
    }
  }

  private var readPixelChecksum: UInt64 = 0

  private var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  private func setNote(_ value: String) {
    lock.lock()
    note = value
    lock.unlock()
  }

  private func setSourcesFound(_ value: Int) {
    lock.lock()
    sourcesFound = value
    lock.unlock()
  }
}
