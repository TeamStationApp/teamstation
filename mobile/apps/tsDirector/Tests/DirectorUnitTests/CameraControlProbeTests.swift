import Foundation
import DirectorCore
@testable import DirectorRTSP
import DirectorSources
import Network
import Testing

/// A camera is asked directly, on its RTSP port, who it is and whether it takes the parameter verbs.
/// Bonjour is only a way to find it sooner.
@Suite("Camera control probe")
struct CameraControlProbeTests {
  private static let firstBaseUUID = "00000000-0000-4000-8000-000000000001"
  private static let thirdBaseUUID = "00000000-0000-4000-8000-000000000003"
  private static let firstBase = CameraEndpoint(host: "192.0.2.21", port: 8554)
  private static let thirdBase = CameraEndpoint(host: "192.0.2.23", port: 8554)

  // MARK: - Reading the replies

  @Test("A 200 with a UUID is a Cameraman; one without, or any refusal, is not")
  func readsTheIdentityReply() throws {
    let found = try #require(CameraControlProbe.identity(
      statusCode: 200,
      body: "device.cname: \(Self.firstBaseUUID)\r\ndevice.name: First Base\r\n"
    ))
    #expect(found.cname == Self.firstBaseUUID)
    #expect(found.name == "First Base")
    #expect(CameraControlProbe.identity(statusCode: 200, body: "device.cname: \(Self.firstBaseUUID)\r\ndevice.name:\r\n")?.name == nil)
    // An empty 200 is what a camera that treats GET_PARAMETER as a keep-alive sends.
    #expect(CameraControlProbe.identity(statusCode: 200, body: "") == nil)
    #expect(CameraControlProbe.identity(statusCode: 200, body: "device.cname:\r\n") == nil)
    for refusal in [ 405, 451, 501 ] {
      #expect(CameraControlProbe.identity(statusCode: refusal, body: "device.cname: \(Self.firstBaseUUID)") == nil)
    }
  }

  @Test("A camera that predates control.version speaks params/1")
  func readsTheVersionReply() {
    #expect(CameraControlProbe.controlVersion(statusCode: 200, body: "control.version: params/2\r\n") == "params/2")
    #expect(CameraControlProbe.controlVersion(statusCode: 451, body: "control.version\r\nunknown parameter") == "params/1")
    #expect(CameraControlProbe.controlVersion(statusCode: 200, body: "") == "params/1")
    #expect(CameraControlProbe.controlVersion(statusCode: nil, body: nil) == "params/1")
  }

  @Test("Parameter lines are name: value, and anything else is skipped")
  func parsesParameterLines() {
    #expect(CameraControlProbe.parse("a: 1\r\nnot a pair\r\n: orphan\r\nb:  two words \n") == [ "a": "1", "b": "two words" ])
  }

  @Test("Only an answer in the version this client speaks gives controls")
  func controllability() {
    #expect(CameraControlProbeOutcome.controllable(cname: "x", name: nil, controlVersion: "params/1").isControllable)
    #expect(!CameraControlProbeOutcome.controllable(cname: "x", name: nil, controlVersion: "params/2").isControllable)
    #expect(!CameraControlProbeOutcome.plain.isControllable)
    #expect(!CameraControlProbeOutcome.unreachable.isControllable)
  }

  // MARK: - When to ask

  @Test("Each endpoint is asked once, and again only when its answer is due")
  func askingCadence() {
    var probes = CameraControlProbes()
    #expect(probes.begin([ Self.firstBase, Self.firstBase, Self.thirdBase ], now: 0) == [ Self.firstBase, Self.thirdBase ])
    // Already being asked: an overlapping sweep does not ask again.
    #expect(probes.begin([ Self.firstBase ], now: 1).isEmpty)
    probes.finish(Self.firstBase, outcome: .controllable(cname: Self.firstBaseUUID, name: nil, controlVersion: "params/1"), now: 2)
    probes.finish(Self.thirdBase, outcome: .unreachable, now: 2)
    #expect(probes.begin([ Self.firstBase, Self.thirdBase ], now: 3).isEmpty)
    // One that never answered is tried again sooner than an answer is refreshed.
    #expect(probes.begin([ Self.firstBase, Self.thirdBase ], now: 2 + CameraControlProbes.retrySeconds) == [ Self.thirdBase ])
    #expect(probes.begin([ Self.firstBase ], now: 2 + CameraControlProbes.refreshSeconds) == [ Self.firstBase ])
  }

  @Test("A reconnect or a camera that went away forgets its answer")
  func forgetting() {
    var probes = CameraControlProbes()
    _ = probes.begin([ Self.firstBase, Self.thirdBase ], now: 0)
    probes.finish(Self.firstBase, outcome: .plain, now: 0)
    probes.finish(Self.thirdBase, outcome: .plain, now: 0)
    probes.forget(Self.firstBase)
    #expect(probes.begin([ Self.firstBase, Self.thirdBase ], now: 1) == [ Self.firstBase ])
    probes.keepOnly([ Self.firstBase ])
    #expect(probes.outcomes[Self.thirdBase] == nil)
    #expect(probes.entries.count == 0)
  }

  // MARK: - Merging with Bonjour

  @Test("A Cameraman nobody heard advertise becomes its own advertisement")
  func answerWithoutBonjour() throws {
    let merged = CameraControlProbes.merge(
      advertisements: [],
      outcomes: [ Self.firstBase: .controllable(cname: Self.firstBaseUUID, name: "First Base", controlVersion: "params/1") ]
    )
    let advertisement = try #require(merged.first)
    #expect(merged.count == 1)
    #expect(advertisement.isControllable)
    #expect(advertisement.endpoint == Self.firstBase)
    #expect(advertisement.advertisedName == "First Base")
    // The same identity the TXT path gives, so records, names and settings stay matched.
    #expect(advertisement.uniqueID == "uuid:\(Self.firstBaseUUID)")
  }

  @Test("An answer corrects the Bonjour record with its UUID and keeps its live name")
  func answerOverBonjour() throws {
    let heard = CameraAdvertisement(
      host: "192.0.2.21",
      advertisedName: "Renamed On The Phone",
      port: 8554,
      uuid: Self.firstBaseUUID.uppercased()
    )
    let merged = CameraControlProbes.merge(
      advertisements: [ heard ],
      outcomes: [ Self.firstBase: .controllable(cname: Self.firstBaseUUID, name: "First Base", controlVersion: "params/1") ]
    )
    #expect(merged.count == 1)
    #expect(merged.first?.isControllable == true)
    #expect(merged.first?.advertisedName == "Renamed On The Phone")
  }

  @Test("A camera that will not answer loses the control its Bonjour record claimed")
  func refusalOutranksBonjour() {
    let claimedHere = CameraAdvertisement(host: "192.0.2.21", advertisedName: "a", port: 8554, uuid: Self.firstBaseUUID, controlVersion: "params/1")
    let claimedByUUID = CameraAdvertisement(host: "first.example.test", advertisedName: "b", port: 8554, uuid: Self.thirdBaseUUID, controlVersion: "params/1")
    let elsewhere = CameraAdvertisement(host: "192.0.2.99", advertisedName: "c", port: 8554, uuid: "00000000-0000-4000-8000-000000000009", controlVersion: "params/1")
    let merged = CameraControlProbes.merge(
      advertisements: [ claimedHere, claimedByUUID, elsewhere ],
      outcomes: [ Self.firstBase: .plain, Self.thirdBase: .unreachable ],
      claims: [ Self.thirdBase: StreamAdvertisement(cname: Self.thirdBaseUUID) ]
    )
    #expect(merged.map(\.isControllable) == [ false, false, true ])
  }

  @Test("One phone answering at two addresses is one advertisement, ahead of a stale one on its address")
  func oneAdvertisementPerUUID() {
    let stale = CameraAdvertisement(host: "192.0.2.21", advertisedName: "Gone", port: 8554, uuid: Self.thirdBaseUUID)
    let answer = CameraControlProbeOutcome.controllable(cname: Self.firstBaseUUID, name: nil, controlVersion: "params/1")
    let merged = CameraControlProbes.merge(
      advertisements: [ stale ],
      outcomes: [ Self.firstBase: answer, CameraEndpoint(host: "192.0.2.31", port: 8554): answer ]
    )
    #expect(merged.map(\.uuid) == [ Self.firstBaseUUID, Self.thirdBaseUUID ])
    #expect(CameraIdentityRules.pair(endpoints: [ Self.firstBase ], advertisements: merged)[Self.firstBase]?.uuid == Self.firstBaseUUID)
  }

  // MARK: - On the wire

  @Test("A Cameraman that knows control.version answers with it")
  func wireControllable() async throws {
    let camera = try await FakeParameterCamera { body in
      body.contains("control.version")
        ? .reply(200, "control.version: params/1\r\n")
        : .reply(200, "device.cname: \(Self.firstBaseUUID)\r\ndevice.name: First Base\r\n")
    }
    defer { camera.stop() }
    let outcome = await RTSPControlProbe(timeout: 3).probe(camera.endpoint)
    #expect(outcome == .controllable(cname: Self.firstBaseUUID, name: "First Base", controlVersion: "params/1"))
    #expect(camera.requests.count == 2)
    #expect(camera.requests.first?.hasPrefix("GET_PARAMETER rtsp://127.0.0.1:") == true)
  }

  @Test("Today's Cameraman, which refuses control.version with 451, still qualifies")
  func wireTodaysCameraman() async throws {
    let camera = try await FakeParameterCamera { body in
      body.contains("control.version")
        ? .reply(451, "control.version\r\nunknown parameter\r\n")
        : .reply(200, "device.cname: \(Self.firstBaseUUID)\r\ndevice.name: First Base\r\n")
    }
    defer { camera.stop() }
    let outcome = await RTSPControlProbe(timeout: 3).probe(camera.endpoint)
    #expect(outcome == .controllable(cname: Self.firstBaseUUID, name: "First Base", controlVersion: "params/1"))
  }

  @Test("A refusal, or a 200 without a UUID, is a plain RTSP camera", arguments: [ 405, 451, 501, 200 ])
  func wirePlain(status: Int) async throws {
    let camera = try await FakeParameterCamera { _ in .reply(status, "") }
    defer { camera.stop() }
    #expect(await RTSPControlProbe(timeout: 3).probe(camera.endpoint) == .plain)
    #expect(camera.requests.count == 1)
  }

  @Test("A camera that never answers is unreachable once the timeout runs out")
  func wireTimeout() async throws {
    let camera = try await FakeParameterCamera { _ in .silent }
    defer { camera.stop() }
    let started = ContinuousClock.now
    #expect(await RTSPControlProbe(timeout: 0.5).probe(camera.endpoint) == .unreachable)
    #expect(ContinuousClock.now - started < .seconds(3))
  }

  @Test("A refused connection is unreachable without waiting out the timeout")
  func wireRefused() async throws {
    let camera = try await FakeParameterCamera { _ in .silent }
    let endpoint = camera.endpoint
    camera.stop()
    try? await Task.sleep(for: .milliseconds(100))
    let started = ContinuousClock.now
    #expect(await RTSPControlProbe(timeout: 5).probe(endpoint) == .unreachable)
    #expect(ContinuousClock.now - started < .seconds(4))
    #expect(await RTSPControlProbe().probe(CameraEndpoint(host: "127.0.0.1", port: 0)) == .unreachable)
  }

  @Test("A camera that said who it is and then hung up is still that Cameraman")
  func wireHangUpAfterIdentity() async throws {
    let camera = try await FakeParameterCamera { body in
      body.contains("control.version")
        ? .close
        : .reply(200, "device.cname: \(Self.firstBaseUUID)\r\n")
    }
    defer { camera.stop() }
    #expect(await RTSPControlProbe(timeout: 3).probe(camera.endpoint) == .controllable(
      cname: Self.firstBaseUUID,
      name: nil,
      controlVersion: "params/1"
    ))
  }

  // MARK: - Discovery

  private func discovery(
    hosts: [String],
    advertisements: [CameraAdvertisement] = [],
    clock: DirectorClock = TestClock(),
    resolveIdentity: RTSPDiscovery.IdentityResolver? = nil,
    claims: [String: StreamAdvertisement] = [:],
    probe: @escaping RTSPDiscovery.ControlProbe
  ) -> RTSPDiscovery {
    RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(manualHosts: hosts, isScanEnabled: false),
      clock: clock,
      resolveIdentity: resolveIdentity,
      advertisementBrowser: StaticAdvertisementBrowser(advertisements),
      confirmHost: { claims[$0.host] ?? StreamAdvertisement() },
      probeControl: probe
    )
  }

  @Test("A swept Cameraman with no Bonjour gets its controls and its identity from the probe")
  func sweptCameramanIsControllable() async throws {
    let asked = ProbeLog()
    let seen = AdvertisementLog()
    let discovery = discovery(
      hosts: [ "192.0.2.21:8554" ],
      resolveIdentity: { _, ads, _ in
        seen.record(ads)
        return [:]
      }
    ) { endpoint in
      asked.record(endpoint)
      return .controllable(cname: Self.firstBaseUUID, name: "First Base", controlVersion: "params/1")
    }

    await discovery.sweepNow()

    #expect(asked.endpoints == [ Self.firstBase ])
    #expect(discovery.advertisements.first?.isControllable == true)
    #expect(seen.last.map { $0.compactMap(\.uniqueID) } == [ "uuid:\(Self.firstBaseUUID)" ])
    #expect(discovery.currentSources.first?.advertisedName == "First Base")
    #expect(discovery.diagnostic.contains("asked=1 control=1"))
  }

  @Test("Its answer is kept, and asked for again after the refresh or on reconnect")
  func probeIsCachedPerEndpoint() async {
    let asked = ProbeLog()
    let clock = TestClock()
    let answer = CameraControlProbeOutcome.controllable(cname: Self.firstBaseUUID, name: nil, controlVersion: "params/1")
    let discovery = discovery(hosts: [ "192.0.2.21:8554" ], clock: clock) { endpoint in
      asked.record(endpoint)
      return answer
    }

    await discovery.sweepNow()
    await discovery.sweepNow()
    #expect(asked.endpoints.count == 1)

    clock.advance(by: CameraControlProbes.refreshSeconds)
    await discovery.sweepNow()
    #expect(asked.endpoints.count == 2)

    await discovery.reprobe(Self.firstBase)
    #expect(asked.endpoints.count == 3)

  }

  @Test("A camera at a new address is asked there, and its old address's answer is dropped")
  func newAddressIsAsked() async {
    let asked = ProbeLog()
    let moved = CameraEndpoint(host: "192.0.2.31", port: 8554)
    let browser = StaticAdvertisementBrowser([
      CameraAdvertisement(host: "192.0.2.21", advertisedName: "First Base", port: 8554, uuid: Self.firstBaseUUID)
    ])
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(isScanEnabled: false),
      clock: TestClock(),
      advertisementBrowser: browser,
      confirmHost: { _ in StreamAdvertisement() },
      probeControl: { endpoint in
        asked.record(endpoint)
        return .controllable(cname: Self.firstBaseUUID, name: nil, controlVersion: "params/1")
      }
    )
    await discovery.sweepNow()
    browser.advertisements = [
      CameraAdvertisement(host: "192.0.2.31", advertisedName: "First Base", port: 8554, uuid: Self.firstBaseUUID)
    ]
    await discovery.sweepNow()
    #expect(asked.endpoints == [ Self.firstBase, moved ])
    #expect(Array(discovery.controlProbeOutcomes.keys) == [ moved ])
  }

  @Test("A camera that did not answer has no controls and is asked again after the retry")
  func unreachableIsRetried() async {
    let asked = ProbeLog()
    let clock = TestClock()
    let heard = CameraAdvertisement(host: "192.0.2.21", advertisedName: "First Base", port: 8554, uuid: Self.firstBaseUUID, controlVersion: "params/1")
    let discovery = discovery(hosts: [], advertisements: [ heard ], clock: clock) { endpoint in
      asked.record(endpoint)
      return .unreachable
    }

    // Before the probe answers, Bonjour's word is used.
    #expect(discovery.advertisements.first?.isControllable == true)
    await discovery.sweepNow()
    #expect(discovery.advertisements.first?.isControllable == false)
    #expect(discovery.controlProbeOutcomes[Self.firstBase] == .unreachable)

    await discovery.sweepNow()
    #expect(asked.endpoints.count == 1)
    clock.advance(by: CameraControlProbes.retrySeconds)
    await discovery.sweepNow()
    #expect(asked.endpoints.count == 2)
  }

  @Test("A camera that answers no loses the control its Bonjour record claims")
  func plainOverridesBonjour() async {
    let heard = CameraAdvertisement(host: "192.0.2.21", advertisedName: "First Base", port: 8554, uuid: Self.firstBaseUUID, controlVersion: "params/1")
    let discovery = discovery(hosts: [], advertisements: [ heard ]) { _ in .plain }
    await discovery.sweepNow()
    #expect(discovery.advertisements.map(\.isControllable) == [ false ])
    #expect(discovery.diagnostic.contains("asked=1 control=0"))
  }

  @Test("A camera that went away is asked again when it comes back")
  func goneCameraIsForgotten() async {
    let asked = ProbeLog()
    let present = Flag(true)
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(manualHosts: [ "192.0.2.21:8554" ], isScanEnabled: false),
      clock: TestClock(),
      confirmHost: { _ in present.value ? StreamAdvertisement() : nil },
      probeControl: { endpoint in
        asked.record(endpoint)
        return .plain
      }
    )
    await discovery.sweepNow()
    present.value = false
    await discovery.sweepNow()
    #expect(discovery.controlProbeOutcomes.isEmpty)
    present.value = true
    await discovery.sweepNow()
    #expect(asked.endpoints.count == 2)
  }

  // MARK: - Identity

  private func registry() -> CameraRegistry {
    let suite = "app.teamstation.director.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return CameraRegistry(store: CameraRecordStore(store: ConfigStore(defaults: defaults)))
  }

  @Test("A camera already known by its CNAME gains the TXT-form hardware id and stays one camera")
  func cnameRecordGainsHardwareID() async throws {
    let cameras = registry()
    // Found by the sweep before this change: known by the CNAME its stream presented.
    _ = cameras.resolve(
      endpoints: [ Self.firstBase ],
      streamAdvertisements: [ Self.firstBase: StreamAdvertisement(cname: Self.firstBaseUUID, name: "First Base") ]
    )
    let before = try #require(cameras.records.first)
    #expect(before.hardwareID == nil)

    let discovery = discovery(
      hosts: [ "192.0.2.21:8554" ],
      resolveIdentity: { cameras.resolve(endpoints: $0, advertisements: $1, streamAdvertisements: $2) },
      claims: [ "192.0.2.21": StreamAdvertisement(cname: Self.firstBaseUUID, name: "First Base") ]
    ) { _ in .controllable(cname: Self.firstBaseUUID, name: "First Base", controlVersion: "params/1") }
    await discovery.sweepNow()

    #expect(cameras.records.count == 1)
    #expect(cameras.records.first?.id == before.id)
    #expect(cameras.records.first?.hardwareID == "uuid:\(Self.firstBaseUUID)")
    #expect(discovery.currentSources.first?.id == SourceID(before.id.uuidString))
  }

  @Test("A camera first named through Bonjour is matched, not duplicated, when only the probe hears it")
  func bonjourRecordIsMatchedByTheProbe() async throws {
    let cameras = registry()
    let heard = CameraAdvertisement(host: "192.0.2.21", advertisedName: "First Base", port: 8554, uuid: Self.firstBaseUUID, controlVersion: "params/1")
    _ = cameras.resolve(endpoints: [ Self.firstBase ], advertisements: [ heard ])
    let before = try #require(cameras.records.first)
    #expect(before.hardwareID == "uuid:\(Self.firstBaseUUID)")

    // Later, Bonjour never arrives and the phone has a new lease.
    let discovery = discovery(
      hosts: [ "192.0.2.41:8554" ],
      resolveIdentity: { cameras.resolve(endpoints: $0, advertisements: $1, streamAdvertisements: $2) }
    ) { _ in .controllable(cname: Self.firstBaseUUID, name: "First Base", controlVersion: "params/1") }
    await discovery.sweepNow()

    #expect(cameras.records.count == 1)
    #expect(discovery.currentSources.first?.id == SourceID(before.id.uuidString))
  }

  // MARK: - Reconnect

  @Test("A stream that plays again after playing once reports a reconnect")
  func reconnectIsReported() {
    let reconnects = Counter()
    let source = RTSPFrameSource(
      sourceID: SourceID("camera"),
      displayName: "camera",
      configuration: RTSPSession.Configuration(host: "127.0.0.1", port: 9),
      onReconnected: { reconnects.increment() }
    )
    let description = SourceSoundTimelineTests.sdp(cname: Self.firstBaseUUID)
    source.handle(.playing(description: description, channels: .init(video: 0, audio: 2)))
    #expect(reconnects.value == 0)
    source.handle(.playing(description: description, channels: .init(video: 0, audio: 2)))
    #expect(reconnects.value == 1)
  }
}

