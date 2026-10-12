import Foundation

/// Whether the phone's Bluetooth can be used. `unknown` until the system has said, which is also
/// while the permission prompt is up.
public enum RadarPower: Sendable, Equatable {
  case unknown
  case on
  case off
}

/// What one radio reports back to the session or fleet that owns it, on the main actor.
@MainActor
public protocol RadarRadioListener: AnyObject {
  func radioPowerChanged(_ power: RadarPower)
  /// A nearby TAG One advertised under `name`.
  func radioDiscovered(_ name: String)
  func radioConnected()
  /// The command characteristic was found and the notifiers are on: the handshake can start.
  func radioReady()
  /// The link dropped, or the connect failed.
  func radioDisconnected()
  func radioReceived(_ bytes: [UInt8])
}

/// One Bluetooth central, as `RadarSession` and `RadarFleet` use it. The production radio is
/// `CoreBluetoothRadarRadio`; tests drive a fake through the listener.
@MainActor
public protocol RadarRadio: AnyObject {
  var listener: RadarRadioListener? { get set }
  var power: RadarPower { get }
  /// Reports every TAG One in range through `radioDiscovered` until `stopScan`.
  func startScan()
  func stopScan()
  /// Connects to the peripheral last discovered under `name`.
  func connect(_ name: String)
  func disconnect()
  func write(_ bytes: [UInt8])
}

enum RadarName {
  static func isTag(_ name: String?) -> Bool {
    guard let name else { return false }
    return name.uppercased().hasPrefix("ADFA")
  }
}
