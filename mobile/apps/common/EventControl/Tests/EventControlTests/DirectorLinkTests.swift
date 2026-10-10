import Foundation
import Testing

@testable import EventControl

private let desiredA = EventControlDesired(revision: 100, assignment: Fixtures.assignmentA)
private let desiredB = EventControlDesired(revision: 200, assignment: Fixtures.assignmentB)
private let fast = EventControlDirectorTiming(
  connectTimeout: 1,
  replyTimeout: 0.2,
  renewInterval: 0.05,
  reconnectDelays: [ 0.01, 0.01 ],
  maxFailures: 3
)

private func makeReceiver(
  credentials: EventControlCredentials = Fixtures.one,
  apply: @escaping EventControlApply = { _, _ in .applied }
) -> EventControlReceiver {
  EventControlReceiver(
    instanceId: Fixtures.instance("e001"),
    credentials: credentials,
    consent: true,
    apply: apply
  )
}

/// Serves every connect with `receiver`, keeping the far ends so a test can cut them.
private final class Bench: @unchecked Sendable {
  let receiver: EventControlReceiver
  private let lock = NSLock()
  private var ends: [EventControlMemoryConnection] = []
  private var next: EventControlConnectionID = 1

  init(_ receiver: EventControlReceiver) {
    self.receiver = receiver
  }

  var connector: EventControlMemoryConnector {
    EventControlMemoryConnector { [self] _, far in
      let id: EventControlConnectionID = lock.withLock {
        ends.append(far)
        defer { next += 1 }
        return next
      }
      let receiver = receiver
      Task { await receiver.serve(far, id: id) }
    }
  }

  var connections: Int { lock.withLock { ends.count } }

  func cut() {
    lock.withLock { ends.last }?.close()
  }
}

private func link(
  _ connector: any EventControlConnector,
  desired: EventControlDesired? = desiredA,
  credentials: EventControlCredentials = Fixtures.one,
  updates: Recorder<EventControlPeer>? = nil
) -> EventControlDirectorLink {
  EventControlDirectorLink(
    endpoint: EventControlEndpoint(host: "192.0.2.30", port: 47614),
    instanceId: Fixtures.instance("d001"),
    credentials: credentials,
    desired: desired,
    connector: connector,
    timing: fast,
    onUpdate: { updates?.append($0) }
  )
}

@Suite("Director link", .serialized)
struct DirectorLinkTests {
  @Test func assignsRenewsChangesAndReleases() async {
    let renewals = Recorder<UInt64>()
    let bench = Bench(makeReceiver { _, context in
      renewals.append(context.revision)
      return .applied
    })
    let updates = Recorder<EventControlPeer>()
    let director = link(bench.connector, updates: updates)
    #expect(director.endpoint.port == 47614)
    #expect(director.instanceId == Fixtures.instance("d001"))
    #expect(await director.peer.state == .connecting)
    await director.start()
    await director.start()
    #expect(await director.isRunning)
    #expect(await eventually { await director.peer.state == .applied(100) })
    #expect(updates.all.map(\.state).starts(with: [ .discovering, .assigning(100), .applied(100) ]))
    // Renewals keep it, without applying again.
    try? await Task.sleep(for: .milliseconds(200))
    #expect(await director.peer.state == .applied(100))
    #expect(renewals.all == [ 100 ])

    await director.setDesired(desiredB)
    #expect(await eventually { await bench.receiver.overrideState.current?.revision == 200 })
    await director.setDesired(nil)
    #expect(await eventually { await bench.receiver.overrideState == .none })
    #expect(await director.peer.state == .released)
    await director.setDesired(desiredA)
    #expect(await eventually { await director.peer.state == .applied(100) })
    await director.stop()
    #expect(await bench.receiver.overrideState == .none)
    #expect(await !director.isRunning)
    // Stopped is final.
    await director.start()
    #expect(await !director.isRunning)
  }

  @Test func stoppingWithoutReleaseLeavesTheLeaseToExpire() async {
    let bench = Bench(makeReceiver())
    let director = link(bench.connector)
    await director.start()
    #expect(await eventually { await director.peer.state == .applied(100) })
    await director.stop(release: false)
    #expect(await bench.receiver.overrideState.current?.revision == 100)
  }

  @Test func aDroppedConnectionIsRemadeAndTheLeaseKept() async {
    let applies = Recorder<UInt64>()
    let bench = Bench(makeReceiver { _, context in
      applies.append(context.revision)
      return .applied
    })
    let director = link(bench.connector)
    await director.start()
    #expect(await eventually { await director.peer.state == .applied(100) })
    bench.cut()
    #expect(await eventually { bench.connections == 2 })
    #expect(await eventually { await director.peer.state == .applied(100) })
    #expect(applies.all == [ 100 ])
    await director.stop()
  }

  @Test func anUnreachablePeerEndsTheLink() async {
    let updates = Recorder<EventControlPeer>()
    let director = link(Handing(), updates: updates)
    await director.start()
    #expect(await eventually { await !director.isRunning })
    #expect(await director.peer.state == .unreachable)
    #expect(updates.all.map(\.state) == [ .unreachable ])
  }

  @Test func anotherAccountEndsTheLinkWithoutReconnecting() async {
    let bench = Bench(makeReceiver(credentials: Fixtures.two))
    let director = link(bench.connector)
    await director.start()
    #expect(await eventually { await !director.isRunning })
    #expect(await director.peer.state == .otherAccount)
    #expect(bench.connections == 1)
  }

  @Test func aSilentPeerTimesOutAndIsGivenUp() async {
    // Connections that take frames and never answer.
    let silent = EventControlMemoryConnector { _, far in
      Task { while (try? await far.receive()) != nil {} }
    }
    let director = link(silent)
    await director.start()
    #expect(await eventually(5) { await !director.isRunning })
    #expect(await director.peer.state == .unreachable)
  }

  @Test func aConnectionThatFailsOnSendIsRemade() async {
    let (near, far) = EventControlMemoryConnection.pair()
    far.close()
    let bench = Bench(makeReceiver())
    let director = link(Chain(first: near, then: bench.connector))
    await director.start()
    #expect(await eventually { await director.peer.state == .applied(100) })
    await director.stop()
  }

  @Test func stopWhileWaitingToReconnect() async {
    let director = EventControlDirectorLink(
      endpoint: EventControlEndpoint(host: "192.0.2.30", port: 47614),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: desiredA,
      connector: Handing(),
      timing: EventControlDirectorTiming(reconnectDelays: [ 30 ])
    )
    await director.start()
    try? await Task.sleep(for: .milliseconds(50))
    await director.stop()
    #expect(await !director.isRunning)
    #expect(await director.peer.state == .connecting)
  }
}

/// Hands out one connection first, then defers to another connector.
private struct Chain: EventControlConnector {
  let first: EventControlMemoryConnection
  let then: EventControlMemoryConnector
  private let used = Once()

  init(first: EventControlMemoryConnection, then: EventControlMemoryConnector) {
    self.first = first
    self.then = then
  }

  func connect(
    to endpoint: EventControlEndpoint,
    timeout: TimeInterval
  ) async throws -> any EventControlConnection {
    if used.claim() { return first }
    return try await then.connect(to: endpoint, timeout: timeout)
  }
}
