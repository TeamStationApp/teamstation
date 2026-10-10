import Foundation
import Testing

@testable import EventControl

@Suite("Key store and peer registry", .serialized)
struct StoreAndRegistryTests {
  private func exercise(_ store: EventControlKeyStore) {
    let server = "https://app.example.test"
    store.removeAll()
    #expect(store.credentials(for: server) == nil)
    #expect(store.save(Fixtures.one, for: server))
    #expect(store.credentials(for: server) == Fixtures.one)
    #expect(store.save(Fixtures.two, for: server))
    #expect(store.credentials(for: server) == Fixtures.two)
    #expect(store.save(Fixtures.otherServer, for: "https://develop9.example.test"))
    store.remove(for: server)
    #expect(store.credentials(for: server) == nil)
    #expect(store.credentials(for: "https://develop9.example.test") == Fixtures.otherServer)
    store.removeAll()
    #expect(store.credentials(for: "https://develop9.example.test") == nil)
  }

  @Test func keepsOneKeyPerServerInMemory() {
    let store = EventControlKeyStore.inMemory()
    #expect(store.service == "inMemory")
    exercise(store)
  }

  @Test func keepsOneKeyPerServerInTheKeychain() {
    // A service of its own, removed again, so nothing a real app keeps is touched.
    let store = EventControlKeyStore(service: "app.teamstation.eventcontrol.tests.\(UUID().uuidString)")
    exercise(store)
  }

  private func peer(
    _ host: String,
    _ port: UInt16,
    _ instance: EventControlInstanceID?,
    _ state: EventControlPeerState
  ) -> EventControlPeer {
    var made = EventControlPeer(endpoint: EventControlEndpoint(host: host, port: port), state: state)
    made.instanceId = instance
    return made
  }

  @Test func peersAreKeptByInstanceNotAddress() {
    let a = Fixtures.instance("e001")
    let b = Fixtures.instance("e002")
    var registry = EventControlPeerRegistry()
    // Not yet identified: held by endpoint.
    registry.update(peer("192.0.2.5", 47614, nil, .connecting))
    #expect(registry.peers.count == 1)
    #expect(registry.peer(at: EventControlEndpoint(host: "192.0.2.5", port: 47614))?.state == .connecting)
    // Identified: replaces the anonymous entry.
    registry.update(peer("192.0.2.5", 47614, a, .applied(100)))
    // Another app on the same handset, on the other port: a second peer.
    registry.update(peer("192.0.2.5", 47615, b, .disabled))
    #expect(registry.peers.count == 2)
    #expect(registry.appliedCount(revision: 100) == 1)
    #expect(registry.count { $0 == .disabled } == 1)
    // The first moved to a new address: still one peer, at its new endpoint.
    registry.update(peer("192.0.2.9", 47614, a, .applied(100)))
    #expect(registry.peers.count == 2)
    #expect(registry.peer(a)?.endpoint.host == "192.0.2.9")
    #expect(registry.knownEndpoints.map(\.description) == [ "192.0.2.5:47615", "192.0.2.9:47614" ])
    // A link at a known endpoint reporting before it identifies itself updates that peer.
    registry.update(peer("192.0.2.9", 47614, nil, .connecting))
    #expect(registry.peer(a)?.state == .connecting)
    #expect(registry.peers.count == 2)
    // A different instance now answers where `b` was: `b` is no longer there.
    let c = Fixtures.instance("e003")
    registry.update(peer("192.0.2.5", 47615, c, .connected))
    #expect(registry.peer(b)?.state == .unreachable)
    #expect(registry.peer(at: EventControlEndpoint(host: "192.0.2.5", port: 47615)) != nil)
    registry.remove(b)
    registry.remove(c)
    registry.update(peer("192.0.2.7", 47614, nil, .unreachable))
    registry.remove(endpoint: EventControlEndpoint(host: "192.0.2.7", port: 47614))
    #expect(registry.peers.map(\.instanceId) == [ a ])
    #expect(registry == registry)
  }
}
