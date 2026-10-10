import Foundation
import Testing

@testable import EventControl

/// A Director session talking straight to a receiver, with no transport between them.
private struct Pair {
  var session: EventControlDirectorSession
  let receiver: EventControlReceiver
  let connection: EventControlConnectionID
  var closed = false

  init(
    receiver: EventControlReceiver,
    director: EventControlInstanceID = Fixtures.instance("d001"),
    credentials: EventControlCredentials = Fixtures.one,
    desired: EventControlDesired?,
    connection: EventControlConnectionID = 1
  ) {
    session = EventControlDirectorSession(
      endpoint: EventControlEndpoint(host: "192.0.2.20", port: 47614),
      instanceId: director,
      credentials: credentials,
      desired: desired
    )
    self.receiver = receiver
    self.connection = connection
  }

  /// Sends a step's payloads, feeding each reply back, until nothing more is sent.
  mutating func pump(_ first: EventControlDirectorStep) async {
    var step = first
    while !step.send.isEmpty {
      var next = EventControlDirectorStep()
      for payload in step.send {
        let reply = await receiver.handle(payload: payload, connection: connection, remoteHost: "192.0.2.10")
        for answer in reply.replies {
          let made = session.receive(answer)
          next.send += made.send
          next.close = next.close || made.close
        }
        if reply.close { closed = true }
      }
      if next.close { closed = true }
      step = next
    }
  }
}

private func receiver(
  consent: Bool = true,
  credentials: EventControlCredentials = Fixtures.one,
  apply: @escaping EventControlApply = { _, _ in .applied }
) -> EventControlReceiver {
  EventControlReceiver(
    instanceId: Fixtures.instance("e001"),
    credentials: credentials,
    consent: consent,
    apply: apply,
    autoExpire: false
  )
}

private let desiredA = EventControlDesired(revision: 100, assignment: Fixtures.assignmentA)
private let desiredB = EventControlDesired(revision: 200, assignment: Fixtures.assignmentB)

@Suite("Director session")
struct DirectorSessionTests {
  @Test func discoversAssignsRenewsAndReleases() async {
    let target = receiver()
    var pair = Pair(receiver: target, desired: desiredA)
    #expect(pair.session.peer.state == .discovering)
    await pair.pump(pair.session.begin())
    #expect(pair.session.peer.state == .applied(100))
    #expect(pair.session.peer.instanceId == Fixtures.instance("e001"))
    #expect(pair.session.peer.consent == true)
    #expect(pair.session.peer.ackedRevision == 100)
    #expect(pair.session.holdsLease)
    #expect(await target.overrideState.current?.assignment == Fixtures.assignmentA)

    await pair.pump(pair.session.tick())
    #expect(pair.session.peer.lastStatus == .applied)

    await pair.pump(pair.session.setDesired(desiredB))
    #expect(pair.session.peer.state == .applied(200))
    #expect(await target.overrideState.current?.assignment == Fixtures.assignmentB)

    await pair.pump(pair.session.setDesired(nil))
    #expect(pair.session.peer.state == .released)
    #expect(await target.overrideState == .none)
    #expect(!pair.session.holdsLease)
    await pair.pump(pair.session.tick())
    #expect(pair.session.peer.state == .released)
    #expect(!pair.closed)
  }

  @Test func connectedWithNothingToAssignThenAssignsWhenAsked() async {
    var pair = Pair(receiver: receiver(), desired: nil)
    await pair.pump(pair.session.begin())
    #expect(pair.session.peer.state == .connected)
    #expect(pair.session.isBound)
    await pair.pump(pair.session.tick())
    #expect(pair.session.peer.state == .connected)
    await pair.pump(pair.session.setDesired(desiredA))
    #expect(pair.session.peer.state == .applied(100))
  }

  @Test func aDisabledPeerIsAskedAgainEachTick() async {
    let target = receiver(consent: false)
    var pair = Pair(receiver: target, desired: desiredA)
    await pair.pump(pair.session.begin())
    #expect(pair.session.peer.state == .disabled)
    #expect(pair.session.peer.consent == false)
    await target.setConsent(true)
    await pair.pump(pair.session.tick())
    #expect(pair.session.peer.state == .applied(100))
  }

