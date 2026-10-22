import Foundation
import DirectorTestHarness
import Testing

@Suite("Launch configuration")
struct LaunchConfigurationTests {
  @Test("rtspHosts splits on comma or semicolon")
  func rtspHostsSeparators() {
    let defaults = UserDefaults(suiteName: "launch-\(UUID().uuidString)")!
    let comma = LaunchConfiguration.resolve(
      arguments: [ "-rtspHosts", "192.168.7.40:18554,192.168.7.40:18555" ],
      environment: [:],
      defaults: defaults
    )
    #expect(comma.rtspHosts == [ "192.168.7.40:18554", "192.168.7.40:18555" ])

    let semicolon = LaunchConfiguration.resolve(
      arguments: [ "-rtspHosts", "192.168.7.40:18554;192.168.7.40:18555" ],
      environment: [:],
      defaults: defaults
    )
    #expect(semicolon.rtspHosts == [ "192.168.7.40:18554", "192.168.7.40:18555" ])
  }

  @Test("Stream overlays arrive at launch and over /configure")
  func streamOverlays() {
    let defaults = UserDefaults(suiteName: "launch-\(UUID().uuidString)")!
    var launch = LaunchConfiguration.resolve(
      arguments: [ "-streamCodec", "h264", "-streamResolution", "1280x720", "-streamFrameRate", "30" ],
      environment: [:],
      defaults: defaults
    )
    #expect(launch.streamCodec == .h264)
    #expect(launch.streamResolution?.width == 1280)
    #expect(launch.streamResolution?.height == 720)
    #expect(launch.streamFrameRate == 30)

    launch.apply(queryItems: [ "streamCodec": "h265", "streamBitrateLow": "1500000", "streamBitrateHigh": "4000000" ])
    #expect(launch.streamCodec == .hevc)
    #expect(launch.streamBitrateLow == 1_500_000)
    #expect(launch.streamBitrateHigh == 4_000_000)
    for key in [ "streamCodec", "streamResolution", "streamFrameRate", "streamBitrateLow", "streamBitrateHigh" ] {
      #expect(LaunchConfiguration.knownKeys.contains(key))
    }
  }

  @Test("The programme compose delay arrives at launch and over /configure")
  func programmeComposeDelay() {
    let defaults = UserDefaults(suiteName: "launch-\(UUID().uuidString)")!
    var launch = LaunchConfiguration.resolve(
      arguments: [ "-programmeComposeDelay", "20" ],
      environment: [:],
      defaults: defaults
    )
    #expect(launch.programmeComposeDelayMilliseconds == 20)
    launch.apply(queryItems: [ "programmeComposeDelay": "0" ])
    #expect(launch.programmeComposeDelayMilliseconds == 0)
    launch.apply(queryItems: [ "programmeComposeDelay": "-3" ])
    #expect(launch.programmeComposeDelayMilliseconds == 0, "a negative delay is ignored")
    #expect(LaunchConfiguration.knownKeys.contains("programmeComposeDelay"))
    #expect(LaunchConfiguration.resolve(arguments: [], environment: [:], defaults: defaults).programmeComposeDelayMilliseconds == nil)
  }

  @Test("The compose delay only applies in a test launch")
  func programmeComposeDelayNeedsUITest() {
    let defaults = UserDefaults(suiteName: "launch-\(UUID().uuidString)")!
    var launch = LaunchConfiguration.resolve(arguments: [ "-programmeComposeDelay", "20" ], environment: [:], defaults: defaults)
    #expect(!launch.isUITest)
    #expect(launch.appliedProgrammeComposeDelayMilliseconds == 0, "an operator launch ignores it")
    launch.apply(queryItems: [ "uiTest": "true", "programmeComposeDelay": "200" ])
    #expect(launch.isUITest)
    #expect(launch.appliedProgrammeComposeDelayMilliseconds == 0, "a link that turns uiTest on does not")
    let test = LaunchConfiguration.resolve(arguments: [ "-uiTest", "true", "-programmeComposeDelay", "20" ], environment: [:], defaults: defaults)
    #expect(test.appliedProgrammeComposeDelayMilliseconds == 20)
  }
}
