import DirectorCore
import DirectorTestHarness
import Foundation
import Testing

@testable import DirectorUI

/// A test run that names a stream URL must stream there, never to the game Settings chose.
@MainActor
struct StreamDestinationOverlayTests {
  private func eventConfig() -> AppConfig {
    var config = AppConfig()
    config.streamDestination = .event
    config.streamURL = ""
    return config
  }

  @Test func launchStreamURLSendsTheSessionToThatURL() {
    var launch = LaunchConfiguration()
    launch.streamURL = "rtmp://192.0.2.10:19350/live/test"
    let session = AppEnvironment.applying(launch, to: eventConfig())
    #expect(session.streamDestination == .url)
    #expect(session.streamURL == "rtmp://192.0.2.10:19350/live/test")
  }

  @Test func emptyOrMissingLaunchURLLeavesTheEventAlone() {
    var launch = LaunchConfiguration()
    #expect(AppEnvironment.applying(launch, to: eventConfig()).streamDestination == .event)
    launch.streamURL = ""
    let session = AppEnvironment.applying(launch, to: eventConfig())
    #expect(session.streamDestination == .event)
    #expect(session.streamURL == "")
  }

  @Test func launchH264StreamTakesFifteenMegabits() {
    var launch = LaunchConfiguration()
    launch.streamCodec = .h264
    launch.streamBitrateHigh = 15_000_000
    var config = eventConfig()
    config.streamCodec = .hevc
    let session = AppEnvironment.applying(launch, to: config)
    #expect(session.streamCodec == .h264)
    #expect(session.streamBitrateHigh == 15_000_000)
  }

  @Test func launchHEVCStreamClampsFifteenMegabitsToTen() {
    var launch = LaunchConfiguration()
    launch.streamCodec = .hevc
    launch.streamBitrateHigh = 15_000_000
    let session = AppEnvironment.applying(launch, to: eventConfig())
    #expect(session.streamBitrateHigh == 10_000_000)
  }

  @Test func targetDropsTheStreamKey() {
    #expect(AppEnvironment.withoutStreamKey("rtmp://host:1935/live/secret") == "rtmp://host:1935/live")
    #expect(AppEnvironment.withoutStreamKey("rtmp://u:p@host/live/key?token=1") == "rtmp://host/live")
    #expect(AppEnvironment.withoutStreamKey("rtmp://host:1935/live") == "rtmp://host:1935/live")
    #expect(AppEnvironment.withoutStreamKey("rtmp://host:1935") == "rtmp://host:1935")
    #expect(AppEnvironment.withoutStreamKey("") == "")
    #expect(AppEnvironment.withoutStreamKey("not a url") == "")
  }
}
