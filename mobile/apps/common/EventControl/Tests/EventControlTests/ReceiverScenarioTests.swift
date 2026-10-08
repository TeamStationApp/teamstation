import Foundation
import Testing

@testable import EventControl

/// scenarios.json, run against `EventControlReceiver`: the receiver's behaviour as every
/// implementation must reproduce it.
@Suite("Receiver scenarios")
struct ReceiverScenarioTests {
  static var fixture: [String: Any] { Fixtures.json("scenarios.json") }
  static let names = (Fixtures.json("scenarios.json")["scenarios"] as! [[String: Any]])
    .map { $0["name"] as! String }

  @Test(arguments: names)
  func scenario(_ name: String) async throws {
    let fixture = Self.fixture
    let scenario = (fixture["scenarios"] as! [[String: Any]]).first { $0["name"] as! String == name }!
    try await ScenarioRun(fixture: fixture, scenario: scenario).run()
  }

  @Test func everyScenarioIsHere() {
    #expect(Self.names.count >= 20)
  }
}

/// What a scenario's `duringApply` does inside the apply closure.
private enum DuringApply: Sendable {
  case setConsent(Bool)
  case setCredentials(EventControlCredentials?)
}

private final class Box<Value>: @unchecked Sendable {
  var value: Value
  init(_ value: Value) { self.value = value }
}

private struct ScenarioRun {
  let fixture: [String: Any]
  let scenario: [String: Any]

  func credentials(_ name: String) -> EventControlCredentials {
    guard name == "forged" else { return Fixtures.credentials(name) }
    return try! EventControlCredentials(
      issuer: Fixtures.one.scope.issuer,
      userId: Fixtures.one.scope.userId,
      accountTag: Fixtures.one.scope.accountTag,
      keyId: Fixtures.one.keyId,
      key: fixture["forgedKey"] as! String
    )
  }

