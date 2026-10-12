@testable import CameramanCapture
import CameramanCore
@testable import CameramanUI
import EventControl
import Foundation
import Testing

/// A radio the tests drive by hand: power, advertisements, the link and the radar's bytes.
@MainActor
final class FakeRadarRadio: RadarRadio {
  weak var listener: RadarRadioListener?
  var power: RadarPower = .unknown
  private(set) var scanning = false
  private(set) var scans = 0
  private(set) var connects: [String] = []
  private(set) var disconnects = 0
  private(set) var writes: [[UInt8]] = []

  func startScan() {
    scanning = true
    scans += 1
  }

  func stopScan() {
    scanning = false
  }

  func connect(_ name: String) {
    connects.append(name)
  }

  func disconnect() {
    disconnects += 1
  }

  func write(_ bytes: [UInt8]) {
    writes.append(bytes)
  }

  func setPower(_ next: RadarPower) {
    power = next
    listener?.radioPowerChanged(next)
  }

  /// Advertises, connects and reports the command characteristic, as a radar in range does.
  func bringUp(_ name: String) {
    listener?.radioDiscovered(name)
    listener?.radioConnected()
  }
}

/// Every radio the fleet makes, in order: the fleet's own scanning radio first once it is on, then
/// one per session.
@MainActor
final class RadarBench {
  var radios: [FakeRadarRadio] = []
  var power: RadarPower = .on
  let defaults: UserDefaults
  var clock = Date(timeIntervalSince1970: 1_800_000_000)

  init() {
    defaults = UserDefaults(suiteName: "RadarFleetTests-\(UUID().uuidString)")!
  }

  func fleet(
    storage: RadarFleet.Storage = RadarBench.phone,
    limit: Int = .max,
    pause: @escaping @Sendable (Duration) async -> Void = { _ in }
  ) -> RadarFleet {
    RadarFleet(
      storage: storage,
      limit: limit,
      defaults: defaults,
      makeRadio: { [unowned self] in
        let radio = FakeRadarRadio()
        radio.power = self.power
        self.radios.append(radio)
        return radio
      },
      pause: pause,
      now: { [unowned self] in self.clock }
    )
  }

  /// The radio whose listener is the session for `serial`.
  func radio(for serial: String) -> FakeRadarRadio? {
    radios.first { ($0.listener as? RadarSession)?.serial == serial }
  }

  var scanRadio: FakeRadarRadio? {
    radios.first { $0.listener is RadarFleet }
  }

  static let phone = RadarFleet.Storage(
    enabledKey: "test.radar.enabled",
    serialsKey: "test.radar.serials",
    enabledByDefault: true
  )
}

/// A speed packet the way the TAG One sends it: a negative primary speed is a pitch, a positive
/// one an exit, in centimetres per second.
func radarSpeedPacket(signedCms: Int, extraCms: Int = 0) -> [UInt8] {
  let signed = UInt16(bitPattern: Int16(signedCms))
  let extra = UInt16(extraCms)
  let body: [UInt8] = [
    0x13, 0, 0, 0, 0, 0, 0,
    UInt8(signed >> 8), UInt8(signed & 0xFF),
    UInt8(extra >> 8), UInt8(extra & 0xFF),
    0
  ]
  return [ 0x80, UInt8(body.count) ] + body
}

/// 72 mph, in the radar's centimetres per second.
let seventyTwoMph = 3_219
/// 88 mph.
let eightyEightMph = 3_934

@Suite("Radar fleet")
@MainActor
struct RadarFleetTests {
  @Test
  func twoRadarsPairAndOneUnpairs() {
    let bench = RadarBench()
    let fleet = bench.fleet()
    fleet.start()
    #expect(fleet.pair("ADFA0000001"))
    #expect(fleet.pair("ADFA0000002"))
    #expect(!fleet.pair("adfa0000001"), "the same radar twice")
    #expect(!fleet.pair("Headphones"))
    #expect(fleet.serials == [ "ADFA0000001", "ADFA0000002" ])
    #expect(fleet.devices.map(\.connection) == [ .scanning, .scanning ])
    #expect(bench.radio(for: "ADFA0000001")?.scanning == true)
    #expect(bench.radio(for: "ADFA0000002")?.scanning == true)

    let first = bench.radio(for: "ADFA0000001")
    first?.bringUp("ADFA0000001")
    fleet.unpair("ADFA0000001")
    #expect(fleet.serials == [ "ADFA0000002" ])
    #expect(fleet.devices.map(\.serial) == [ "ADFA0000002" ])
    #expect(first?.disconnects == 1)
    #expect(first?.listener == nil)
    fleet.unpair("ADFA0000009")
    #expect(fleet.serials == [ "ADFA0000002" ])
  }

