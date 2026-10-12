import CameramanCore
import CoreBluetooth
import Foundation

/// Connects to one paired TAG One and publishes its battery and pitch/exit.
///
/// The radio stays down while `enabled` is false, so a second camera can take the gun. The battery
/// byte is the standard Battery Level characteristic, already a percent from 0 to 100.
public final class RadarSession: NSObject, @unchecked Sendable {
  public var onChange: (@MainActor (RadarSnapshot) -> Void)?
  /// A pitch or exit that just arrived. Expiry to a dash does not call this.
  public var onSpeeds: (@Sendable (Int, Int) -> Void)?

  private let defaults: UserDefaults
  private var central: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var writeCharacteristic: CBCharacteristic?
  private var snapshot = RadarSnapshot()
  private var pitch: (mph: Int, at: Date)?
  private var exit: (mph: Int, at: Date)?
  private var handshake: Task<Void, Never>?
  private var keepalive: Task<Void, Never>?
  private var didHandshake = false

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    super.init()
    snapshot.enabled = defaults.object(forKey: Keys.enabled) as? Bool ?? false
    snapshot.serial = defaults.string(forKey: Keys.serial)
    snapshot.status = snapshot.enabled ? "Idle" : "Off"
  }

  public func start() {
    guard snapshot.enabled else {
      publish()
      return
    }
    ensureCentral()
  }

  public func setEnabled(_ enabled: Bool) {
    defaults.set(enabled, forKey: Keys.enabled)
    snapshot.enabled = enabled
    if !enabled {
      stopRadio()
      snapshot.connected = false
      snapshot.pairing = false
      snapshot.choices = []
      snapshot.status = "Off"
      snapshot.readout = nil
    } else {
      snapshot.status = "Idle"
      ensureCentral()
      refresh()
    }
    publish()
  }

  public func openPairing() {
    guard snapshot.enabled else { return }
    snapshot.pairing = true
    snapshot.choices = []
    ensureCentral()
    refresh()
    publish()
  }

  public func dismissPairing() {
    snapshot.pairing = false
    refresh()
    publish()
  }

  public func pair(_ name: String) {
    guard name.uppercased().hasPrefix("ADFA") else { return }
    defaults.set(name, forKey: Keys.serial)
    snapshot.serial = name
    snapshot.pairing = false
    snapshot.choices = []
    refresh()
    publish()
  }

  public func unpair() {
    defaults.removeObject(forKey: Keys.serial)
    snapshot.serial = nil
    snapshot.connected = false
    snapshot.pairing = false
    pitch = nil
    exit = nil
    stopRadio()
    snapshot.status = snapshot.enabled ? "Idle" : "Off"
    snapshot.readout = nil
    publish()
  }

  private func ensureCentral() {
    if central == nil {
      central = CBCentralManager(delegate: self, queue: .main)
    }
  }

  private func refresh() {
    guard snapshot.enabled, central?.state == .poweredOn else {
      central?.stopScan()
      return
    }
    if snapshot.serial == nil && !snapshot.pairing {
      central?.stopScan()
      if peripheral != nil { stopRadio() }
      snapshot.connected = false
      snapshot.status = "Idle"
      return
    }
    if peripheral?.state == .connected {
      central?.stopScan()
      return
    }
    central?.scanForPeripherals(withServices: nil, options: [
      CBCentralManagerScanOptionAllowDuplicatesKey: false
    ])
    snapshot.status = snapshot.serial == nil ? "Scanning" : "Connecting"
  }

  private func stopRadio() {
    handshake?.cancel()
    keepalive?.cancel()
    handshake = nil
    keepalive = nil
    didHandshake = false
    central?.stopScan()
    if let peripheral {
      central?.cancelPeripheralConnection(peripheral)
    }
    peripheral = nil
    writeCharacteristic = nil
  }

  private func publish() {
    rebuildReadout()
    let next = snapshot
    let callback = onChange
    Task { @MainActor in
      callback?(next)
    }
  }

  private func rebuildReadout() {
    guard snapshot.connected else {
      snapshot.readout = nil
      return
    }
    let now = Date()
    let speeds = side(pitch, now: now) + "/" + side(exit, now: now)
    if let battery = snapshot.batteryPercent {
      snapshot.readout = "⚡\(battery)% \(speeds)"
    } else {
      snapshot.readout = speeds
    }
  }

  private func side(_ slot: (mph: Int, at: Date)?, now: Date) -> String {
    guard let slot else { return "–" }
    return now.timeIntervalSince(slot.at) < 5 ? String(slot.mph) : "–"
  }

  private func noteSpeed(pitchMph: Int, exitMph: Int) {
    let now = Date()
    if pitchMph > 0 { pitch = (pitchMph, now) }
    if exitMph > 0 { exit = (exitMph, now) }
    if pitchMph > 0 || exitMph > 0 { onSpeeds?(pitchMph, exitMph) }
  }

  private static func isTag(_ name: String?) -> Bool {
    guard let name else { return false }
    return name.uppercased().hasPrefix("ADFA")
  }

  private enum Keys {
    static let enabled = "app.teamstation.cameraman.radar.enabled"
    static let serial = "app.teamstation.cameraman.radar.serial"
  }
}

