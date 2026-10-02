import DirectorCore
import DirectorDVR
import DirectorExport
import DirectorLink
import DirectorPipeline
import DirectorSources
import DirectorTestHarness
import DistributorWire
import Foundation
import LoopbackHTTP
import Testing

@testable import DirectorUI

/// A TS Director behind the link that is recording or streaming, so every export it is asked for
/// is refused.
private actor BusyDirector: DistributorBackend {
  let refusal: DistributorRefusal

  init(_ refusal: DistributorRefusal) {
    self.refusal = refusal
  }

  func identity() async -> DirectorIdentity {
    DirectorIdentity(deviceName: "iPad", directorVersion: "1.0 (1)", directorID: UUID(), isRecording: true)
  }

  func recordings() async throws -> [RecordingListing] { [] }
  func deleteRecordings(_ ids: [Int64]) async throws -> [Int64] { ids }
  func manifest(recordingID: Int64, tracks: [Track]) async throws -> ManifestResponse? { nil }
  func startJob(_ request: JobRequest, id: UUID, events: EventHub) async throws { throw refusal }
  func cancelJob(_ id: UUID) async {}
  func beginExport() async throws -> UUID { throw refusal }
  func endExport(_ id: UUID) async {}
}

/// The names TS Director goes by: its keys and queues under `app.teamstation.director`, and
/// `TS Director` wherever it introduces itself to something else.
@Suite("TS Director's names")
struct TeamStationNamesTests {
  private static func service(_ refusal: DistributorRefusal, in base: URL) -> DistributorService {
    DistributorService(
      backend: BusyDirector(refusal),
      roots: FileRoots(
        archives: base.appendingPathComponent("Archives", isDirectory: true),
        program: base.appendingPathComponent("Program", isDirectory: true),
        prepared: base.appendingPathComponent("Prepared", isDirectory: true)
      ),
      settings: DistributorSettingsStore(url: base.appendingPathComponent("settings.json"))
    )
  }

  @Test("TS Distributor is told TS Director is recording or streaming when it asks to export")
  func exportRefusals() async throws {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("ts-names-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: base) }
    let lock = HTTPRequest(method: "POST", path: "/v1/export-lock")

    #expect(Self.refusal(await Self.service(.recording, in: base).handle(lock))?.contains("TS Director is recording") == true)
    #expect(Self.refusal(await Self.service(.streaming, in: base).handle(lock))?.contains("TS Director is streaming") == true)
  }

  /// The body of a 409, or nil for anything else.
  private static func refusal(_ response: HTTPResponse) -> String? {
    guard case let .data(status, _, body) = response, status == 409 else { return nil }
    return String(decoding: body, as: UTF8.self)
  }

  @Test("This install's id is kept under app.teamstation.director and is the same every time")
  func installID() {
    let id = DistributorLinkBackend.installID
    #expect(DistributorLinkBackend.installID == id)
    #expect(UserDefaults.standard.string(forKey: "app.teamstation.director.installID") == id.uuidString)
  }

  @Test("A camera that is not there has no frame rate to give TS Director")
  func frameRateFromNowhere() async {
    // Port 9 on loopback: nothing listens, so the connection is refused at once.
    #expect(await CameraFrameRateQuery.frameRate(host: "127.0.0.1", port: 9, path: "/live/mainstream") == nil)
  }

  @Test("The telemetry poller and the test control server can be made and left unstarted")
  @MainActor
  func unstartedHelpers() {
    let poller = CameraTelemetryPoller(endpoint: CameraEndpoint(host: "127.0.0.1", port: 9)) { _ in }
    #expect(poller.endpoint.port == 9)
    let server = ControlServer(port: 0) { _ in nil }
    #expect(server.port == 0)
  }

  @Test("A camera's proxy store files its stills under the camera")
  func proxyStore() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("ts-proxy-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ProxyStore(
      sourceID: SourceID("cam-1"),
      sourceIndex: 0,
      index: try ArchiveIndex(url: root.appendingPathComponent("index.sqlite")),
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      clock: FixedClock(1_800_000_000),
      directory: root.appendingPathComponent("proxy", isDirectory: true)
    )
    #expect(store.capturedStills == 0)
  }
}
