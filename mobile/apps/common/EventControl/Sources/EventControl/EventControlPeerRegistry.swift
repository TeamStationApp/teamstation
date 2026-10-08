import Foundation

/// Every peer a Director has heard from, one entry per instance ID.
///
/// Keyed by instance ID rather than address: two apps at one address on the two ports are two
/// peers, and one device that moved to a new address is still one. A peer not yet identified (no
/// reply yet) is held by its endpoint until it is.
public struct EventControlPeerRegistry: Sendable, Equatable {
  private var identified: [EventControlInstanceID: EventControlPeer] = [:]
  private var anonymous: [EventControlEndpoint: EventControlPeer] = [:]

  public init() {}

  /// Records what a link reports. An identified peer replaces its own earlier entry and any
  /// anonymous entry at its endpoint.
  public mutating func update(_ peer: EventControlPeer) {
    guard let instanceId = peer.instanceId else {
      if let known = identified.values.first(where: { $0.endpoint == peer.endpoint }) {
        var merged = known
        merged.state = peer.state
        identified[known.instanceId!] = merged
      } else {
        anonymous[peer.endpoint] = peer
      }
      return
    }
    anonymous[peer.endpoint] = nil
    // Another instance last seen at this endpoint has left it; this one is there now.
    for (other, known) in identified where other != instanceId && known.endpoint == peer.endpoint {
      var moved = known
      moved.state = .unreachable
      identified[other] = moved
    }
    identified[instanceId] = peer
  }

  /// Forgets a peer, by instance ID.
  public mutating func remove(_ instanceId: EventControlInstanceID) {
    identified[instanceId] = nil
  }

  /// Forgets an endpoint not yet identified.
  public mutating func remove(endpoint: EventControlEndpoint) {
    anonymous[endpoint] = nil
  }

  public func peer(_ instanceId: EventControlInstanceID) -> EventControlPeer? {
    identified[instanceId]
  }

  /// The peer last seen at an endpoint.
  public func peer(at endpoint: EventControlEndpoint) -> EventControlPeer? {
    identified.values.first { $0.endpoint == endpoint } ?? anonymous[endpoint]
  }

  /// Every peer, identified ones first, each group in endpoint order.
  public var peers: [EventControlPeer] {
    identified.values.sorted { $0.endpoint.description < $1.endpoint.description }
      + anonymous.values.sorted { $0.endpoint.description < $1.endpoint.description }
  }

  /// Where identified peers were last seen, to probe first after a restart.
  public var knownEndpoints: [EventControlEndpoint] {
    identified.values.map(\.endpoint).sorted { $0.description < $1.description }
  }

  /// How many peers are in each state, for a status line.
  public func count(where matches: (EventControlPeerState) -> Bool) -> Int {
    peers.filter { matches($0.state) }.count
  }

  /// Peers currently publishing to `revision`.
  public func appliedCount(revision: UInt64) -> Int {
    count { $0 == .applied(revision) }
  }
}
