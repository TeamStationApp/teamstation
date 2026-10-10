import Foundation
import Testing

@testable import EventControl

private let desiredA = EventControlDesired(revision: 100, assignment: Fixtures.assignmentA)

@Suite("Receiver")
struct ReceiverTests {
  @Test func reportsTheOverrideItHoldsAndWhyItEnds() async {
    let events = Recorder<EventControlReceiverEvent>()
    let clock = TestClock()
    let receiver = EventControlReceiver(
      instanceId: Fixtures.instance("e001"),
      credentials: Fixtures.one,
      consent: true,
      apply: { _, context in
        #expect(context.ownerHost == "192.0.2.1")
        #expect(context.ownerInstanceId == Fixtures.instance("d001"))
        #expect(context.revision == 100)
        return .applied
      },
      now: { clock.now.timeIntervalSince1970 },
      autoExpire: false,
      onEvent: { events.append($0) }
    )
    #expect(await receiver.isConsenting)
    #expect(receiver.instanceId == Fixtures.instance("e001"))
    let (director, far) = EventControlMemoryConnection.pair()
    let serving = Task { await receiver.serve(far, id: 7) }
    let link = EventControlDirectorLink(
      endpoint: EventControlEndpoint(host: "192.0.2.2", port: 47614),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: desiredA,
      connector: Handing(director),
      timing: EventControlDirectorTiming(renewInterval: 60)
    )
    await link.start()
    #expect(await eventually { await receiver.overrideState.current?.revision == 100 })
    let held = await receiver.overrideState.current
    #expect(held?.ownerHost == "192.0.2.1")
    #expect(await receiver.leaseExpiresAt == clock.now.timeIntervalSince1970 + 15)
    #expect(events.all.first == .overrideChanged(.controlled(held!)))

    await receiver.setConsent(true)  // Unchanged: nothing happens.
    #expect(await receiver.overrideState.current != nil)
    await receiver.setCredentials(Fixtures.credentials("one"))  // The same key again.
    #expect(await receiver.overrideState.current != nil)
    clock.advance(14)
    await receiver.expireIfDue()
    #expect(await receiver.overrideState.current != nil)
    clock.advance(1)
    await receiver.expireIfDue()
    #expect(await receiver.overrideState == .none)
    #expect(events.all.contains(.overrideEnded(held!, .expired)))
    #expect(events.last == .overrideChanged(.none))
    await link.stop(release: false)
    _ = await serving.value
  }

  @Test func expiresOnItsOwnWhenNobodyRenews() async {
    let receiver = EventControlReceiver(
      instanceId: Fixtures.instance("e001"),
      credentials: Fixtures.one,
      consent: true,
      apply: { _, _ in .applied },
      leaseDuration: 0.2
    )
    let (director, far) = EventControlMemoryConnection.pair()
    Task { await receiver.serve(far, id: 1) }
    var session = EventControlDirectorSession(
      endpoint: EventControlEndpoint(host: "192.0.2.2", port: 47614),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: desiredA
    )
    try? await director.send(session.begin().send[0])
    let assign = session.receive(try! await director.receive()).send[0]
    try? await director.send(assign)
    _ = session.receive(try! await director.receive())
    #expect(session.peer.state == .applied(100))
    #expect(await eventually(3) { await receiver.overrideState == .none })
    director.close()
  }

  @Test func aLeaseStillEndsWhenTheClockStepsBackAfterItsTimerWasSet() async {
    // The receiver's clock follows real time from an offset the test can move. The timer is set for
    // 0.2 s; the clock then steps back 1 s, so when the timer fires the lease has 1 s left. The
    // receiver must wait for that, not stop watching and keep the lease for ever.
    let offset = Box(0.0)
    let started = EventControlClock.monotonic()
    let receiver = EventControlReceiver(
      instanceId: Fixtures.instance("e001"),
      credentials: Fixtures.one,
      consent: true,
      apply: { _, _ in .applied },
      now: { EventControlClock.monotonic() - started + offset.value },
      leaseDuration: 0.2
    )
    let (director, far) = EventControlMemoryConnection.pair()
    Task { await receiver.serve(far, id: 1) }
    var session = EventControlDirectorSession(
      endpoint: EventControlEndpoint(host: "192.0.2.2", port: 47614),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: desiredA
    )
    try? await director.send(session.begin().send[0])
    let assign = session.receive(try! await director.receive()).send[0]
    try? await director.send(assign)
    _ = session.receive(try! await director.receive())
    #expect(session.peer.state == .applied(100))
    offset.value = -1
    try? await Task.sleep(for: .milliseconds(400))
    #expect(await receiver.overrideState != .none, "the timer fired early by the clock and waits on")
    #expect(await eventually(3) { await receiver.overrideState == .none })
    director.close()
  }

