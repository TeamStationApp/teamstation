import Foundation

/// What the operating screen and Settings draw for the TAG One.
///
/// `readout` is the lightning bolt, the percent, a space, and the pitch/exit pair, and only while
/// the link is up. `enabled` is the switch that keeps this phone off the radio so another camera
/// can hold it.
public struct RadarSnapshot: Equatable, Sendable {
  public var enabled: Bool
  public var serial: String?
  public var connected: Bool
  public var batteryPercent: Int?
  public var readout: String?
  public var status: String
  public var choices: [String]
  public var pairing: Bool

  public init(
    enabled: Bool = false,
    serial: String? = nil,
    connected: Bool = false,
    batteryPercent: Int? = nil,
    readout: String? = nil,
    status: String = "Off",
    choices: [String] = [],
    pairing: Bool = false
  ) {
    self.enabled = enabled
    self.serial = serial
    self.connected = connected
    self.batteryPercent = batteryPercent
    self.readout = readout
    self.status = status
    self.choices = choices
    self.pairing = pairing
  }
}

/// The phone's own environment conforms. A remote model does not, and the shared screen skips the
/// radar chrome.
@MainActor
public protocol RadarControlling: AnyObject {
  var radar: RadarSnapshot { get }
  func setRadarEnabled(_ enabled: Bool)
  func openRadarPairing()
  func dismissRadarPairing()
  func pairRadar(_ serial: String)
  func unpairRadar()
}
