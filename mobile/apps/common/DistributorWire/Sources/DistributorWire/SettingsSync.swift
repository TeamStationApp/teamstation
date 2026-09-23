import Foundation

/// When a group of settings last changed, and on which device.
public struct SettingsStamp: Codable, Equatable, Sendable {
  public var modifiedAt: Date
  /// `SettingsStamp.iPad`, or the Mac's `IOPlatformUUID`.
  public var by: String

  public static let iPad = "ipad"

  public init(modifiedAt: Date, by: String) {
    self.modifiedAt = modifiedAt
    self.by = by
  }
}

/// The parts of the settings that change together, and are brought together as a whole: a newer
/// change to a group on either device replaces the whole group on the other.
public enum SettingsGroup: Hashable, Sendable {
  /// One Mac's download folder. Each Mac's is its own group, so two Macs never clash.
  case destination(mac: String)
  case createCombined
  case combinedLayout
  case upload

  /// Every group but the per-Mac folders.
  public static let shared: [SettingsGroup] = [
    .createCombined, .combinedLayout, .upload
  ]

  public var key: String {
    switch self {
    case .destination(let mac): "\(Self.destinationPrefix)\(mac)"
    case .createCombined: "createCombined"
    case .combinedLayout: "combinedLayout"
    case .upload: "upload"
    }
  }

  /// The group `key` names, or nil for one this build does not have.
  public init?(key: String) {
    if key.hasPrefix(Self.destinationPrefix) {
      self = .destination(mac: String(key.dropFirst(Self.destinationPrefix.count)))
      return
    }
    guard let group = Self.shared.first(where: { $0.key == key }) else { return nil }
    self = group
  }

  static let destinationPrefix = "destination:"
}

public extension DistributorSettings {
  func stamp(_ group: SettingsGroup) -> SettingsStamp? { stamps[group.key] }

  /// Every group whose value differs from `old`, stamped as changed now on `device`.
  func stampingChanges(from old: DistributorSettings, by device: String, at date: Date = Date()) -> DistributorSettings {
    var stamped = self
    for group in groups(alongside: old) where !sameValue(group, as: old) {
      stamped.stamps[group.key] = SettingsStamp(modifiedAt: date, by: device)
    }
    return stamped
  }

  /// Both copies brought together: each group from whichever copy changed it last. A group
  /// neither copy has stamped, or stamped at the same moment, comes from `other`.
  func reconciled(with other: DistributorSettings) -> DistributorSettings {
    var result = other
    for group in groups(alongside: other) {
      let mine = stamp(group)?.modifiedAt ?? .distantPast
      let theirs = other.stamp(group)?.modifiedAt ?? .distantPast
      guard mine > theirs else { continue }
      result.copy(group, from: self)
    }
    result.version = Self.currentVersion
    return result
  }

  // MARK: - Groups

  private func groups(alongside other: DistributorSettings) -> [SettingsGroup] {
    let stamped = (Array(stamps.keys) + Array(other.stamps.keys)).compactMap { key -> String? in
      guard case .destination(let mac) = SettingsGroup(key: key) else { return nil }
      return mac
    }
    let macs = Set(destinations.keys).union(other.destinations.keys).union(stamped)
    return SettingsGroup.shared + macs.sorted().map { SettingsGroup.destination(mac: $0) }
  }

  private func sameValue(_ group: SettingsGroup, as other: DistributorSettings) -> Bool {
    switch group {
    case .destination(let mac): destinations[mac] == other.destinations[mac]
    case .createCombined: createCombined == other.createCombined
    case .combinedLayout: combinedLayout == other.combinedLayout
    case .upload: upload == other.upload
    }
  }

  private mutating func copy(_ group: SettingsGroup, from other: DistributorSettings) {
    switch group {
    case .destination(let mac): destinations[mac] = other.destinations[mac]
    case .createCombined: createCombined = other.createCombined
    case .combinedLayout: combinedLayout = other.combinedLayout
    case .upload: upload = other.upload
    }
    stamps[group.key] = other.stamps[group.key]
  }
}
