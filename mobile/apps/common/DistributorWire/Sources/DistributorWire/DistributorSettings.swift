import Foundation

/// Everything GS Distributor remembers. The Mac keeps a copy and GS Director keeps one on the
/// iPad; `reconciled(with:)` brings the two together whenever the iPad is attached, so the
/// Distributor works with the iPad away and nothing edited meanwhile is lost.
///
/// Every field decodes with a default when it is missing, so settings written by an older build
/// still load in a newer one; a group the older build had and this one does not is left unread.
public struct DistributorSettings: Codable, Equatable, Sendable {
  public var version: Int
  /// Download folder per Mac, keyed by the Mac's `IOPlatformUUID`, so a second Mac gets its own
  /// folder instead of a path that does not exist on it.
  public var destinations: [String: String]
  public var createCombined: Bool
  /// Whether the iPad takes a share of an export's stitching. Off, the Mac stitches every file;
  /// files the iPad already stitched are still fetched from it.
  public var combinedLayout: CombinedLayoutSettings
  public var upload: UploadSettings
  /// When each group last changed and on which device, by `SettingsGroup.key`. A group with no
  /// stamp has not changed since before stamps were kept.
  public var stamps: [String: SettingsStamp]

  public static let currentVersion = 2

  public init(
    destinations: [String: String] = [:],
    createCombined: Bool = false,
    combinedLayout: CombinedLayoutSettings = CombinedLayoutSettings(),
    upload: UploadSettings = UploadSettings(),
    stamps: [String: SettingsStamp] = [:]
  ) {
    self.version = Self.currentVersion
    self.destinations = destinations
    self.createCombined = createCombined
    self.combinedLayout = combinedLayout
    self.upload = upload
    self.stamps = stamps
  }

  enum CodingKeys: String, CodingKey {
    case version, destinations, createCombined, combinedLayout, upload, stamps
    /// Where the ticked files were kept when uploads went to PeerTube. Read,
    /// never written.
    case peerTube
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(version, forKey: .version)
    try container.encode(destinations, forKey: .destinations)
    try container.encode(createCombined, forKey: .createCombined)
    try container.encode(combinedLayout, forKey: .combinedLayout)
    try container.encode(upload, forKey: .upload)
    try container.encode(stamps, forKey: .stamps)
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    version = try container.decodeIfPresent(Int.self, forKey: .version) ?? Self.currentVersion
    destinations = try container.decodeIfPresent([String: String].self, forKey: .destinations) ?? [:]
    createCombined = try container.decodeIfPresent(Bool.self, forKey: .createCombined) ?? false
    combinedLayout = try container.decodeIfPresent(CombinedLayoutSettings.self, forKey: .combinedLayout)
      ?? CombinedLayoutSettings()
    // Settings written before uploads stopped going to PeerTube kept the
    // ticked files inside that block. The account it sat beside is gone; the
    // ticks are the same ticks, so they are read from wherever they are.
    upload = try container.decodeIfPresent(UploadSettings.self, forKey: .upload)
      ?? UploadSettings(
        choice: try container.decodeIfPresent(LegacyPeerTubeSettings.self, forKey: .peerTube)?.uploadChoice
          ?? UploadChoice()
      )
    // A group this build does not have is not read, and neither is its stamp, so neither is
    // written back.
    stamps = (try container.decodeIfPresent([String: SettingsStamp].self, forKey: .stamps) ?? [:])
      .filter { SettingsGroup(key: $0.key) != nil }
  }
}

/// Which files of an export are sent, remembered between exports.
public struct UploadSettings: Codable, Equatable, Sendable {
  public var choice: UploadChoice

  public init(choice: UploadChoice = UploadChoice()) {
    self.choice = choice
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    choice = try container.decodeIfPresent(UploadChoice.self, forKey: .choice) ?? UploadChoice()
  }
}

/// Only what is still wanted from the block uploads used to keep: which files
/// were ticked. Read when settings written by an older build are loaded, and
/// never written.
struct LegacyPeerTubeSettings: Decodable {
  var uploadChoice: UploadChoice

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    uploadChoice = try container.decodeIfPresent(UploadChoice.self, forKey: .uploadChoice) ?? UploadChoice()
  }

  enum CodingKeys: String, CodingKey { case uploadChoice }
}

/// Which files of an export are ticked to be sent. Cameras are remembered by name.
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
