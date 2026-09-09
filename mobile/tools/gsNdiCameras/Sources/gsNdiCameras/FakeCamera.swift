import CNDIMac
import CoreGraphics
import Foundation

/// One fake NDI camera: an NDI sender, a test pattern, a tone, and whatever faults have been asked
/// for.
///
/// The send loop is deliberately wall-clock paced rather than sleeping a frame interval. A camera
/// that stalls for eight seconds and resumes has to resume at the *current* time, not eight seconds
/// behind — which is exactly what the app's archive filler has to cover, and a generator that
/// quietly caught up would hide the bug it exists to expose.
final class FakeCamera: @unchecked Sendable {
  let index: Int
  private(set) var name: String

  private let baseWidth: Int
  private let baseHeight: Int
  private let baseFrameRate: Double

  private let lock = NSLock()
  private var faults = CameraFaults()
  private var sender: NDIlib_send_instance_t?
  private var pattern: TestPattern?
  private var patternWidth = 0
  private var patternHeight = 0

  private var thread: Thread?
  private var running = false

  /// Where a frame's time actually went, so "the generator is too slow" can be told from "the app
  /// is too slow" without guessing. Exponential moving averages, milliseconds.
  private var renderMilliseconds: Double = 0
  private var sendMilliseconds: Double = 0
  private var loopMilliseconds: Double = 0
  private var periodMilliseconds: Double = 0
  private var sleepMilliseconds: Double = 0

  private(set) var framesSent: UInt64 = 0
  private(set) var framesDropped: UInt64 = 0
  private var frameID: UInt64 = 0
  private var audioSampleIndex: Int64 = 0
  private var startedAt = Date()

  init(index: Int, name: String, width: Int, height: Int, frameRate: Double) {
    self.index = index
    self.name = name
    self.baseWidth = width
    self.baseHeight = height
    self.baseFrameRate = frameRate
  }

  var status: [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return [
      "index": index,
      "name": name,
      "framesSent": framesSent,
      "framesDropped": framesDropped,
      "frameID": frameID,
      "width": faults.width ?? baseWidth,
      "height": faults.height ?? baseHeight,
      "frameRate": faults.frameRate ?? baseFrameRate,
      "faults": faults.summary,
      "renderMilliseconds": renderMilliseconds,
      "sendMilliseconds": sendMilliseconds,
      "loopMilliseconds": loopMilliseconds,
      "periodMilliseconds": periodMilliseconds,
      "sleepMilliseconds": sleepMilliseconds,
      "live": sender != nil
    ]
  }

  /// Lateness actually in effect, walking towards `faults.lateMilliseconds` a few milliseconds
  /// per frame. See `CameraFaults.lateMilliseconds` for why it is not applied in one step.
  private var lateRamp: Double = 0

  func applyFaults(_ query: [String: String]) -> [String] {
    lock.lock()
    let applied = faults.apply(query)
    let wantsRename = faults.renameTo
    faults.renameTo = nil
    let killed = faults.killed
    lock.unlock()

    if let wantsRename {
      lock.lock()
      name = wantsRename
      lock.unlock()
      recreateSender()
    } else if killed {
      destroySender()
    } else {
      // Reviving is not a special case: `ensureSender` is what the send loop calls every frame
      // anyway, so a revived camera comes back on the next tick.
      ensureSender()
    }
    return applied
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

    ensureSender()

    let thread = Thread { [weak self] in self?.run() }
    thread.name = "gsNdiCameras.camera.\(index)"
    thread.qualityOfService = .userInitiated
    lock.lock()
    self.thread = thread
    lock.unlock()
    thread.start()
  }

  func stop() {
    lock.lock()
    running = false
    thread = nil
    lock.unlock()
    Thread.sleep(forTimeInterval: 0.1)
    destroySender()
    lock.lock()
    pattern?.release()
    pattern = nil
    lock.unlock()
  }

  // MARK: - Sender lifecycle

  private func ensureSender() {
    lock.lock()
    let alreadyLive = sender != nil
    let killed = faults.killed
    let name = self.name
    lock.unlock()
    guard !alreadyLive, !killed else { return }

    let created: NDIlib_send_instance_t? = name.withCString { cName in
      var settings = NDIlib_send_create_t()
      settings.p_ndi_name = cName
      settings.p_groups = nil
      // The SDK's own video clock is off, and the send loop paces itself against wall clock
      // instead. Two reasons, and the first is not a preference:
      //
      //   * Measured on this machine, `clock_video` paced a declared 30 fps stream at 12. Free
      //     running, the same sender reached 316 fps, so the ceiling was the SDK's clock rather
      //     than its encoder — and a generator that cannot reach 30 fps makes every frame-rate
      //     assertion downstream meaningless.
      //   * Half the faults here *are* timing faults. Jitter, bursts and stalls would all be
      //     fighting a genlock that exists to smooth exactly what they are trying to inject.
      settings.clock_video = false
      settings.clock_audio = false
      return NDIlib_send_create(&settings)
    }
    lock.lock()
    sender = created
    lock.unlock()
  }

