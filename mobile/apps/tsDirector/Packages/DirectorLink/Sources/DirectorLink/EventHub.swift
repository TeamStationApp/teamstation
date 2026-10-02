import DistributorWire
import Foundation
// The service's routes take and return these types, so whoever imports DirectorLink gets them.
@_exported import LoopbackHTTP

/// Fans events out to every open `/v1/events` stream.
public typealias EventHub = JSONEventHub<DistributorEvent>

public extension LinkServer {
  /// TS Director's link server, on the port TS Distributor looks for.
  convenience init(
    connectionsChanged: (@Sendable (Int) -> Void)? = nil,
    handler: @escaping Handler
  ) {
    self.init(port: DistributorProtocol.port, connectionsChanged: connectionsChanged, handler: handler)
  }
}
