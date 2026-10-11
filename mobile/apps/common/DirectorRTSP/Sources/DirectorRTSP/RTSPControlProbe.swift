import Foundation
import DirectorSources
import Network
import os

/// Asks a camera, once, on its own RTSP port, who it is and whether it takes the parameter verbs:
/// `GET_PARAMETER device.cname device.name`, then `GET_PARAMETER control.version` on the same
/// connection. See `CameraControlProbe` for how the replies are read.
///
/// A connection of its own that never sets up a stream, so it costs a playing camera nothing and is
/// the same kind of control-only socket the tile's telemetry poller and control screen already
/// open. Bounded by `timeout` from start to finish; it runs off the main thread, on the network
/// framework's queue, and nothing waits on it but discovery.
public struct RTSPControlProbe: Sendable {
  private let timeout: TimeInterval
  private let userAgent: String

  public init(timeout: TimeInterval = 4, userAgent: String = "TS Director/1.0") {
    self.timeout = timeout
    self.userAgent = userAgent
  }

  public func probe(_ endpoint: CameraEndpoint) async -> CameraControlProbeOutcome {
    guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: endpoint.port)), endpoint.port > 0 else {
      return .unreachable
    }
    var builder = RTSPRequestBuilder(userAgent: userAgent)
    let headers = [ (name: "Content-Type", value: "text/parameters") ]
    let identity = builder.make(
      .getParameter,
      uri: endpoint.url,
      headers: headers,
      body: Data(CameraControlProbe.identityBody.utf8)
    )
    let version = builder.make(
      .getParameter,
      uri: endpoint.url,
      headers: headers,
      body: Data(CameraControlProbe.versionBody.utf8)
    )

    return await withCheckedContinuation { continuation in
      let parameters = NWParameters.tcp
      parameters.includePeerToPeer = true
      let connection = NWConnection(host: NWEndpoint.Host(endpoint.host), port: nwPort, using: parameters)
      let state = OSAllocatedUnfairLock(initialState: State())

      // Resumed exactly once, whichever of the replies, a failure or the deadline comes first.
      let finish: @Sendable (CameraControlProbeOutcome) -> Void = { outcome in
        let first = state.withLock { current -> Bool in
          guard !current.finished else { return false }
          current.finished = true
          return true
        }
        guard first else { return }
        connection.cancel()
        continuation.resume(returning: outcome)
      }

      // The connection ended before a reply that settles it: a camera that said who it is but
      // dropped before the version is still the Cameraman it said it was.
      let onEnded: @Sendable () -> Void = {
        if let found = state.withLock({ $0.identity }) {
          finish(.controllable(
            cname: found.cname,
            name: found.name,
            controlVersion: CameraControlProbe.controlVersion(statusCode: nil, body: nil)
          ))
        } else {
          finish(.unreachable)
        }
      }

      // One reply has arrived: the identity's decides whether to ask for the version, and the
      // version's completes the answer.
      let onResponse: @Sendable (RTSPResponse) -> Void = { response in
        let found = state.withLock { $0.identity }
        if let found {
          finish(.controllable(
            cname: found.cname,
            name: found.name,
            controlVersion: CameraControlProbe.controlVersion(
              statusCode: response.statusCode,
              body: response.bodyText
            )
          ))
          return
        }
        guard let answered = CameraControlProbe.identity(
          statusCode: response.statusCode,
          body: response.bodyText
        ) else {
          finish(.plain)
          return
        }
        state.withLock { $0.identity = Identity(cname: answered.cname, name: answered.name) }
        connection.send(content: version.wireFormat, completion: .contentProcessed { error in
          if error != nil { onEnded() }
        })
      }

      connection.stateUpdateHandler = { connectionState in
        switch connectionState {
        case .ready:
          Self.receive(on: connection, state: state, onResponse: onResponse, onEnded: onEnded)
          connection.send(content: identity.wireFormat, completion: .contentProcessed { error in
            if error != nil { onEnded() }
          })
        case .failed, .cancelled, .waiting(.posix(.ECONNREFUSED)):
          // Nothing listens there. The framework would wait and retry; there is no one to wait for.
          onEnded()
        default:
          // `.waiting` is how a peer-to-peer connection to another iOS device starts; giving up on
          // it would lose a camera that answers a moment later. The deadline bounds the wait.
          break
        }
      }
      connection.start(queue: Self.queue)
      Self.queue.asyncAfter(deadline: .now() + timeout) { onEnded() }
    }
  }

  /// Reads replies until one is complete, hands it on, and keeps reading for the next.
  private static func receive(
    on connection: NWConnection,
    state: OSAllocatedUnfairLock<State>,
    onResponse: @escaping @Sendable (RTSPResponse) -> Void,
    onEnded: @escaping @Sendable () -> Void
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
      let responses = state.withLock { current -> [RTSPResponse]? in
        guard !current.finished else { return nil }
        if let data { current.parser.append(data) }
        var parsed: [RTSPResponse] = []
        while let item = current.parser.next() {
          if case let .response(response) = item { parsed.append(response) }
        }
        return parsed
      }
      guard let responses else { return }
      for response in responses { onResponse(response) }
      if error != nil || isComplete {
        onEnded()
        return
      }
      receive(on: connection, state: state, onResponse: onResponse, onEnded: onEnded)
    }
  }

  private struct Identity: Sendable {
    let cname: String
    let name: String?
  }

  private struct State: Sendable {
    var finished = false
    var parser = RTSPStreamParser()
    var identity: Identity?
  }

  private static let queue = DispatchQueue(
    label: "app.teamstation.director.rtsp.control-probe",
    attributes: .concurrent
  )
}
