import Foundation
import Network
import Testing

@testable import EventControl

@Suite("Connection limits")
struct ConnectionLimiterTests {
  private let limits = EventControlConnectionLimiter.Limits(maxConnections: 3, handshakeTimeout: 5, idleTimeout: 15)

  @Test("The defaults are the README's: 16 open, 5 s to authenticate, 15 s of quiet")
  func defaults() {
    let standard = EventControlConnectionLimiter.Limits.standard
    #expect(standard.maxConnections == 16)
    #expect(standard.handshakeTimeout == 5)
    #expect(standard.idleTimeout == EventControlProtocol.leaseDuration)
    #expect(standard.idleTimeout == 15)
  }

  @Test("Below the cap every connection is admitted and nothing is evicted")
  func admitsBelowTheCap() {
    var limiter = EventControlConnectionLimiter(limits: limits)
    #expect(limiter.admit(1, now: 0) == .admitted(evicting: nil))
    #expect(limiter.admit(2, now: 1) == .admitted(evicting: nil))
    #expect(limiter.admit(3, now: 2) == .admitted(evicting: nil))
    #expect(limiter.openCount == 3)
  }

  @Test("At the cap the oldest unauthenticated connection makes room, never an authenticated one")
  func evictsTheOldestUnauthenticated() {
    var limiter = EventControlConnectionLimiter(limits: limits)
    _ = limiter.admit(1, now: 0)
    _ = limiter.admit(2, now: 1)
    _ = limiter.admit(3, now: 2)
    limiter.authenticated(1, now: 2)
    #expect(limiter.admit(4, now: 3) == .admitted(evicting: 2))
    #expect(limiter.admit(5, now: 3) == .admitted(evicting: 3))
    #expect(limiter.isAuthenticated(1))
    #expect(limiter.openCount == 3)
  }

  @Test("With every open connection authenticated a new one is refused")
  func refusesWhenAllAreAuthenticated() {
    var limiter = EventControlConnectionLimiter(limits: limits)
    for id: EventControlConnectionID in 1 ... 3 {
      _ = limiter.admit(id, now: 0)
      limiter.authenticated(id, now: 0)
    }
    #expect(limiter.admit(4, now: 1) == .refused)
    #expect(limiter.openCount == 3)
    // A close frees a slot.
    limiter.closed(2)
    #expect(limiter.admit(5, now: 1) == .admitted(evicting: nil))
  }

  @Test("Not authenticated within the handshake deadline: closed; authenticated in time: kept")
  func handshakeDeadline() {
    var limiter = EventControlConnectionLimiter(limits: limits)
    _ = limiter.admit(1, now: 0)
    _ = limiter.admit(2, now: 0)
    limiter.authenticated(2, now: 4.9)
    #expect(limiter.expired(now: 4.9).isEmpty)
    #expect(limiter.expired(now: 5) == [ 1 ])
    #expect(limiter.openCount == 1)
    #expect(limiter.expired(now: 6).isEmpty)
  }

  @Test("An authenticated connection closes after the lease duration without activity; activity extends it")
  func idleAfterAuthentication() {
    var limiter = EventControlConnectionLimiter(limits: limits)
    _ = limiter.admit(1, now: 0)
    limiter.authenticated(1, now: 1)
    limiter.authenticated(1, now: 10)
    #expect(limiter.expired(now: 24.9).isEmpty)
    #expect(limiter.expired(now: 25) == [ 1 ])
  }

  @Test("Reports for unknown connections change nothing; expired ones come oldest first")
  func bookkeeping() {
    var limiter = EventControlConnectionLimiter(limits: limits)
    limiter.authenticated(9, now: 0)
    #expect(limiter.openCount == 0)
    #expect(!limiter.isAuthenticated(9))
    _ = limiter.admit(3, now: 1)
    _ = limiter.admit(2, now: 0)
    #expect(limiter.expired(now: 10) == [ 2, 3 ])
    limiter.closed(7)
    #expect(limiter.openCount == 0)
  }
}

// MARK: - Over loopback

private let desiredA = EventControlDesired(revision: 100, assignment: Fixtures.assignmentA)

private func freePorts() -> [UInt16] {
  let base = UInt16.random(in: 15000 ... 19500) * 2
  return [ base, base + 1 ]
}

private func receiver() -> EventControlReceiver {
  EventControlReceiver(
    instanceId: Fixtures.instance("e001"),
    credentials: Fixtures.one,
    consent: true,
    apply: { _, _ in .applied }
  )
}

private func listeningPort(_ listener: EventControlListener) async -> UInt16? {
  _ = await eventually {
    if case .listening = listener.state { return true }
    return false
  }
  if case let .listening(port) = listener.state { return port }
  return nil
}