  @Test
  func eachRadarHasItsOwnConnectionAndBattery() {
    let bench = RadarBench()
    let fleet = bench.fleet()
    var changes = 0
    fleet.onChange = { changes += 1 }
    fleet.start()
    fleet.pair("ADFA0000001")
    fleet.pair("ADFA0000002")
    let one = bench.radio(for: "ADFA0000001")!
    let two = bench.radio(for: "ADFA0000002")!

    // Another radar's advertisement does not connect this session.
    one.listener?.radioDiscovered("ADFA0000002")
    #expect(one.connects.isEmpty)
    one.listener?.radioDiscovered("ADFA0000001")
    #expect(one.connects == [ "ADFA0000001" ])
    #expect(!one.scanning)
    #expect(fleet.devices[0].connection == .connecting)
    one.listener?.radioDiscovered("ADFA0000001")
    #expect(one.connects.count == 1, "connecting does not connect again")
    one.listener?.radioConnected()
    one.listener?.radioReceived([ 85 ])
    two.listener?.radioReceived([ 40 ])
    #expect(fleet.devices[0] == RadarDeviceState(serial: "ADFA0000001", connection: .connected, batteryPercent: 85))
    #expect(fleet.devices[1] == RadarDeviceState(serial: "ADFA0000002", connection: .scanning, batteryPercent: 40))

    // A drop goes back to looking for the serial.
    one.listener?.radioDisconnected()
    #expect(fleet.devices[0].connection == .scanning)
    #expect(one.scanning)
    one.listener?.radioDisconnected()
    one.listener?.radioConnected()
    #expect(fleet.devices[0].connection == .scanning, "a stray connect with no connect asked for")

    two.setPower(.off)
    #expect(fleet.devices[1].connection == .bluetoothOff)
    #expect(!two.scanning)
    #expect(changes > 0)
  }

  @Test
  func aReadingUpdatesOnlyItsOwnRadar() {
    let bench = RadarBench()
    let fleet = bench.fleet()
    let heard = HeardSpeeds()
    fleet.onSpeeds = { serial, pitch, exit in
      MainActor.assumeIsolated { heard.lines.append("\(serial) \(pitch)/\(exit)") }
    }
    fleet.start()
    fleet.pair("ADFA0000001")
    fleet.pair("ADFA0000002")
    let one = bench.radio(for: "ADFA0000001")!
    let two = bench.radio(for: "ADFA0000002")!
    one.bringUp("ADFA0000001")
    two.bringUp("ADFA0000002")

    one.listener?.radioReceived(radarSpeedPacket(signedCms: -seventyTwoMph))
    #expect(fleet.devices[0].pitchMph == 72)
    #expect(fleet.devices[0].exitMph == nil)
    #expect(fleet.devices[0].readingAt == bench.clock)
    #expect(fleet.devices[1].pitchMph == nil)
    #expect(fleet.devices[1].readingAt == nil)

    bench.clock += 2
    two.listener?.radioReceived(radarSpeedPacket(signedCms: eightyEightMph))
    #expect(fleet.devices[1].exitMph == 88)
    #expect(fleet.devices[1].readingAt == bench.clock)
    #expect(fleet.devices[0].exitMph == nil)
    #expect(heard.lines == [ "ADFA0000001 72/0", "ADFA0000002 0/88" ])

    // Bytes that are neither a battery nor a speed change nothing, and a zero speed is no reading.
    one.listener?.radioReceived([ 1, 2, 3 ])
    one.listener?.radioReceived(radarSpeedPacket(signedCms: 0))
    #expect(fleet.devices[0].readingAt == bench.clock - 2)
    #expect(heard.lines.count == 2)
  }

