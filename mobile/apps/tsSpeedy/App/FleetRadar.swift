import CameramanCapture
import CoreBluetooth
import SpeedyCore

/// The shared TAG One fleet, held to one radar and always on, as TS Speedy's `SpeedyRadar`.
@MainActor
final class FleetRadar: SpeedyRadar {
  /// TS Speedy's own keys, so its pairing is its own and the radar is on from the first launch.
  static let storage = RadarFleet.Storage(
    enabledKey: "app.teamstation.speedy.radar.enabled",
    serialsKey: "app.teamstation.speedy.radar.serial",
    enabledByDefault: true
  )

  let fleet: RadarFleet
  var onChange: (() -> Void)?
  var onSpeeds: ((Int, Int) -> Void)?
  /// Whether the person let TS Speedy use Bluetooth. The shared radio reports a refusal as power
  /// off, so it is read here.
  private let authorization: () -> CBManagerAuthorization

  init(
    fleet: RadarFleet = RadarFleet(storage: FleetRadar.storage, limit: 1),
    authorization: @escaping () -> CBManagerAuthorization = { CBManager.authorization }
  ) {
    self.fleet = fleet
    self.authorization = authorization
    fleet.onChange = { [weak self] in self?.onChange?() }
    // Sessions report on the main actor; the fleet's callback is only marked Sendable.
    fleet.onSpeeds = { [weak self] _, pitch, exit in
      MainActor.assumeIsolated { self?.onSpeeds?(pitch, exit) }
    }
  }

  var status: RadarStatus {
    let device = fleet.devices.first
    return RadarStatus(
      serial: device?.serial,
      link: device.map { Self.link($0.connection) },
      power: Self.refused(authorization()) ? .unauthorized : Self.power(fleet.power),
      batteryPercent: device?.batteryPercent,
      nearby: fleet.nearby,
      pairing: fleet.isScanning
    )
  }

  func start() {
    fleet.start()
    if !fleet.isEnabled { fleet.setEnabled(true) }
  }

  /// Off the screen the radar is turned off, pairing kept, so its link is free for another phone.
  func pause() { fleet.setEnabled(false) }
  func resume() { fleet.setEnabled(true) }

  func startPairing() { fleet.scan() }
  func stopPairing() { fleet.stopScan() }

  func pair(_ name: String) { fleet.pair(name) }

  func unpair() {
    for serial in fleet.serials { fleet.unpair(serial) }
  }

  static func link(_ connection: RadarConnection) -> RadarStatus.Link {
    switch connection {
    case .off: return .off
    case .scanning: return .searching
    case .connecting: return .connecting
    case .connected: return .connected
    case .bluetoothOff: return .bluetoothOff
    }
  }

  static func refused(_ authorization: CBManagerAuthorization) -> Bool {
    authorization == .denied || authorization == .restricted
  }

  static func power(_ power: RadarPower) -> RadarStatus.Power {
    switch power {
    case .unknown: return .unknown
    case .on: return .on
    case .off: return .off
    }
  }
}