  private func destroySender() {
    lock.lock()
    let existing = sender
    sender = nil
    lock.unlock()
    guard let existing else { return }
    // An async send is still reading the last buffer. Submitting nil is the documented way to wait
    // for it, and without it the pattern's memory can be freed underneath the encoder.
    NDIlib_send_send_video_async_v2(existing, nil)
    NDIlib_send_destroy(existing)
  }

  private func recreateSender() {
    destroySender()
    lock.lock()
    faults.killed = false
    lock.unlock()
    ensureSender()
  }

  // MARK: - Send loop

  private func run() {
    var random = SystemRandomNumberGenerator()
    var pacer = FramePacer()
    var previousTop: Date?

    while true {
      let top = Date()
      if let previousTop {
        let period = top.timeIntervalSince(previousTop) * 1_000
        lock.lock()
        periodMilliseconds += (period - periodMilliseconds) * 0.05
        lock.unlock()
      }
      previousTop = top

      lock.lock()
      let running = self.running
      lock.unlock()
      guard running else { return }

      ensureSender()

      lock.lock()
      var faults = self.faults
      let sender = self.sender
      let width = faults.width ?? baseWidth
      let height = faults.height ?? baseHeight
      let rate = faults.frameRate ?? baseFrameRate
      lock.unlock()

      let interval = 1.0 / rate

      guard let sender, !faults.isStalled else {
        // Nothing is sent while stalled or killed, and the frame counter does not advance: the
        // stopwatch has to show the gap, because a receiver's archive is judged against it.
        _ = pacer.wait(interval: interval)
        pacer.restart()
        continue
      }

      let dropped = faults.shouldDropFrame(random: &random)
      lock.lock()
      self.faults.burstRemaining = faults.burstRemaining
      let id = frameID
      frameID += 1
      if dropped { framesDropped += 1 }
      lock.unlock()

      let loopStarted = Date()
      if !dropped {
        let sendStarted = Date()
        send(video: sender, id: id, width: width, height: height, rate: rate, faults: faults)
        if faults.audioEnabled {
          send(audio: sender, rate: rate, faults: faults)
        }
        let elapsed = Date().timeIntervalSince(sendStarted) * 1_000
        lock.lock()
        sendMilliseconds += (elapsed - sendMilliseconds) * 0.05
        lock.unlock()
        if faults.malformedMetadata, id % 30 == 0 {
          sendMalformedMetadata(sender)
        }
        lock.lock()
        framesSent += 1
        lock.unlock()
      }

      let loopElapsed = Date().timeIntervalSince(loopStarted) * 1_000
      lock.lock()
      loopMilliseconds += (loopElapsed - loopMilliseconds) * 0.05
      lock.unlock()

      let extra = faults.jitterMilliseconds > 0
        ? Double.random(in: 0 ... faults.jitterMilliseconds, using: &random) / 1_000
        : 0
      let slept = pacer.wait(interval: interval, extra: extra) * 1_000
      lock.lock()
      sleepMilliseconds += (slept - sleepMilliseconds) * 0.05
      lock.unlock()
    }
  }