/// A connection that sends half a length prefix and nothing more, as a flood or a stuck client
/// would.
private func idleConnection(_ port: UInt16) async throws -> EventControlNWConnection {
  let connection = try await EventControlNWConnector().connect(
    to: EventControlEndpoint(host: "127.0.0.1", port: port),
    timeout: 2
  )
  let raw = try #require(connection as? EventControlNWConnection)
  try await raw.sendRaw(Data([ 0x00, 0x00 ]))
  return raw
}

private func director(_ port: UInt16, _ suffix: String, timing: EventControlDirectorTiming) -> EventControlDirectorLink {
  EventControlDirectorLink(
    endpoint: EventControlEndpoint(host: "127.0.0.1", port: port),
    instanceId: Fixtures.instance(suffix),
    credentials: Fixtures.one,
    desired: desiredA,
    timing: timing
  )
}

@Suite("Connection limits over loopback", .serialized)
struct ConnectionLimitListenerTests {
  @Test("Sixteen idle connections do not lock a Director out: it replaces the oldest and is applied")
  func idleFloodDoesNotLockTheDirectorOut() async throws {
    let listener = EventControlListener(receiver: receiver(), ports: freePorts())
    listener.start()
    let port = try #require(await listeningPort(listener))
    var idle: [EventControlNWConnection] = []
    for _ in 0 ..< 16 { idle.append(try await idleConnection(port)) }
    #expect(await eventually { listener.connectionCount == 16 })

    let link = director(port, "d001", timing: EventControlDirectorTiming(renewInterval: 0.2))
    await link.start()
    #expect(await eventually { await link.peer.state == .applied(100) })
    #expect(listener.connectionCount == 16)
    // The oldest idle connection was the one let go.
    await #expect(throws: EventControlTransportError.closed) { try await idle[0].receive() }

    // More idle connections never displace the authenticated Director.
    for _ in 0 ..< 20 { idle.append(try await idleConnection(port)) }
    try await Task.sleep(for: .milliseconds(600))
    #expect(await link.peer.state == .applied(100))
    #expect(await listener.receiver.overrideState.current?.ownerHost == "127.0.0.1")
    await link.stop()
    for connection in idle { connection.close() }
    listener.stop()
  }

  @Test("A connection that never authenticates is closed at the handshake deadline")
  func handshakeDeadlineClosesIdleConnections() async throws {
    let listener = EventControlListener(
      receiver: receiver(),
      ports: freePorts(),
      limits: EventControlConnectionLimiter.Limits(handshakeTimeout: 0.3),
      reapInterval: 0.05
    )
    listener.start()
    let port = try #require(await listeningPort(listener))
    let idle = try await idleConnection(port)
    let opened = Date()
    await #expect(throws: EventControlTransportError.closed) { try await idle.receive() }
    #expect(Date().timeIntervalSince(opened) < 3)
    #expect(await eventually { listener.connectionCount == 0 })
    listener.stop()
  }

  @Test("An authenticated connection that stops renewing is closed after the idle timeout; the lease is untouched")
  func idleAuthenticatedConnectionCloses() async throws {
    let listener = EventControlListener(
      receiver: receiver(),
      ports: freePorts(),
      limits: EventControlConnectionLimiter.Limits(handshakeTimeout: 5, idleTimeout: 0.4),
      reapInterval: 0.05
    )
    listener.start()
    let port = try #require(await listeningPort(listener))
    // Renews only every minute and reconnects only after ten seconds: silent once applied.
    let link = director(port, "d001", timing: EventControlDirectorTiming(renewInterval: 60, reconnectDelays: [ 10 ]))
    await link.start()
    #expect(await eventually { await link.peer.state == .applied(100) })
    #expect(listener.connectionCount == 1)
    #expect(await eventually { listener.connectionCount == 0 })
    // Closing the connection dropped its session only: the lease runs to its own expiry.
    #expect(await listener.receiver.overrideState.current?.assignment == Fixtures.assignmentA)
    await link.stop(release: false)
    listener.stop()
  }

  @Test("With every slot held by an authenticated Director a new connection is refused")
  func refusedWhenEverySlotIsAuthenticated() async throws {
    let listener = EventControlListener(
      receiver: receiver(),
      ports: freePorts(),
      limits: EventControlConnectionLimiter.Limits(maxConnections: 2)
    )
    listener.start()
    let port = try #require(await listeningPort(listener))
    let timing = EventControlDirectorTiming(renewInterval: 0.2)
    let owner = director(port, "d001", timing: timing)
    let other = director(port, "d002", timing: timing)
    await owner.start()
    #expect(await eventually { await owner.peer.state == .applied(100) })
    await other.start()
    #expect(await eventually { await other.peer.state == .busy })
    let refused = try await idleConnection(port)
    await #expect(throws: EventControlTransportError.closed) { try await refused.receive() }
    #expect(listener.connectionCount == 2)
    #expect(await owner.peer.state == .applied(100))
    await other.stop(release: false)
    await owner.stop()
    listener.stop()
  }
}
