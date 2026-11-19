@testable import CameramanCapture
import Foundation
@testable import Speedy
@testable import SpeedyCore
import Testing

@Suite("Fleet radar")
@MainActor
struct FleetRadarTests {
  @MainActor
  final class Bench {
    var radios: [FakeRadarRadio] = []
    var power: RadarPower = .on
    let defaults = freshDefaults()

    func radar() -> FleetRadar {
      FleetRadar(fleet: RadarFleet(
        storage: FleetRadar.storage,
        limit: 1,
        defaults: defaults,
        makeRadio: { [unowned self] in
          let radio = FakeRadarRadio()
          radio.power = self.power
          self.radios.append(radio)
          return radio
        },
        pause: { _ in },
        now: { Date(timeIntervalSince1970: 1_800_000_000) }
      ))
    }

    var scanner: FakeRadarRadio? { radios.first { $0.listener is RadarFleet } }

    func session(_ serial: String) -> FakeRadarRadio? {
      radios.first { ($0.listener as? RadarSession)?.serial == serial }
    }
  }

  @Test
  func startTurnsTheFleetOnWithNothingPaired() {
    let bench = Bench()
    let radar = bench.radar()
    radar.start()
    #expect(radar.fleet.isEnabled)
    #expect(radar.status.text == "No radar paired")
    #expect(!radar.status.isPaired)
  }

  @Test
  func startTurnsOnAFleetSomeoneTurnedOff() {
    let bench = Bench()
    bench.defaults.set(false, forKey: FleetRadar.storage.enabledKey)
    let radar = bench.radar()
    #expect(!radar.fleet.isEnabled)
    radar.start()
    #expect(radar.fleet.isEnabled)
  }

  @Test
  func pairingListsRadarsInRangeAndPairs() {
    let bench = Bench()
    let radar = bench.radar()
    var changes = 0
    radar.onChange = { changes += 1 }
    radar.start()
    radar.startPairing()
    #expect(radar.status.pairing)
    #expect(bench.scanner?.scanning == true)
    bench.scanner?.listener?.radioDiscovered("ADFA0000001")
    bench.scanner?.listener?.radioDiscovered("Not a radar")
    #expect(radar.status.nearby == [ "ADFA0000001" ])
    radar.pair("ADFA0000001")
    radar.stopPairing()
    #expect(!radar.status.pairing)
    #expect(radar.status.serial == "ADFA0000001")
    #expect(changes > 0)
  }

  @Test
  func aSecondPairingReplacesTheFirst() {
    let bench = Bench()
    let radar = bench.radar()
    radar.start()
    radar.pair("ADFA0000001")
    radar.pair("ADFA0000002")
    #expect(radar.fleet.serials == [ "ADFA0000002" ])
    #expect(bench.defaults.string(forKey: FleetRadar.storage.serialsKey) == "ADFA0000002")
    radar.unpair()
    #expect(radar.fleet.serials.isEmpty)
    #expect(radar.status.serial == nil)
  }

  @Test
  func readingsReachTheModel() {
    let bench = Bench()
    let radar = bench.radar()
    final class Heard { var lines: [String] = [] }
    let heard = Heard()
    radar.onSpeeds = { pitch, exit in heard.lines.append("\(pitch)/\(exit)") }
    radar.start()
    radar.pair("ADFA0000001")
    let radio = bench.session("ADFA0000001")!
    radio.bringUp("ADFA0000001")
    radio.listener?.radioReceived(radarSpeedPacket(signedCms: -2_503))
    radio.listener?.radioReceived(radarSpeedPacket(signedCms: -2_503, extraCms: 2_325))
    #expect(heard.lines == [ "56/0", "56/52" ])
  }

  @Test
  func theLinkAndBatteryShowInTheStatus() {
    let bench = Bench()
    let radar = bench.radar()
    radar.start()
    radar.pair("ADFA0000001")
    let radio = bench.session("ADFA0000001")!
    radio.bringUp("ADFA0000001")
    radio.listener?.radioReady()
    radio.listener?.radioReceived([ 85 ])
    #expect(radar.status.link == .connected)
    #expect(radar.status.text == "Connected")
    #expect(radar.status.batteryPercent == 85)
  }

  @Test
  func bluetoothOffShows() {
    let bench = Bench()
    bench.power = .off
    let radar = bench.radar()
    radar.start()
    #expect(radar.status.power == .off)
    #expect(radar.status.text == "Bluetooth off")
  }

  @Test
  func everyConnectionAndPowerMaps() {
    #expect(FleetRadar.link(.off) == .off)
    #expect(FleetRadar.link(.scanning) == .searching)
    #expect(FleetRadar.link(.connecting) == .connecting)
    #expect(FleetRadar.link(.connected) == .connected)
    #expect(FleetRadar.link(.bluetoothOff) == .bluetoothOff)
    #expect(FleetRadar.power(.unknown) == .unknown)
    #expect(FleetRadar.power(.on) == .on)
    #expect(FleetRadar.power(.off) == .off)
  }
}