  @Test
  func scanListsOnlyRadarsThatAreNotPaired() {
    let bench = RadarBench()
    let fleet = bench.fleet()
    fleet.start()
    fleet.pair("ADFA0000001")
    fleet.scan()
    let scanner = bench.scanRadio!
    #expect(scanner.scanning)
    #expect(fleet.isScanning)
    scanner.listener?.radioDiscovered("ADFA0000001")
    scanner.listener?.radioDiscovered("adfa0000001")
    scanner.listener?.radioDiscovered("ADFA0000002")
    scanner.listener?.radioDiscovered("ADFA0000002")
    scanner.listener?.radioDiscovered("Headphones")
    scanner.listener?.radioDiscovered("ADFA0000003")
    #expect(fleet.nearby == [ "ADFA0000002", "ADFA0000003" ])

    // Pairing one takes it off the list; the scan keeps going until stopped.
    fleet.pair("ADFA0000002")
    #expect(fleet.nearby == [ "ADFA0000003" ])
    #expect(fleet.isScanning)
    fleet.stopScan()
    #expect(!scanner.scanning)
    #expect(fleet.nearby.isEmpty)
    scanner.listener?.radioDiscovered("ADFA0000004")
    #expect(fleet.nearby.isEmpty, "nothing is listed once the scan stops")

    // The scanning radio's other callbacks are not the fleet's business.
    scanner.listener?.radioConnected()
    scanner.listener?.radioReady()
    scanner.listener?.radioDisconnected()
    scanner.listener?.radioReceived([ 50 ])
    #expect(fleet.devices.map(\.batteryPercent) == [ nil, nil ])
  }

  @Test
  func aScanWaitsForBluetooth() {
    let bench = RadarBench()
    bench.power = .unknown
    let fleet = bench.fleet()
    fleet.start()
    fleet.scan()
    let scanner = bench.scanRadio!
    #expect(!scanner.scanning)
    scanner.setPower(.on)
    #expect(scanner.scanning)
    #expect(fleet.power == .on)
    scanner.setPower(.off)
    #expect(!scanner.scanning)
    #expect(fleet.power == .off)
  }

  @Test
  func disablingStopsEverySession() {
    let bench = RadarBench()
    let fleet = bench.fleet()
    fleet.start()
    fleet.pair("ADFA0000001")
    fleet.pair("ADFA0000002")
    fleet.scan()
    let one = bench.radio(for: "ADFA0000001")!
    let two = bench.radio(for: "ADFA0000002")!
    one.bringUp("ADFA0000001")

    fleet.setEnabled(false)
    #expect(fleet.devices.map(\.connection) == [ .off, .off ])
    #expect(one.disconnects == 1)
    #expect(!one.scanning)
    #expect(!two.scanning)
    #expect(two.disconnects == 0, "a radar that never connected has nothing to drop")
    #expect(!fleet.isScanning)
    #expect(!bench.scanRadio!.scanning)
    #expect(bench.defaults.object(forKey: RadarBench.phone.enabledKey) as? Bool == false)
    fleet.scan()
    #expect(!fleet.isScanning, "no scan while off")

    fleet.setEnabled(true)
    #expect(fleet.devices.map(\.connection) == [ .scanning, .scanning ])
    #expect(one.scanning)
    #expect(two.scanning)
  }

  @Test
  func aRadarPairedWhileOffWaitsForTheSwitch() {
    let bench = RadarBench()
    bench.defaults.set(false, forKey: RadarBench.phone.enabledKey)
    let fleet = bench.fleet()
    fleet.start()
    fleet.pair("ADFA0000001")
    #expect(bench.radios.isEmpty, "no radio, and so no Bluetooth prompt, while the radar is off")
    #expect(fleet.devices.map(\.connection) == [ .off ])
    fleet.setEnabled(true)
    #expect(fleet.devices.map(\.connection) == [ .scanning ])
  }

  @Test
  func pairingsPersistAcrossARestart() {
    let bench = RadarBench()
    let fleet = bench.fleet()
    fleet.start()
    fleet.pair("ADFA0000001")
    fleet.pair("ADFA0000002")
    #expect(bench.defaults.stringArray(forKey: RadarBench.phone.serialsKey) == [ "ADFA0000001", "ADFA0000002" ])

    let again = bench.fleet()
    #expect(again.serials == [ "ADFA0000001", "ADFA0000002" ])
    #expect(again.isEnabled)
    again.start()
    #expect(again.devices.map(\.connection) == [ .scanning, .scanning ])

    again.unpair("ADFA0000001")
    again.unpair("ADFA0000002")
    #expect(bench.defaults.object(forKey: RadarBench.phone.serialsKey) == nil)
    #expect(bench.fleet().serials.isEmpty)
  }

  @Test
  func theRadioSubscribesToBatteryAndTheGunsNotifiersAndWritesCommandsToItsOwn() {
    #expect(RadarWire.isCommandWrite("6E40FF02-B5A3-F393-E0A9-5461674F6E65"))
    #expect(!RadarWire.isCommandWrite("6E40FF03-B5A3-F393-E0A9-5461674F6E65"))
    #expect(RadarWire.shouldNotify("2A19"))
    #expect(RadarWire.shouldNotify("00002A19-0000-1000-8000-00805F9B34FB"))
    #expect(!RadarWire.shouldNotify("2A29"))
    #expect(!RadarWire.shouldNotify("00002A29-0000-1000-8000-00805F9B34FB"))
    #expect(RadarWire.shouldNotify("6E40FF03-B5A3-F393-E0A9-5461674F6E65"))
    #expect(RadarName.isTag("adfa0000001"))
    #expect(!RadarName.isTag(nil))
  }

