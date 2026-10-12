import Foundation
import Testing

@testable import TeamStationKit

@Suite("Device model names")
struct DeviceModelNameTests {
  @Test func namesEachIPhoneExactly() {
    #expect(DeviceModelName.name(for: "iPhone14,2") == "iPhone 13 Pro")
    #expect(DeviceModelName.name(for: "iPhone17,1") == "iPhone 16 Pro")
    #expect(DeviceModelName.name(for: "iPhone11,8") == "iPhone XR")
    #expect(DeviceModelName.name(for: "iPhone18,4") == "iPhone Air")
  }

  @Test func namesAnIPadByItsFamily() {
    #expect(DeviceModelName.name(for: "iPad16,3") == "iPad Pro")
    #expect(DeviceModelName.name(for: "iPad13,16") == "iPad Air")
    #expect(DeviceModelName.name(for: "iPad14,1") == "iPad mini")
    #expect(DeviceModelName.name(for: "iPad13,18") == "iPad")
  }

  @Test func fallsBackToTheFamilyThenTheIdentifier() {
    #expect(DeviceModelName.name(for: "iPhone99,1") == "iPhone")
    #expect(DeviceModelName.name(for: "iPad99,1") == "iPad")
    #expect(DeviceModelName.name(for: "arm64") == "arm64")
  }

  @Test func aSimulatorIsTheDeviceItSimulates() {
    #expect(
      DeviceModelName.identifier(
        machine: "arm64",
        environment: [ "SIMULATOR_MODEL_IDENTIFIER": "iPad16,5" ]
      ) == "iPad16,5"
    )
    #expect(DeviceModelName.identifier(machine: "iPhone14,2", environment: [:]) == "iPhone14,2")
    #expect(
      DeviceModelName.identifier(machine: "iPhone14,2", environment: [ "SIMULATOR_MODEL_IDENTIFIER": "" ])
        == "iPhone14,2"
    )
  }

  @Test func readsThisMachine() {
    #expect(!DeviceModelName.currentIdentifier.isEmpty)
    #expect(DeviceModelName.current == DeviceModelName.name(for: DeviceModelName.currentIdentifier))
  }

  @Test func everyIdentifierIsNamedOnce() {
    let pads = DeviceModelName.pads.values.flatMap { $0 }
    #expect(Set(pads).count == pads.count)
    #expect(Set(pads).isDisjoint(with: DeviceModelName.phones.keys))
  }
}