  private func send(
    video sender: NDIlib_send_instance_t,
    id: UInt64,
    width: Int,
    height: Int,
    rate: Double,
    faults: CameraFaults
  ) {
    lock.lock()
    if pattern == nil || patternWidth != width || patternHeight != height {
      pattern?.release()
      pattern = TestPattern(
        width: width,
        height: height,
        frameRate: rate,
        name: name,
        paletteIndex: index
      )
      patternWidth = width
      patternHeight = height
    }
    let pattern = self.pattern
    let elapsed = Date().timeIntervalSince(startedAt)
    lock.unlock()
    guard let pattern else { return }

    // The stopwatch shows wall clock rather than frame count, so a stall shows as a jump. A
    // frame-count clock would run slow by exactly the stall and hide it.
    let renderStarted = Date()
    pattern.render(frameID: id, seconds: elapsed)
    let renderElapsed = Date().timeIntervalSince(renderStarted) * 1_000
    lock.lock()
    renderMilliseconds += (renderElapsed - renderMilliseconds) * 0.05
    lock.unlock()

    var frame = NDIlib_video_frame_v2_t()
    frame.xres = Int32(width)
    frame.yres = Int32(height)
    frame.FourCC = faults.fourCC.map(Self.fourCC(from:)) ?? NDIlib_FourCC_video_type_BGRX
    if faults.zeroFrameRateDenominator {
      frame.frame_rate_N = Int32(rate * 1_000)
      frame.frame_rate_D = 0
    } else {
      frame.frame_rate_N = Int32(rate * 1_000)
      frame.frame_rate_D = 1_000
    }
    frame.picture_aspect_ratio = Float(width) / Float(height)
    frame.frame_format_type = NDIlib_frame_format_type_progressive
    frame.p_data = pattern.pixels.assumingMemoryBound(to: UInt8.self)
    // A stride that does not cover its own row. A receiver that trusts it walks off the end of
    // every line; one that checks refuses the frame on the header alone.
    frame.line_stride_in_bytes = Int32(faults.shortStride ? width * 2 : width * 4)

    var timestamp = Int64(Date().timeIntervalSince1970 * 10_000_000)
    // Taken when it says, delivered now. A receiver that anchors capture times off its
    // least-delayed frame reads this as exactly this much lateness.
    lock.lock()
    let target = faults.lateMilliseconds
    if lateRamp < target {
      lateRamp = min(target, lateRamp + CameraFaults.lateRampPerFrame)
    } else if lateRamp > target {
      lateRamp = max(target, lateRamp - CameraFaults.lateRampPerFrame)
    }
    let late = lateRamp
    lock.unlock()
    if late > 0 {
      timestamp -= Int64(late * 10_000)
    }
    if faults.backwardsTimestamps, id % 10 == 5 {
      // One frame in ten steps back a full second. Scattered rather than continuous, so the
      // receiver's timeline has to recover rather than simply stop.
      timestamp -= 10_000_000
    }
    frame.timecode = timestamp
    frame.timestamp = timestamp

    // Asynchronous: the SDK's colour conversion and SpeedHQ encode happen on its own threads while
    // this one goes back to pacing. The buffer stays valid because `TestPattern` alternates between
    // two, so the frame being encoded is never the one being drawn.
    NDIlib_send_send_video_async_v2(sender, &frame)
  }

  private func send(audio sender: NDIlib_send_instance_t, rate: Double, faults: CameraFaults) {
    let channels = faults.audioChannels
    let sampleRate = faults.audioSampleRate
    let samples = Int(sampleRate / rate)
    guard samples > 0 else { return }

    lock.lock()
    let start = audioSampleIndex
    audioSampleIndex += Int64(samples)
    lock.unlock()

    // Planar float, which is the only audio format NDI carries.
    var planes = [Float](repeating: 0, count: samples * channels)
    let frequency = 220.0 + 110.0 * Double(index % 5)
    for offset in 0 ..< samples {
      let sampleIndex = start + Int64(offset)
      let time = Double(sampleIndex) / sampleRate
      var value = sin(2 * .pi * frequency * time) * 0.2
      // One click per second, so A/V sync is measurable against the stopwatch in the picture
      // rather than by eye.
      if sampleIndex % Int64(sampleRate) < 240 { value += 0.5 }
      for channel in 0 ..< channels {
        planes[channel * samples + offset] = Float(value)
      }
    }

    planes.withUnsafeMutableBufferPointer { buffer in
      guard let base = buffer.baseAddress else { return }
      var frame = NDIlib_audio_frame_v3_t()
      frame.sample_rate = Int32(sampleRate)
      frame.no_channels = Int32(channels)
      frame.no_samples = Int32(samples)
      frame.timecode = NDIlib_send_timecode_synthesize
      frame.FourCC = NDIlib_FourCC_audio_type_FLTP
      frame.p_data = UnsafeMutablePointer(OpaquePointer(base))
      frame.channel_stride_in_bytes = Int32(samples * MemoryLayout<Float>.size)
      NDIlib_send_send_audio_v3(sender, &frame)
    }
  }

  /// Unclosed tag, unescaped ampersand. The SDK documentation tells receivers to expect exactly
  /// this from real senders, so a receiver that throws on it is broken by a camera being sloppy.
  private func sendMalformedMetadata(_ sender: NDIlib_send_instance_t) {
    let payload = "<ndi_product long_name=\"Broken & Unclosed"
    payload.withCString { pointer in
      var frame = NDIlib_metadata_frame_t()
      frame.p_data = UnsafeMutablePointer(mutating: pointer)
      frame.length = Int32(payload.utf8.count + 1)
      frame.timecode = NDIlib_send_timecode_synthesize
      NDIlib_send_send_metadata(sender, &frame)
    }
  }

  private static func fourCC(from string: String) -> NDIlib_FourCC_video_type_e {
    let padded = (string + "    ").prefix(4)
    var value: UInt32 = 0
    for byte in padded.utf8 {
      value = (value << 8) | UInt32(byte)
    }
    // NDI FourCCs are little-endian in memory, which is the reverse of the order they are written.
    let swapped = value.byteSwapped
    return NDIlib_FourCC_video_type_e(rawValue: swapped)
  }
}
