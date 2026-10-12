import CameramanCapture
import Foundation

/// The phone's radars as the overlay's Radar card shows them: on or off, Bluetooth, every paired
/// radar with its connection, battery and last speeds, and what a scan has found.
public struct PhoneRadarState: Sendable, Equatable {
  public var enabled: Bool
  public var scanning: Bool
  public var bluetooth: RadarPower
  public var devices: [RadarDeviceState]
  /// Radars in range that are not paired, while scanning.
  public var nearby: [String]

  public init(
    enabled: Bool,
    scanning: Bool,
    bluetooth: RadarPower,
    devices: [RadarDeviceState],
    nearby: [String]
  ) {
    self.enabled = enabled
    self.scanning = scanning
    self.bluetooth = bluetooth
    self.devices = devices
    self.nearby = nearby
  }
}

extension RadarFleet.Storage {
  /// The phone's radar switch and pairings: any number of radars, off until turned on.
  public static let phoneStream = RadarFleet.Storage(
    enabledKey: "app.teamstation.phoneStream.radar.enabled",
    serialsKey: "app.teamstation.phoneStream.radar.serials",
    enabledByDefault: false
  )
}

/// Any number of paired radars, through TS Cameraman's `RadarFleet`.
@MainActor
public final class PhoneRadar {
  public let fleet: RadarFleet
  /// After every change the fleet publishes.
  public var onChange: ((PhoneRadarState) -> Void)?
  private var started = false

  public init(fleet: RadarFleet) {
    self.fleet = fleet
    fleet.onChange = { [weak self] in
      guard let self else { return }
      self.onChange?(self.state)
    }
  }

  public var state: PhoneRadarState {
    PhoneRadarState(
      enabled: fleet.isEnabled,
      scanning: fleet.isScanning,
      bluetooth: fleet.power,
      devices: fleet.devices,
      nearby: fleet.nearby
    )
  }

  /// Brings the paired radars up when the radar is on. Once; later calls change nothing.
  public func start() {
    guard !started else { return }
    started = true
    fleet.start()
  }

  public func setEnabled(_ enabled: Bool) { fleet.setEnabled(enabled) }
  public func scan() { fleet.scan() }
  public func stopScan() { fleet.stopScan() }
  @discardableResult
  public func pair(_ serial: String) -> Bool { fleet.pair(serial) }
  public func unpair(_ serial: String) { fleet.unpair(serial) }
}
