import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import DirectorCore
import DirectorSources

/// Plays archived tape back at wall-clock pace so a scrubbed tile shows moving video.
///
/// Finger-scrub and instant-replay hotkeys share this decoder. Complete MP4 archive files are
/// decoded on one producer thread into a 2–3 second pixel FIFO; the display timer only pops
/// that FIFO, one frame per tick, so file boundaries cannot hitch or skip the picture.
/// Fragmented HLS recordings still go through loopback HTTP, because iOS `AVPlayer` will not
/// play `file://` HLS and `AVAssetReader` does not decode concatenated `mpeg4AppleHLS`
/// fragments.
///
/// This is the decode session for replay specifically, kept separate from the camera decoders
/// so a scrub can never disturb a live tile. Each tile may replay independently.
public final class ReplayDecoder: @unchecked Sendable {
  public struct Configuration: Sendable {
    public var url: URL
    /// Seconds into the assembled playlist where playback should begin, relative to that
    /// playlist's first sample.
    public var startOffset: TimeInterval
    public var frameRate: Double
    /// Loopback port this decoder's HTTP server binds. One port per tile so two replays cannot
    /// share a listener. Tile 0 is `loopbackBasePort`. Unused when `fileURLs` is set.
    public var port: UInt16
    /// `AVPlayer.rate`. Instant-replay slow-mo uses the Settings value; a finger scrub is 1.
    public var rate: Float
    /// When set, return to live after this many seconds of *content*, not wall clock.
    public var playDuration: TimeInterval?
    /// Complete archive MP4s in play order. When non-empty, replay reads them with
    /// `AVAssetReader` instead of loopback HLS.
    public var fileURLs: [URL]
    /// Index durations for `fileURLs`, used to skip `startOffset` across files.
    public var fileDurations: [TimeInterval]

    public init(
      url: URL,
      startOffset: TimeInterval,
      frameRate: Double = 30,
      port: UInt16,
      rate: Float = 1,
      playDuration: TimeInterval? = nil,
      fileURLs: [URL] = [],
      fileDurations: [TimeInterval] = []
    ) {
      self.url = url
      self.startOffset = startOffset
      self.frameRate = frameRate
      self.port = port
      self.rate = rate
      self.playDuration = playDuration
      self.fileURLs = fileURLs
      self.fileDurations = fileDurations
    }
  }

  /// Control server is `:8765`. Replay HTTP is `18701 + sourceIndex` so HUD/debug can name the port.
  public static let loopbackBasePort: UInt16 = 18_701

  public static func loopbackPort(forSource sourceIndex: Int) -> UInt16 {
    UInt16(Int(loopbackBasePort) + max(0, sourceIndex))
  }

  public typealias FrameHandler = @Sendable (CVPixelBuffer, CMTime, TimeInterval) -> Void

  private let configuration: Configuration
  private let onFrame: FrameHandler
  private let onFinish: @Sendable () -> Void
  private let onFailure: @Sendable (Error) -> Void
  /// Playlist ended before `playDuration`. The owner stages newly closed archive files and
  /// calls `appendFiles` so playback does not stop and restart.
  private let onNeedsMoreFiles: @Sendable (TimeInterval) -> Void
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
  private var startGeneration: UInt64 = 0
  /// Replay copies out of `AVPlayer`'s IOSurfaces into this cap. Handing player buffers to the
  /// display layer, compositor and encoder pins `mediaplaybackd` memory until jetsam.
  private var framePool: PixelBufferFactory?
  private var fileReader: ReplayFileReader?
  private var filePumpTick: UInt64 = 0
  /// Where playback was anchored, and what has been shown. Position is derived from these and the
  /// wall clock rather than accumulated per tick, so a dropped or late tick does not shift the rate.
  private var replayAnchorWall: Double?
  private var replayAnchorMedia: Double = 0
  private var lastShownMedia: Double?
  /// The previously shown frame's position, so the frame now on screen can be given the duration
  /// its own timeline says it has rather than one assumed from a declared rate.
  private var previousShownMedia: Double?
  private var waitingForMoreFiles = false
  private var lastDeliveredAt: CFAbsoluteTime = 0
  private let stallPolicy = ReplayStallPolicy()