// MARK: - Doubles

private final class ProbeLog: @unchecked Sendable {
  private let lock = NSLock()
  private var asked: [CameraEndpoint] = []

  func record(_ endpoint: CameraEndpoint) { lock.withLock { asked.append(endpoint) } }
  var endpoints: [CameraEndpoint] { lock.withLock { asked } }
}

private final class AdvertisementLog: @unchecked Sendable {
  private let lock = NSLock()
  private var seen: [[CameraAdvertisement]] = []

  func record(_ ads: [CameraAdvertisement]) { lock.withLock { seen.append(ads) } }
  var last: [CameraAdvertisement]? { lock.withLock { seen.last } }
}

private final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Bool

  init(_ value: Bool) { stored = value }

  var value: Bool {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }
}

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0

  func increment() { lock.withLock { count += 1 } }
  var value: Int { lock.withLock { count } }

  /// True the first time only.
  func claim() -> Bool {
    lock.withLock {
      count += 1
      return count == 1
    }
  }
}

/// A Cameraman's RTSP port on loopback that answers each `GET_PARAMETER` as a test scripts it.
private final class FakeParameterCamera: @unchecked Sendable {
  enum Answer: Sendable {
    case reply(Int, String)
    case silent
    case close
  }

  private let listener: NWListener
  private let queue = DispatchQueue(label: "test.fake-parameter-camera")
  private let answer: @Sendable (String) -> Answer
  private let lock = NSLock()
  private var received: [String] = []
  private(set) var port: UInt16 = 0

