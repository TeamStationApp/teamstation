import DirectorUI
import Testing

@Suite("Replay hotkey labels")
struct ReplayHotkeyTests {
  @Test("Full-speed buttons show seconds with a trailing s")
  func fullSpeedTitle() {
    #expect(ReplayHotkeyFormatting.fullSpeedTitle(5) == "5s")
    #expect(ReplayHotkeyFormatting.fullSpeedTitle(7.5) == "7.5s")
    #expect(ReplayHotkeyFormatting.fullSpeedTitle(10) == "10s")
  }

  @Test("Slow-motion buttons show seconds at a percent, not a × rate")
  func slowMotionTitle() {
    #expect(ReplayHotkeyFormatting.slowMotionTitle(5, rate: 0.5) == "5s @ 50%")
    #expect(ReplayHotkeyFormatting.slowMotionTitle(7.5, rate: 0.5) == "7.5s @ 50%")
    #expect(ReplayHotkeyFormatting.slowMotionTitle(5, rate: 0.75) == "5s @ 75%")
  }
}
