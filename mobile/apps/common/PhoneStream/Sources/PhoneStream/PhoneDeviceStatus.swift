import CameramanCore
import Foundation
import UIKit

/// The phone's battery and heat, for the overlay's pills.
@MainActor
public protocol PhoneDeviceStatusReading: AnyObject {
  /// Nil when the system does not know, as on a simulator.
  func battery() -> BatteryStatus?
  func thermal() -> ThermalBadgeLevel
}

/// `UIDevice`'s battery and `ProcessInfo`'s thermal state, Cameraman's four levels.
@MainActor
public final class SystemDeviceStatus: PhoneDeviceStatusReading {
  public init() {
    UIDevice.current.isBatteryMonitoringEnabled = true
  }

  public func battery() -> BatteryStatus? {
    let device = UIDevice.current
    let charging = device.batteryState == .charging || device.batteryState == .full
    return BatteryStatus(level: Double(device.batteryLevel), isCharging: charging)
  }

  public func thermal() -> ThermalBadgeLevel {
    ThermalBadgeLevel(process: ProcessInfo.processInfo.thermalState)
  }
}
