import AVFoundation
import CameramanCapture
import CameramanCore
import CoreMedia
import DirectorCore
import DirectorMedia
import DirectorRTMP
import DirectorSources
import Foundation
import Network
import Testing

@testable import PhoneStream

/// Every PhoneStream test, one at a time: the engine tests share the simulator's encoders and a
/// stub server whose tally is static, and run in parallel they would count each other's work.
@Suite("PhoneStream", .serialized)
struct PhoneStreamTests {}

// MARK: - Files

func scratchDirectory(_ name: String = #function) throws -> URL {
  let url = FileManager.default.temporaryDirectory
    .appendingPathComponent("phonestream-\(name.filter { $0.isLetter })-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

/// Waits for `condition` on the main actor, polling, up to `seconds`.
@MainActor
func waitUntil(_ seconds: Double = 20, _ condition: @MainActor () throws -> Bool) async rethrows -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if try condition() { return true }
    try? await Task.sleep(for: .milliseconds(50))
  }
  return try condition()
}

// MARK: - Sample buffers

/// A 1920×1080 4:2:0 picture stamped `seconds` on the capture clock.
func videoSample(at seconds: Double, width: Int = 1920, height: Int = 1080) -> CMSampleBuffer {
  var pixels: CVPixelBuffer?
  CVPixelBufferCreate(
    kCFAllocatorDefault,
    width,
    height,
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    [ kCVPixelBufferIOSurfacePropertiesKey: [:] ] as CFDictionary,
    &pixels
  )
  var format: CMVideoFormatDescription?
  CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixels!, formatDescriptionOut: &format)
  var timing = CMSampleTimingInfo(
    duration: CMTime(value: 1, timescale: 30),
    presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 600),
    decodeTimeStamp: .invalid
  )
  var sample: CMSampleBuffer?
  CMSampleBufferCreateReadyWithImageBuffer(
    allocator: nil,
    imageBuffer: pixels!,
    formatDescription: format!,
    sampleTiming: &timing,
    sampleBufferOut: &sample
  )
  return sample!
}

/// 20 ms of mono 16-bit sound at 48 kHz stamped `seconds` on the capture clock.
func audioSample(at seconds: Double, frames: Int = 960) -> CMSampleBuffer {
  let format = AudioSampleBuilder.makeFormatDescription(AudioSampleBuilder.interleavedInt16Description())!
  let tone = (0 ..< frames).map { Int16(sin(Double($0) / 8) * 8_000) }
  return AudioSampleBuilder.makeSampleBuffer(
    samples: tone,
    formatDescription: format,
    presentationTime: CMTime(seconds: seconds, preferredTimescale: 48_000)
  )!
}

// MARK: - A camera

/// A capture device a test drives by hand: it records what it was told and delivers what the
/// test hands it.
final class FakeCaptureDevice: PhoneCaptureDevice, @unchecked Sendable {
  var onVideoFrame: (@Sendable (SampleBuffer) -> Void)?
  var onAudioFrame: (@Sendable (SampleBuffer) -> Void)?
  var onStateChange: (@MainActor @Sendable (CameraSession.State) -> Void)?
  var previewSession: AVCaptureSession? { nil }
  var configured: [(CameraPosition, CameramanCore.StreamSettings)] = []
  var started = 0
  var stopped = 0
  var flips = 0
  var deviceZooms: [Double] = []
  var displayedZooms: [Double] = []

  func configure(position: CameraPosition, settings: CameramanCore.StreamSettings) {
    configured.append((position, settings))
  }
  func start() { started += 1 }
  func stop() { stopped += 1 }
  func flip() { flips += 1 }
  func setDeviceZoom(_ value: Double) { deviceZooms.append(value) }
  func setDisplayedZoom(_ value: Double) { displayedZooms.append(value) }

  @MainActor
  func publish(_ state: CameraSession.State) {
    onStateChange?(state)
  }
}

