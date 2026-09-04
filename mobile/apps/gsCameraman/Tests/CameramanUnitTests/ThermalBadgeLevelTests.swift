import CameramanUI
import Foundation
import Testing

@Suite("Thermal badge level")
struct ThermalBadgeLevelTests {
  @Test("ProcessInfo states map to cool, fair, warm, hot")
  func processStates() {
    #expect(ThermalBadgeLevel(process: .nominal) == .cool)
    #expect(ThermalBadgeLevel(process: .fair) == .fair)
    #expect(ThermalBadgeLevel(process: .serious) == .warm)
    #expect(ThermalBadgeLevel(process: .critical) == .hot)
  }

  @Test("Telemetry names match dump-state thermalState words")
  func telemetryNames() {
    #expect(ThermalBadgeLevel(telemetryName: "nominal") == .cool)
    #expect(ThermalBadgeLevel(telemetryName: "fair") == .fair)
    #expect(ThermalBadgeLevel(telemetryName: "serious") == .warm)
    #expect(ThermalBadgeLevel(telemetryName: "critical") == .hot)
    #expect(ThermalBadgeLevel(telemetryName: "unknown") == .cool)
    #expect(ThermalBadgeLevel(telemetryName: "") == .cool)
  }

  @Test("Labels, flames, and shimmer direction")
  func presentation() {
    #expect(ThermalBadgeLevel.cool.label == "COOL")
    #expect(ThermalBadgeLevel.fair.label == "FAIR")
    #expect(ThermalBadgeLevel.warm.label == "WARM")
    #expect(ThermalBadgeLevel.hot.label == "HOT")

    #expect(!ThermalBadgeLevel.cool.showsFlames)
    #expect(!ThermalBadgeLevel.fair.showsFlames)
    #expect(!ThermalBadgeLevel.warm.showsFlames)
    #expect(ThermalBadgeLevel.hot.showsFlames)

    #expect(ThermalBadgeLevel.cool.shimmer == .pulse)
    #expect(ThermalBadgeLevel.fair.shimmer == .pulse)
    #expect(ThermalBadgeLevel.warm.shimmer == .pulse)
    #expect(ThermalBadgeLevel.hot.shimmer == .up)
  }

  @Test("Cycle seconds are 3, 3, 2, 1")
  func cycleSeconds() {
    #expect(ThermalBadgeLevel.cool.cycleSeconds == 3)
    #expect(ThermalBadgeLevel.fair.cycleSeconds == 3)
    #expect(ThermalBadgeLevel.warm.cycleSeconds == 2)
    #expect(ThermalBadgeLevel.hot.cycleSeconds == 1)
  }
}
