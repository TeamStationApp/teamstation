/// The paired radar's link as Settings describes it.
public struct RadarStatus: Equatable, Sendable {
  public enum Power: Sendable {
    case unknown
    case on
    case off
  }

  public enum Link: Sendable {
    case off
    case searching
    case connecting
    case connected
    case bluetoothOff
  }

  public var serial: String?
  public var link: Link?
  public var power: Power
  public var batteryPercent: Int?
  /// While pairing: the unpaired radars in range.
  public var nearby: [String]
  public var pairing: Bool

  public init(
    serial: String? = nil,
    link: Link? = nil,
    power: Power = .unknown,
    batteryPercent: Int? = nil,
    nearby: [String] = [],
    pairing: Bool = false
  ) {
    self.serial = serial
    self.link = link
    self.power = power
    self.batteryPercent = batteryPercent
    self.nearby = nearby
    self.pairing = pairing
  }

  public var isPaired: Bool { serial != nil }

  /// The status line: Bluetooth first, then whether a radar is paired, then its link.
  public var text: String {
    if power == .off { return "Bluetooth off" }
    guard serial != nil, let link else { return "No radar paired" }
    switch link {
    case .off: return "Off"
    case .searching: return "Searching"
    case .connecting: return "Connecting"
    case .connected: return "Connected"
    case .bluetoothOff: return "Bluetooth off"
    }
  }
}