/// A camera that plays pre-rendered noisy pictures at 30 fps and a tone at 50 buffers a second,
/// stamped on the host clock as a capture session stamps them. Nothing is rendered or converted per
/// frame, so the simulator's encoders get the processor to themselves.
final class ReplayCaptureDevice: PhoneCaptureDevice, @unchecked Sendable {
  var onVideoFrame: (@Sendable (SampleBuffer) -> Void)?
  var onAudioFrame: (@Sendable (SampleBuffer) -> Void)?
  var onStateChange: (@MainActor @Sendable (CameraSession.State) -> Void)?
  var previewSession: AVCaptureSession? { nil }
  private let pictures: [CVPixelBuffer]
  private let queue = DispatchQueue(label: "phonestream.tests.replay", qos: .userInitiated)
  private var videoTimer: DispatchSourceTimer?
  private var audioTimer: DispatchSourceTimer?
  private var frame = 0

  init(pictures count: Int = 6) {
    var made: [CVPixelBuffer] = []
    for seed in 0 ..< count {
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(
        kCFAllocatorDefault, 1920, 1080, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        [ kCVPixelBufferIOSurfacePropertiesKey: [:] ] as CFDictionary, &buffer
      )
      let pixels = buffer!
      CVPixelBufferLockBaseAddress(pixels, [])
      var state = UInt32(truncatingIfNeeded: seed &* 2_654_435_761 &+ 1)
      for plane in 0 ..< CVPixelBufferGetPlaneCount(pixels) {
        let base = CVPixelBufferGetBaseAddressOfPlane(pixels, plane)!.assumingMemoryBound(to: UInt8.self)
        let bytes = CVPixelBufferGetBytesPerRowOfPlane(pixels, plane) * CVPixelBufferGetHeightOfPlane(pixels, plane)
        for index in 0 ..< bytes {
          state = state &* 1_664_525 &+ 1_013_904_223
          base[index] = UInt8(truncatingIfNeeded: state >> 24) / 2 &+ (plane == 0 ? 64 : 96)
        }
      }
      CVPixelBufferUnlockBaseAddress(pixels, [])
      made.append(pixels)
    }
    pictures = made
  }

  func configure(position: CameraPosition, settings: CameramanCore.StreamSettings) {}
  func flip() {}
  func setDeviceZoom(_ value: Double) {}
  func setDisplayedZoom(_ value: Double) {}

  func start() {
    let video = DispatchSource.makeTimerSource(queue: queue)
    video.schedule(deadline: .now(), repeating: 1.0 / 30, leeway: .milliseconds(1))
    video.setEventHandler { [weak self] in self?.emitPicture() }
    let audio = DispatchSource.makeTimerSource(queue: queue)
    audio.schedule(deadline: .now(), repeating: 0.02, leeway: .milliseconds(1))
    audio.setEventHandler { [weak self] in self?.emitSound() }
    videoTimer = video
    audioTimer = audio
    video.resume()
    audio.resume()
  }

  func stop() {
    queue.sync {
      videoTimer?.cancel()
      audioTimer?.cancel()
      videoTimer = nil
      audioTimer = nil
    }
  }

  private static var hostNow: Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }

  private func emitPicture() {
    let pixels = pictures[frame % pictures.count]
    frame += 1
    var format: CMVideoFormatDescription?
    CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixels, formatDescriptionOut: &format)
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: 30),
      presentationTimeStamp: CMTime(seconds: Self.hostNow, preferredTimescale: 1_000_000_000),
      decodeTimeStamp: .invalid
    )
    var sample: CMSampleBuffer?
    CMSampleBufferCreateReadyWithImageBuffer(
      allocator: nil, imageBuffer: pixels, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample
    )
    if let sample { onVideoFrame?(SampleBuffer(sample)) }
  }

  private func emitSound() {
    onAudioFrame?(SampleBuffer(audioSample(at: Self.hostNow - 0.02)))
  }
}

