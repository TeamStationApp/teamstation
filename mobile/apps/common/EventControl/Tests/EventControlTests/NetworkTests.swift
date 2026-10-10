import Foundation
import Network
import Testing

@testable import EventControl

private let desiredA = EventControlDesired(revision: 100, assignment: Fixtures.assignmentA)

/// Two free-looking TCP ports for one test, away from 47614/47615 so a real receiver running on
/// this machine is never disturbed.
private func portPair() -> [UInt16] {
  let base = UInt16.random(in: 20000 ... 29000) * 2
  return [ base, base + 1 ]
}

private func makeReceiver(events: Recorder<EventControlReceiverEvent>? = nil) -> EventControlReceiver {
  EventControlReceiver(
    instanceId: Fixtures.instance("e001"),
    credentials: Fixtures.one,
    consent: true,
    apply: { _, _ in .applied },
    onEvent: { events?.append($0) }
  )
}

private func listening(_ listener: EventControlListener) async -> UInt16? {
  _ = await eventually {
    if case .listening = listener.state { return true }
    if case .portsUnavailable = listener.state { return true }
    return false
  }
  if case let .listening(port) = listener.state { return port }
  return nil
}

@Suite("TCP adapters", .serialized)
struct NetworkTests {
  @Test func aDirectorLinkDrivesAListenerOverLoopback() async throws {
    let events = Recorder<EventControlReceiverEvent>()
    let states = Recorder<EventControlListener.State>()
    let ports = portPair()
    let listener = EventControlListener(
      receiver: makeReceiver(events: events),
      ports: ports,
      onStateChange: { states.append($0) }
    )
    #expect(listener.state == .stopped)
    listener.start()
    listener.start()
    let port = try #require(await listening(listener))
    #expect(port == ports[0])
    #expect(states.all.contains(.binding))

    let director = EventControlDirectorLink(
      endpoint: EventControlEndpoint(host: "127.0.0.1", port: port),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: desiredA,
      timing: EventControlDirectorTiming(renewInterval: 0.1)
    )
    await director.start()
    #expect(await eventually { await director.peer.state == .applied(100) })
    let held = await listener.receiver.overrideState.current
    #expect(held?.ownerHost == "127.0.0.1")
    #expect(held?.assignment == Fixtures.assignmentA)
    #expect(listener.connectionCount == 1)
    await director.stop()
    #expect(await listener.receiver.overrideState == .none)
    #expect(events.all.contains { if case .overrideEnded(_, .released) = $0 { return true }; return false })
    listener.stop()
    #expect(listener.state == .stopped)
    #expect(await eventually { listener.connectionCount == 0 })
  }

  @Test func takesTheSecondPortWhenTheFirstIsTakenAndSaysSoWhenBothAre() async throws {
    let ports = portPair()
    let first = EventControlListener(receiver: makeReceiver(), ports: ports)
    first.start()
    #expect(await listening(first) == ports[0])
    let second = EventControlListener(receiver: makeReceiver(), ports: ports)
    second.start()
    #expect(await listening(second) == ports[1])
    let third = EventControlListener(receiver: makeReceiver(), ports: ports)
    third.start()
    #expect(await listening(third) == nil)
    #expect(third.state == .portsUnavailable(ports))
    // Once a port is free again, asking to listen takes it.
    first.stop()
    try? await Task.sleep(for: .milliseconds(100))
    third.ensureListening()
    #expect(await eventually { third.state == .listening(port: ports[0]) })
    second.stop()
    third.stop()
  }

  @Test func rebindsAfterTheSystemCancelsAndRestartsTheReceiver() async throws {
    let events = Recorder<EventControlReceiverEvent>()
    let ports = portPair()
    let listener = EventControlListener(
      receiver: makeReceiver(events: events),
      ports: ports,
      rebindDelay: 0.05
    )
    listener.start()
    #expect(await listening(listener) == ports[0])
    let director = EventControlDirectorLink(
      endpoint: EventControlEndpoint(host: "127.0.0.1", port: ports[0]),
      instanceId: Fixtures.instance("d001"),
      credentials: Fixtures.one,
      desired: desiredA,
      timing: EventControlDirectorTiming(renewInterval: 60)
    )
    await director.start()
    #expect(await eventually { await director.peer.state == .applied(100) })
    listener.cancelAsTheSystemWould()
    #expect(await eventually { await listener.receiver.overrideState == .none })
    #expect(events.all.contains { if case .overrideEnded(_, .restarted) = $0 { return true }; return false })
    #expect(await eventually { listener.state == .listening(port: ports[0]) })
    await director.stop(release: false)
    listener.stop()
  }