  @Test func busyUntilTheOtherDirectorLetsGo() async {
    let target = receiver()
    var first = Pair(receiver: target, desired: desiredA)
    await first.pump(first.session.begin())
    var second = Pair(receiver: target, director: Fixtures.instance("d002"), desired: desiredB, connection: 2)
    await second.pump(second.session.begin())
    #expect(second.session.peer.state == .busy)
    await first.pump(first.session.finish(release: true))
    #expect(first.session.peer.state == .released)
    await second.pump(second.session.tick())
    #expect(second.session.peer.state == .applied(200))
  }

  @Test func anotherAccountIsLeftAlone() async {
    var pair = Pair(receiver: receiver(credentials: Fixtures.two), desired: desiredA)
    await pair.pump(pair.session.begin())
    #expect(pair.session.peer.state == .otherAccount)
    #expect(pair.session.peer.lastStatus == .wrongAccount)
    #expect(pair.closed)
  }

  @Test func aRotatedKeyIsReportedWithThePeersKeyId() async {
    var pair = Pair(receiver: receiver(credentials: Fixtures.rotated), desired: desiredA)
    await pair.pump(pair.session.begin())
    #expect(pair.session.peer.state == .keyMismatch)
    #expect(pair.session.peer.peerKeyId == Fixtures.rotated.keyId)
  }

  @Test func aReconnectFindsItsOwnLeaseAndOnlyRenews() async {
    let applies = Recorder<UInt64>()
    let target = receiver { _, context in
      applies.append(context.revision)
      return .applied
    }
    var first = Pair(receiver: target, desired: desiredA)
    await first.pump(first.session.begin())
    var again = Pair(receiver: target, desired: desiredA, connection: 2)
    again.session.restore(from: first.session.peer)
    #expect(again.session.peer.instanceId == Fixtures.instance("e001"))
    await again.pump(again.session.begin())
    #expect(again.session.holdsLease)
    // Counted as on the event at once, not only after the next renew.
    #expect(again.session.peer.state == .applied(100))
    await again.pump(again.session.tick())
    #expect(again.session.peer.lastStatus == .applied)
    #expect(applies.all == [ 100 ])
  }

  @Test func anExpiredLeaseIsAssignedAgain() async {
    let target = receiver()
    var pair = Pair(receiver: target, desired: desiredA)
    await pair.pump(pair.session.begin())
    await target.restart()
    // The restart dropped the session too: rebind on a new connection, as the link would.
    var again = Pair(receiver: target, desired: desiredA, connection: 2)
    await again.pump(again.session.begin())
    #expect(again.session.peer.state == .applied(100))
    // A renew the receiver no longer recognises comes back expired, and is assigned again.
    await target.setConsent(false)
    await target.setConsent(true)
    await again.pump(again.session.tick())
    #expect(again.session.peer.state == .applied(100))
  }

  @Test func failuresGiveUpAfterThree() async {
    var pair = Pair(receiver: receiver { _, _ in .failed }, desired: desiredA)
    await pair.pump(pair.session.begin())
    #expect(pair.session.peer.lastStatus == .failed)
    await pair.pump(pair.session.tick())
    #expect(pair.session.peer.state == .assigning(100))
    await pair.pump(pair.session.tick())
    #expect(pair.session.peer.state == .failed)
    #expect(pair.closed)
  }

  @Test func timeoutsCountAsFailures() {
    var session = EventControlDirectorSession(
      endpoint: EventControlEndpoint(host: "192.0.2.20", port: 47614),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: desiredA,
      maxFailures: 2
    )
    #expect(session.replyTimedOut() == EventControlDirectorStep())
    _ = session.begin()
    #expect(session.awaitingRequestId == 1)
    #expect(session.replyTimedOut() == EventControlDirectorStep(close: true))
    _ = session.begin()
    #expect(session.replyTimedOut().close)
    #expect(session.peer.state == .failed)
  }

  @Test func repliesThatDoNotAnswerTheOutstandingRequestAreIgnored() async throws {
    let target = receiver()
    var pair = Pair(receiver: target, desired: desiredA)
    let discover = pair.session.begin().send[0]
    let reply = await target.handle(payload: discover, connection: 1, remoteHost: "192.0.2.10")
    let announce = reply.replies[0]
    // Nothing outstanding yet? It is outstanding; but a reply for another challenge is ignored.
    var other = EventControlDirectorSession(
      endpoint: pair.session.peer.endpoint,
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: desiredA
    )
    _ = other.begin()
    #expect(other.receive(announce) == EventControlDirectorStep())
    #expect(other.peer.state == .discovering)
    // The real answer moves the session on; the same answer again is now stale and ignored.
    let step = pair.session.receive(announce)
    #expect(step.send.count == 1)
    #expect(pair.session.receive(announce) == EventControlDirectorStep())
    // Garbage closes.
    #expect(pair.session.receive(Data([ 1, 2, 3 ])).close)
    #expect(pair.session.peer.state == .invalid)
  }

