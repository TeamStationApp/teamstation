import DistributorWire
import Foundation

/// Whether an export fits on this Mac, asked before it writes anything.
///
/// The saved files and the combined video go to the download folder. While the Mac stitches a
/// camera it also holds that camera's segments in the temporary folder, one camera at a time.
/// Some room is always left over, so an export never takes a disk to its last byte.
public struct SpaceCheck: Sendable {
  public var freeBytes: @Sendable (URL) -> Int64?
  public var volume: @Sendable (URL) -> String?

  public init(freeBytes: @escaping @Sendable (URL) -> Int64?, volume: @escaping @Sendable (URL) -> String?) {
    self.freeBytes = freeBytes
    self.volume = volume
  }

  /// This Mac's disks.
  public static let system = SpaceCheck(
    freeBytes: { url in
      (try? url.resourceValues(forKeys: [ .volumeAvailableCapacityForImportantUsageKey ]))?
        .volumeAvailableCapacityForImportantUsage
    },
    volume: { url in
      (try? url.resourceValues(forKeys: [ .volumeUUIDStringKey ]))?.volumeUUIDString
    }
  )

  /// Left free whatever an export needs.
  public static let margin: Int64 = 2 << 30

  /// Nil when the export fits; otherwise what to tell the user.
  public func shortfall(trackBytes: [Int64], combinedBytes: Int64, destination: URL, scratch: URL) -> String? {
    let saved = trackBytes.reduce(0, +) + combinedBytes
    let working = trackBytes.max() ?? 0
    let destinationVolume = volume(destination)
    let sameDisk = destinationVolume != nil && destinationVolume == volume(scratch)
    let needs: [(url: URL, bytes: Int64)] = sameDisk
      ? [ (destination, saved + working) ]
      : [ (destination, saved), (scratch, working) ]
    for need in needs where need.bytes > 0 {
      guard let free = freeBytes(need.url) else { continue }
      let wanted = need.bytes + Self.margin
      if free < wanted {
        return "Not enough room on \(Self.diskName(need.url)): this export needs about \(Self.format(wanted)) and \(Self.format(free)) is free"
      }
    }
    return nil
  }

  static func format(_ bytes: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
  }

  static func diskName(_ url: URL) -> String {
    (try? url.resourceValues(forKeys: [ .volumeNameKey ]))?.volumeName ?? url.path
  }
}

public enum ExportSpace {
  /// The bytes behind each track of a manifest: a camera's segments, or the programme's parts. A
  /// stitched file comes out about as large as what it was stitched from.
  public static func bytesPerTrack(_ files: [RemoteFile]) -> [Int64] {
    var tracks: [String: Int64] = [:]
    for file in files {
      let track = file.root == .program ? "primary" : String(file.path.split(separator: "/").first ?? "")
      tracks[track, default: 0] += file.bytes
    }
    return Array(tracks.values)
  }

  /// A combined video of `cameras` over `seconds`, at the bit rate it is encoded at.
  public static func combinedBytes(seconds: Double, cameras: Int) -> Int64 {
    Int64(Double(CombinedLayoutRules.bitsPerSecond(cameraCount: cameras)) / 8 * max(0, seconds))
  }
}
