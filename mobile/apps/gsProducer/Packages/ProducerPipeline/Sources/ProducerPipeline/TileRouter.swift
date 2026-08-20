import CoreMedia
import CoreVideo
import Foundation
import ProducerCore
import ProducerSources

/// Where archived frames go. `ProducerDVR.SegmentWriter` conforms.
/// Declaring it here keeps the dependency pointing one way: the pipeline never learns what an
/// fMP4 segment is, and the DVR never learns where frames come from.
///
/// The archive takes coded frames, not pixels: what a camera sent is what belongs on disk, so the
/// bytes go from the socket to the file without passing through a decoder or an encoder.
public protocol ArchiveSink: AnyObject, Sendable {
  func append(_ frame: CompressedFrame)
  func append(audio: CompressedAudioFrame)
}

/// Where the 1 fps proxy taps. `ProducerDVR.ProxyStore` conforms.
public protocol ProxySink: AnyObject, Sendable {
  func offer(_ frame: PixelFrame)
}

/// One source's journey from arrival to screen, archive and proxy.
///
/// The order in `handle` is the plan's first testable property: **the archive branch diverges
/// after conversion and before any UI state**. A tile in replay keeps recording live underneath
/// because the archive sink never sees `state`.
public final class SourcePipeline: @unchecked Sendable {
  public let sourceID: SourceID
  public let tileIndex: Int
  public let renderer = TileRenderer()

  private let converter: PixelConverter
  private let telemetry: PipelineTelemetry

  private let lock = NSLock()
  /// Not a `let`: a camera that reappears at another address needs a new session, and everything
  /// else about the tile — its archive, proxy, program and audio sinks — has to survive the swap.
  private var source: FrameSource
  private var archive: ArchiveSink?
  private var proxy: ProxySink?
  private var state: TileState = .live
  private var programSink: (@Sendable (CVPixelBuffer, CMTime) -> Void)?
  private var audioSink: (@Sendable (AudioFrame) -> Void)?
  private var replay: ReplayDecoder?
  private var lastLiveWall: WallClock?
  private var sawAudio = false

  public init(
    sourceID: SourceID,
    tileIndex: Int,
    source: FrameSource,
    converter: PixelConverter,
    telemetry: PipelineTelemetry
  ) {
    self.sourceID = sourceID
    self.tileIndex = tileIndex
    self.source = source
    self.converter = converter
    self.telemetry = telemetry
  }

  public var displayName: String { currentSource.displayName }
  public var format: SourceFormat? { currentSource.format }
  public var connections: Int { currentSource.connections }
  public var receiveStats: ReceiveStats { currentSource.receiveStats }

  private var currentSource: FrameSource {
    lock.lock()
    defer { lock.unlock() }
    return source
  }

  /// Whether this source has ever delivered an audio buffer.
  ///
  /// Not cosmetic: giving an archive an audio track that never receives a sample stalls a segmented
  /// `AVAssetWriter` at the first segment rotation, which drops every subsequent frame with no error
  /// reported anywhere. A camera may send video only, so this has to be checked rather than
  /// assumed.
  public var hasDeliveredAudio: Bool {
    lock.lock()
    defer { lock.unlock() }
    return sawAudio
  }

  public var currentState: TileState {
    lock.lock()
    defer { lock.unlock() }
    return state
  }

  /// Wall clock of the most recent live frame — the "now" edge of this source's timeline.
  public var liveEdge: WallClock? {
    lock.lock()
    defer { lock.unlock() }
    return lastLiveWall
  }

  public var sourceIsRunning: Bool { currentSource.isRunning }

  public func start() throws {
    let source = currentSource
    telemetry.mutateTile(tileIndex) {
      $0.sourceID = sourceID.rawValue
      $0.displayName = source.displayName
      $0.state = .live
    }
    try source.start(sinks: frameSinks)
  }

  /// Swaps in a session pointed at the camera's new address, leaving the tile itself alone.
  ///
  /// The archive keeps writing to the same segments, because as far as everything downstream is
  /// concerned this is the same camera — which it is.
  public func replaceSource(_ replacement: FrameSource) throws {
    lock.lock()
    let previous = source
    source = replacement
    lock.unlock()

    previous.stop()
    telemetry.mutateTile(tileIndex) { $0.displayName = replacement.displayName }
    try replacement.start(sinks: frameSinks)
  }

