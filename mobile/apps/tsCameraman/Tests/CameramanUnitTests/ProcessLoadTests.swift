import CameramanCore
import Foundation
import Testing

@Suite("Process load")
struct ProcessLoadTests {
  @Test("physFootprintMB is a non-negative reading from this process")
  func footprintIsReadable() {
    #expect(ProcessLoad.physFootprintMB() >= 0)
    #expect(ProcessLoad.residentSizeMB() >= 0)
    #expect(ProcessLoad.availableMemoryMB() >= 0)
    #expect(ProcessLoad.coreCount > 0)
  }

  @Test("thermalStateName covers the known ProcessInfo values")
  func thermalNames() {
    #expect(ProcessLoad.thermalStateName(.nominal) == "nominal")
    #expect(ProcessLoad.thermalStateName(.fair) == "fair")
    #expect(ProcessLoad.thermalStateName(.serious) == "serious")
    #expect(ProcessLoad.thermalStateName(.critical) == "critical")
    let live = ProcessLoad.thermalStateName()
    #expect(["nominal", "fair", "serious", "critical", "unknown"].contains(live))
  }
}
