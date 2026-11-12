import Testing
@testable import CameramanCore

@Suite("Landscape capture rotation")
struct LandscapeRotationTests {
  @Test("Waits for a landscape reading and ignores portrait ones")
  func waitsForLandscape() {
    var rotation = LandscapeRotation()
    for portrait in [90.0, 270, -1, 360, 45] {
      let accepted = rotation.report(interfaceAngle: portrait)
      #expect(!accepted)
      #expect(rotation.captureAngle == nil)
    }
    let accepted = rotation.report(interfaceAngle: 180)
    #expect(accepted)
    #expect(rotation.captureAngle == 180)
    for portrait in [90.0, 270, -1] {
      let accepted = rotation.report(interfaceAngle: portrait)
      #expect(!accepted)
      #expect(rotation.captureAngle == 180)
    }
    #expect(LandscapeRotation(interfaceAngle: 90).interfaceAngle == nil)
    #expect(LandscapeRotation(interfaceAngle: 0).interfaceAngle == 0)
  }

  @Test("The back camera takes the interface's angle and the front camera the opposite one",
        arguments: [(0.0, 0.0, 180.0), (180, 180, 0)])
  func frontIsOpposite(interface: Double, back: Double, front: Double) {
    var rotation = LandscapeRotation(position: .back)
    rotation.report(interfaceAngle: interface)
    #expect(rotation.captureAngle == back)
    rotation.position = .front
    #expect(rotation.captureAngle == front)
    // A portrait reading while the front camera is up, as a settings sheet makes, keeps its side.
    rotation.report(interfaceAngle: 90)
    #expect(rotation.captureAngle == front)
    rotation.position = .back
    #expect(rotation.captureAngle == back)
  }

  @Test("Turning the phone over while the front camera is up turns its picture with it")
  func frontFollowsInterface() {
    var rotation = LandscapeRotation(position: .front, interfaceAngle: 0)
    #expect(rotation.captureAngle == 180)
    rotation.report(interfaceAngle: 180)
    #expect(rotation.captureAngle == 0)
    #expect(LandscapeRotation.captureAngle(interface: 180, position: .back) == 180)
    #expect(LandscapeRotation.captureAngle(interface: 0, position: .front) == 180)
  }
}
