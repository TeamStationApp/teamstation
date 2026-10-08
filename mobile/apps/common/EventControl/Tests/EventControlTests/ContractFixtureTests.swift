import Foundation
import Testing

@testable import EventControl

/// The shared wire vectors, byte for byte. The Node reference and the Android app run the same
/// files; a difference anywhere is a different protocol.
@Suite("Contract fixtures")
struct ContractFixtureTests {
  @Test func keysDecodeFromTheServersReply() throws {
    let vectors = Fixtures.json("keys.json")["vectors"] as! [[String: String]]
    #expect(vectors.count >= 4)
    for vector in vectors {
      var reply = vector
      reply["secret"] = nil
      reply["name"] = nil
      let data = try JSONSerialization.data(withJSONObject: reply)
      let credentials = try EventControlCredentials.decode(serverReply: data)
      #expect(credentials.scope.issuer == vector["issuer"])
      #expect(credentials.scope.userId == vector["userId"])
      #expect(credentials.keyId == vector["keyId"])
      #expect(EventControlBytes.hex(credentials.keyBytes) == vector["key"])
    }
    #expect(Fixtures.one.scope.accountTag != Fixtures.two.scope.accountTag)
    #expect(Fixtures.one.keyId == Fixtures.two.keyId)
    #expect(Fixtures.one.keyId != Fixtures.rotated.keyId)
    #expect(!Fixtures.one.isSameAccount(as: Fixtures.otherServer))
    #expect(Fixtures.one.isSameAccount(as: Fixtures.credentials("one")))
  }

