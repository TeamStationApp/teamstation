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

  @Test func targetDropsTheStreamKey() {
    #expect(AppEnvironment.withoutStreamKey("rtmp://host:1935/live/secret") == "rtmp://host:1935/live")
    #expect(AppEnvironment.withoutStreamKey("rtmp://u:p@host/live/key?token=1") == "rtmp://host/live")
    #expect(AppEnvironment.withoutStreamKey("rtmp://host:1935/live") == "rtmp://host:1935/live")
    #expect(AppEnvironment.withoutStreamKey("rtmp://host:1935") == "rtmp://host:1935")
    #expect(AppEnvironment.withoutStreamKey("") == "")
    #expect(AppEnvironment.withoutStreamKey("not a url") == "")
  }
}
