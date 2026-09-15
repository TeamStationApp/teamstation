import Foundation
import DirectorCore
import DirectorSources

/// Test configuration read from the launch environment.
///
/// I1: `maestro-runner` is an independent reimplementation of Maestro and its handling of
/// `launchApp.arguments` is unverified, so every plausible shape is accepted — `-key value`
/// (which also lands in `UserDefaults`), `--key=value`, bare `key=value`, and environment
/// variables. If all of them fail, `ControlChannel.configure` provides the `openLink` fallback.
public struct LaunchConfiguration: Sendable, Equatable {
  /// Master switch. Nothing test-only appears in the UI unless this is set (D7).
  public var isUITest = false
  /// Nil means the saved Settings toggle chooses live vs simulated cameras.
  public var sourceProfile: SourceProfile?
  public var useTestClock = false
  public var autoRecord = false
  public var clearState = false
  public var fixtureDirectory: String?
  public var syntheticFrameRate: Double = 30
  public var syntheticWidth = 1920
  public var syntheticHeight = 1080
  /// Segment length override so a flow can produce many segments in a few seconds.
  public var segmentSeconds: Double?
  /// Detail level of generated frames. Defaults to `.high` so an encode measurement taken without
  /// thinking about it is the pessimistic one rather than the flattering one.
  public var syntheticEntropy: SyntheticEntropy = .high
  /// Whether per-camera archives carry an audio track. Exists to test a specific suspicion: a
  /// camera whose audio lags its video throttles the writer's video input, so the archive drops
  /// most frames while the camera looks like it is at fault.
  public var archiveAudio = true
  /// Programme master codec override. Worth being able to set from a flow: the same hardware
  /// sustains 118 fps of 1080p H.264 and 296 fps of 1080p HEVC, and the programme master is the
  /// only output this app still encodes.
  public var programCodec: ProgramCodec?
  /// What a simulated camera puts on the wire. Real cameras in the population send a mix of H.264
  /// and HEVC, and since archives are copies of the wire this is the only way a flow can cover an
  /// HEVC archive without an HEVC camera on the bench.
  public var cameraCodec: CompressedFrame.Codec = .h264
  /// Telemetry overlay override. Left nil so the stored preference wins, which is what makes the
  /// Settings toggle stick between runs.
  public var debugHUD: Bool?
  /// How many synthetic cameras to generate. Five fills the grid, which is the only way to exercise
  /// the fifth tile without five real cameras on the bench.
  public var syntheticCount = 4
  /// `tcp` or `udp`. Only TCP is implemented; a flow asking for UDP fails rather than quietly
  /// testing TCP and reporting a pass.
  public var rtspTransport = "tcp"
  /// Cameras to try directly, bypassing the scan. Needed for another subnet, and the escape hatch
  /// when a venue blocks scanning.
  public var rtspHosts: [String] = []
  public var rtspPath = "/live/mainstream"
  /// False turns the subnet scan off, leaving only `rtspHosts`.
  public var rtspScan = true
  /// NDI sources to restrict the list to, by full `MACHINE (Stream)` name or by stream name.
  /// Empty means everything the finder sees, which is what a venue run wants and what a flow
  /// asserting on a known set does not.
  public var ndiSources: [String] = []
  /// Addresses the NDI finder queries directly, for a camera on another subnet or a network that
  /// drops mDNS between segments.
  public var ndiExtraIPs: [String] = []
  /// `highest` or `lowest`. The SDK's low-bandwidth mode is a proxy-quality stream; a flow uses it
  /// to prove the app follows the setting, not because a game would.
  public var ndiBandwidth = "highest"
  /// Whether the NDI finder reports senders on this machine. On by default because on a simulator
  /// the whole test rig is a generator on the same host.
  public var ndiLocalSources = true
  /// Keeps NDI's reliable-UDP receive transport on despite the crash it carries at three cameras.
  /// A measurement switch: it is the smoother transport, and whether that matters on a given rig
  /// is only answerable by running both.
  public var ndiReliableUDP = false
  /// Codec for archives the app has to encode itself. Overrides the stored setting for the
  /// session, the way `programCodec` does for the master.
  public var sourceEncodeCodec: ProgramCodec?
  /// How many cameras may encode their own archive at once. A flow sets it to 1 to prove that the
  /// cameras past the cap stay live and say why, rather than taking the board down with them.
  public var sourceEncodeLimit: Int?
  /// Bitrate for those archives. Worth setting from a flow: it is what an NDI camera's archive
  /// size and encode cost are actually decided by.
  public var sourceEncodeBitrate: Int?
  /// RTMP publish URL overlay for a flow. Session-only; never written back to Settings.
  public var streamURL: String?
  /// Programme encoder overlays, so a soak can change bitrate mid-run over `/configure` instead
  /// of driving the Settings stepper. Session-only, like `streamURL`.
  public var programBitrate: Int?
  public var programFrameRate: Int?
  /// Stream encoder overlays, so a run can stream H.264 and H.265, at another size or rate, or in
  /// another bitrate range, without touching the operator's Settings. Session-only, like
  /// `streamURL`, and read when the stream starts.
  public var streamCodec: ProgramCodec?
  public var streamResolution: ProgramResolution?
  public var streamFrameRate: Int?
  public var streamBitrateLow: Int?
  public var streamBitrateHigh: Int?
  /// How old a picture may be and still be shown, and still be kept. Session-only overlays, so a
  /// run can prove the caps bite without leaving a 10 ms display cap in the operator's Settings.
  /// Zero means off, which is how a run turns a cap back off again.
  public var displayLatencyCapMilliseconds: Double?
  public var diskLatencyCapMilliseconds: Double?
  /// How long the app may have been away and still pick a take back up, in seconds. A flow can
  /// set it to a second or two and reach the expiry without waiting an hour for it.
  public var resumeDowntimeLimitSeconds: Double?