  @Test func framesEncodeAndDecodeByteForByte() throws {
    let vectors = Fixtures.json("frames.json")["vectors"] as! [[String: Any]]
    #expect(vectors.count >= 12)
    for vector in vectors {
      let name = vector["name"] as! String
      let credentials = Fixtures.credentials(vector["key"] as! String)
      let fields = vector["message"] as! [String: Any]
      let message = EventControlMessage(
        header: EventControlHeader(
          sender: EventControlInstanceID(hex: fields["sender"] as! String)!,
          requestId: UInt64(fields["requestId"] as! String)!,
          accountTag: credentials.accountTagBytes,
          keyId: credentials.keyIdBytes,
          challenge: Fixtures.hex(fields["challenge"] as! String),
          receiverNonce: Fixtures.hex(fields["receiverNonce"] as! String)
        ),
        body: body(fields)
      )
      let payload = EventControlCodec.encode(message, with: credentials)
      #expect(EventControlBytes.hex(payload) == vector["payload"] as? String, "\(name)")
      #expect(
        EventControlBytes.hex(EventControlCodec.frame(payload)) == vector["frame"] as? String,
        "\(name)"
      )
      let decoded = try EventControlCodec.decode(Fixtures.hex(vector["payload"] as! String))
      #expect(decoded.message == message, "\(name)")
      #expect(decoded.isAuthentic(with: credentials), "\(name)")
      #expect(!decoded.isAuthentic(with: Fixtures.two) || credentials == Fixtures.two)
      var reader = EventControlFrameReader()
      #expect((try? reader.append(Fixtures.hex(vector["frame"] as! String))) == [ payload ])
    }
  }

  private func body(_ fields: [String: Any]) -> EventControlBody {
    let revision = { (key: String) in UInt64(fields[key] as! String)! }
    switch fields["type"] as! String {
    case "discover":
      return .discover
    case "announce":
      let lease = [ "free": EventControlLeaseState.free, "heldBySender": .heldBySender,
                    "heldByOther": .heldByOther ][fields["lease"] as! String]!
      return .announce(
        consent: fields["consent"] as! Bool,
        lease: lease,
        leaseRevision: revision("leaseRevision")
      )
    case "assign":
      return .assign(
        revision: revision("revision"),
        gameId: fields["gameId"] as! String,
        title: fields["title"] as! String,
        startAt: fields["startAt"] as! String
      )
    case "ack":
      let status = EventControlAckStatus.allCases.first { "\($0)" == fields["status"] as! String }!
      return .ack(status: status, revision: revision("revision"))
    case "renew":
      return .renew(revision: revision("revision"))
    default:
      return .release(revision: revision("revision"))
    }
  }

  @Test func rejectionsAreRefusedForTheNamedReason() {
    let fixture = Fixtures.json("rejections.json")
    let vectors = fixture["decode"] as! [[String: Any]]
    #expect(vectors.count >= 15)
    for vector in vectors {
      let name = vector["name"] as! String
      let index = vector["index"] as? Int
      let expected: EventControlCodecError
      switch vector["error"] as! String {
      case "tooLarge": expected = .tooLarge
      case "tooShort": expected = .tooShort
      case "unsupportedVersion": expected = .unsupportedVersion(UInt8(index!))
      case "unknownType": expected = .unknownType(UInt8(index!))
      case "truncated": expected = .truncated
      case "fieldTooLong": expected = .fieldTooLong(index: index!)
      case "badFieldLength": expected = .badFieldLength(index: index!)
      case "trailingBytes": expected = .trailingBytes
      case "badValue": expected = .badValue(index: index!)
      default: expected = .badUTF8(index: index!)
      }
      #expect(throws: expected, "\(name)") {
        try EventControlCodec.decode(Fixtures.hex(vector["payload"] as! String))
      }
    }
    for vector in fixture["unauthentic"] as! [[String: String]] {
      let decoded = try? EventControlCodec.decode(Fixtures.hex(vector["payload"]!))
      #expect(decoded != nil, "\(vector["name"]!)")
      #expect(decoded?.isAuthentic(with: Fixtures.credentials(vector["key"]!)) == false)
    }
    for vector in fixture["prefixes"] as! [[String: Any]] {
      let prefix = Fixtures.hex(vector["prefix"] as! String)
      if let length = vector["length"] as? Int {
        #expect((try? EventControlFrameReader.payloadLength(prefix)) == length)
      } else {
        let expected: EventControlCodecError = vector["error"] as! String == "tooLarge"
          ? .tooLarge : .tooShort
        #expect(throws: expected) { try EventControlFrameReader.payloadLength(prefix) }
        var reader = EventControlFrameReader()
        #expect(throws: expected) { try reader.append(prefix) }
      }
    }
  }

  @Test func assignmentsBuildAndValidateAsTheFixturesSay() {
    let fixture = Fixtures.json("assignments.json")
    for vector in fixture["build"] as! [[String: Any]] {
      let name = vector["name"] as! String
      let input = vector["input"] as! [String: Any]
      let date = Date(timeIntervalSince1970: (input["startAtMs"] as! Double) / 1000)
      let made = Result { () throws(EventAssignment.Problem) in
        try EventAssignment(gameId: input["gameId"] as! String, title: input["title"] as! String, startAt: date)
      }
      if let expected = vector["expected"] as? [String: String] {
        let built = try? made.get()
        #expect(built?.gameId == expected["gameId"], "\(name)")
        #expect(built?.title == expected["title"], "\(name)")
        #expect(built?.startAt == expected["startAt"], "\(name)")
      } else {
        #expect(throws: problem(vector["error"] as! String), "\(name)") { try made.get() }
      }
    }
    for vector in fixture["wire"] as! [[String: Any]] {
      let name = vector["name"] as! String
      let make = { () throws(EventAssignment.Problem) in
        try EventAssignment(
          wireGameId: vector["gameId"] as! String,
          title: vector["title"] as! String,
          startAt: vector["startAt"] as! String
        )
      }
      if let error = vector["error"] as? String {
        #expect(throws: problem(error), "\(name)") { try make() }
      } else {
        #expect(throws: Never.self, "\(name)") { try make() }
      }
    }
  }

  private func problem(_ name: String) -> EventAssignment.Problem {
    switch name {
    case "emptyGameId": return .emptyGameId
    case "gameIdTooLong": return .gameIdTooLong
    case "untrimmedGameId": return .untrimmedGameId
    case "emptyTitle": return .emptyTitle
    case "titleTooLong": return .titleTooLong
    case "untrimmedTitle": return .untrimmedTitle
    default: return .badStartAt
    }
  }
}
