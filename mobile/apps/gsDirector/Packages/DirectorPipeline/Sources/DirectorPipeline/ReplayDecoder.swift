import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import DirectorCore

/// Plays an assembled HLS playlist back at wall-clock pace so a scrubbed tile shows moving video.
///
/// Archive segments are `mpeg4AppleHLS` fragments. Concatenating them into one `.mp4` is valid
/// for ffmpeg, but `AVAssetReader` on iOS decodes no frames from that file — especially HEVC —
/// and `AVPlayer` will not play the same playlist from a `file://` URL (the item stays
/// `.unknown` forever). Replay therefore stages the fragments and serves them over loopback
/// HTTP, which is the shape `AVPlayer` actually accepts.
///
/// This is the decode session for replay specifically, kept separate from the camera decoders
/// so a scrub can never disturb a live tile. Each tile may replay independently; decode budget
/// is one `AVPlayer` per camera that is in rewind, not a global singleton.
public final class ReplayDecoder: @unchecked Sendable {
  public struct Configuration: Sendable {
    public var url: URL
    /// Seconds into the assembled playlist where playback should begin, relative to that
    /// playlist's first sample.
    public var startOffset: TimeInterval
    public var frameRate: Double
    /// Loopback port this decoder's HTTP server binds. One port per tile so two replays cannot
    /// share a listener. Tile 0 is `loopbackBasePort`.
    public var port: UInt16
    /// `AVPlayer.rate`. Instant-replay slow-mo uses the Settings value; a finger scrub is 1.
    public var rate: Float
    /// When set, return to live after this many seconds of *content*, not wall clock.
    public var playDuration: TimeInterval?

    public init(
      url: URL,
      startOffset: TimeInterval,
      frameRate: Double = 30,
      port: UInt16,
      rate: Float = 1,
      playDuration: TimeInterval? = nil
    ) {
      self.url = url
      self.startOffset = startOffset
      self.frameRate = frameRate
      self.port = port
      self.rate = rate
      self.playDuration = playDuration
    }
  }

  /// Control server is `:8765`. Replay HTTP is `18701 + tileIndex` so HUD/debug can name the port.
  public static let loopbackBasePort: UInt16 = 18_701

  public static func loopbackPort(forTile tileIndex: Int) -> UInt16 {
    UInt16(Int(loopbackBasePort) + max(0, tileIndex))
  }

  public typealias FrameHandler = @Sendable (CVPixelBuffer, CMTime, TimeInterval) -> Void

  private let configuration: Configuration
  private let onFrame: FrameHandler
  private let onFinish: @Sendable () -> Void
  private let onFailure: @Sendable (Error) -> Void
  private let queue: DispatchQueue

  private let lock = NSLock()
  private var player: AVPlayer?
  private var videoOutput: AVPlayerItemVideoOutput?
  private var httpServer: ReplayHTTPServer?
  private var timer: DispatchSourceTimer?
  private var endObserver: NSObjectProtocol?
  private var failedObserver: NSObjectProtocol?
  private var running = false
  private var elapsed: TimeInterval = 0
  private var deliveredFrames: UInt64 = 0

  public init(
    configuration: Configuration,
    onFrame: @escaping FrameHandler,
    onFinish: @escaping @Sendable () -> Void = {},
    onFailure: @escaping @Sendable (Error) -> Void = { _ in }
  ) {
    self.configuration = configuration
    self.onFrame = onFrame
    self.onFinish = onFinish
    self.onFailure = onFailure
    self.queue = DispatchQueue(label: "co.gamestation.director.replay", qos: .userInitiated)
  }

  deinit {
    stop()
  }

