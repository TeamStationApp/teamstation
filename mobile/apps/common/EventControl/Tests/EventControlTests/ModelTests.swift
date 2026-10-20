import Foundation
import Testing

@testable import EventControl

@Suite("Bytes, credentials, identities and assignments")
struct ModelTests {
  @Test func hexAndIntegersRoundTrip() {
    let bytes = Data([ 0x00, 0x7F, 0x80, 0xFF, 0xAB ])
    #expect(EventControlBytes.hex(bytes) == "007f80ffab")
    #expect(EventControlBytes.data(hex: "007F80ffAB") == bytes)
    #expect(EventControlBytes.data(hex: "abc") == nil)
    #expect(EventControlBytes.data(hex: "zz") == nil)
    #expect(EventControlBytes.u64(0x0102_0304_0506_0708) == Data([ 1, 2, 3, 4, 5, 6, 7, 8 ]))
    #expect(EventControlBytes.readU64(Data([ 1, 2, 3, 4, 5, 6, 7, 8 ])) == 0x0102_0304_0506_0708)
    #expect(EventControlBytes.lengthPrefixed([ Data("ab".utf8), Data([ 1 ]) ]) == Data([ 0, 2, 97, 98, 0, 1, 1 ]))
    #expect(EventControlBytes.constantTimeEqual(bytes, bytes))
    #expect(!EventControlBytes.constantTimeEqual(bytes, Data([ 0 ])))
    #expect(!EventControlBytes.constantTimeEqual(bytes, Data([ 0x00, 0x7F, 0x80, 0xFF, 0xAC ])))
    #expect(EventControlBytes.random(16).count == 16)
    #expect(EventControlBytes.random(16) != EventControlBytes.random(16))
  }

