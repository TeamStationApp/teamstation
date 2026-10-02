import CameramanCore
import Foundation
import Testing

@Suite("Battery status")
struct BatteryStatusTests {
  @Test("UIDevice's 0…1 level becomes a percentage, and unknown is nil")
  func fromLevel() {
    #expect(BatteryStatus(level: 0.87, isCharging: false)?.percent == 87)
    #expect(BatteryStatus(level: 1, isCharging: true) == BatteryStatus(percent: 100, isCharging: true))
    #expect(BatteryStatus(level: 0, isCharging: false)?.percent == 0)
    #expect(BatteryStatus(level: -1, isCharging: false) == nil, "a simulator reports -1")
    #expect(BatteryStatus(level: .nan, isCharging: false) == nil)
    #expect(BatteryStatus(percent: 140).percent == 100)
  }

  @Test("Under 20 % is low and turns the Low Power Mode yellow")
  func lowThreshold() {
    #expect(!BatteryStatus(percent: 20).isLow)
    #expect(BatteryStatus(percent: 19).isLow)
    #expect(BatteryStatus(percent: 50).hue == BatteryStatus(percent: 100).hue)
    #expect(BatteryStatus(percent: 19).hue != BatteryStatus(percent: 20).hue)
    let low = BatteryStatus(percent: 5).hue
    #expect(low.red > low.blue && low.green > low.blue, "yellow, not green")
    let full = BatteryStatus(percent: 80).hue
    #expect(full.green > full.red, "green")
  }

  @Test("The label is the percentage")
  func label() {
    #expect(BatteryStatus(percent: 87).label == "87%")
  }
}