  @Test func anOversizedFrameClosesTheConnectionUnread() async throws {
    let ports = portPair()
    let listener = EventControlListener(receiver: makeReceiver(), ports: ports)
    listener.start()
    let port = try #require(await listening(listener))
    let connection = try await EventControlNWConnector().connect(
      to: EventControlEndpoint(host: "127.0.0.1", port: port),
      timeout: 2
    )
    let raw = try #require(connection as? EventControlNWConnection)
    #expect(raw.remoteHost == "127.0.0.1")
    try await raw.sendRaw(Data([ 0x00, 0x00, 0x10, 0x01 ]))
    await #expect(throws: EventControlTransportError.closed) { try await connection.receive() }
    connection.close()
    listener.stop()
  }

  @Test func aReceiverRefusesAnOversizedReplyToo() async throws {
    // A server that answers with a declared length over 4096 bytes.
    let server = try NWListener(using: .tcp, on: .any)
    let queue = DispatchQueue(label: "test.oversized")
    server.newConnectionHandler = { incoming in
      incoming.start(queue: queue)
      incoming.send(content: Data([ 0x00, 0x00, 0x20, 0x00 ]), completion: .idempotent)
    }
    server.start(queue: queue)
    #expect(await eventually { server.port != nil && server.state == .ready })
    let connection = try await EventControlNWConnector().connect(
      to: EventControlEndpoint(host: "127.0.0.1", port: server.port!.rawValue),
      timeout: 2
    )
    await #expect(throws: EventControlTransportError.frame(.tooLarge)) { try await connection.receive() }
    await #expect(throws: EventControlTransportError.closed) { try await connection.send(Data([ 1 ])) }
    server.cancel()
  }

  @Test func connectFailuresSayWhy() async {
    let ports = portPair()
    do {
      _ = try await EventControlNWConnector().connect(
        to: EventControlEndpoint(host: "127.0.0.1", port: ports[0]),
        timeout: 2
      )
      Issue.record("connected to a closed port")
    } catch let error as EventControlTransportError {
      switch error {
      case .refused, .waiting: break
      default: Issue.record("unexpected \(error)")
      }
    } catch {
      Issue.record("unexpected \(error)")
    }
    do {
      // A documentation address nobody answers: the timeout wins (or the system gives up first).
      _ = try await EventControlNWConnector().connect(
        to: EventControlEndpoint(host: "192.0.2.1", port: 47614),
        timeout: 0.3
      )
      Issue.record("connected to a documentation address")
    } catch let error as EventControlTransportError {
      #expect(error != .closed)
    } catch {
      Issue.record("unexpected \(error)")
    }
  }

  @Test func hostsAreWrittenThePlainWay() {
    #expect(EventControlNWConnection.describe(.ipv4(IPv4Address("192.0.2.10")!)) == "192.0.2.10")
    #expect(EventControlNWConnection.describe(.ipv6(IPv6Address("::ffff:192.0.2.10")!)) == "192.0.2.10")
    #expect(EventControlNWConnection.describe(.ipv6(IPv6Address("fe80::1%lo0")!)) == "fe80::1")
    #expect(EventControlNWConnection.describe(.name("peer.example.test", nil)) == "peer.example.test")
    #expect(
      EventControlNWConnection.host(of: .hostPort(host: "192.0.2.4", port: 47614)) == "192.0.2.4"
    )
    #expect(EventControlNWConnection.host(of: .service(name: "x", type: "_t._tcp", domain: "local", interface: nil)) != "")
  }
}

extension EventControlNWConnection {
  /// Bytes straight onto the socket, for tests of what a peer must refuse.
  func sendRaw(_ bytes: Data) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      connection.send(content: bytes, completion: .contentProcessed { _ in continuation.resume() })
    }
  }
}
