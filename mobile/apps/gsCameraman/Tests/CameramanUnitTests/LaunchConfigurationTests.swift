import CameramanCore
import CameramanTestHarness
import Foundation
import Testing

@Suite("Launch configuration")
struct LaunchConfigurationTests {
  @Test("No arguments leaves the documented defaults in place")
  func defaults() {
    let configuration = LaunchConfiguration(arguments: [])

    #expect(configuration.isUITest == false)
    #expect(configuration.settings == StreamSettings.default)
    #expect(configuration.settings.width == 1920)
    #expect(configuration.settings.height == 1080)
    #expect(configuration.settings.frameRate == 30)
    #expect(configuration.settings.bitrate == 4_000_000)
    #expect(configuration.settings.codec == .hevc)
    #expect(configuration.settings.port == 554)
    #expect(configuration.settings.audioEnabled)
    #expect(configuration.settings.cleanHDMIEnabled)
    #expect(configuration.providedSettingFields.isEmpty)
    #expect(configuration.persistSettings)
  }

  @Test("Clean HDMI can be pinned off for a flow, and counts as provided")
  func cleanHDMIIsALaunchKey() {
    let configuration = LaunchConfiguration(arguments: [ "-cleanHdmi", "false" ])
    #expect(configuration.settings.cleanHDMIEnabled == false)
    #expect(configuration.providedSettingFields == Set([ .cleanHDMI ]))
    #expect(configuration.unknownKeys.isEmpty)
    #expect(LaunchConfiguration(arguments: [ "-cleanHdmi", "yes" ]).settings.cleanHDMIEnabled)
  }

  @Test("Saved settings are off under uiTest and can be switched back on")
  func persistenceFollowsUITestUnlessAsked() {
    #expect(LaunchConfiguration(arguments: [ "-uiTest" ]).persistSettings == false)
    #expect(LaunchConfiguration(arguments: []).persistSettings)
    #expect(
      LaunchConfiguration(arguments: [ "-uiTest", "-persistSettings", "true" ]).persistSettings
    )
    #expect(
      LaunchConfiguration(arguments: [ "-persistSettings", "false" ]).persistSettings == false
    )
  }

  @Test("Only the settings this launch named are reported as provided")
  func providedFieldsAreTracked() {
    let configuration = LaunchConfiguration(arguments: [
      "-codec", "h264", "-width", "1280", "-height", "720"
    ])

    #expect(configuration.providedSettingFields == Set([ .codec, .width, .height ]))
  }

  @Test("A key with an unparseable value still counts as provided")
  func unparseableValueStillCountsAsProvided() {
    // Otherwise a typo in the value hands the decision back to whatever the operator last saved,
    // which is the opposite of what pinning a value in a flow is for.
    let configuration = LaunchConfiguration(arguments: [ "-codec", "av1" ])

    #expect(configuration.providedSettingFields == Set([ .codec ]))
    #expect(configuration.settings.codec == StreamSettings.default.codec)
  }

  @Test("Flags and values are both read")
  func flagsAndValues() {
    let configuration = LaunchConfiguration(arguments: [
      "-uiTest", "-rtspPort", "8554", "-codec", "hevc", "-bitrateMbps", "2.5"
    ])

    #expect(configuration.isUITest)
    #expect(configuration.settings.port == 8554)
    #expect(configuration.settings.codec == .hevc)
    #expect(configuration.settings.bitrate == 2_500_000)
  }

  @Test("An unknown key is reported instead of ignored")
  func unknownKeysAreReported() {
    // A silently swallowed typo produces a green run that proved nothing, which is the whole reason
    // this list exists.
    let configuration = LaunchConfiguration(arguments: [ "-rtspPrt", "8554", "-uiTest" ])

    #expect(configuration.unknownKeys == [ "rtspPrt" ])
    #expect(configuration.settings.port == 554)
  }

  @Test("The environment can override, so a Maestro flow needs no argument plumbing")
  func environmentOverrides() {
    let configuration = LaunchConfiguration(
      arguments: [ "-rtspPort", "554" ],
      environment: [ "rtspPort": "8554", "PATH": "/usr/bin" ]
    )

    #expect(configuration.settings.port == 8554)
    // An unrelated environment variable is not a typo in a launch argument.
    #expect(configuration.unknownKeys.isEmpty)
  }

  @Test("Booleans accept the spellings a shell script is likely to produce")
  func booleanSpellings() {
    #expect(LaunchConfiguration(arguments: [ "-audioEnabled", "false" ]).settings.audioEnabled == false)
    #expect(LaunchConfiguration(arguments: [ "-audioEnabled", "0" ]).settings.audioEnabled == false)
    #expect(LaunchConfiguration(arguments: [ "-audioEnabled", "no" ]).settings.audioEnabled == false)
    #expect(LaunchConfiguration(arguments: [ "-audioEnabled", "yes" ]).settings.audioEnabled == true)
  }

  @Test("Switching codec carries the matching default bitrate across")
  func codecCarriesDefaultBitrate() {
    // HEVC at the H.264 default would waste half the rate, and the operator never asked for 6 Mbps.
    let configuration = LaunchConfiguration(arguments: [ "-codec", "hevc" ])
    #expect(configuration.settings.bitrate == 4_000_000)
  }

  @Test("An explicit bitrate survives a codec change")
  func explicitBitrateIsKept() {
    var settings = StreamSettings.default
    settings.bitrate = 9_000_000
    settings.setCodec(.hevc)
    #expect(settings.bitrate == 9_000_000)
  }

  @Test("A pinned identity and name come through for a flow that asserts an exact CNAME")
  func identityOverrides() {
    let configuration = LaunchConfiguration(arguments: [
      "-identityUUID", "3f2504e0-4f89-41d3-9a0c-0305e82c33ab",
      "-cameraName", "Corner Flag"
    ])

    #expect(configuration.identityUUID == "3f2504e0-4f89-41d3-9a0c-0305e82c33ab")
    #expect(configuration.cameraName == "Corner Flag")
  }

  @Test("A trailing flag with no value still registers")
  func trailingFlag() {
    let configuration = LaunchConfiguration(arguments: [ "-rtspPort", "8554", "-syntheticCamera" ])
    #expect(configuration.useSyntheticCamera)
  }

  @Test("The debug HUD follows uiTest unless it is set explicitly")
  func debugHUDDefault() {
    #expect(LaunchConfiguration(arguments: [ "-uiTest" ]).showDebugHUD)
    #expect(LaunchConfiguration(arguments: []).showDebugHUD == false)
    #expect(LaunchConfiguration(arguments: [ "-uiTest", "-debugHUD", "false" ]).showDebugHUD == false)
  }

  @Test("Lens disable lists are comma-separated IDs")
  func disabledLenses() {
    let configuration = LaunchConfiguration(arguments: [ "-disabledLenses", "uw,tele" ])
    #expect(configuration.settings.disabledLensIDs == Set(["uw", "tele"]))
  }
}
