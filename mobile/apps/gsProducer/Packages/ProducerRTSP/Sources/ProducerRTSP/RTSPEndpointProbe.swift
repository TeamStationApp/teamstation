import Foundation
import Network
import os

/// Asks one open port whether it is actually a camera.
///
/// An open 554 proves only that something speaks RTSP. Requiring a `DESCRIBE` that returns a video
/// media line is what stops a NAS or a doorbell from appearing in the operator's source list.
public struct RTSPEndpointProbe: Sendable {
  public struct Confirmation: Sendable {
    public let description: SDPDescription
    public let serverName: String?
  }

  private let timeout: TimeInterval

  public init(timeout: TimeInterval = 2) {
    self.timeout = timeout
  }

  public func confirm(host: String, port: Int, path: String) async -> Confirmation? {
    guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return nil }
    let url = "rtsp://\(host):\(port)\(path)"

    var builder = RTSPRequestBuilder()
    let request = builder.make(.describe, uri: url, headers: [
      (name: "Accept", value: "application/sdp")
    ])

    return await withCheckedContinuation { continuation in
      let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
      let state = OSAllocatedUnfairLock(initialState: ProbeState())

      // A continuation may be resumed exactly once, and the timeout races the state handler.
      let finish: @Sendable (Confirmation?) -> Void = { confirmation in
        let shouldResume = state.withLock { current -> Bool in
          guard !current.resumed else { return false }
          current.resumed = true
          return true
        }
        guard shouldResume else { return }
        connection.cancel()
        continuation.resume(returning: confirmation)
      }

      connection.stateUpdateHandler = { connectionState in
        switch connectionState {
        case .ready:
          self.receive(on: connection, state: state, finish: finish)
          connection.send(content: request.wireFormat, completion: .contentProcessed { error in
            if error != nil { finish(nil) }
          })
        case .failed, .cancelled, .waiting:
          finish(nil)
        default:
          break
        }
      }
      connection.start(queue: Self.queue)
      Self.queue.asyncAfter(deadline: .now() + timeout) { finish(nil) }
    }
  }

  /// A method rather than a nested function so it can call itself from inside a `@Sendable` receive
  /// handler, which a local closure cannot.
  private func receive(
    on connection: NWConnection,
    state: OSAllocatedUnfairLock<ProbeState>,
    finish: @escaping @Sendable (Confirmation?) -> Void
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, isComplete, error in
      guard error == nil else {
        finish(nil)
        return
      }
      let accumulated = state.withLock { current -> Data? in
        guard !current.resumed else { return nil }
        if let data { current.buffer.append(data) }
        return current.buffer
      }
      guard let accumulated else { return }

      if let parsed = RTSPResponse.parse(accumulated) {
        guard parsed.response.isSuccess else {
          finish(nil)
          return
        }
        // A camera, for this app's purposes, is something with a video track it can decode.
        let description = SDPDescription.parse(parsed.response.bodyText)
        guard let video = description.video, video.videoCodec != nil else {
          finish(nil)
          return
        }
        finish(Confirmation(description: description, serverName: parsed.response.header("server")))
        return
      }
      if isComplete {
        finish(nil)
        return
      }
      self.receive(on: connection, state: state, finish: finish)
    }
  }

  struct ProbeState: Sendable {
    var resumed = false
    var buffer = Data()
  }

  private static let queue = DispatchQueue(
    label: "co.gamestation.producer.rtsp.probe",
    attributes: .concurrent
  )
}
