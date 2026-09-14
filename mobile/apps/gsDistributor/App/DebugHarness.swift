#if DEBUG
import Foundation
import Network

/// Debug builds only, and only when launched with `-harness`: a loopback server on port 8768 that
/// answers `/dump-state` with what the window is showing, so a script can check the app without
/// seeing the screen. Like the Director's and Cameraman's harnesses, it is never in a release.
@MainActor
final class DebugHarness {
  static let port: UInt16 = 8768

  private let model: DistributorModel
  private var listener: NWListener?

  init(model: DistributorModel) {
    self.model = model
  }

  static var isRequested: Bool {
    ProcessInfo.processInfo.arguments.contains("-harness")
  }

  func start() {
    guard listener == nil else { return }
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: Self.port)!)
    guard let listener = try? NWListener(using: parameters) else { return }
    listener.newConnectionHandler = { [weak self] connection in
      Task { @MainActor in self?.serve(connection) }
    }
    listener.start(queue: .main)
    self.listener = listener
  }

  private func serve(_ connection: NWConnection) {
    connection.start(queue: .main)
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] _, _, _, _ in
      Task { @MainActor in
        guard let self else { return }
        let body = (try? JSONSerialization.data(withJSONObject: self.state(), options: [ .prettyPrinted, .sortedKeys ]))
          ?? Data("{}".utf8)
        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
      }
    }
  }

  private func state() -> [String: Any] {
    var link: [String: Any] = [:]
    switch model.link {
    case .waitingForIPad:
      link["state"] = "waitingForIPad"
    case .waitingForDirector(let serial):
      link["state"] = "waitingForDirector"
      link["serial"] = serial
    case .connected(let hello):
      link["state"] = "connected"
      link["directorVersion"] = hello.directorVersion
      link["sessionID"] = hello.sessionID.uuidString
      link["isRecording"] = hello.isRecording
    case .failed(let reason):
      link["state"] = "failed"
      link["reason"] = reason
    }
    return [
      "link": link,
      "devices": model.devices.map { [ "serial": $0.serial, "deviceID": $0.deviceID ] },
      "recordings": model.recordings.map { recording in
        [
          "id": recording.id,
          "isLive": recording.isLive,
          "cameras": recording.cameras.map(\.name)
        ] as [String: Any]
      },
      "settingsLoaded": model.settings != nil,
      "destination": model.destination?.path ?? NSNull(),
      "createCombined": model.settings?.createCombined ?? NSNull(),
      "problem": model.problem ?? NSNull()
    ]
  }
}
#endif
