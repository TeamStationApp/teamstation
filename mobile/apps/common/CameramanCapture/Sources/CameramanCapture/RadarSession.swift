import Foundation

/// Connects to one paired TAG One and publishes its connection, battery and pitch/exit.
///
/// `RadarFleet` owns one per paired serial. The radio stays down while the session is disabled, so
/// a second camera can take the gun. The battery byte is the standard Battery Level characteristic,
/// already a percent from 0 to 100.
@MainActor
public final class RadarSession: RadarRadioListener {
  public let serial: String
  public private(set) var state: RadarDeviceState
  /// After every change of `state`.
  var onChange: (() -> Void)?
  /// A pitch or exit that just arrived. Expiry to a dash does not call this.
  var onSpeeds: ((Int, Int) -> Void)?

  private enum Link {
    case down
    case connecting
    case up
  }

  private let makeRadio: @MainActor () -> RadarRadio
  private let pause: @Sendable (Duration) async -> Void
  private let now: () -> Date
  private var radio: RadarRadio?
  private var enabled: Bool
  private var link = Link.down
  private var battery: Int?
  private var pitch: (mph: Int, at: Date)?
  private var exit: (mph: Int, at: Date)?
  private var readingAt: Date?
  private var handshake: Task<Void, Never>?
  private var keepalive: Task<Void, Never>?

  init(
    serial: String,
    enabled: Bool,
    makeRadio: @escaping @MainActor () -> RadarRadio,
    pause: @escaping @Sendable (Duration) async -> Void,
    now: @escaping () -> Date
  ) {
    self.serial = serial
    self.enabled = enabled
    self.makeRadio = makeRadio
    self.pause = pause
    self.now = now
    self.state = RadarDeviceState(serial: serial, connection: .off)
  }

  /// Brings the radio up when enabled, and starts looking for this serial.
  func start() {
    if enabled { ensureRadio() }
    refresh()
  }

  func setEnabled(_ on: Bool) {
    enabled = on
    if on {
      ensureRadio()
    } else {
      dropLink()
    }
    refresh()
  }

  /// Unpaired: the link drops and the radio is let go.
  func stop() {
    enabled = false
    dropLink()
    radio?.listener = nil
    radio = nil
    publish()
  }

  /// The lightning bolt, the percent, a space, and the pitch/exit pair, each side a dash five
  /// seconds after its reading. Nil unless connected.
  func readout(at time: Date) -> String? {
    guard link == .up else { return nil }
    let speeds = side(pitch, now: time) + "/" + side(exit, now: time)
    guard let battery else { return speeds }
    return "⚡\(battery)% \(speeds)"
  }

  // MARK: RadarRadioListener

  public func radioPowerChanged(_ power: RadarPower) {
    if power != .on { dropLink() }
    refresh()
  }

  public func radioDiscovered(_ name: String) {
    guard enabled, link == .down, name.caseInsensitiveCompare(serial) == .orderedSame else { return }
    link = .connecting
    radio?.stopScan()
    radio?.connect(name)
    publish()
  }

  public func radioConnected() {
    guard link != .down else { return }
    link = .up
    publish()
  }

  public func radioReady() {
    guard link == .up else { return }
    beginHandshake()
  }

  public func radioDisconnected() {
    guard link != .down else { return }
    link = .down
    cancelHandshake()
    refresh()
  }

  public func radioReceived(_ bytes: [UInt8]) {
    if bytes.count == 1, bytes[0] <= 100 {
      battery = Int(bytes[0])
      publish()
      return
    }
    guard let speeds = RadarWire.pitchExit(bytes) else { return }
    let time = now()
    if speeds.pitch > 0 { pitch = (speeds.pitch, time) }
    if speeds.exit > 0 { exit = (speeds.exit, time) }
    if speeds.pitch > 0 || speeds.exit > 0 {
      readingAt = time
      onSpeeds?(speeds.pitch, speeds.exit)
    }
    publish()
  }

  // MARK: Private

  private func ensureRadio() {
    guard radio == nil else { return }
    let next = makeRadio()
    next.listener = self
    radio = next
  }

  /// Scans for this serial while the radio is on and nothing is connected or connecting.
  private func refresh() {
    if enabled, let radio, radio.power == .on, link == .down {
      radio.startScan()
    } else {
      radio?.stopScan()
    }
    publish()
  }

  private func dropLink() {
    cancelHandshake()
    radio?.stopScan()
    if link != .down {
      radio?.disconnect()
    }
    link = .down
  }

