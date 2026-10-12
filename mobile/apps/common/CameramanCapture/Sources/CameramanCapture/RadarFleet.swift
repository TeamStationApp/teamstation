import CameramanCore
import Foundation

/// Where one paired radar's link stands.
public enum RadarConnection: String, Sendable, Equatable {
  /// The radar is turned off on this phone.
  case off
  /// Looking for the paired serial.
  case scanning
  case connecting
  case connected
  case bluetoothOff
}

/// What the fleet publishes for each paired radar. The speeds are the last nonzero pitch and exit,
/// and `readingAt` is when the latest of them arrived.
public struct RadarDeviceState: Equatable, Sendable {
  public var serial: String
  public var connection: RadarConnection
  public var batteryPercent: Int?
  public var pitchMph: Int?
  public var exitMph: Int?
  public var readingAt: Date?

  public init(
    serial: String,
    connection: RadarConnection,
    batteryPercent: Int? = nil,
    pitchMph: Int? = nil,
    exitMph: Int? = nil,
    readingAt: Date? = nil
  ) {
    self.serial = serial
    self.connection = connection
    self.batteryPercent = batteryPercent
    self.pitchMph = pitchMph
    self.exitMph = exitMph
    self.readingAt = readingAt
  }
}

/// Any number of paired TAG One radars, one `RadarSession` each, up to `limit`.
///
/// `scan()` lists the radars in range that are not paired yet, `pair` and `unpair` change the set,
/// and `setEnabled` turns every session's radio on or off. The serials persist under the host's
/// keys: with a limit of one as the single string Cameraman has always stored, otherwise as a list.
@MainActor
public final class RadarFleet: RadarRadioListener {
  /// The `UserDefaults` keys a host keeps its radar switch and pairings under.
  public struct Storage: Sendable, Equatable {
    public var enabledKey: String
    public var serialsKey: String
    public var enabledByDefault: Bool

    public init(enabledKey: String, serialsKey: String, enabledByDefault: Bool) {
      self.enabledKey = enabledKey
      self.serialsKey = serialsKey
      self.enabledByDefault = enabledByDefault
    }

    /// TS Cameraman's keys, from before the fleet: one serial, and the radar off until turned on.
    public static let cameraman = Storage(
      enabledKey: "app.teamstation.cameraman.radar.enabled",
      serialsKey: "app.teamstation.cameraman.radar.serial",
      enabledByDefault: false
    )
  }

  public let limit: Int
  public private(set) var isEnabled: Bool
  public private(set) var isScanning = false
  /// Radars in range that are not paired, in the order they were heard, while scanning.
  public private(set) var nearby: [String] = []
  public private(set) var devices: [RadarDeviceState] = []
  /// After every change to what the fleet publishes.
  public var onChange: (() -> Void)?
  /// A pitch or exit that just arrived from the radar with this serial.
  public var onSpeeds: (@Sendable (String, Int, Int) -> Void)?

  private let storage: Storage
  private let defaults: UserDefaults
  private let makeRadio: @MainActor () -> RadarRadio
  private let pause: @Sendable (Duration) async -> Void
  private let now: () -> Date
  private var sessions: [RadarSession] = []
  private var scanRadio: RadarRadio?

  public init(
    storage: Storage,
    limit: Int = .max,
    defaults: UserDefaults = .standard,
    makeRadio: @escaping @MainActor () -> RadarRadio = { CoreBluetoothRadarRadio() },
    pause: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
    now: @escaping () -> Date = Date.init
  ) {
    self.storage = storage
    self.limit = max(1, limit)
    self.defaults = defaults
    self.makeRadio = makeRadio
    self.pause = pause
    self.now = now
    self.isEnabled = defaults.object(forKey: storage.enabledKey) as? Bool ?? storage.enabledByDefault
    for serial in Self.storedSerials(defaults.object(forKey: storage.serialsKey)).prefix(self.limit) {
      sessions.append(makeSession(serial))
    }
    devices = sessions.map(\.state)
  }

  public var serials: [String] { sessions.map(\.serial) }

  /// Bluetooth as the fleet's own radio last heard it; `unknown` until the radar is first on.
  public var power: RadarPower { scanRadio?.power ?? .unknown }

  /// Brings every paired radar's radio up when the fleet is enabled.
  public func start() {
    if isEnabled { ensureScanRadio() }
    for session in sessions { session.start() }
    publish()
  }

  public func setEnabled(_ enabled: Bool) {
    defaults.set(enabled, forKey: storage.enabledKey)
    isEnabled = enabled
    if enabled {
      ensureScanRadio()
    } else {
      endScan()
    }
    for session in sessions { session.setEnabled(enabled) }
    publish()
  }