/// The camera as an `AVCaptureSession` behaves when a rotation's rebuild fails: the pictures stop
/// and the state says it stopped on a runtime error, until `start` is called again. Pictures come
/// from a `ReplayCaptureDevice` and are counted.
final class RotationFailingCaptureDevice: PhoneCaptureDevice, @unchecked Sendable {
  private let replay = ReplayCaptureDevice()
  private let lock = NSLock()
  private var pictures = 0
  private var state = CameraSession.State()
  var onAudioFrame: (@Sendable (SampleBuffer) -> Void)? {
    get { replay.onAudioFrame }
    set { replay.onAudioFrame = newValue }
  }
  var onVideoFrame: (@Sendable (SampleBuffer) -> Void)? {
    didSet {
      guard let deliver = onVideoFrame else {
        replay.onVideoFrame = nil
        return
      }
      let counting: @Sendable (SampleBuffer) -> Void = { [weak self] sample in
        self?.counted()
        deliver(sample)
      }
      replay.onVideoFrame = counting
    }
  }
  var onStateChange: (@MainActor @Sendable (CameraSession.State) -> Void)?
  var previewSession: AVCaptureSession? { nil }
  private(set) var starts = 0

  /// Pictures delivered so far.
  var delivered: Int {
    lock.lock()
    defer { lock.unlock() }
    return pictures
  }

  private func counted() {
    lock.lock()
    pictures += 1
    lock.unlock()
  }

  func configure(position: CameraPosition, settings: CameramanCore.StreamSettings) {}
  func flip() {}
  func setDeviceZoom(_ value: Double) {}
  func setDisplayedZoom(_ value: Double) {}

  /// Called on the main actor, as the engine calls it.
  func start() {
    starts += 1
    replay.start()
    state.isRunning = true
    publish()
  }

  func stop() {
    replay.stop()
    state.isRunning = false
    publish()
  }

  private func publish() {
    let snapshot = state
    MainActor.assumeIsolated { onStateChange?(snapshot) }
  }

  /// The phone turns to the other landscape: the capture rotation flips, and the rebuild fails.
  @MainActor
  func rotate() {
    replay.stop()
    state.captureRotationAngle = state.captureRotationAngle == 0 ? 180 : 0
    state.isRunning = false
    state.failure = "runtimeError AVFoundationErrorDomain -11800: The operation could not be completed"
    publish()
  }

  /// The system takes the camera away, as going to the background does; AVFoundation gives it back.
  @MainActor
  func interrupt() {
    replay.stop()
    state.isRunning = false
    state.isInterrupted = true
    publish()
  }
}

// MARK: - The battery

@MainActor
final class FakeDeviceStatus: PhoneDeviceStatusReading {
  var level: BatteryStatus? = BatteryStatus(percent: 81, isCharging: true)
  var heat: ThermalBadgeLevel = .fair
  func battery() -> BatteryStatus? { level }
  func thermal() -> ThermalBadgeLevel { heat }
}

// MARK: - Radars

@MainActor
final class FakeRadarRadio: RadarRadio {
  weak var listener: RadarRadioListener?
  var power: RadarPower = .on
  var scanning = false
  var connected: [String] = []
  func startScan() { scanning = true }
  func stopScan() { scanning = false }
  func connect(_ name: String) { connected.append(name) }
  func disconnect() {}
  func write(_ bytes: [UInt8]) {}
}

/// Every radio the fleet has made, the first being its scanning radio.
@MainActor
final class Radios {
  var made: [FakeRadarRadio] = []
  func make() -> FakeRadarRadio {
    let radio = FakeRadarRadio()
    made.append(radio)
    return radio
  }
}

// MARK: - Redial timing

/// Runs each redial after a tenth of its wait, so the backoff schedule takes a fraction of a second.
@MainActor
final class QuickRetryScheduler: StreamRetryScheduling {
  var waits: [Double] = []

  private final class Pending: StreamRetryTimer {
    var task: Task<Void, Never>?
    func cancel() { task?.cancel() }
  }

  func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> any StreamRetryTimer {
    waits.append(seconds)
    let pending = Pending()
    pending.task = Task { @MainActor in
      try? await Task.sleep(for: .seconds(seconds / 10))
      guard !Task.isCancelled else { return }
      action()
    }
    return pending
  }
}

// MARK: - Free space

final class FreeSpace: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Int64 = 50_000_000_000
  var bytes: Int64 {
    get { lock.lock(); defer { lock.unlock() }; return value }
    set { lock.lock(); value = newValue; lock.unlock() }
  }
}

// MARK: - An engine