  private func connection() -> RadarConnection {
    guard enabled, let radio else { return .off }
    if radio.power == .off { return .bluetoothOff }
    switch link {
    case .up: return .connected
    case .connecting: return .connecting
    case .down: return .scanning
    }
  }

  private func publish() {
    state = RadarDeviceState(
      serial: serial,
      connection: connection(),
      batteryPercent: battery,
      pitchMph: pitch?.mph,
      exitMph: exit?.mph,
      readingAt: readingAt
    )
    onChange?()
  }

  private func side(_ slot: (mph: Int, at: Date)?, now: Date) -> String {
    guard let slot else { return "–" }
    return now.timeIntervalSince(slot.at) < 5 ? String(slot.mph) : "–"
  }

  private func cancelHandshake() {
    handshake?.cancel()
    keepalive?.cancel()
    handshake = nil
    keepalive = nil
  }

  /// The six handshake commands a second apart, then the version every 25 seconds while the link
  /// stays up.
  private func beginHandshake() {
    cancelHandshake()
    let pause = self.pause
    let commands = RadarWire.handshake(now: now())
    handshake = Task { [weak self] in
      for command in commands {
        await pause(.seconds(1))
        guard !Task.isCancelled, let self else { return }
        self.radio?.write(command)
      }
      guard !Task.isCancelled, let self else { return }
      self.keepalive = Task { [weak self] in
        while !Task.isCancelled {
          await pause(.seconds(25))
          guard !Task.isCancelled, let self else { return }
          self.radio?.write(RadarWire.version)
        }
      }
    }
  }
}

enum RadarWire {
  static func isCommandWrite(_ uuid: String) -> Bool {
    bare(uuid).contains("6e40ff02b5a3f393e0a95461674f6e65")
  }

  /// Battery Level, plus the gun's custom notifiers. Other Bluetooth SIG characteristics stay quiet.
  static func shouldNotify(_ uuid: String) -> Bool {
    let id = bare(uuid)
    if id == "2a19" || id.hasPrefix("00002a19") { return true }
    if id.count <= 8 || id.hasSuffix("00001000800000805f9b34fb") { return false }
    return true
  }

  private static func bare(_ uuid: String) -> String {
    uuid.replacingOccurrences(of: "-", with: "").lowercased()
  }

  static var version: [UInt8] { wrap([0x65]) }

  static func handshake(now: Date) -> [[UInt8]] {
    let parts = Calendar(identifier: .gregorian).dateComponents(
      [.year, .month, .day, .hour, .minute, .second],
      from: now
    )
    let clock = wrap([
      0x66,
      bcd(parts.year ?? 0),
      bcd(parts.month ?? 0),
      bcd(parts.day ?? 0),
      bcd(parts.hour ?? 0),
      bcd(parts.minute ?? 0),
      bcd(parts.second ?? 0)
    ])
    return [
      version,
      clock,
      version,
      wrap([0x70, 0x00, 0x01]),
      wrap([0x62, 0x00, 0x09, 0x00, 0x66]),
      wrap([0x70, 0x01, 0x03])
    ]
  }

  static func pitchExit(_ bytes: [UInt8]) -> (pitch: Int, exit: Int)? {
    guard bytes.count >= 12, bytes[0] == 0x80, bytes[2] == 0x13 else { return nil }
    let body = Array(bytes.dropFirst(2).prefix(Int(bytes[1])))
    guard body.count >= 10 else { return nil }
    let signed = Int(Int16(bitPattern: UInt16(body[7]) << 8 | UInt16(body[8])))
    let extra = body.count >= 12 ? Int(UInt16(body[9]) << 8 | UInt16(body[10])) : 0
    let primary = mph(signed)
    let extraMph = mph(extra)
    if extraMph == 0 {
      return signed < 0 ? (primary, 0) : (0, primary)
    }
    if signed >= 0 { return (extraMph, primary) }
    return (primary, extraMph)
  }

  private static func mph(_ cms: Int) -> Int {
    if cms == 0 { return 0 }
    return Int((Double(abs(cms)) / 44.704 + 0.5).rounded(.down))
  }

  private static func bcd(_ value: Int) -> UInt8 {
    let v = ((value % 100) + 100) % 100
    return UInt8((v / 10) << 4 | (v % 10))
  }

  private static func wrap(_ body: [UInt8]) -> [UInt8] {
    [0x80, UInt8(body.count)] + body
  }
}
