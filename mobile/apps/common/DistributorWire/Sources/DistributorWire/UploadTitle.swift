import Foundation

/// One file of an export, as far as uploading is concerned.
public enum UploadTrack: Hashable, Codable, Sendable {
  case primary
  case camera(String)
  case combined
}

/// Titles for uploads. The title field starts as the recording's date and a space; it is an
/// ordinary field, so the user types after the date, or changes or deletes it. Each file's title is
/// what the field holds plus what the file is.
///
/// The suffix is not decoration: the library reads it to tell one camera of a
/// take from another, and the file with no suffix is the primary output. Two
/// videos of a game that share everything up to their last word are two angles
/// of it.
///
/// For a recording that started on 2026-09-13, with "badgers versus blueberries" typed after the
/// date:
///
/// - primary output: `2026-09-13 badgers versus blueberries`
/// - camera Home: `2026-09-13 badgers versus blueberries Home`
/// - combined video: `2026-09-13 badgers versus blueberries combined`
public enum UploadTitle {
  /// The recording's start date, local time.
  public static func datePrefix(for start: Date, timeZone: TimeZone = .current) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let parts = calendar.dateComponents([ .year, .month, .day ], from: start)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }

  /// What the title field holds before the user types: the date and a space.
  public static func initialTitle(for start: Date, timeZone: TimeZone = .current) -> String {
    datePrefix(for: start, timeZone: timeZone) + " "
  }

  public static func make(title: String, track: UploadTrack) -> String {
    let base = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let suffix: String? = switch track {
    case .primary: nil
    case .camera(let name): name
    case .combined: "combined"
    }
    guard let suffix else { return base }
    return base.isEmpty ? suffix : "\(base) \(suffix)"
  }
}
