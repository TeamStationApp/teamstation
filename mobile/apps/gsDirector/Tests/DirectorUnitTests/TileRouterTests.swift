import AVFoundation
import CoreMedia
import CoreVideo
import DirectorCore
import DirectorPipeline
import DirectorSources
import Testing

@Suite("Tile router program highlight")
struct TileRouterTests {
  @Test("Removing the on-air camera leaves exactly one Output highlight")
  func removeProgramTileClearsTheOldHighlight() throws {
    let (router, telemetry) = makeRouter()
    router.add(pipeline(index: 0, telemetry: telemetry))
    router.add(pipeline(index: 1, telemetry: telemetry))
    router.selectProgram(sourceIndex: 0)

    #expect(onAir(in: telemetry) == [0])

    router.remove(sourceIndex: 0)
    let snapshot = telemetry.snapshot
    #expect(snapshot.programSource == 1)
    #expect(snapshot.tiles.first { $0.index == 0 }?.isProgram == false)
    #expect(snapshot.tiles.first { $0.index == 1 }?.isProgram == true)
    #expect(onAir(in: telemetry) == [1])
  }

  @Test("Removing a middle on-air camera with three live tiles highlights one survivor")
  func removeMiddleProgramTile() {
    let (router, telemetry) = makeRouter()
    router.add(pipeline(index: 0, telemetry: telemetry))
    router.add(pipeline(index: 1, telemetry: telemetry))
    router.add(pipeline(index: 2, telemetry: telemetry))
    router.selectProgram(sourceIndex: 1)

    #expect(onAir(in: telemetry) == [1])

    router.remove(sourceIndex: 1)
    let snapshot = telemetry.snapshot
    #expect(snapshot.programSource == 0)
    #expect(snapshot.tiles.first { $0.index == 1 }?.isProgram == false)
    #expect(onAir(in: telemetry) == [0])
    #expect(snapshot.tiles.filter(\.isProgram).count == 1)
  }

  @Test("Reassigning two live sources swaps pipelines and Output follows the slot")
  func reassignSwapsPipelinesAndProgram() {
    let (router, telemetry) = makeRouter()
    router.add(pipeline(index: 0, telemetry: telemetry))
    router.add(pipeline(index: 1, telemetry: telemetry))
    router.selectProgram(sourceIndex: 0)
    router.reassign(from: 0, to: 1)

    #expect(router.pipeline(at: 0)?.sourceID.rawValue == "cam-1")
    #expect(router.pipeline(at: 1)?.sourceID.rawValue == "cam-0")
    #expect(router.currentProgramSource == 1)
    #expect(onAir(in: telemetry) == [1])
  }

  @Test("Selecting Output before the pipeline exists still attaches the sink on add")
  func selectProgramBeforeAddAttachesSink() {
    let (router, telemetry) = makeRouter()
    router.selectProgram(sourceIndex: 0)
    let pipe = pipeline(index: 0, telemetry: telemetry)
    #expect(pipe.hasProgramSink == false)
    router.add(pipe)
    #expect(pipe.hasProgramSink)
    #expect(router.currentProgramSource == 0)
    #expect(onAir(in: telemetry) == [0])
  }

  @Test("Clearing every camera keeps Output attached so the next cut can paint")
  func removeAllKeepsProgramDisplayLayer() throws {
    let (router, telemetry) = makeRouter()
    let layer = AVSampleBufferDisplayLayer()
    router.programRenderer.attach(layer: layer)
    router.add(pipeline(index: 0, telemetry: telemetry))
    router.removeAll()

    let factory = try #require(
      PixelBufferFactory(width: 64, height: 64, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let buffer = try #require(factory.makeBuffer())
    #expect(router.programRenderer.enqueue(pixelBuffer: buffer, presentationTime: .zero))
  }

  @Test("Programme frames still enqueue when only the Picture-in-Picture layer is attached")
  func enqueueToPictureInPictureWithoutOutputTile() throws {
    let (router, _) = makeRouter()
    let layer = AVSampleBufferDisplayLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 128, height: 72)
    router.programRenderer.attachPictureInPicture(layer)
    let factory = try #require(
      PixelBufferFactory(width: 64, height: 64, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let buffer = try #require(factory.makeBuffer())
    #expect(router.programRenderer.enqueue(pixelBuffer: buffer, presentationTime: .zero))
  }

  @Test("A replay frame that races Return to Live cannot leave the tile marked as replaying")
  func lateReplayFrameDoesNotReviveReplay() async throws {
    let (router, telemetry) = makeRouter()
    let pipe = pipeline(index: 0, telemetry: telemetry)
    router.add(pipe)
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("replay-race-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("seg-0.mp4")
    try await writeTestMovie(to: url, seconds: 0.6, framesPerSecond: 10)
    let decoder = ReplayDecoder(
      configuration: .init(
        url: url,
        startOffset: 0,
        frameRate: 10,
        port: 19_002,
        rate: 1,
        playDuration: nil,
        fileURLs: [url],
        fileDurations: [0.6]
      ),
      onFrame: { _, _, _ in }
    )
    defer { decoder.stop() }
    try await pipe.beginReplay(decoder, offsetSeconds: -1.5)
    #expect(telemetry.snapshot.tiles.first { $0.index == 0 }?.state == .replaying)

    // The programme sink runs after the frame has been checked and before its telemetry is written,
    // which is exactly where a Return to Live from the operator or the control channel can land.
    pipe.setProgramSink { [pipe] _, _, _ in pipe.returnToLive() }
    let factory = try #require(
      PixelBufferFactory(width: 64, height: 64, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let buffer = try #require(factory.makeBuffer())
    pipe.deliverReplayFrame(buffer, presentationTime: .zero, offsetSeconds: -1.5)

    let tile = telemetry.snapshot.tiles.first { $0.index == 0 }
    #expect(tile?.state == .live)
    #expect(tile?.offsetSeconds == 0)
  }

  private func makeRouter() -> (TileRouter, PipelineTelemetry) {
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let encoder = ProgramEncoder(telemetry: telemetry, converter: converter, config: .default)
    let streamer = ProgramStreamer(telemetry: telemetry, converter: converter)
    let router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: nil,
      programEncoder: encoder,
      programStreamer: streamer,
      clock: clock
    )
    return (router, telemetry)
  }

  private func pipeline(index: Int, telemetry: PipelineTelemetry) -> SourcePipeline {
    SourcePipeline(
      sourceID: SourceID("cam-\(index)"),
      sourceIndex: index,
      source: DummyFrameSource(id: "cam-\(index)", name: "CAM\(index + 1)"),
      converter: PixelConverter(),
      telemetry: telemetry
    )
  }

  private func onAir(in telemetry: PipelineTelemetry) -> [Int] {
    telemetry.snapshot.tiles.filter(\.isProgram).map(\.index)
  }
}

private final class DummyFrameSource: FrameSource, @unchecked Sendable {
  let sourceID: SourceID
  let displayName: String
  private(set) var isRunning = false
  var format: SourceFormat? { nil }

  init(id: String, name: String) {
    sourceID = SourceID(id)
    displayName = name
  }

  func start(sinks: FrameSinks) throws {
    isRunning = true
  }

  func stop() {
    isRunning = false
  }
}