  @Test
  func storedSerialsKeepTagNamesOnce() {
    #expect(RadarFleet.storedSerials(nil).isEmpty)
    #expect(RadarFleet.storedSerials(7).isEmpty)
    #expect(RadarFleet.storedSerials(" ADFA0000001 ") == [ "ADFA0000001" ])
    #expect(RadarFleet.storedSerials("Headphones").isEmpty)
    #expect(
      RadarFleet.storedSerials([ "ADFA0000001", "x", "adfa0000001", "ADFA0000002" ])
        == [ "ADFA0000001", "ADFA0000002" ]
    )
  }

  @Test
  func aFullFleetDropsItsOldestPairing() {
    let bench = RadarBench()
    let fleet = bench.fleet(limit: 2)
    fleet.start()
    fleet.pair("ADFA0000001")
    fleet.pair("ADFA0000002")
    fleet.pair("ADFA0000003")
    #expect(fleet.serials == [ "ADFA0000002", "ADFA0000003" ])
    #expect(bench.fleet(limit: 2).serials == [ "ADFA0000002", "ADFA0000003" ])
    #expect(bench.fleet(limit: 1).serials == [ "ADFA0000002" ], "a stored list longer than the limit is cut")
  }

  @Test
  func theHandshakeRunsThenTheKeepaliveUntilTheLinkDrops() async {
    let bench = RadarBench()
    let keepalives = KeepaliveTicks()
    let fleet = bench.fleet(pause: { duration in
      // Every handshake pause and the first keepalive pass at once; the second keepalive waits.
      if duration == .seconds(25), await keepalives.next() > 1 {
        try? await Task.sleep(for: .seconds(3_600))
      }
    })
    fleet.start()
    fleet.pair("ADFA0000001")
    let radio = bench.radio(for: "ADFA0000001")!
    radio.listener?.radioReady()
    #expect(radio.writes.isEmpty, "no handshake before the link is up")
    radio.bringUp("ADFA0000001")
    radio.listener?.radioReady()
    #expect(await eventually { radio.writes.count == 7 })
    let handshake = RadarWire.handshake(now: bench.clock)
    #expect(Array(radio.writes.prefix(6)) == handshake)
    #expect(radio.writes[6] == RadarWire.version)

    radio.listener?.radioDisconnected()
    try? await Task.sleep(for: .milliseconds(50))
    #expect(radio.writes.count == 7)
  }

  @Test
  func aDroppedLinkStopsTheHandshake() async {
    let bench = RadarBench()
    let fleet = bench.fleet(pause: { _ in try? await Task.sleep(for: .seconds(3_600)) })
    fleet.start()
    fleet.pair("ADFA0000001")
    let radio = bench.radio(for: "ADFA0000001")!
    radio.bringUp("ADFA0000001")
    radio.listener?.radioReady()
    radio.setPower(.off)
    #expect(fleet.devices[0].connection == .bluetoothOff)
    #expect(radio.disconnects == 1)
    try? await Task.sleep(for: .milliseconds(50))
    #expect(radio.writes.isEmpty)
  }
}

@MainActor
final class HeardSpeeds {
  var lines: [String] = []
}

actor KeepaliveTicks {
  private var count = 0

  func next() -> Int {
    count += 1
    return count
  }
}

@Suite("Radar fleet in Cameraman", .serialized)
@MainActor
struct RadarFleetCameramanTests {
  @Test
  func cameramanKeysAreReadAndWrittenAsBefore() {
    let bench = RadarBench()
    let keys = RadarFleet.Storage.cameraman
    #expect(keys.enabledKey == "app.teamstation.cameraman.radar.enabled")
    #expect(keys.serialsKey == "app.teamstation.cameraman.radar.serial")

    // Off until turned on, as before.
    let fresh = bench.fleet(storage: .cameraman, limit: 1)
    #expect(!fresh.isEnabled)

    // A serial stored by an earlier build is the pairing.
    bench.defaults.set(true, forKey: keys.enabledKey)
    bench.defaults.set("ADFA0000001", forKey: keys.serialsKey)
    let fleet = bench.fleet(storage: .cameraman, limit: 1)
    #expect(fleet.serials == [ "ADFA0000001" ])
    #expect(fleet.isEnabled)

    // Pairing another replaces it, stored as the same single string.
    fleet.start()
    fleet.pair("ADFA0000002")
    #expect(fleet.serials == [ "ADFA0000002" ])
    #expect(bench.defaults.object(forKey: keys.serialsKey) as? String == "ADFA0000002")
    fleet.setEnabled(false)
    #expect(bench.defaults.object(forKey: keys.enabledKey) as? Bool == false)
    fleet.unpair("ADFA0000002")
    #expect(bench.defaults.object(forKey: keys.serialsKey) == nil)
  }

