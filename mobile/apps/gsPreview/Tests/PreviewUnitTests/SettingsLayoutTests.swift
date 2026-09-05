import CameramanCore
import CoreGraphics
import Foundation
import Testing

/// The one rule behind the Settings sheet's shape on a rotating phone.
@Suite("Settings layout")
struct SettingsLayoutTests {
  @Test("Portrait phones get one column, landscape phones and every iPad get two")
  func columns() {
    #expect(SettingsLayout.columns(for: CGSize(width: 390, height: 844)) == 1, "iPhone portrait")
    #expect(SettingsLayout.columns(for: CGSize(width: 844, height: 390)) == 2, "iPhone landscape")
    #expect(SettingsLayout.columns(for: CGSize(width: 1024, height: 768)) == 2, "iPad landscape")
    #expect(SettingsLayout.columns(for: CGSize(width: 768, height: 1024)) == 1, "iPad portrait stacks")
  }

  @Test("A landscape window narrower than 600 points still stacks")
  func narrowLandscape() {
    #expect(SettingsLayout.columns(for: CGSize(width: 560, height: 320)) == 1)
    #expect(SettingsLayout.columns(for: CGSize(width: 600, height: 320)) == 2)
  }

  @Test("A sheet on the phone's landscape-only screen is unchanged")
  func cameramanUnchanged() {
    #expect(SettingsLayout.columns(for: CGSize(width: 844, height: 390)) == 2)
    #expect(SettingsLayout.columns(for: CGSize(width: 932, height: 430)) == 2)
  }
}