  @Test func unauthenticAndUnboundRepliesAreInvalid() async throws {
    let target = receiver()
    var pair = Pair(receiver: target, desired: desiredA)
    let discover = pair.session.begin().send[0]
    var announce = await target.handle(payload: discover, connection: 1, remoteHost: "192.0.2.10").replies[0]
    announce[announce.count - 1] ^= 1
    #expect(pair.session.receive(announce).close)
    #expect(pair.session.peer.state == .invalid)

    // An ack carrying another nonce than the one announced.
    var bound = Pair(receiver: target, desired: desiredA, connection: 2)
    let opening = bound.session.begin().send[0]
    let reply = await target.handle(payload: opening, connection: 2, remoteHost: "192.0.2.10").replies[0]
    let assign = bound.session.receive(reply).send[0]
    let decoded = try EventControlCodec.decode(assign).message.header
    let forged = EventControlCodec.encode(
      EventControlMessage(
        header: EventControlHeader(
          sender: Fixtures.instance("e001"), requestId: decoded.requestId,
          accountTag: Fixtures.one.accountTagBytes, keyId: Fixtures.one.keyIdBytes,
          challenge: decoded.challenge, receiverNonce: Data(count: 16)
        ),
        body: .ack(status: .applied, revision: 100)
      ),
      with: Fixtures.one
    )
    #expect(bound.session.receive(forged).close)
    #expect(bound.session.peer.state == .invalid)

    // An announce answering an assign is out of order.
    var order = Pair(receiver: target, desired: desiredA, connection: 3)
    let first = order.session.begin().send[0]
    let hello = await target.handle(payload: first, connection: 3, remoteHost: "192.0.2.10").replies[0]
    let next = order.session.receive(hello).send[0]
    let asked = try EventControlCodec.decode(next).message.header
    let misplaced = EventControlCodec.encode(
      EventControlMessage(
        header: EventControlHeader(
          sender: Fixtures.instance("e001"), requestId: asked.requestId,
          accountTag: Fixtures.one.accountTagBytes, keyId: Fixtures.one.keyIdBytes,
          challenge: asked.challenge, receiverNonce: asked.receiverNonce
        ),
        body: .announce(consent: true, lease: .free, leaseRevision: 0)
      ),
      with: Fixtures.one
    )
    #expect(order.session.receive(misplaced).close)
  }

  @Test func receiverAnswersThatEndTheSession() {
    func answered(_ status: EventControlAckStatus) -> EventControlPeerState {
      var session = EventControlDirectorSession(
        endpoint: EventControlEndpoint(host: "192.0.2.20", port: 47614),
        instanceId: Fixtures.instance("d001"),
        credentials: Fixtures.one,
        desired: desiredA,
        challenge: Data(count: 16)
      )
      _ = session.begin()
      let ack = EventControlCodec.encode(
        EventControlMessage(
          header: EventControlHeader(
            sender: Fixtures.instance("e001"), requestId: 1,
            accountTag: Fixtures.one.accountTagBytes, keyId: Fixtures.one.keyIdBytes,
            challenge: Data(count: 16), receiverNonce: Data()
          ),
          body: .ack(status: status, revision: 0)
        ),
        with: Fixtures.one
      )
      _ = session.receive(ack)
      return session.peer.state
    }
    #expect(answered(.unsupported) == .unsupported)
    #expect(answered(.keyMismatch) == .keyMismatch)
    #expect(answered(.wrongAccount) == .otherAccount)
    #expect(answered(.invalid) == .discovering)
    #expect(answered(.stale) == .assigning(100))
  }

  @Test func aReleaseNobodyHeldStillEndsReleased() async {
    let target = receiver()
    var pair = Pair(receiver: target, desired: desiredA)
    await pair.pump(pair.session.begin())
    await target.restart()
    var again = Pair(receiver: target, desired: desiredA, connection: 2)
    await again.pump(again.session.begin())
    // Taken away underneath: the lease is gone, so the release comes back expired.
    await target.setConsent(false)
    await target.setConsent(true)
    await again.pump(again.session.setDesired(nil))
    #expect(again.session.peer.state == .released)
    #expect(again.session.finish(release: true) == EventControlDirectorStep(close: true))
  }
}