  public init() {}

  public static func resolve(
    arguments: [String] = ProcessInfo.processInfo.arguments,
    environment: [String: String] = ProcessInfo.processInfo.environment,
    defaults: UserDefaults = .standard
  ) -> LaunchConfiguration {
    let values = parse(arguments: arguments, environment: environment, defaults: defaults)
    var configuration = LaunchConfiguration()

    configuration.isUITest = boolean(values["uiTest"]) ?? false
    if let raw = values["sourceProfile"], let profile = SourceProfile(rawValue: raw) {
      configuration.sourceProfile = profile
    }
    configuration.useTestClock = boolean(values["testClock"]) ?? configuration.isUITest
    configuration.autoRecord = boolean(values["autoRecord"]) ?? false
    configuration.clearState = boolean(values["clearState"]) ?? false
    configuration.fixtureDirectory = values["fixtureDir"]
    if let rate = values["frameRate"].flatMap({ Double($0) }), rate > 0 {
      configuration.syntheticFrameRate = rate
    }
    if let width = values["sourceWidth"].flatMap({ Int($0) }), width > 0 {
      configuration.syntheticWidth = width
    }
    if let height = values["sourceHeight"].flatMap({ Int($0) }), height > 0 {
      configuration.syntheticHeight = height
    }
    if let seconds = values["segmentSeconds"].flatMap({ Double($0) }), seconds > 0 {
      configuration.segmentSeconds = seconds
    }
    if let raw = values["syntheticEntropy"]?.lowercased(), let level = SyntheticEntropy(rawValue: raw) {
      configuration.syntheticEntropy = level
    }
    configuration.archiveAudio = boolean(values["archiveAudio"]) ?? true
    if let raw = values["programCodec"]?.lowercased(), let codec = ProgramCodec(rawValue: raw) {
      configuration.programCodec = codec
    }
    if let raw = values["cameraCodec"]?.lowercased(), let codec = CompressedFrame.Codec(rawValue: raw) {
      configuration.cameraCodec = codec
    }
    configuration.debugHUD = boolean(values["debugHUD"])
    if let count = values["sourceCount"].flatMap({ Int($0) }), count > 0 {
      configuration.syntheticCount = count
    }
    if let transport = values["rtspTransport"]?.lowercased(), !transport.isEmpty {
      configuration.rtspTransport = transport
    }
    if let hosts = values["rtspHosts"] {
      configuration.rtspHosts = splitList(hosts)
    }
    if let path = values["rtspPath"], !path.isEmpty {
      configuration.rtspPath = path
    }
    configuration.rtspScan = boolean(values["rtspScan"]) ?? true
    // Semicolon as well as comma, for the same reason `rtspHosts` accepts both: Maestro
    // `-e KEY=a,b` keeps only `a`.
    if let names = values["ndiSources"] {
      configuration.ndiSources = splitList(names)
    }
    if let ips = values["ndiExtraIPs"] {
      configuration.ndiExtraIPs = splitList(ips)
    }
    if let bandwidth = values["ndiBandwidth"]?.lowercased(), !bandwidth.isEmpty {
      configuration.ndiBandwidth = bandwidth
    }
    configuration.ndiLocalSources = boolean(values["ndiLocalSources"]) ?? true
    configuration.ndiReliableUDP = boolean(values["ndiRudp"]) ?? false
    if let raw = values["sourceEncodeCodec"]?.lowercased(), let codec = ProgramCodec(rawValue: raw) {
      configuration.sourceEncodeCodec = codec
    }
    if let value = values["sourceEncodeBitrate"], let rate = Int(value), rate > 0 {
      configuration.sourceEncodeBitrate = rate
    }
    if let value = values["sourceEncodeLimit"], let limit = Int(value), limit > 0 {
      configuration.sourceEncodeLimit = limit
    }
    configuration.streamURL = values["streamURL"]
    if let value = values["programBitrate"], let rate = Int(value), rate > 0 {
      configuration.programBitrate = rate
    }
    if let value = values["programFrameRate"], let rate = Int(value), rate > 0 {
      configuration.programFrameRate = rate
    }
    configuration.applyStreamOverlays(values)
    if let value = values["displayLatencyCap"], let cap = Double(value), cap >= 0 {
      configuration.displayLatencyCapMilliseconds = cap
    }
    if let value = values["diskLatencyCap"], let cap = Double(value), cap >= 0 {
      configuration.diskLatencyCapMilliseconds = cap
    }
    if let value = values["resumeLimit"], let seconds = Double(value), seconds > 0 {
      configuration.resumeDowntimeLimitSeconds = seconds
    }

    // `-key value` is registered in UserDefaults by the system before `main` runs, and it stays
    // there after the process exits. The next tap of the icon would then still be running last
    // night's Maestro arguments — which is how a test flag replaced a stored operator setting,
    // and how the telemetry overlay vanished after `live.yaml` passed `debugHUD: false`.
    for key in knownKeys {
      defaults.removeObject(forKey: key)
    }
    defaults.removeObject(forKey: "scoreboardURL")

    return configuration
  }