  func run() async throws {
    let name = scenario["name"] as! String
    let instances = fixture["instances"] as! [String: String]
    let hosts = fixture["hosts"] as! [String: String]
    let challenges = fixture["challenges"] as! [String: String]
    let assignments = fixture["assignments"] as! [String: [String: String]]
    let clock = TestClock(Date(timeIntervalSince1970: (fixture["clockStartMs"] as! Double) / 1000))
    let nonces = Box((fixture["nonces"] as! [String]).map(Fixtures.hex))
    let applies = Box(0)
    let events = Recorder<EventControlReceiverEvent>()
    let receiverBox = Box<EventControlReceiver?>(nil)
    let answer = EventControlAckStatus.allCases.first {
      "\($0)" == (scenario["apply"] as? String ?? "applied")
    }!
    // One op, or a list run in order.
    let hooks = scenario["duringApply"] as? [[String: Any]]
      ?? (scenario["duringApply"] as? [String: Any]).map { [ $0 ] } ?? []
    let ops: [DuringApply] = hooks.map { hook in
      hook["op"] as? String == "setConsent"
        ? .setConsent(hook["value"] as! Bool)
        : .setCredentials((hook["key"] as? String).map(credentials))
    }

    let receiver = EventControlReceiver(
      instanceId: EventControlInstanceID(hex: instances["receiver"]!)!,
      credentials: Fixtures.one,
      consent: scenario["consent"] as? Bool ?? true,
      apply: { _, _ in
        applies.value += 1
        if let receiver = receiverBox.value {
          for op in ops {
            switch op {
            case let .setConsent(allowed): await receiver.setConsent(allowed)
            case let .setCredentials(next): await receiver.setCredentials(next)
            }
          }
        }
        return answer
      },
      now: { clock.now.timeIntervalSince1970 },
      random: { _ in nonces.value.removeFirst() },
      autoExpire: false,
      onEvent: { events.append($0) }
    )
    receiverBox.value = receiver

    var sent: [Data] = []
    var replies: [Data?] = []
    var nonceOf: [Int: Data] = [:]
    for (index, step) in (scenario["steps"] as! [[String: Any]]).enumerated() {
      let label = "\(name) step \(index)"
      let expect = step["expect"] as? [String: Any] ?? [:]
      if let op = step["op"] as? String {
        switch op {
        case "advance":
          clock.advance((step["ms"] as! Double) / 1000)
          await receiver.expireIfDue()
        case "setConsent":
          await receiver.setConsent(step["value"] as! Bool)
        case "setCredentials":
          await receiver.setCredentials((step["key"] as? String).map(credentials))
        case "restart":
          await receiver.restart()
        default:
          await receiver.connectionClosed(EventControlConnectionID(step["connection"] as! Int))
        }
        sent.append(Data())
        replies.append(nil)
        try await check(expect, receiver, events, applies.value, assignments, instances, label)
        continue
      }

      let connection = step["connection"] as! Int
      let director = step["director"] as! String
      let key = credentials(step["key"] as? String ?? "one")
      let challenge = Fixtures.hex(challenges[String(connection)]!)
      let requestId = UInt64(step["requestId"] as? String ?? "0") ?? 0
      var payload: Data
      switch step["send"] as! String {
      case "raw":
        payload = Fixtures.hex(step["hex"] as! String)
      case "replay":
        payload = sent[step["fromStep"] as! Int]
      default:
        let header = EventControlHeader(
          sender: EventControlInstanceID(hex: instances[director]!)!,
          requestId: requestId,
          accountTag: key.accountTagBytes,
          keyId: key.keyIdBytes,
          challenge: challenge,
          receiverNonce: (step["nonce"] as? String).map(Fixtures.hex) ?? nonceOf[connection] ?? Data()
        )
        payload = EventControlCodec.encode(
          EventControlMessage(header: header, body: body(step, assignments)),
          with: key
        )
      }
      if step["tamper"] as? Bool == true { payload[payload.count - 1] ^= 0x01 }
      sent.append(payload)

      let reply = await receiver.handle(
        payload: payload,
        connection: EventControlConnectionID(connection),
        remoteHost: hosts[director]!
      )
      #expect(reply.replies.count <= 1, "\(label)")
      let answer = reply.replies.first
      replies.append(answer)
      if let close = expect["close"] as? Bool { #expect(reply.close == close, "\(label)") }
      if let same = expect["sameReplyAs"] as? Int {
        #expect(answer == replies[same], "\(label)")
      }
      if expect.keys.contains("reply") {
        if let wanted = expect["reply"] as? [String: Any] {
          let bytes = try #require(answer, "\(label)")
          let decoded = try #require(try? EventControlCodec.decode(bytes), "\(label)")
          let replyKey = credentials(expect["replyKey"] as? String ?? "one")
          #expect(decoded.isAuthentic(with: replyKey), "\(label)")
          let header = decoded.message.header
          // A reply echoes the request it answers: the payload sent, replayed or not.
          let asked = (try? EventControlCodec.decode(payload))?.message.header
          let echoed = wanted["requestId"].map { UInt64("\($0)")! } ?? asked?.requestId ?? 0
          #expect(header.requestId == echoed, "\(label)")
          if wanted["status"] as? String == "unsupported" {
            #expect(header.challenge == Data(count: 16), "\(label)")
          } else {
            #expect(header.challenge == asked?.challenge, "\(label)")
          }
          #expect(describe(decoded.message.body) == wanted.mapValues { "\($0)" }.filter { $0.key != "requestId" }, "\(label)")
          if case .announce = decoded.message.body { nonceOf[connection] = header.receiverNonce }
        } else {
          #expect(answer == nil, "\(label)")
        }
      }
      try await check(expect, receiver, events, applies.value, assignments, instances, label)
    }
  }

  private func body(_ step: [String: Any], _ assignments: [String: [String: String]]) -> EventControlBody {
    let revision = UInt64(step["revision"] as? String ?? "0")!
    switch step["send"] as! String {
    case "discover": return .discover
    case "assign":
      let fields = assignments[step["assignment"] as! String]!
      return .assign(revision: revision, gameId: fields["gameId"]!, title: fields["title"]!, startAt: fields["startAt"]!)
    case "renew": return .renew(revision: revision)
    case "release": return .release(revision: revision)
    default:
      let status = EventControlAckStatus.allCases.first { "\($0)" == step["status"] as! String }!
      return .ack(status: status, revision: revision)
    }
  }

  private func describe(_ body: EventControlBody) -> [String: String] {
    switch body {
    case let .announce(consent, lease, revision):
      return [ "type": "announce", "consent": consent ? "1" : "0", "lease": "\(lease)", "leaseRevision": "\(revision)" ]
        .mapValues { $0 }
    case let .ack(status, revision):
      return [ "type": "ack", "status": "\(status)", "revision": "\(revision)" ]
    default:
      return [ "type": "\(body.type)" ]
    }
  }

  private func check(
    _ expect: [String: Any],
    _ receiver: EventControlReceiver,
    _ events: Recorder<EventControlReceiverEvent>,
    _ applies: Int,
    _ assignments: [String: [String: String]],
    _ instances: [String: String],
    _ label: String
  ) async throws {
    if let count = expect["applies"] as? Int { #expect(applies == count, "\(label)") }
    if expect.keys.contains("lease") {
      let state = await receiver.overrideState
      if let wanted = expect["lease"] as? [String: Any] {
        let held = try #require(state.current, "\(label)")
        let fields = assignments[wanted["assignment"] as! String]!
        #expect(held.ownerInstanceId.hex == instances[wanted["owner"] as! String], "\(label)")
        #expect(held.revision == UInt64(wanted["revision"] as! String), "\(label)")
        #expect(held.ownerHost == wanted["ownerHost"] as? String, "\(label)")
        #expect(held.assignment.gameId == fields["gameId"], "\(label)")
        #expect(held.assignment.title == fields["title"], "\(label)")
        #expect(held.assignment.startAt == fields["startAt"], "\(label)")
      } else {
        #expect(state == .none, "\(label)")
      }
    }
    if let reason = expect["ended"] as? String {
      let ended = events.all.compactMap { event -> EventOverrideEndReason? in
        if case let .overrideEnded(_, why) = event { return why }
        return nil
      }.last
      #expect(ended.map { "\($0)" } == reason, "\(label)")
    }
    if let key = expect["keyMismatch"] as? String {
      #expect(events.all.contains(.keyMismatch(peerKeyId: credentials(key).keyId)), "\(label)")
    }
  }
}
