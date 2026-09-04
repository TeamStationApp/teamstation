import Foundation
import Testing

@testable import CameramanTestHarness

/// A mistyped command that parses as something else is worse than one that fails, because the flow
/// carries on and fails somewhere unrelated.
struct ControlChannelTests {
  private func command(_ target: String) -> ControlCommand? {
    guard let url = URL(string: "gscameraman://test\(target)") else { return nil }
    return ControlChannel.command(from: url)
  }

  @Test func parsesTheCommandsWithNoArguments() {
    #expect(command("/dump-state") == .dumpState)
    #expect(command("/flip-camera") == .flipCamera)
    #expect(command("/force-keyframe") == .forceKeyframe)
    #expect(command("/clients") == .clients)
    #expect(command("/reset") == .reset)
  }

  @Test func readsTheZoomItWasGiven() {
    #expect(command("/set-zoom?displayed=2.5") == .setZoom(displayed: 2.5))
    #expect(command("/set-zoom?displayed=0.5") == .setZoom(displayed: 0.5))
  }

  @Test func aFormatWithoutARateGetsTheUsualOne() {
    #expect(command("/set-format?width=3840&height=2160") == .setFormat(width: 3840, height: 2160, fps: 30))
    #expect(command("/set-format?width=1280&height=720&fps=60") == .setFormat(width: 1280, height: 720, fps: 60))
  }

  @Test func codecNamesAreCaseInsensitive() {
    #expect(command("/set-codec?codec=HEVC") == .setCodec("hevc"))
    #expect(command("/set-codec?codec=h264") == .setCodec("h264"))
  }

  @Test func everySpellingOfYesMeansYes() {
    for yes in [ "1", "true", "yes", "on", "TRUE", "Yes" ] {
      #expect(command("/set-audio?on=\(yes)") == .setAudio(on: true))
    }
    for no in [ "0", "false", "no", "off" ] {
      #expect(command("/set-audio?on=\(no)") == .setAudio(on: false))
    }
  }

  @Test func anEmptyNameIsARequestNotAMistake() {
    // How a flow checks the fallback name appears, so it must reach the app rather than be refused.
    #expect(command("/set-name?name=") == .setName(""))
    #expect(command("/set-name?name=Third%20Base") == .setName("Third Base"))
  }

  @Test func aMissingArgumentIsRefusedRatherThanDefaulted() {
    // Silently substituting a default here is how a flow ends up asserting on a zoom nobody asked
    // for and reporting the wrong cause.
    #expect(command("/set-zoom") == nil)
    #expect(command("/set-zoom?displayed=abc") == nil)
    #expect(command("/set-bitrate") == nil)
    #expect(command("/set-format?width=1920") == nil)
    #expect(command("/set-codec?codec=") == nil)
    #expect(command("/set-audio") == nil)
  }

  @Test func anUnknownCommandIsNotGuessedAt() {
    #expect(command("/set-zoomm?displayed=2") == nil)
    #expect(command("/") == nil)
  }

  @Test func lensDisableListsAreParsed() {
    #expect(command("/set-lenses") == .setLenses(disabled: []))
    #expect(command("/set-lenses?disabled=uw,tele") == .setLenses(disabled: [ "uw", "tele" ]))
  }

  @Test func anotherAppsSchemeIsNotOurs() {
    let producer = URL(string: "gsproducer://test/dump-state")!
    // Both apps run during the end-to-end phase and both listen; taking each other's commands
    // would make that run unreadable.
    #expect(ControlChannel.command(from: producer) == nil)
  }

  @Test func theRequestLineIsReducedToItsTarget() {
    #expect(ControlServer.requestTarget("GET /set-zoom?displayed=2 HTTP/1.1\nHost: x") == "/set-zoom?displayed=2")
    #expect(ControlServer.requestTarget("GET / HTTP/1.1") == "/")
    #expect(ControlServer.requestTarget("nonsense") == "/")
  }
}