  private var frameSinks: FrameSinks {
    FrameSinks(
      pixel: { [weak self] frame in self?.handle(frame) },
      audio: { [weak self] frame in self?.handle(audio: frame) },
      compressed: { [weak self] frame in self?.handle(compressed: frame) },
      compressedAudio: { [weak self] frame in self?.handle(compressedAudio: frame) }
    )
  }

  public func stop() {
    lock.lock()
    let replay = self.replay
    self.replay = nil
    let source = self.source
    lock.unlock()
    replay?.stop()
    source.stop()
    renderer.attach(layer: nil)
    telemetry.mutateTile(tileIndex) {
      $0.state = .empty
      $0.sourceID = nil
      $0.displayName = nil
      $0.isProgram = false
    }
  }

  public func setArchive(_ sink: ArchiveSink?) {
    lock.lock()
    archive = sink
    lock.unlock()
  }

  public func setProxy(_ sink: ProxySink?) {
    lock.lock()
    proxy = sink
    lock.unlock()
  }

  public func setProgramSink(_ sink: (@Sendable (CVPixelBuffer, CMTime) -> Void)?) {
    lock.lock()
    programSink = sink
    lock.unlock()
    telemetry.mutateTile(tileIndex) { $0.isProgram = sink != nil }
  }

  public func setAudioSink(_ sink: (@Sendable (AudioFrame) -> Void)?) {
    lock.lock()
    audioSink = sink
    lock.unlock()
  }

  // MARK: - Frame path

  private func handle(_ frame: PixelFrame) {
    guard let converted = converter.convert(frame) else {
      telemetry.recordDroppedFrame(tile: tileIndex)
      return
    }

    lock.lock()
    lastLiveWall = converted.wallClock
    let proxy = self.proxy
    let state = self.state
    let programSink = self.programSink
    lock.unlock()

    telemetry.recordReceivedFrame(tile: tileIndex, frameID: converted.frameID)

    // The proxy runs regardless of what the tile is showing, as the archive does on its own path.
    // This is what makes "scrub back while it keeps recording" true rather than aspirational.
    proxy?.offer(converted)

    guard state == .live else { return }
    if renderer.enqueue(converted) {
      telemetry.recordDisplayedFrame(tile: tileIndex)
    }
    programSink?(converted.pixelBuffer, converted.presentationTime)
  }

  private func handle(audio frame: AudioFrame) {
    lock.lock()
    let audioSink = self.audioSink
    lock.unlock()
    telemetry.mutateTile(tileIndex) { $0.audioFrames &+= 1 }
    audioSink?(frame)
  }

  /// The archive branch. It diverges before conversion, before the renderer and before `state`, so
  /// a tile in replay keeps recording underneath and what lands on disk is byte-for-byte what the
  /// camera sent.
  private func handle(compressed frame: CompressedFrame) {
    lock.lock()
    let archive = self.archive
    lock.unlock()
    archive?.append(frame)
  }

  private func handle(compressedAudio frame: CompressedAudioFrame) {
    lock.lock()
    let archive = self.archive
    sawAudio = true
    lock.unlock()
    archive?.append(audio: frame)
  }

  // MARK: - Scrub and replay

  public func beginScrubbing() {
    lock.lock()
    state = .scrubbing
    let replay = self.replay
    self.replay = nil
    lock.unlock()
    replay?.stop()
    renderer.setPaused(true)
    telemetry.mutateTile(tileIndex) { $0.state = .scrubbing }
  }

  /// Shows a proxy still while the finger is down. The still is pushed straight into the same
  /// display layer as live video, so there is no second view to keep in sync.
  public func showScrubStill(_ pixelBuffer: CVPixelBuffer, offsetSeconds: Double) {
    renderer.setPaused(false)
    if renderer.enqueue(pixelBuffer: pixelBuffer, presentationTime: .invalid) {
      telemetry.recordDisplayedFrame(tile: tileIndex)
    }
    renderer.setPaused(true)
    telemetry.mutateTile(tileIndex) {
      $0.state = .scrubbing
      $0.offsetSeconds = offsetSeconds
    }
  }

