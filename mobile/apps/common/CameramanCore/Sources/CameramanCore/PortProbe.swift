import Foundation
import Network
import os

/// Answers "can this build actually bind that port?" empirically.
///
/// iOS applies no privileged-port restriction, so 554 works on a handset — measured on an iPhone
/// 13 Pro on 2026-08-19, including a full RTSP exchange from a Mac on the same subnet. The
/// simulator has been reported to refuse low ports, and this is what tells us which case we are in
/// rather than guessing from the platform.
public enum PortProbe {
  public enum Outcome: Sendable, Equatable {
    case bound
    case refused(String)

    public var description: String {
      switch self {
      case .bound: "bound"
      case .refused(let reason): "refused: \(reason)"
      }
    }
  }

  public static func probe(port: Int) async -> Outcome {
    guard let endpointPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else {
      return .refused("not a valid port number")
    }

    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true

    let listener: NWListener
    do {
      listener = try NWListener(using: parameters, on: endpointPort)
    } catch {
      return .refused("\(error)")
    }

    // An incoming connection must be started for the handshake to complete, but this probe accepts
    // nothing, so refuse cleanly rather than leaving a client hanging.
    listener.newConnectionHandler = { connection in
      connection.start(queue: .global())
      connection.cancel()
    }

    let outcome = await withCheckedContinuation { (continuation: CheckedContinuation<Outcome, Never>) in
      // `stateUpdateHandler` can fire more than once and the timeout races all of it, so resuming is
      // guarded rather than assumed: a second resume of a checked continuation traps.
      let resumed = OSAllocatedUnfairLock(initialState: false)
      let finish: @Sendable (Outcome) -> Void = { value in
        let shouldResume = resumed.withLock { done -> Bool in
          if done { return false }
          done = true
          return true
        }
        if shouldResume { continuation.resume(returning: value) }
      }

      listener.stateUpdateHandler = { state in
        switch state {
        case .ready: finish(.bound)
        case .failed(let error): finish(.refused("\(error)"))
        case .cancelled: finish(.refused("cancelled"))
        default: break
        }
      }
      listener.start(queue: .global())

      Task {
        try? await Task.sleep(for: .seconds(3))
        finish(.refused("timed out waiting for the listener to become ready"))
      }
    }

    listener.cancel()
    return outcome
  }

  public static func report(ports: [Int]) async -> [String: String] {
    var result: [String: String] = [:]
    for port in ports {
      result["\(port)"] = await probe(port: port).description
    }
    return result
  }
}