  @Test func holdsTheEventFromItsApplyUntilTheLeaseEnds() async {
    let during = Box<Bool?>(nil)
    let me = Box<EventControlReceiver?>(nil)
    let interrupt = Box(false)
    let receiver = EventControlReceiver(
      instanceId: Fixtures.instance("e001"),
      credentials: Fixtures.one,
      consent: true,
      apply: { _, _ in
        guard let receiver = me.value else { return .failed }
        during.value = await receiver.holdsEvent
        if interrupt.value { await receiver.setConsent(false) }
        return .applied
      },
      autoExpire: false
    )
    me.value = receiver
    #expect(await receiver.holdsEvent == false)
    let (director, far) = EventControlMemoryConnection.pair()
    Task { await receiver.serve(far, id: 1) }
    var session = EventControlDirectorSession(
      endpoint: EventControlEndpoint(host: "192.0.2.2", port: 47614),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: desiredA
    )
    try? await director.send(session.begin().send[0])
    let assign = session.receive(try! await director.receive()).send[0]
    try? await director.send(assign)
    _ = session.receive(try! await director.receive())
    #expect(during.value == true, "while its apply runs")
    #expect(await receiver.holdsEvent, "with the lease")
    await receiver.setConsent(false)
    #expect(await receiver.holdsEvent == false)

    // An apply interrupted after its commit leaves nothing held.
    await receiver.setConsent(true)
    interrupt.value = true
    var again = EventControlDirectorSession(
      endpoint: EventControlEndpoint(host: "192.0.2.2", port: 47614),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: EventControlDesired(revision: 101, assignment: Fixtures.assignmentB)
    )
    let (second, otherFar) = EventControlMemoryConnection.pair()
    Task { await receiver.serve(otherFar, id: 2) }
    try? await second.send(again.begin().send[0])
    let next = again.receive(try! await second.receive()).send[0]
    try? await second.send(next)
    _ = again.receive(try! await second.receive())
    #expect(again.peer.state == .disabled)
    #expect(await receiver.holdsEvent == false)
    director.close()
    second.close()
  }

  @Test func theMonotonicClockMovesForward() async throws {
    let first = EventControlClock.monotonic()
    try await Task.sleep(for: .milliseconds(20))
    #expect(EventControlClock.monotonic() - first >= 0.015)
  }

  @Test func withoutAKeyEveryConnectionClosesUnanswered() async {
    let receiver = EventControlReceiver(
      instanceId: Fixtures.instance("e001"),
      credentials: nil,
      consent: true,
      apply: { _, _ in .applied }
    )
    let reply = await receiver.handle(payload: Data([ 1, 1 ]), connection: 1, remoteHost: "192.0.2.1")
    #expect(reply == EventControlReceiverReply(replies: [], close: true))
  }

  @Test func servingStopsWhenTheOtherEndGoes() async {
    let receiver = EventControlReceiver(
      instanceId: Fixtures.instance("e001"),
      credentials: Fixtures.one,
      consent: true,
      apply: { _, _ in .applied }
    )
    let (near, far) = EventControlMemoryConnection.pair()
    let serving = Task { await receiver.serve(far, id: 1) }
    // A discover whose answer cannot be sent, because this end has gone.
    let session = EventControlDirectorSession(
      endpoint: EventControlEndpoint(host: "192.0.2.2", port: 47614),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: nil
    )
    var opening = session
    let discover = opening.begin().send[0]
    try? await near.send(discover)
    near.close()
    await serving.value
    #expect(await (try? far.receive()) == nil)
    #expect(await (try? near.send(discover)) == nil)
  }
}

/// A value a test changes while a closure reads it.
private final class Box<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Value
  init(_ value: Value) { current = value }
  var value: Value {
    get { lock.withLock { current } }
    set { lock.withLock { current = newValue } }
  }
}

/// A connector that hands out one prepared connection, then refuses.
final class Handing: EventControlConnector, @unchecked Sendable {
  private let lock = NSLock()
  private var connections: [any EventControlConnection]

  init(_ connections: any EventControlConnection...) {
    self.connections = connections
  }

  func connect(
    to endpoint: EventControlEndpoint,
    timeout: TimeInterval
  ) async throws -> any EventControlConnection {
    let next: (any EventControlConnection)? = lock.withLock {
      connections.isEmpty ? nil : connections.removeFirst()
    }
    guard let next else { throw EventControlTransportError.refused("no more") }
    return next
  }
}