  init(answer: @escaping @Sendable (String) -> Answer) async throws {
    self.answer = answer
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
    port = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, any Error>) in
      let once = Counter()
      listener.stateUpdateHandler = { [listener] state in
        switch state {
        case .ready:
          if once.claim() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
        case let .failed(error):
          if once.claim() { continuation.resume(throwing: error) }
        default:
          break
        }
      }
      listener.start(queue: queue)
    }
  }

  var endpoint: CameraEndpoint { CameraEndpoint(host: "127.0.0.1", port: Int(port)) }
  var requests: [String] { lock.withLock { received } }

  func stop() { listener.cancel() }

  private func serve(_ connection: NWConnection) {
    connection.start(queue: queue)
    read(connection, buffer: Data())
  }

  private func read(_ connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buffer = buffer
      if let data { buffer.append(data) }
      while let (request, body, cseq, consumed) = Self.nextRequest(in: buffer) {
        buffer.removeFirst(consumed)
        lock.withLock { received.append(request) }
        switch answer(body) {
        case let .reply(status, text):
          var reply = "RTSP/1.0 \(status) Status\r\nCSeq: \(cseq)\r\n"
          if !text.isEmpty {
            reply += "Content-Type: text/parameters\r\nContent-Length: \(text.utf8.count)\r\n"
          }
          reply += "\r\n\(text)"
          connection.send(content: Data(reply.utf8), completion: .contentProcessed { _ in })
        case .silent:
          break
        case .close:
          connection.cancel()
          return
        }
      }
      if error != nil || isComplete { return }
      read(connection, buffer: buffer)
    }
  }

  /// The first whole request in `buffer`: its text, its body, its CSeq, and how many bytes it took.
  private static func nextRequest(in buffer: Data) -> (String, String, String, Int)? {
    guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
    let head = String(decoding: buffer[buffer.startIndex ..< end.lowerBound], as: UTF8.self)
    var length = 0
    var cseq = "0"
    for line in head.components(separatedBy: "\r\n") {
      let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      guard parts.count == 2 else { continue }
      if parts[0].lowercased() == "content-length" { length = Int(parts[1]) ?? 0 }
      if parts[0].lowercased() == "cseq" { cseq = parts[1] }
    }
    let bodyStart = end.upperBound
    guard buffer.distance(from: bodyStart, to: buffer.endIndex) >= length else { return nil }
    let bodyEnd = buffer.index(bodyStart, offsetBy: length)
    let body = String(decoding: buffer[bodyStart ..< bodyEnd], as: UTF8.self)
    return (head, body, cseq, buffer.distance(from: buffer.startIndex, to: bodyEnd))
  }
}
