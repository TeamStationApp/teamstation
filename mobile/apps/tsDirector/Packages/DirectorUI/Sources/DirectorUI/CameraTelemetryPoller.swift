import CameramanCore
import DirectorRTSP
import DirectorSources
import Foundation

/// Reads a Cameraman's thermal state and battery every few seconds for the tile pills.
///
/// Its own control-only connection, like the control screen's, so the media session stays
/// untouched. Slow on purpose: a pill that lags five seconds is fine, and five phones polling at
/// 1 Hz would be a hundred requests a minute the grid does not need. Stops reporting when the
/// phone stops answering, so the tile shows its last known reading rather than a guess.
@MainActor
final class CameraTelemetryPoller {
  struct Reading: Sendable, Equatable {
    var thermal: String?
    var batteryPercent: Int?
    var batteryCharging: Bool
  }

  static let interval: Duration = .seconds(5)
  private static let body = [
    CameraParameterName.systemThermal,
    CameraParameterName.systemBattery,
    CameraParameterName.systemBatteryCharging
  ].map { "\($0)\r\n" }.joined()

  let endpoint: CameraEndpoint
  private let session: RTSPParameterSession
  private let onReading: (Reading) -> Void
  private var task: Task<Void, Never>?

  init(endpoint: CameraEndpoint, onReading: @escaping (Reading) -> Void) {
    self.endpoint = endpoint
    self.onReading = onReading
    session = RTSPParameterSession(
      host: endpoint.host,
      port: endpoint.port,
      path: endpoint.path,
      userAgent: "TS Director/1.0"
    )
  }

  func start() {
    guard task == nil else { return }
    session.start()
    task = Task { [weak self] in
      while !Task.isCancelled {
        await self?.poll()
        try? await Task.sleep(for: Self.interval)
      }
    }
  }

  func stop() {
    task?.cancel()
    task = nil
    session.stop()
  }

  private func poll() async {
    guard let reply = try? await session.get(Self.body), reply.isSuccess,
          case .success(let set) = CameraParameterSet.decode(reply.body)
    else { return }
    onReading(Reading(
      thermal: set[CameraParameterName.systemThermal],
      batteryPercent: set[CameraParameterName.systemBattery].flatMap(Int.init),
      batteryCharging: set[CameraParameterName.systemBatteryCharging]?.lowercased() == "true"
    ))
  }
}