  /// Starts listing radars in range that are not paired. Nothing while the fleet is off.
  public func scan() {
    guard isEnabled else { return }
    isScanning = true
    nearby = []
    ensureScanRadio()
    applyScan()
    publish()
  }

  public func stopScan() {
    endScan()
    publish()
  }

  /// Pairs `serial`, dropping the oldest pairing when the fleet is full. False for a name that is
  /// not a TAG One or is already paired.
  @discardableResult
  public func pair(_ serial: String) -> Bool {
    let name = serial.trimmingCharacters(in: .whitespaces)
    guard RadarName.isTag(name), session(for: name) == nil else { return false }
    while sessions.count >= limit {
      sessions.removeFirst().stop()
    }
    let session = makeSession(name)
    sessions.append(session)
    nearby.removeAll { $0.caseInsensitiveCompare(name) == .orderedSame }
    persist()
    session.start()
    publish()
    return true
  }

  public func unpair(_ serial: String) {
    guard let session = session(for: serial) else { return }
    sessions.removeAll { $0 === session }
    session.stop()
    persist()
    publish()
  }

  /// The single radar as TS Cameraman's Settings and viewfinder draw it, with the status words
  /// they have always shown.
  public func cameramanSnapshot() -> RadarSnapshot {
    let session = sessions.first
    let connected = session?.state.connection == .connected
    return RadarSnapshot(
      enabled: isEnabled,
      serial: session?.serial,
      connected: connected,
      batteryPercent: session?.state.batteryPercent,
      readout: session?.readout(at: now()),
      status: cameramanStatus(session: session, connected: connected),
      choices: nearby,
      pairing: isScanning
    )
  }

  // MARK: RadarRadioListener, for the fleet's scanning radio

  public func radioPowerChanged(_ power: RadarPower) {
    applyScan()
    publish()
  }

  public func radioDiscovered(_ name: String) {
    guard isScanning, RadarName.isTag(name), session(for: name) == nil else { return }
    guard !nearby.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) else { return }
    nearby.append(name)
    publish()
  }

  public func radioConnected() {}
  public func radioReady() {}
  public func radioDisconnected() {}
  public func radioReceived(_ bytes: [UInt8]) {}

  // MARK: Private

  private func cameramanStatus(session: RadarSession?, connected: Bool) -> String {
    guard isEnabled else { return "Off" }
    switch power {
    case .unknown: return "Idle"
    case .off: return "Bluetooth is off"
    case .on:
      if session != nil { return connected ? "Connected" : "Connecting" }
      return isScanning ? "Scanning" : "Idle"
    }
  }

  private func makeSession(_ serial: String) -> RadarSession {
    let session = RadarSession(
      serial: serial,
      enabled: isEnabled,
      makeRadio: makeRadio,
      pause: pause,
      now: now
    )
    session.onChange = { [weak self] in self?.publish() }
    session.onSpeeds = { [weak self] pitch, exit in self?.onSpeeds?(serial, pitch, exit) }
    return session
  }

  private func session(for serial: String) -> RadarSession? {
    sessions.first { $0.serial.caseInsensitiveCompare(serial) == .orderedSame }
  }

  private func ensureScanRadio() {
    guard scanRadio == nil else { return }
    let radio = makeRadio()
    radio.listener = self
    scanRadio = radio
  }

  private func applyScan() {
    if isScanning, let scanRadio, scanRadio.power == .on {
      scanRadio.startScan()
    } else {
      scanRadio?.stopScan()
    }
  }

  private func endScan() {
    isScanning = false
    nearby = []
    scanRadio?.stopScan()
  }

  private func persist() {
    let list = serials
    if list.isEmpty {
      defaults.removeObject(forKey: storage.serialsKey)
    } else if limit == 1 {
      defaults.set(list[0], forKey: storage.serialsKey)
    } else {
      defaults.set(list, forKey: storage.serialsKey)
    }
  }

  private func publish() {
    devices = sessions.map(\.state)
    onChange?()
  }

  /// A single stored serial or a list, keeping the TAG One names once each, in order.
  static func storedSerials(_ value: Any?) -> [String] {
    let raw: [String]
    if let one = value as? String {
      raw = [ one ]
    } else {
      raw = value as? [String] ?? []
    }
    var seen: [String] = []
    for name in raw.map({ $0.trimmingCharacters(in: .whitespaces) }) where RadarName.isTag(name) {
      if !seen.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) {
        seen.append(name)
      }
    }
    return seen
  }
}