  public var frameCount: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return deliveredFrames
  }

  /// Seconds of replayed material delivered so far, used to keep the tile's `off=` value
  /// truthful while a replay runs.
  public var playedSeconds: TimeInterval {
    lock.lock()
    defer { lock.unlock() }
    return elapsed
  }

  public func start() async throws {
    let server = ReplayHTTPServer(root: configuration.url.deletingLastPathComponent(), port: configuration.port)
    store(server: server)
    let playlistURL = try await server.start()

    let session = makeSession(playlistURL: playlistURL)
    try await waitUntilReady(session.item)
    try await seekIfNeeded(player: session.player, item: session.item)

    observe(session.item)
    adopt(player: session.player, output: session.output)
    session.player.rate = configuration.rate
    try await copyFirstFrame(player: session.player, output: session.output)
    armTimer()
  }

  private struct Session {
    var player: AVPlayer
    var item: AVPlayerItem
    var output: AVPlayerItemVideoOutput
  }

  private func makeSession(playlistURL: URL) -> Session {
    let item = AVPlayerItem(url: playlistURL)
    let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: String],
      kCVPixelBufferMetalCompatibilityKey as String: true
    ])
    item.add(output)

    let player = AVPlayer(playerItem: item)
    player.actionAtItemEnd = .pause
    player.isMuted = true
    player.automaticallyWaitsToMinimizeStalling = false
    return Session(player: player, item: item, output: output)
  }

  private func store(server: ReplayHTTPServer) {
    lock.lock()
    httpServer = server
    lock.unlock()
  }

  private func adopt(player: AVPlayer, output: AVPlayerItemVideoOutput) {
    lock.lock()
    self.player = player
    self.videoOutput = output
    running = true
    elapsed = 0
    deliveredFrames = 0
    lock.unlock()
  }

  public func stop() {
    lock.lock()
    running = false
    let timer = self.timer
    self.timer = nil
    let player = self.player
    self.player = nil
    videoOutput = nil
    let server = httpServer
    httpServer = nil
    let endObserver = self.endObserver
    let failedObserver = self.failedObserver
    self.endObserver = nil
    self.failedObserver = nil
    lock.unlock()

    timer?.cancel()
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    if let failedObserver { NotificationCenter.default.removeObserver(failedObserver) }
    player?.pause()
    player?.replaceCurrentItem(with: nil)
    server?.stop()
    cleanupStagingDirectory()
  }

  private func waitUntilReady(_ item: AVPlayerItem) async throws {
    for _ in 0..<80 {
      switch item.status {
      case .readyToPlay:
        return
      case .failed:
        throw ReplayError.startFailed(Self.describe(item.error) ?? "item failed")
      default:
        try await Task.sleep(for: .milliseconds(50))
      }
    }
    guard item.status == .readyToPlay else {
      throw ReplayError.startFailed(
        Self.describe(item.error) ?? "playlist never became ready (status \(item.status.rawValue))"
      )
    }
  }

  private func seekIfNeeded(player: AVPlayer, item: AVPlayerItem) async throws {
    let target = max(0, configuration.startOffset)
    guard target > 0.04 else { return }

    for _ in 0..<40 {
      if item.duration.isNumeric, item.duration.seconds > 0 { break }
      try await Task.sleep(for: .milliseconds(50))
    }

    let duration = item.duration.isNumeric ? item.duration.seconds : target
    let seconds = min(target, max(0, duration - 0.05))
    let time = CMTime(seconds: seconds, preferredTimescale: 600)
    let finished = await player.seek(
      to: time,
      toleranceBefore: .zero,
      toleranceAfter: CMTime(seconds: 0.2, preferredTimescale: 600)
    )
    guard finished else {
      throw ReplayError.noSamples
    }
  }

  private func copyFirstFrame(player: AVPlayer, output: AVPlayerItemVideoOutput) async throws {
    for _ in 0..<100 {
      if let pixelBuffer = copyPixelBuffer(from: output, at: player.currentTime(), force: true) {
        deliver(pixelBuffer: pixelBuffer, time: player.currentTime(), played: 0)
        return
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    throw ReplayError.noSamples
  }

  private func observe(_ item: AVPlayerItem) {
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: item,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async { self?.finishSuccessfully() }
    }
    failedObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemFailedToPlayToEndTime,
      object: item,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async {
        self?.fail(ReplayError.startFailed(Self.describe(item.error) ?? "playback failed"))
      }
    }
  }

  private func armTimer() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    let interval = 1 / max(configuration.frameRate, 1)
    timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(2))
    timer.setEventHandler { [weak self] in
      self?.pump()
    }
    lock.lock()
    self.timer = timer
    lock.unlock()
    timer.resume()
  }

  private func pump() {
    lock.lock()
    guard running, let player, let output = videoOutput else {
      lock.unlock()
      return
    }
    lock.unlock()

    let time = player.currentTime()
    guard let pixelBuffer = copyPixelBuffer(from: output, at: time) else { return }
    let played = max(0, time.seconds - configuration.startOffset)
    deliver(
      pixelBuffer: pixelBuffer,
      time: time,
      played: played
    )
    if ScrubMapping.hasPlayedRequestedDuration(played: played, requested: configuration.playDuration) {
      finishSuccessfully()
    }
  }

  private func deliver(pixelBuffer: CVPixelBuffer, time: CMTime, played: TimeInterval) {
    lock.lock()
    elapsed = played
    deliveredFrames += 1
    lock.unlock()
    onFrame(pixelBuffer, time, played)
  }

  private func copyPixelBuffer(
    from output: AVPlayerItemVideoOutput,
    at time: CMTime,
    force: Bool = false
  ) -> CVPixelBuffer? {
    guard force || output.hasNewPixelBuffer(forItemTime: time) else { return nil }
    var displayTime = CMTime.invalid
    return output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: &displayTime)
  }

  private func finishSuccessfully() {
    lock.lock()
    let shouldFinish = running
    lock.unlock()
    stop()
    if shouldFinish { onFinish() }
  }

  private func fail(_ error: Error) {
    lock.lock()
    let shouldFail = running
    lock.unlock()
    stop()
    if shouldFail { onFailure(error) }
  }

  private func cleanupStagingDirectory() {
    let directory = configuration.url.deletingLastPathComponent()
    guard directory.lastPathComponent.hasPrefix("replay-") else { return }
    try? FileManager.default.removeItem(at: directory)
  }

  private static func describe(_ error: Error?) -> String? {
    guard let error else { return nil }
    let ns = error as NSError
    var parts = [ns.localizedDescription]
    if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
      parts.append(underlying.localizedDescription)
    }
    return parts.joined(separator: "; ")
  }

  public enum ReplayError: Error, LocalizedError, CustomStringConvertible {
    case noVideoTrack
    case noSamples
    case readerRejectedOutput
    case startFailed(String)

    public var description: String {
      switch self {
      case .noVideoTrack: "assembled replay file has no video track"
      case .noSamples: "assembled replay file decoded no frames at the scrub point"
      case .readerRejectedOutput: "reader rejected the replay output settings"
      case let .startFailed(reason): "replay reader failed to start: \(reason)"
      }
    }

    public var errorDescription: String? { description }
  }
}