@MainActor
struct EngineRig {
  let root: URL
  let free = FreeSpace()
  let scheduler = QuickRetryScheduler()
  let deviceStatus = FakeDeviceStatus()
  let radios = Radios()
  let defaults: UserDefaults
  let session: URLSession

  init(root: URL) {
    self.root = root
    defaults = UserDefaults(suiteName: "phonestream-tests-\(UUID().uuidString)")!
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ StubServer.self ]
    session = URLSession(configuration: configuration)
  }

  /// An engine on this rig's storage. Its camera plays pre-rendered noise through the camera path:
  /// the simulator encodes HEVC in software, and rendering and converting the synthetic source's
  /// pictures as well would leave the two encoders even less of the processor.
  func engine(
    source: (@MainActor () -> PhoneCameraSource)? = nil,
    stopTail: Double = 1
  ) throws -> PhoneStreamEngine {
    let free = self.free
    let scheduler = self.scheduler
    let deviceStatus = self.deviceStatus
    let radios = self.radios
    let defaults = self.defaults
    return try PhoneStreamEngine(environment: PhoneStreamEnvironment(
      storage: PhoneStorage(root: root),
      makeSource: source ?? { PhoneCameraSource(input: .camera(ReplayCaptureDevice())) },
      freeDiskBytes: { free.bytes },
      urlSession: session,
      makeRetryScheduler: { scheduler },
      makePathMonitor: { nil },
      heartbeatInterval: 0.5,
      statusInterval: 0.1,
      storageCheckInterval: 0.2,
      stopTailSeconds: stopTail,
      makeDeviceStatus: { deviceStatus },
      makeRadarFleet: {
        RadarFleet(
          storage: .phoneStream,
          defaults: defaults,
          makeRadio: { radios.make() },
          pause: { _ in }
        )
      },
      backgroundWork: .none,
      observesApplication: false
    ))
  }

  var request: PhoneStreamRequest {
    PhoneStreamRequest(
      apiBase: URL(string: "https://ts.example.test/api/v1")!,
      token: "token-0000",
      deviceId: "00000000-0000-4000-8000-000000000001",
      deviceModel: "iPhone 13 Pro"
    )
  }
}

/// Collects the engine's events.
@MainActor
final class EventLog {
  var statuses: [PhoneStreamStatus] = []
  var uploads: [PhoneUploadProgress] = []
  var radars: [PhoneRadarState] = []
  var observation: PhoneStreamObservation?

  init(_ engine: PhoneStreamEngine) {
    observation = engine.observe { [weak self] event in
      switch event {
      case let .status(status): self?.statuses.append(status)
      case let .upload(progress): self?.uploads.append(progress)
      case let .radar(state): self?.radars.append(state)
      }
    }
  }

  var phases: [String] {
    statuses.map { $0.phase }.reduce(into: []) { phases, phase in
      if phases.last != phase { phases.append(phase) }
    }
  }
}

// MARK: - The RTMP sink

/// An RTMP server in the test, speaking the subset `rtmpSink.js` speaks: the simple handshake,
/// connect, createStream and publish, then counting what the publisher sends. `drop` closes every
/// connection and stops listening, as an ingest that goes away does; `restore` listens again on the
/// same port.
final class TestRTMPSink: @unchecked Sendable {
  let port: UInt16
  private let queue = DispatchQueue(label: "phonestream.tests.rtmp-sink")
  private let lock = NSLock()
  private var listener: NWListener?
  private var connections: [SinkConnection] = []
  private var counts = Counts()

  struct Counts: Sendable, Equatable {
    var publishes = 0
    var publishNames: [String] = []
    var videoMessages = 0
    var audioMessages = 0
    var keyframes = 0
    var hevcSequenceHeaders = 0
    var fourCcList: [String] = []
  }

  init() {
    port = UInt16.random(in: 40_000 ... 49_000)
  }

  var url: String { "rtmp://127.0.0.1:\(port)/live/key-0000" }

  var listenerState: String {
    lock.lock()
    defer { lock.unlock() }
    return listener.map { "\($0.state)" } ?? "none"
  }

  var snapshot: Counts {
    lock.lock()
    defer { lock.unlock() }
    return counts
  }