  @Test
  func theSnapshotShowsTheWordsCameramanAlwaysHas() {
    let bench = RadarBench()
    bench.power = .unknown
    let fleet = bench.fleet(storage: .cameraman, limit: 1)
    fleet.start()
    #expect(fleet.cameramanSnapshot() == RadarSnapshot(enabled: false, status: "Off"))

    fleet.setEnabled(true)
    #expect(fleet.cameramanSnapshot().status == "Idle", "Bluetooth has not answered yet")
    let scanner = bench.scanRadio!
    scanner.setPower(.off)
    #expect(fleet.cameramanSnapshot().status == "Bluetooth is off")
    scanner.setPower(.on)
    #expect(fleet.cameramanSnapshot().status == "Idle")

    fleet.scan()
    scanner.listener?.radioDiscovered("ADFA0000001")
    #expect(fleet.cameramanSnapshot() == RadarSnapshot(
      enabled: true,
      status: "Scanning",
      choices: [ "ADFA0000001" ],
      pairing: true
    ))

    bench.power = .on
    fleet.pair("ADFA0000001")
    fleet.stopScan()
    #expect(fleet.cameramanSnapshot() == RadarSnapshot(
      enabled: true,
      serial: "ADFA0000001",
      status: "Connecting"
    ))

    let radio = bench.radio(for: "ADFA0000001")!
    radio.bringUp("ADFA0000001")
    #expect(fleet.cameramanSnapshot().readout == "–/–")
    radio.listener?.radioReceived([ 85 ])
    radio.listener?.radioReceived(radarSpeedPacket(signedCms: -seventyTwoMph))
    #expect(fleet.cameramanSnapshot() == RadarSnapshot(
      enabled: true,
      serial: "ADFA0000001",
      connected: true,
      batteryPercent: 85,
      readout: "⚡85% 72/–",
      status: "Connected"
    ))
    bench.clock += 3
    radio.listener?.radioReceived(radarSpeedPacket(signedCms: -seventyTwoMph, extraCms: eightyEightMph))
    #expect(fleet.cameramanSnapshot().readout == "⚡85% 72/88")
    bench.clock += 5
    #expect(fleet.cameramanSnapshot().readout == "⚡85% –/–", "each side is a dash five seconds on")
  }

  @Test
  func theAppEnvironmentDrivesTheFleet() {
    let bench = RadarBench()
    let keys = RadarFleet.Storage.cameraman
    bench.defaults.set(true, forKey: keys.enabledKey)
    let environment = AppEnvironment(
      broadcastStore: InMemorySettingsStore(),
      eventControlKeys: .inMemory(),
      eventControlPorts: [],
      radarFleet: bench.fleet(storage: .cameraman, limit: 1)
    )
    environment.startRadar()
    #expect(environment.radar.enabled)
    #expect(environment.radar.status == "Idle")

    environment.openRadarPairing()
    #expect(environment.radar.pairing)
    bench.scanRadio?.listener?.radioDiscovered("ADFA0000001")
    #expect(environment.radar.choices == [ "ADFA0000001" ])
    environment.pairRadar("Headphones")
    #expect(environment.radar.pairing, "a name that is not a radar leaves the list open")
    environment.pairRadar("ADFA0000001")
    #expect(environment.radar.serial == "ADFA0000001")
    #expect(!environment.radar.pairing)
    #expect(environment.radar.status == "Connecting")
    #expect(bench.defaults.string(forKey: keys.serialsKey) == "ADFA0000001")

    environment.openRadarPairing()
    environment.dismissRadarPairing()
    #expect(!environment.radar.pairing)

    environment.unpairRadar()
    #expect(environment.radar.serial == nil)
    #expect(bench.defaults.object(forKey: keys.serialsKey) == nil)

    environment.setRadarEnabled(false)
    #expect(environment.radar == RadarSnapshot(enabled: false, status: "Off"))
  }
}
