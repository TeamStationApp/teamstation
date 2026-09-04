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
}