  func start() throws {
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    let ready = DispatchSemaphore(value: 0)
    listener.stateUpdateHandler = { state in
      switch state {
      case .ready, .failed, .cancelled: ready.signal()
      default: break
      }
    }
    listener.start(queue: queue)
    _ = ready.wait(timeout: .now() + 5)
    lock.lock()
    self.listener = listener
    lock.unlock()
  }

  func drop() {
    lock.lock()
    let listener = self.listener
    self.listener = nil
    let open = connections
    connections = []
    lock.unlock()
    listener?.cancel()
    for connection in open { connection.connection.cancel() }
  }

  func restore() throws {
    try start()
  }

  private func accept(_ connection: NWConnection) {
    let sink = SinkConnection(connection: connection, owner: self)
    lock.lock()
    connections.append(sink)
    lock.unlock()
    connection.start(queue: queue)
    sink.receive()
  }

  fileprivate func count(_ change: (inout Counts) -> Void) {
    lock.lock()
    change(&counts)
    lock.unlock()
  }
}

private final class SinkConnection: @unchecked Sendable {
  let connection: NWConnection
  weak var owner: TestRTMPSink?
  private var buffer = Data()
  private var phase = 0
  private let reader = RTMPChunkReader()

  init(connection: NWConnection, owner: TestRTMPSink) {
    self.connection = connection
    self.owner = owner
  }

  func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, done, error in
      guard let self else { return }
      if let data, !data.isEmpty { self.handle(data) }
      if done || error != nil {
        self.connection.cancel()
        return
      }
      self.receive()
    }
  }

  private func send(_ data: Data) {
    connection.send(content: data, completion: .contentProcessed { _ in })
  }

  private func send(_ type: RTMPMessageType, stream: UInt32 = 0, _ payload: Data) {
    send(RTMPChunk.encode(
      RTMPMessage(streamID: stream, type: type, timestamp: 0, payload: payload),
      chunkStreamID: type == .amf0Command ? 3 : 2,
      chunkSize: 4_096
    ))
  }

  private func handle(_ data: Data) {
    guard phase < 2 else {
      messages(data)
      return
    }
    buffer.append(data)
    if phase == 0 {
      guard buffer.count >= 1 + RTMPHandshake.packetSize else { return }
      let c1 = buffer[1 ..< (1 + RTMPHandshake.packetSize)]
      var hello = Data([ 0x03 ])
      hello.append(Data(repeating: 0, count: RTMPHandshake.packetSize))
      hello.append(c1)
      send(hello)
      buffer.removeFirst(1 + RTMPHandshake.packetSize)
      phase = 1
    }
    guard buffer.count >= RTMPHandshake.packetSize else { return }
    buffer.removeFirst(RTMPHandshake.packetSize)
    phase = 2
    let rest = buffer
    buffer = Data()
    if !rest.isEmpty { messages(rest) }
  }

  /// A few kilobytes at a time: `RTMPChunkReader` takes a chunk per call deep, and a megabyte of
  /// stream at once is deeper than a queue's stack.
  private func messages(_ data: Data) {
    var offset = data.startIndex
    while offset < data.endIndex {
      let end = min(offset + 2_048, data.endIndex)
      for message in reader.push(data.subdata(in: offset ..< end)) { handle(message) }
      offset = end
    }
  }

  private func handle(_ message: RTMPMessage) {
    switch message.type {
    case .setChunkSize:
      let size = message.payload.prefix(4).reduce(0) { ($0 << 8) | Int($1) } & 0x7FFF_FFFF
      if size > 0 { reader.setChunkSize(size) }
    case .amf0Command:
      command(AMF0.decodeList(message.payload), stream: message.streamID)
    case .video:
      let first = message.payload.first ?? 0
      let enhanced = first & 0x80 != 0
      let packetType = first & 0x0F
      owner?.count { counts in
        counts.videoMessages += 1
        if enhanced, packetType == 0 { counts.hevcSequenceHeaders += 1 }
        if enhanced, (first >> 4) & 0x07 == 1, packetType == 1 || packetType == 3 { counts.keyframes += 1 }
      }
    case .audio:
      owner?.count { $0.audioMessages += 1 }
    default:
      break
    }
  }

  private func command(_ values: [AMF0], stream: UInt32) {
    guard let name = values.first?.stringValue else { return }
    let transaction = values.dropFirst().first?.numberValue ?? 0
    switch name {
    case "connect":
      let list = values.dropFirst(2).first?.objectValue?["fourCcList"]
      if case let .strictArray(codes)? = list {
        owner?.count { $0.fourCcList = codes.compactMap { $0.stringValue } }
      }
      send(.windowAckSize, Data([ 0x00, 0x26, 0x25, 0xA0 ]))
      send(.setPeerBandwidth, Data([ 0x00, 0x26, 0x25, 0xA0, 0x02 ]))
      send(.setChunkSize, Data([ 0x00, 0x00, 0x10, 0x00 ]))
      send(.amf0Command, AMF0.encode([
        .string("_result"), .number(transaction),
        .object([ "fmsVer": .string("FMS/3,5,7,7009"), "capabilities": .number(31) ]),
        .object([ "level": .string("status"), "code": .string("NetConnection.Connect.Success") ])
      ]))
    case "createStream":
      send(.amf0Command, AMF0.encode([ .string("_result"), .number(transaction), .null, .number(1) ]))
    case "publish":
      let name = values.dropFirst(3).first?.stringValue ?? ""
      owner?.count {
        $0.publishes += 1
        $0.publishNames.append(name)
      }
      send(.amf0Command, stream: stream, AMF0.encode([
        .string("onStatus"), .number(0), .null,
        .object([ "level": .string("status"), "code": .string("NetStream.Publish.Start") ])
      ]))
    default:
      break
    }
  }
}