  /// Merges values delivered later over the control channel, so the `openLink` fallback can
  /// reconfigure an already-launched app.
  public mutating func apply(queryItems: [String: String]) {
    if let value = queryItems["uiTest"], let flag = Self.boolean(value) { isUITest = flag }
    if let raw = queryItems["sourceProfile"], let profile = SourceProfile(rawValue: raw) {
      sourceProfile = profile
    }
    if let value = queryItems["testClock"], let flag = Self.boolean(value) { useTestClock = flag }
    if let value = queryItems["autoRecord"], let flag = Self.boolean(value) { autoRecord = flag }
    if let value = queryItems["frameRate"], let rate = Double(value), rate > 0 { syntheticFrameRate = rate }
    if let value = queryItems["segmentSeconds"], let seconds = Double(value), seconds > 0 {
      segmentSeconds = seconds
    }
    if let value = queryItems["streamURL"] { streamURL = value }
    if let value = queryItems["programBitrate"], let rate = Int(value), rate > 0 {
      programBitrate = rate
    }
    if let value = queryItems["programFrameRate"], let rate = Int(value), rate > 0 {
      programFrameRate = rate
    }
    applyStreamOverlays(queryItems)
    if let value = queryItems["displayLatencyCap"], let cap = Double(value), cap >= 0 {
      displayLatencyCapMilliseconds = cap
    }
    if let value = queryItems["diskLatencyCap"], let cap = Double(value), cap >= 0 {
      diskLatencyCapMilliseconds = cap
    }
    if let value = queryItems["resumeLimit"], let seconds = Double(value), seconds > 0 {
      resumeDowntimeLimitSeconds = seconds
    }
  }

