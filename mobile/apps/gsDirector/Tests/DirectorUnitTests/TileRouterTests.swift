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
    router.selectProgram(tileIndex: 0)

    #expect(onAir(in: telemetry) == [0])

    router.remove(tileIndex: 0)
    let snapshot = telemetry.snapshot
    #expect(snapshot.programTile == 1)
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
    router.selectProgram(tileIndex: 1)

    #expect(onAir(in: telemetry) == [1])

    router.remove(tileIndex: 1)
    let snapshot = telemetry.snapshot
    #expect(snapshot.programTile == 0)
    #expect(snapshot.tiles.first { $0.index == 1 }?.isProgram == false)
    #expect(onAir(in: telemetry) == [0])
    #expect(snapshot.tiles.filter(\.isProgram).count == 1)
  }

  private func makeRouter() -> (TileRouter, PipelineTelemetry) {
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let encoder = ProgramEncoder(telemetry: telemetry, converter: converter, config: .default)
    let router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: nil,
      programEncoder: encoder,
      clock: clock
    )
    return (router, telemetry)
  }

  private func pipeline(index: Int, telemetry: PipelineTelemetry) -> SourcePipeline {
    SourcePipeline(
      sourceID: SourceID("cam-\(index)"),
      tileIndex: index,
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