  public func beginReplay(_ decoder: ReplayDecoder, offsetSeconds: Double) async throws {
    attachReplay(decoder, offsetSeconds: offsetSeconds)
    do {
      try await decoder.start()
    } catch {
      revertToScrubbing()
      throw error
    }
  }

  private func attachReplay(_ decoder: ReplayDecoder, offsetSeconds: Double) {
    lock.lock()
    let previous = replay
    replay = decoder
    state = .replaying
    lock.unlock()
    previous?.stop()

    renderer.setPaused(false)
    renderer.invalidateFormatCache()
    renderer.flush()
    telemetry.recordDecodeSessionChange(delta: 1)
    telemetry.mutateTile(tileIndex) {
      $0.state = .replaying
      $0.offsetSeconds = offsetSeconds
    }
  }

  /// Finger-up replay failed: keep the JPEG the drag already showed rather than snapping to live.
  public func revertToScrubbing() {
    lock.lock()
    let wasReplaying = state == .replaying
    let replay = self.replay
    self.replay = nil
    state = .scrubbing
    lock.unlock()
    replay?.stop()
    if wasReplaying { telemetry.recordDecodeSessionChange(delta: -1) }
    renderer.setPaused(true)
    telemetry.mutateTile(tileIndex) { $0.state = .scrubbing }
  }

  /// Called by the replay decoder for each decoded frame.
  public func deliverReplayFrame(
    _ pixelBuffer: CVPixelBuffer,
    presentationTime: CMTime,
    offsetSeconds: Double
  ) {
    lock.lock()
    let state = self.state
    let programSink = self.programSink
    lock.unlock()
    guard state == .replaying else { return }

    if renderer.enqueue(pixelBuffer: pixelBuffer, presentationTime: presentationTime) {
      telemetry.recordDisplayedFrame(tile: tileIndex)
    }
    // Spec 6.4: the master output carries whatever the program tile is showing, replay
    // included.
    programSink?(pixelBuffer, presentationTime)
    // Only while the tile still reports itself replaying. A frame already in flight when the
    // replay reaches the live edge would otherwise write its offset back over the zero that
    // `returnToLive` just published, leaving a live tile claiming to be fifteen seconds behind.
    telemetry.mutateTile(tileIndex) { tile in
      guard tile.state == .replaying else { return }
      tile.offsetSeconds = offsetSeconds
    }
  }

  public func returnToLive() {
    lock.lock()
    let wasReplaying = state == .replaying
    let replay = self.replay
    self.replay = nil
    state = .live
    lock.unlock()

    replay?.stop()
    if wasReplaying { telemetry.recordDecodeSessionChange(delta: -1) }
    renderer.prepareForLive()
    telemetry.mutateTile(tileIndex) {
      $0.state = .live
      $0.offsetSeconds = 0
    }
  }
}

/// Owns every active source pipeline, the exactly-one-program invariant, and the program
/// output chain.
public final class TileRouter: @unchecked Sendable {
  private let telemetry: PipelineTelemetry
  private let converter: PixelConverter
  private let compositor: MetalCompositor?
  private let programEncoder: ProgramEncoder

  /// Display layer for the programme preview tile, fed the composited frame.
  public let programRenderer = TileRenderer()
  public let audioMixer: AudioMixer

  private let lock = NSLock()
  private var pipelines: [Int: SourcePipeline] = [:]
  private var programTile: Int?

  public init(
    telemetry: PipelineTelemetry,
    converter: PixelConverter,
    compositor: MetalCompositor?,
    programEncoder: ProgramEncoder,
    clock: ProducerClock
  ) {
    self.telemetry = telemetry
    self.converter = converter
    self.compositor = compositor
    self.programEncoder = programEncoder
    self.audioMixer = AudioMixer(clock: clock) { [programEncoder] frame in
      programEncoder.append(audio: frame)
    }
  }

  public var activePipelines: [SourcePipeline] {
    lock.lock()
    defer { lock.unlock() }
    return pipelines.values.sorted { $0.tileIndex < $1.tileIndex }
  }