  /// `streamCodec` (`h264` or `hevc`), `streamResolution` (`1280x720`), `streamFrameRate`, and
  /// `streamBitrateLow` / `streamBitrateHigh` in bits per second.
  mutating func applyStreamOverlays(_ values: [String: String]) {
    if let raw = values["streamCodec"]?.lowercased() {
      if let codec = ProgramCodec(rawValue: raw.replacingOccurrences(of: "h265", with: "hevc")) {
        streamCodec = codec
      }
    }
    if let raw = values["streamResolution"]?.lowercased() {
      let parts = raw.split(separator: "x").compactMap { Int($0) }
      if parts.count == 2, parts[0] > 0, parts[1] > 0 {
        streamResolution = ProgramResolution(width: parts[0], height: parts[1])
      }
    }
    if let value = values["streamFrameRate"], let rate = Int(value), rate > 0 { streamFrameRate = rate }
    if let value = values["streamBitrateLow"], let rate = Int(value), rate > 0 { streamBitrateLow = rate }
    if let value = values["streamBitrateHigh"], let rate = Int(value), rate > 0 { streamBitrateHigh = rate }
  }

  /// Names of every key understood here, surfaced in the HUD so a failing flow shows what the
  /// app actually received.
  public static let knownKeys = [
    "uiTest", "sourceProfile", "testClock", "autoRecord", "clearState", "fixtureDir",
    "frameRate", "sourceWidth", "sourceHeight", "segmentSeconds",
    "syntheticEntropy", "archiveAudio", "programCodec", "cameraCodec", "debugHUD", "sourceCount",
    // A key missing from this array is silently ignored, which has already cost this project
    // debugging time; every argument above must appear here.
    "rtspTransport", "rtspHosts", "rtspPath", "rtspScan", "streamURL",
    "programBitrate", "programFrameRate", "displayLatencyCap", "diskLatencyCap", "resumeLimit",
    "ndiSources", "ndiExtraIPs", "ndiBandwidth", "ndiLocalSources", "ndiRudp",
    "sourceEncodeCodec", "sourceEncodeBitrate", "sourceEncodeLimit",
    "streamCodec", "streamResolution", "streamFrameRate", "streamBitrateLow", "streamBitrateHigh"
  ]

  /// Semicolon as well as comma: Maestro `-e KEY=a,b` keeps only `a`, which left the M4 farm
  /// looking like a single camera when LAN_HOSTS listed four host:port pairs.
  static func splitList(_ value: String) -> [String] {
    value
      .split { $0 == "," || $0 == ";" }
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
  }

  static func parse(
    arguments: [String],
    environment: [String: String],
    defaults: UserDefaults
  ) -> [String: String] {
    var values: [String: String] = [:]

    for key in knownKeys {
      // `-key value` is consumed by UserDefaults before main() runs, so the current launch's
      // arguments have to be read from there. Values left behind by a previous launch must not:
      // they are why a Maestro argument outlived the test and replaced an operator setting.
      if let value = defaults.string(forKey: key), launchedWith(key, in: arguments) {
        values[key] = value
      }
      if let value = environment[key] { values[key] = value }
      if let value = environment["GSP_" + key] { values[key] = value }
    }

    var index = 0
    while index < arguments.count {
      let argument = arguments[index]
      if argument.hasPrefix("--"), argument.contains("=") {
        let parts = argument.dropFirst(2).split(separator: "=", maxSplits: 1)
        if parts.count == 2 { values[String(parts[0])] = String(parts[1]) }
      } else if argument.hasPrefix("-"), !argument.hasPrefix("--"), index + 1 < arguments.count {
        let key = String(argument.dropFirst())
        if knownKeys.contains(key) { values[key] = arguments[index + 1] }
        index += 1
      } else if argument.contains("="), !argument.hasPrefix("-") {
        let parts = argument.split(separator: "=", maxSplits: 1)
        if parts.count == 2, knownKeys.contains(String(parts[0])) {
          values[String(parts[0])] = String(parts[1])
        }
      }
      index += 1
    }
    return values
  }

  /// True when this process was actually launched with `key`, as opposed to UserDefaults still
  /// holding a value written by a previous `-key value` launch.
  private static func launchedWith(_ key: String, in arguments: [String]) -> Bool {
    arguments.contains("-" + key)
      || arguments.contains("--" + key)
      || arguments.contains { argument in
        argument.hasPrefix("--\(key)=") || argument.hasPrefix("\(key)=")
      }
  }

  static func boolean(_ value: String?) -> Bool? {
    guard let value = value?.lowercased() else { return nil }
    switch value {
    case "1", "true", "yes", "on": return true
    case "0", "false", "no", "off": return false
    default: return nil
    }
  }
}
