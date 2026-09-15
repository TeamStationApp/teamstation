import Foundation
import DirectorTestHarness
import Testing

@Suite("Launch configuration")
struct LaunchConfigurationTests {
  @Test("rtspHosts splits on comma or semicolon")
  func rtspHostsSeparators() {
    let defaults = UserDefaults(suiteName: "launch-\(UUID().uuidString)")!
    let comma = LaunchConfiguration.resolve(
      arguments: [ "-rtspHosts", "10.10.7.40:18554,10.10.7.40:18555" ],
      environment: [:],
      defaults: defaults
    )
    #expect(comma.rtspHosts == [ "10.10.7.40:18554", "10.10.7.40:18555" ])

    let semicolon = LaunchConfiguration.resolve(
      arguments: [ "-rtspHosts", "10.10.7.40:18554;10.10.7.40:18555" ],
      environment: [:],
      defaults: defaults
    )
    #expect(semicolon.rtspHosts == [ "10.10.7.40:18554", "10.10.7.40:18555" ])
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
}