  public func pipeline(at tileIndex: Int) -> SourcePipeline? {
    lock.lock()
    defer { lock.unlock() }
    return pipelines[tileIndex]
  }

  public func pipeline(for sourceID: SourceID) -> SourcePipeline? {
    lock.lock()
    defer { lock.unlock() }
    return pipelines.values.first { $0.sourceID == sourceID }
  }

  /// Repoints one tile's camera at a new session. Nothing else about the grid changes: the tile
  /// keeps its index, its program status and its archive.
  public func replaceSource(_ replacement: FrameSource, for sourceID: SourceID) throws {
    guard let pipeline = pipeline(for: sourceID) else { return }
    try pipeline.replaceSource(replacement)
  }

  public func add(_ pipeline: SourcePipeline) {
    lock.lock()
    pipelines[pipeline.tileIndex] = pipeline
    lock.unlock()
  }

  public func removeAll() {
    lock.lock()
    let existing = Array(pipelines.values)
    pipelines.removeAll()
    programTile = nil
    lock.unlock()
    for pipeline in existing { pipeline.stop() }
    audioMixer.stop()
    programRenderer.attach(layer: nil)
    telemetry.mutate { $0.programTile = nil }
  }

  /// Stops one tile without touching the others. Opening the camera list must not rebuild the grid.
  public func remove(tileIndex: Int) {
    lock.lock()
    let pipeline = pipelines.removeValue(forKey: tileIndex)
    let wasProgram = programTile == tileIndex
    if wasProgram { programTile = nil }
    let remaining = pipelines.values.sorted { $0.tileIndex < $1.tileIndex }
    lock.unlock()
    pipeline?.stop()
    if remaining.isEmpty {
      audioMixer.stop()
    }
    if wasProgram {
      selectProgram(tileIndex: remaining.first?.tileIndex)
    }
  }

  public var currentProgramTile: Int? {
    lock.lock()
    defer { lock.unlock() }
    return programTile
  }

  /// The exactly-one-program invariant lives here rather than in the view, so it holds even
  /// when program is changed over the control channel.
  public func selectProgram(tileIndex: Int?) {
    lock.lock()
    programTile = tileIndex
    let all = pipelines
    lock.unlock()

    // Audio is no longer tied to whichever tile is on program — it comes from every source the
    // operator ticked, mixed together — so cutting the picture leaves the sound alone.
    for (index, pipeline) in all {
      if index == tileIndex {
        pipeline.setProgramSink { [weak self] buffer, time in
          self?.composeAndEncode(buffer, presentationTime: time)
        }
      } else {
        pipeline.setProgramSink(nil)
      }
    }
    telemetry.mutate { snapshot in
      snapshot.programTile = tileIndex
      for index in snapshot.tiles.indices {
        snapshot.tiles[index].isProgram = snapshot.tiles[index].index == tileIndex
      }
    }
  }

  /// Points the named sources at the programme mix and everything else at nothing.
  public func setAudioContributors(_ ids: Set<SourceID>) {
    lock.lock()
    let all = Array(pipelines.values)
    lock.unlock()

    for pipeline in all {
      let contributes = ids.contains(pipeline.sourceID)
      var sink: (@Sendable (AudioFrame) -> Void)?
      if contributes {
        sink = { [weak self] frame in self?.audioMixer.append(frame) }
      }
      pipeline.setAudioSink(sink)
      telemetry.mutateTile(pipeline.tileIndex) { $0.contributesAudio = contributes }
    }
    audioMixer.retainContributors(ids)
  }

  /// Composites the programme frame and sends it to the preview tile as well as the encoder.
  ///
  /// The compositing happens whether or not anything is recording, which is the point of the
  /// preview: the operator has to be able to see the scorebug sitting over the picture before
  /// committing it to a file, not discover afterwards that it was mispositioned.
  private func composeAndEncode(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
    let composed = compositor?.compose(program: pixelBuffer) ?? pixelBuffer
    programRenderer.enqueue(pixelBuffer: composed, presentationTime: presentationTime)
    guard programEncoder.running else { return }
    programEncoder.append(composed, presentationTime: presentationTime)
  }
}