  @Test func credentialsRefuseEveryMalformedField() {
    let good = Fixtures.one
    func make(
      issuer: String? = nil, userId: String? = nil, tag: String? = nil, keyId: String? = nil,
      key: String? = nil
    ) throws(EventControlCredentials.Problem) {
      _ = try EventControlCredentials(
        issuer: issuer ?? good.scope.issuer,
        userId: userId ?? good.scope.userId,
        accountTag: tag ?? good.scope.accountTag,
        keyId: keyId ?? good.keyId,
        key: key ?? EventControlBytes.hex(good.keyBytes)
      )
    }
    #expect(throws: EventControlCredentials.Problem.badIssuer) { try make(issuer: "") }
    #expect(throws: EventControlCredentials.Problem.badUserId) { try make(userId: "12a") }
    #expect(throws: EventControlCredentials.Problem.badUserId) { try make(userId: "") }
    #expect(throws: EventControlCredentials.Problem.badAccountTag) { try make(tag: "AB") }
    #expect(throws: EventControlCredentials.Problem.badAccountTag) {
      try make(tag: good.scope.accountTag.uppercased())
    }
    #expect(throws: EventControlCredentials.Problem.badKeyId) { try make(keyId: "00") }
    #expect(throws: EventControlCredentials.Problem.badKey) { try make(key: "00") }
    #expect(throws: Never.self) { try make() }
  }

  @Test func credentialsDecodeCanonicalUserIdAndRefuseLegacyVersion() throws {
    let json = """
    {"version":2,"issuer":"https://app.example.test","userId":"\(Fixtures.one.scope.userId)",
     "accountTag":"\(Fixtures.one.scope.accountTag)","keyId":"\(Fixtures.one.keyId)",
     "key":"\(EventControlBytes.hex(Fixtures.one.keyBytes))"}
    """
    let decoded = try EventControlCredentials.decode(serverReply: Data(json.utf8))
    #expect(decoded == Fixtures.one)
    #expect(throws: EventControlCredentials.Problem.unsupportedVersion) {
      try EventControlCredentials.decode(
        serverReply: Data(json.replacingOccurrences(of: "\"version\":2", with: "\"version\":1").utf8)
      )
    }
    // Encoding writes the server's shape back, and reads it again.
    let encoded = try JSONEncoder().encode(Fixtures.one)
    #expect(try EventControlCredentials.decode(serverReply: encoded) == Fixtures.one)
  }

  @Test func descriptionsNeverCarryTheKey() {
    let key = EventControlBytes.hex(Fixtures.one.keyBytes)
    #expect(!Fixtures.one.description.contains(key))
    #expect(!Fixtures.one.debugDescription.contains(key))
    #expect(!"\(Fixtures.one)".contains(key))
    #expect(Fixtures.one.description.contains("<redacted>"))
  }

  @Test func canonicalOrigins() {
    func origin(_ text: String) -> String? {
      EventControlCredentials.canonicalOrigin(of: URL(string: text)!)
    }
    #expect(origin("https://App.Example.Test/") == "https://app.example.test")
    #expect(origin("https://app.example.test:443/api/v1") == "https://app.example.test")
    #expect(origin("http://192.0.2.4:80") == "http://192.0.2.4")
    #expect(origin("http://127.0.0.1:9100") == "http://127.0.0.1:9100")
    #expect(origin("http://[::1]:9100")?.hasSuffix(":9100") == true)
    #expect(origin("file:///tmp") == nil)
  }

  @Test func instanceIdsAreSixteenRandomBytesKeptOnce() throws {
    #expect(EventControlInstanceID(bytes: Data(count: 15)) == nil)
    #expect(EventControlInstanceID(hex: "zz") == nil)
    let made = EventControlInstanceID.random()
    #expect(made.bytes.count == 16)
    #expect(made.description == made.hex)
    #expect(made != EventControlInstanceID.random())
    let defaults = UserDefaults(suiteName: "eventcontrol.tests.\(UUID().uuidString)")!
    let first = EventControlInstanceID.persisted(in: defaults, key: "instance")
    #expect(EventControlInstanceID.persisted(in: defaults, key: "instance") == first)
    defaults.set("not hex", forKey: "broken")
    #expect(EventControlInstanceID.persisted(in: defaults, key: "broken").bytes.count == 16)
    let round = try JSONDecoder().decode(
      [EventControlInstanceID].self,
      from: JSONEncoder().encode([ first ])
    )
    #expect(round == [ first ])
    #expect(throws: DecodingError.self) {
      try JSONDecoder().decode([EventControlInstanceID].self, from: Data(#"["00"]"#.utf8))
    }
  }

  @Test func assignmentFromASelectedEvent() throws {
    let start = Date(timeIntervalSince1970: 1_790_013_600.75)
    let made = try #require(EventAssignment.from(gameId: " gam_demoA ", title: "Visitors at Pioneers", startAt: start))
    #expect(made.gameId == "gam_demoA")
    #expect(made.title == "Visitors at Pioneers")
    #expect(made.startAt == "2026-09-21T18:00:00Z")
    #expect(made.startDate == Date(timeIntervalSince1970: 1_790_013_600))
    #expect(EventAssignment.from(gameId: nil, title: "T", startAt: start) == nil)
    #expect(EventAssignment.from(gameId: "g", title: nil, startAt: start) == nil)
    #expect(EventAssignment.from(gameId: "g", title: "T", startAt: nil) == nil)
    #expect(EventAssignment.from(gameId: "", title: "T", startAt: start) == nil)
    #expect(EventAssignment.from(gameId: String(repeating: "g", count: 129), title: "T", startAt: start) == nil)
    // Years before 1000 keep four digits.
    #expect(EventAssignment.format(Date(timeIntervalSince1970: -30_000_000_000)).count == 20)
  }

  @Test func assignmentsPersistAsStrictlyAsTheyAreReceived() throws {
    let encoded = try JSONEncoder().encode(Fixtures.assignmentA)
    #expect(try JSONDecoder().decode(EventAssignment.self, from: encoded) == Fixtures.assignmentA)
    let bad = Data(#"{"gameId":" g","title":"T","startAt":"2026-09-21T18:00:00Z"}"#.utf8)
    #expect(throws: EventAssignment.Problem.untrimmedGameId) {
      try JSONDecoder().decode(EventAssignment.self, from: bad)
    }
  }

  @Test func revisionsOnlyGoUp() {
    var counter = EventControlRevisionCounter()
    let first = counter.next(now: Date(timeIntervalSince1970: 1_790_013_600))
    #expect(first == 1_790_013_600_000)
    #expect(counter.next(now: Date(timeIntervalSince1970: 1_790_013_600)) == first + 1)
    #expect(counter.next(now: Date(timeIntervalSince1970: 100)) == first + 2)
    #expect(counter.next(now: Date(timeIntervalSince1970: 1_790_013_601)) == 1_790_013_601_000)
    var relaunched = EventControlRevisionCounter(last: 5)
    #expect(relaunched.next(now: Date(timeIntervalSince1970: -1)) == 6)
    #expect(relaunched.last == 6)
  }

  @Test func endpointsAndBodiesDescribeThemselves() {
    #expect(EventControlEndpoint(host: "192.0.2.4", port: 47614).description == "192.0.2.4:47614")
    #expect(EventControlEndpoint(host: "fe80::1", port: 47615).description == "[fe80::1]:47615")
    #expect(EventControlMessageType.allCases.filter(\.isFromDirector) == [ .discover, .assign, .renew, .release ])
    let bodies: [EventControlBody] = [
      .discover, .announce(consent: true, lease: .free, leaseRevision: 0),
      .assign(Fixtures.assignmentA, revision: 1), .ack(status: .applied, revision: 1),
      .renew(revision: 1), .release(revision: 1)
    ]
    #expect(bodies.map(\.type) == EventControlMessageType.allCases)
    #expect(EventOverrideState.none.current == nil)
  }

  @Test func theFrameReaderSplitsAStream() throws {
    let a = Data(repeating: 1, count: 40)
    let b = Data(repeating: 2, count: 50)
    let stream = EventControlCodec.frame(a) + EventControlCodec.frame(b)
    var reader = EventControlFrameReader()
    #expect(try reader.append(stream.prefix(3)) == [])
    #expect(try reader.append(stream.dropFirst(3).prefix(50)) == [ a ])
    #expect(try reader.append(stream.dropFirst(53)) == [ b ])
    #expect(throws: EventControlCodecError.truncated) {
      try EventControlFrameReader.payloadLength(Data([ 0, 0 ]))
    }
  }
}