  public init(
    configuration: Configuration,
    onFrame: @escaping FrameHandler,
    onFinish: @escaping @Sendable () -> Void = {},
    onFailure: @escaping @Sendable (Error) -> Void = { _ in },
    onNeedsMoreFiles: @escaping @Sendable (TimeInterval) -> Void = { _ in }
  ) {
    self.configuration = configuration
    self.onFrame = onFrame
    self.onFinish = onFinish
    self.onFailure = onFailure
    self.onNeedsMoreFiles = onNeedsMoreFiles
    self.queue = DispatchQueue(label: "app.teamstation.director.replay", qos: .userInitiated)
  }

  /// Closed archive files that were not in the first assembly. Playback continues without
  /// tearing down the tile. Finger-scrub and hotkeys both append this way so the next file can
  /// be primed before the current one ends.
  public func appendFiles(urls: [URL], durations: [TimeInterval]) {
    guard !urls.isEmpty else { return }
    queue.async {
      self.lock.lock()
      self.fileReader?.append(urls: urls, durations: durations)
      self.waitingForMoreFiles = false
      self.lock.unlock()
    }
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
    let generation = beginStart()
    if !configuration.fileURLs.isEmpty {
      try await startFromCompleteFiles(generation)
      return
    }
    var session: Session?
    do {
      let server = ReplayHTTPServer(root: configuration.url.deletingLastPathComponent(), port: configuration.port)
      store(server: server)
      try throwIfCancelled(generation)
      let playlistURL = try await server.start()
      try throwIfCancelled(generation)
      let created = makeSession(playlistURL: playlistURL)
      session = created
      try await waitUntilReady(created.item)
      try throwIfCancelled(generation)
      try await seekIfNeeded(player: created.player, item: created.item)
      try throwIfCancelled(generation)
      observe(created.item)
      adopt(player: created.player, output: created.output)
      try throwIfCancelled(generation)
      created.player.rate = 0
      try await copyFirstFrame(player: created.player, output: created.output)
      try throwIfCancelled(generation)
      created.player.rate = configuration.rate
      armTimer()
    } catch {
      discardLocalSession(session)
      stop()
      throw error
    }
  }

  private func beginStart() -> UInt64 {
    lock.lock()
    startGeneration &+= 1
    let generation = startGeneration
    lock.unlock()
    return generation
  }

  private func throwIfCancelled(_ generation: UInt64) throws {
    lock.lock()
    let current = startGeneration
    lock.unlock()
    if current != generation {
      throw ReplayError.startFailed("cancelled")
    }
  }

  private func startFromCompleteFiles(_ generation: UInt64) async throws {
    try await startFromFileReader(generation)
  }