// MARK: - The server

/// TeamStation's live-stream and upload routes, as far as the engine uses them.
final class StubServer: URLProtocol, @unchecked Sendable {
  struct State {
    var streamURL = "rtmp://127.0.0.1:1/live/key-0000"
    /// Answer the live-stream request with 410.
    var ended = false
    /// Answer this many live-stream requests with 503 first, as a server that cannot be reached.
    var streamFailures = 0
    var streamRequests: [[String: Any]] = []
    var opens: [[String: Any]] = []
    var stateAsks = 0
    var partsSent: [Int] = []
    var finishes = 0
    var parts = 0
    var partSize = 0
    var received: Set<Int> = []
    /// Parts from this index on are never answered, as on a link that died.
    var holdFromPart: Int?
    /// Every `PATCH …/live-streams/:id` body, and how many to answer 503 first.
    var streamChanges: [[String: Any]] = []
    var streamChangeFailures = 0
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var state = State()

  static func reset() {
    lock.lock()
    state = State()
    lock.unlock()
  }

  static func read<T>(_ body: (State) -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body(state)
  }

  static func with<T>(_ body: (inout State) -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body(&state)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    let path = request.url?.path ?? ""
    let method = request.httpMethod ?? "GET"
    let body = Self.body(of: request).flatMap {
      try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
    } ?? [:]

    if path.hasSuffix("/live-streams"), method == "POST" {
      let (ended, failing, url) = Self.with { state -> (Bool, Bool, String) in
        state.streamRequests.append(body)
        let failing = state.streamFailures > 0
        if failing { state.streamFailures -= 1 }
        return (state.ended, failing, state.streamURL)
      }
      if failing {
        reply(503, #"{"code":"unavailable","message":"try again"}"#)
      } else if ended {
        reply(410, #"{"code":"gone","message":"This camera was ended. Start streaming again to go live"}"#)
      } else {
        reply(200, #"{"id":"lst_0001","gameId":"gam_0001","label":"Home Plate","state":"idle","url":"\#(url)"}"#)
      }
      return
    }
    if path.contains("/live-streams/"), method == "PATCH" {
      let failing = Self.with { state -> Bool in
        state.streamChanges.append(body)
        let failing = state.streamChangeFailures > 0
        if failing { state.streamChangeFailures -= 1 }
        return failing
      }
      if failing {
        reply(503, #"{"code":"unavailable","message":"try again"}"#)
      } else {
        reply(200, #"{"id":"lst_0001","gameId":"gam_0001","label":"Home Plate","state":"publishing"}"#)
      }
      return
    }
    if path.hasSuffix("/director/uploads"), method == "POST" {
      let size = (body["sizeBytes"] as? Int) ?? 1
      let reply = Self.with { state -> String in
        state.opens.append(body)
        state.partSize = max(1, (size + 3) / 4)
        state.parts = (size + state.partSize - 1) / state.partSize
        state.received = []
        return #"{"uploadId":"upl_0001","partSize":\#(state.partSize),"parts":\#(state.parts),"received":[]}"#
      }
      self.reply(200, reply)
      return
    }
    if path.contains("/parts/") {
      let index = Int(path.split(separator: "/").last ?? "") ?? -1
      let hold = Self.with { state -> Bool in
        if let from = state.holdFromPart, index >= from { return true }
        state.partsSent.append(index)
        state.received.insert(index)
        return false
      }
      if hold { return }
      reply(200, #"{"received":1,"parts":4,"missing":[]}"#)
      return
    }
    if path.hasSuffix("/finish") {
      Self.with { $0.finishes += 1 }
      reply(200, #"{"videoId":"vid_0001","state":"ready","step":null}"#)
      return
    }
    if path.contains("/director/uploads/"), method == "GET" {
      let reply = Self.with { state -> String in
        state.stateAsks += 1
        let received = state.received.sorted().map(String.init).joined(separator: ",")
        return #"{"uploadId":"upl_0001","state":"open","partSize":\#(state.partSize),"parts":\#(state.parts),"received":[\#(received)],"missing":[],"receivedBytes":0}"#
      }
      self.reply(200, reply)
      return
    }
    if method == "DELETE" {
      reply(204, "")
      return
    }
    reply(404, #"{"code":"missing","message":"no such route"}"#)
  }

  private func reply(_ status: Int, _ body: String) {
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: status,
      httpVersion: nil,
      headerFields: [ "content-type": "application/json" ]
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  static func body(of request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 65_536)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: buffer.count)
      if read <= 0 { break }
      data.append(contentsOf: buffer[0 ..< read])
    }
    return data
  }
}

// MARK: - Reading a file back

struct TrackReading {
  var videoCodec: FourCharCode?
  var width = 0
  var height = 0
  var frameRate: Float = 0
  /// The shortest picture: one slot of the grid the file was written on.
  var minFrameDuration: Double = 0
  var videoSeconds: Double = 0
  var videoEnd: Double = 0
  var audioStart: Double = 0
  var audioEnd: Double = 0
  var hasAAC = false
  var bitsPerSecond: Float = 0
  var pictureTimes: [Double] = []
}

/// What AVFoundation reads from a file: its tracks, their ends, and every picture's time.
func readBack(_ url: URL, pictures: Bool = false) async throws -> TrackReading {
  let asset = AVURLAsset(url: url)
  var reading = TrackReading()
  if let video = try await asset.loadTracks(withMediaType: .video).first {
    let (formats, size, rate, range, bits) = try await video.load(
      .formatDescriptions, .naturalSize, .nominalFrameRate, .timeRange, .estimatedDataRate
    )
    reading.minFrameDuration = try await video.load(.minFrameDuration).seconds
    reading.videoCodec = formats.first.map(CMFormatDescriptionGetMediaSubType)
    reading.width = Int(size.width)
    reading.height = Int(size.height)
    reading.frameRate = rate
    reading.videoSeconds = range.duration.seconds
    reading.videoEnd = range.end.seconds
    reading.bitsPerSecond = bits
    if pictures {
      let reader = try AVAssetReader(asset: asset)
      let output = AVAssetReaderTrackOutput(track: video, outputSettings: nil)
      reader.add(output)
      reader.startReading()
      while let sample = output.copyNextSampleBuffer() {
        guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
        reading.pictureTimes.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
      }
      reading.pictureTimes.sort()
    }
  }
  if let audio = try await asset.loadTracks(withMediaType: .audio).first {
    let (formats, range) = try await audio.load(.formatDescriptions, .timeRange)
    reading.hasAAC = formats.first.map { CMFormatDescriptionGetMediaSubType($0) == kAudioFormatMPEG4AAC } ?? false
    reading.audioStart = range.start.seconds
    reading.audioEnd = range.end.seconds
  }
  return reading
}