extension RadarSession: CBCentralManagerDelegate {
  public func centralManagerDidUpdateState(_ central: CBCentralManager) {
    if central.state != .poweredOn {
      snapshot.connected = false
      snapshot.status = snapshot.enabled ? "Bluetooth is off" : "Off"
      publish()
      return
    }
    refresh()
    publish()
  }

  public func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
    guard let name, Self.isTag(name) else { return }
    if snapshot.pairing && !snapshot.choices.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) {
      snapshot.choices.append(name)
      publish()
    }
    guard let serial = snapshot.serial, name.caseInsensitiveCompare(serial) == .orderedSame else { return }
    guard self.peripheral == nil else { return }
    self.peripheral = peripheral
    peripheral.delegate = self
    central.stopScan()
    central.connect(peripheral, options: nil)
    snapshot.status = "Connecting"
    publish()
  }

  public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    snapshot.connected = true
    snapshot.status = "Connected"
    publish()
    peripheral.discoverServices(nil)
  }

  public func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    self.peripheral = nil
    snapshot.connected = false
    refresh()
    publish()
  }

  public func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    self.peripheral = nil
    writeCharacteristic = nil
    didHandshake = false
    snapshot.connected = false
    snapshot.readout = nil
    handshake?.cancel()
    keepalive?.cancel()
    refresh()
    publish()
  }
}

extension RadarSession: CBPeripheralDelegate {
  public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    for service in peripheral.services ?? [] {
      peripheral.discoverCharacteristics(nil, for: service)
    }
  }

  public func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    for characteristic in service.characteristics ?? [] {
      let id = characteristic.uuid.uuidString
      if RadarWire.isCommandWrite(id) {
        writeCharacteristic = characteristic
      }
      if characteristic.properties.contains(.notify), RadarWire.shouldNotify(id) {
        peripheral.setNotifyValue(true, for: characteristic)
      }
    }
    if writeCharacteristic != nil, !didHandshake {
      didHandshake = true
      beginHandshake()
    }
  }

  public func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard let value = characteristic.value else { return }
    let bytes = [UInt8](value)
    if bytes.count == 1, bytes[0] <= 100 {
      snapshot.batteryPercent = Int(bytes[0])
      publish()
      return
    }
    if let speeds = RadarWire.pitchExit(bytes) {
      noteSpeed(pitchMph: speeds.pitch, exitMph: speeds.exit)
      publish()
    }
  }

  private func beginHandshake() {
    handshake?.cancel()
    handshake = Task { @MainActor in
      let commands = RadarWire.handshake(now: Date())
      for command in commands {
        if Task.isCancelled { return }
        try? await Task.sleep(for: .seconds(1))
        self.write(command)
      }
      self.keepalive?.cancel()
      self.keepalive = Task { @MainActor in
        while !Task.isCancelled {
          try? await Task.sleep(for: .seconds(25))
          if Task.isCancelled { return }
          self.write(RadarWire.version)
        }
      }
    }
  }

  private func write(_ bytes: [UInt8]) {
    guard let peripheral, let writeCharacteristic else { return }
    peripheral.writeValue(Data(bytes), for: writeCharacteristic, type: .withoutResponse)
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
