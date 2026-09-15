import Foundation

/// Everything GS Distributor remembers. The Mac keeps a copy and GS Director keeps one on the
/// iPad; `reconciled(with:)` brings the two together whenever the iPad is attached, so the
/// Distributor works with the iPad away and nothing edited meanwhile is lost.
///
/// Every field decodes with a default when it is missing, so settings written by an older build
/// still load in a newer one.
public struct DistributorSettings: Codable, Equatable, Sendable {
  public var version: Int
  /// Download folder per Mac, keyed by the Mac's `IOPlatformUUID`, so a second Mac gets its own
  /// folder instead of a path that does not exist on it.
  public var destinations: [String: String]
  public var createCombined: Bool
  /// Whether the iPad takes a share of an export's stitching. Off, the Mac stitches every file;
  /// files the iPad already stitched are still fetched from it.
  public var iPadStitching: Bool
  public var combinedLayout: CombinedLayoutSettings
  public var peerTube: PeerTubeSettings
  /// When each group last changed and on which device, by `SettingsGroup.key`. A group with no
  /// stamp has not changed since before stamps were kept.
  public var stamps: [String: SettingsStamp]

  public static let currentVersion = 2

  public init(
    destinations: [String: String] = [:],
    createCombined: Bool = false,
    iPadStitching: Bool = false,
    combinedLayout: CombinedLayoutSettings = CombinedLayoutSettings(),
    peerTube: PeerTubeSettings = PeerTubeSettings(),
    stamps: [String: SettingsStamp] = [:]
  ) {
    self.version = Self.currentVersion
    self.destinations = destinations
    self.createCombined = createCombined
    self.iPadStitching = iPadStitching
    self.combinedLayout = combinedLayout
    self.peerTube = peerTube
    self.stamps = stamps
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    version = try container.decodeIfPresent(Int.self, forKey: .version) ?? Self.currentVersion
    destinations = try container.decodeIfPresent([String: String].self, forKey: .destinations) ?? [:]
    createCombined = try container.decodeIfPresent(Bool.self, forKey: .createCombined) ?? false
    iPadStitching = try container.decodeIfPresent(Bool.self, forKey: .iPadStitching) ?? false
    combinedLayout = try container.decodeIfPresent(CombinedLayoutSettings.self, forKey: .combinedLayout)
      ?? CombinedLayoutSettings()
    peerTube = try container.decodeIfPresent(PeerTubeSettings.self, forKey: .peerTube) ?? PeerTubeSettings()
    stamps = try container.decodeIfPresent([String: SettingsStamp].self, forKey: .stamps) ?? [:]
  }
}

public struct PeerTubeSettings: Codable, Equatable, Sendable {
  public var enabled: Bool
  /// Bare host, optionally with a port: `videos.example.org`. Always reached over https.
  public var host: String?
  public var username: String?
  public var channelID: Int?
  /// Nil until the user picks one; `PeerTubePrivacy.preferred` decides until then.
  public var privacy: Int?
  public var uploadChoice: UploadChoice

  public init(
    enabled: Bool = false,
    host: String? = nil,
    username: String? = nil,
    channelID: Int? = nil,
    privacy: Int? = nil,
    uploadChoice: UploadChoice = UploadChoice()
  ) {
    self.enabled = enabled
    self.host = host
    self.username = username
    self.channelID = channelID
    self.privacy = privacy
    self.uploadChoice = uploadChoice
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
    host = try container.decodeIfPresent(String.self, forKey: .host)
    username = try container.decodeIfPresent(String.self, forKey: .username)
    channelID = try container.decodeIfPresent(Int.self, forKey: .channelID)
    privacy = try container.decodeIfPresent(Int.self, forKey: .privacy)
    uploadChoice = try container.decodeIfPresent(UploadChoice.self, forKey: .uploadChoice) ?? UploadChoice()
  }
}

/// Which files of an export go to PeerTube. Cameras are remembered by name.
public struct UploadChoice: Codable, Equatable, Sendable {
  public var primary: Bool
  public var cameras: [String]
  public var combined: Bool

  public init(primary: Bool = true, cameras: [String] = [], combined: Bool = false) {
    self.primary = primary
    self.cameras = cameras
    self.combined = combined
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    primary = try container.decodeIfPresent(Bool.self, forKey: .primary) ?? true
    cameras = try container.decodeIfPresent([String].self, forKey: .cameras) ?? []
    combined = try container.decodeIfPresent(Bool.self, forKey: .combined) ?? false
  }

  /// The remembered choice as it applies to one export: only what that export makes can be ticked.
  /// Names it does not have are left out here but stay in the remembered choice.
  public func applied(hasPrimary: Bool, cameras available: [String], makesCombined: Bool) -> UploadChoice {
    UploadChoice(
      primary: primary && hasPrimary,
      cameras: available.filter { cameras.contains($0) },
      combined: combined && makesCombined
    )
  }

  /// Saves what was ticked this time without forgetting cameras this export did not have.
  public func remembering(_ ticked: UploadChoice, from available: [String]) -> UploadChoice {
    UploadChoice(
      primary: ticked.primary,
      cameras: ticked.cameras + cameras.filter { !available.contains($0) },
      combined: ticked.combined
    )
  }
}