  private func startFromFileReader(_ generation: UInt64) async throws {
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
      queue.async {
        do {
          try self.throwIfCancelled(generation)
          try self.primeCompleteFiles()
          try self.throwIfCancelled(generation)
          self.armTimer()
          cont.resume()
        } catch {
          self.stop()
          cont.resume(throwing: error)
        }
      }
    }
  }

  private func primeCompleteFiles() throws {
    let reader = ReplayFileReader(
      urls: configuration.fileURLs,
      durations: configuration.fileDurations,
      frameRate: configuration.frameRate,
      playDuration: configuration.playDuration
    )
    try reader.open(startOffset: configuration.startOffset)
    guard let frame = reader.pop() else { throw ReplayError.noSamples }
    guard let copy = detachedCopy(frame.pixel) else { throw ReplayError.noSamples }
    lock.lock()
    fileReader = reader
    running = true
    elapsed = 0
    deliveredFrames = 0
    filePumpTick = 0
    previousShownMedia = nil
    lock.unlock()
    deliver(pixelBuffer: copy, time: CMClockGetTime(CMClockGetHostTimeClock()), played: 0)
  }

  /// An `AVPlayer` created before `adopt` is not on `self` yet, so `stop()` would miss it.
  private func discardLocalSession(_ session: Session?) {
    guard let session else { return }
    lock.lock()
    let adopted = player === session.player
    lock.unlock()
    if adopted { return }
    session.item.remove(session.output)
    session.player.pause()
    session.player.replaceCurrentItem(with: nil)
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
    startGeneration &+= 1
    running = false
    let timer = self.timer
    self.timer = nil
    let player = self.player
    self.player = nil
    let output = videoOutput
    videoOutput = nil
    let server = httpServer
    httpServer = nil
    let endObserver = self.endObserver
    let failedObserver = self.failedObserver
    self.endObserver = nil
    self.failedObserver = nil
    let files = fileReader
    fileReader = nil
    waitingForMoreFiles = false
    lastDeliveredAt = 0
    lock.unlock()

    timer?.cancel()
    files?.cancel()
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    if let failedObserver { NotificationCenter.default.removeObserver(failedObserver) }
    player?.pause()
    if let player, let output {
      player.currentItem?.remove(output)
    }
    if let queuePlayer = player as? AVQueuePlayer {
      queuePlayer.removeAllItems()
    } else {
      player?.replaceCurrentItem(with: nil)
    }
    server?.stop()
    cleanupStagingDirectory()
    framePool = nil
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
    try await seekItem(player: player, item: item, seconds: configuration.startOffset)
  }

  private func seekItem(player: AVPlayer, item: AVPlayerItem, seconds: TimeInterval) async throws {
    let target = max(0, seconds)
    guard target > 0.04 else { return }

    for _ in 0..<40 {
      if item.duration.isNumeric, item.duration.seconds > 0 { break }
      try await Task.sleep(for: .milliseconds(50))
    }

    let duration = item.duration.isNumeric ? item.duration.seconds : target
    let skip = min(target, max(0, duration - 0.05))
    let time = CMTime(seconds: skip, preferredTimescale: 600)
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
      let time = player.currentTime()
      if let pixelBuffer = copyPixelBuffer(from: output, at: time, force: true) {
        deliver(
          pixelBuffer: pixelBuffer,
          time: time,
          played: max(0, time.seconds - configuration.startOffset)
        )
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

  /// How often a replay from the archive files looks for the next picture: often enough that each
  /// is handed on within a few milliseconds of its moment, as the live delay line's drain does.
  static let filePumpInterval = 0.004

  private func armTimer() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    let interval = configuration.fileURLs.isEmpty ? 1 / max(configuration.frameRate, 1) : Self.filePumpInterval
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
    guard running else {
      lock.unlock()
      return
    }
    let files = fileReader
    let player = self.player
    let output = videoOutput
    lock.unlock()

    if let files {
      pumpFiles(files)
      return
    }
    guard let player, let output else { return }

    let time = player.currentTime()
    guard let pixelBuffer = copyPixelBuffer(from: output, at: time) else {
      finishIfStalled()
      return
    }
    let played = max(0, time.seconds - configuration.startOffset)
    deliver(pixelBuffer: pixelBuffer, time: time, played: played)
    if ScrubMapping.hasPlayedRequestedDuration(played: played, requested: configuration.playDuration) {
      finishSuccessfully()
    }
  }

  /// Content shown from the replay's first frame up to and including the one now on screen.
  ///
  /// The frames carry their own presentation timestamps and the anchor is the first one shown, so
  /// this is a subtraction rather than a running total at an assumed rate. The trailing frame's
  /// own duration is included — otherwise a replay stops at the *start* of its last frame, which
  /// at 30 fps is 33 ms short of the requested duration and outside the 20 ms tolerance.
  private func playedSeconds(upTo media: TimeInterval, bootstrapStep: TimeInterval) -> TimeInterval {
    lock.lock()
    let anchor = replayAnchorMedia
    let previous = previousShownMedia
    previousShownMedia = media
    lock.unlock()
    let step = previous.map { max(0, media - $0) } ?? 0
    let duration = step > 0 ? step : bootstrapStep
    return max(0, media - anchor) + duration
  }

  private func pumpFiles(_ reader: ReplayFileReader) {
    lock.lock()
    let shown = elapsed
    filePumpTick += 1
    let tick = filePumpTick
    lock.unlock()
    let step = 1 / max(configuration.frameRate, 1)
    if ScrubMapping.hasPlayedRequestedDuration(played: shown, requested: configuration.playDuration) {
      finishSuccessfully()
      return
    }
    if reader.shouldPrefetchMore {
      requestMoreFiles(played: shown)
    }
    // Which frame belongs on screen now, asked of a clock rather than counted in ticks: the newest
    // whose moment on the tape is due within the lead (`ReplayCadence`), stamped with that moment,
    // which the programme takes it at. Counting ticks quantised the rate to 1/n.
    let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    var chosen: (pixel: CVPixelBuffer, time: CMTime, media: TimeInterval)?
    lock.lock()
    let anchorWall = replayAnchorWall
    let anchorMedia = replayAnchorMedia
    lock.unlock()
    if anchorWall == nil {
      // The first picture is shown at once and anchors the replay's clock.
      if let first = reader.pop() {
        chosen = first
        lock.lock()
        replayAnchorWall = now
        replayAnchorMedia = first.media
        lastShownMedia = first.media
        lock.unlock()
      }
    } else if let anchorWall {
      let cadence = ReplayCadence(anchorWall: anchorWall, anchorMedia: anchorMedia, rate: Double(configuration.rate))
      let reached = cadence.handOnThrough(now) + 1e-9
      while let media = reader.peekMedia(), media <= reached, let next = reader.pop() {
        chosen = next
        lock.lock()
        lastShownMedia = next.media
        lock.unlock()
      }
    }
    guard let frame = chosen else {
      if reader.isExhausted {
        finishSuccessfully()
      } else if stalled() {
        // A stall ends the replay whether or not anything has been shown yet. Requiring that
        // nothing had been shown meant an underrun part-way through left the tile frozen on its
        // last picture with no path back to live, which is worse than ending early.
        finishSuccessfully()
      } else {
        // Not stalled and nothing due: at a slow rate this is the normal case. Keep the reader fed.
        requestMoreFiles(played: shown)
      }
      return
    }
    guard let copy = detachedCopy(frame.pixel) else { return }
    // How much tape has been shown, measured on the frames' own timeline rather than counted at
    // the rate the camera claimed. `step` is the bootstrap for the very first frame, which has no
    // predecessor to be measured against.
    let played = playedSeconds(upTo: frame.media, bootstrapStep: step)
    // Stamped with its own moment on the host clock, which the programme places it by.
    lock.lock()
    let cadence = ReplayCadence(
      anchorWall: replayAnchorWall ?? now,
      anchorMedia: replayAnchorMedia,
      rate: Double(configuration.rate)
    )
    lock.unlock()
    deliver(
      pixelBuffer: copy,
      time: CMTime(seconds: cadence.due(media: frame.media), preferredTimescale: 1_000_000_000),
      played: played
    )
    if ScrubMapping.hasPlayedRequestedDuration(played: played, requested: configuration.playDuration) {
      finishSuccessfully()
    }
  }

  private func requestMoreFiles(played: TimeInterval) {
    if ScrubMapping.hasPlayedRequestedDuration(played: played, requested: configuration.playDuration) {
      finishSuccessfully()
      return
    }
    lock.lock()
    let alreadyWaiting = waitingForMoreFiles
    waitingForMoreFiles = true
    lock.unlock()
    if alreadyWaiting { return }
    onNeedsMoreFiles(played)
    queue.asyncAfter(deadline: .now() + .milliseconds(400)) { [weak self] in
      guard let self else { return }
      self.lock.lock()
      self.waitingForMoreFiles = false
      self.lock.unlock()
    }
  }

  private func deliver(pixelBuffer: CVPixelBuffer, time: CMTime, played: TimeInterval) {
    lock.lock()
    elapsed = played
    deliveredFrames += 1
    lastDeliveredAt = CFAbsoluteTimeGetCurrent()
    lock.unlock()
    onFrame(pixelBuffer, time, played)
  }

  private func stalled() -> Bool {
    lock.lock()
    let last = lastDeliveredAt
    lock.unlock()
    return stallPolicy.shouldFinish(now: CFAbsoluteTimeGetCurrent(), lastDeliveredAt: last)
  }

  private func finishIfStalled() {
    if stalled() { finishSuccessfully() }
  }

  private func copyPixelBuffer(
    from output: AVPlayerItemVideoOutput,
    at time: CMTime,
    force: Bool = false
  ) -> CVPixelBuffer? {
    guard force || output.hasNewPixelBuffer(forItemTime: time) else { return nil }
    var displayTime = CMTime.invalid
    guard let source = output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: &displayTime)
    else { return nil }
    return detachedCopy(source)
  }

  /// `AVPlayerItemVideoOutput` hands out `mediaplaybackd` IOSurfaces. The display layer,
  /// compositor and program encoder would otherwise hold them across frames and the player's
  /// pool would grow without bound.
  private func detachedCopy(_ source: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(source)
    let height = CVPixelBufferGetHeight(source)
    let format = CVPixelBufferGetPixelFormatType(source)
    if framePool?.width != width || framePool?.height != height || framePool?.pixelFormat != format {
      framePool = PixelBufferFactory(
        width: width,
        height: height,
        pixelFormat: format,
        minimumBuffers: 4,
        maximumBuffers: 16
      )
    }
    guard let destination = framePool?.makeBuffer() else { return nil }
    guard Self.copyPlanes(from: source, to: destination) else { return nil }
    return destination
  }

  private static func copyPlanes(from source: CVPixelBuffer, to destination: CVPixelBuffer) -> Bool {
    let planes = max(CVPixelBufferGetPlaneCount(source), 1)
    guard planes == max(CVPixelBufferGetPlaneCount(destination), 1) else { return false }
    CVPixelBufferLockBaseAddress(source, .readOnly)
    CVPixelBufferLockBaseAddress(destination, [])
    defer {
      CVPixelBufferUnlockBaseAddress(destination, [])
      CVPixelBufferUnlockBaseAddress(source, .readOnly)
    }
    for plane in 0..<planes {
      let srcBytes = CVPixelBufferGetPlaneCount(source) == 0
        ? CVPixelBufferGetBytesPerRow(source)
        : CVPixelBufferGetBytesPerRowOfPlane(source, plane)
      let dstBytes = CVPixelBufferGetPlaneCount(destination) == 0
        ? CVPixelBufferGetBytesPerRow(destination)
        : CVPixelBufferGetBytesPerRowOfPlane(destination, plane)
      let height = CVPixelBufferGetPlaneCount(source) == 0
        ? CVPixelBufferGetHeight(source)
        : CVPixelBufferGetHeightOfPlane(source, plane)
      let width = min(srcBytes, dstBytes)
      guard
        let src = CVPixelBufferGetPlaneCount(source) == 0
          ? CVPixelBufferGetBaseAddress(source)
          : CVPixelBufferGetBaseAddressOfPlane(source, plane),
        let dst = CVPixelBufferGetPlaneCount(destination) == 0
          ? CVPixelBufferGetBaseAddress(destination)
          : CVPixelBufferGetBaseAddressOfPlane(destination, plane)
      else { return false }
      for row in 0..<height {
        memcpy(dst.advanced(by: row * dstBytes), src.advanced(by: row * srcBytes), width)
      }
    }
    return true
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
