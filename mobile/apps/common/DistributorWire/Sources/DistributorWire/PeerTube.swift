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
/// For a recording that started on 2026-09-13, with "badgers versus blueberries" typed after the
/// date:
///
/// - primary output: `2026-09-13 badgers versus blueberries`
/// - camera Home: `2026-09-13 badgers versus blueberries Home`
/// - combined video: `2026-09-13 badgers versus blueberries combined`
public enum PeerTubeTitle {
  /// PeerTube's limits on a video name.
  public static let minimumLength = 3
  public static let maximumLength = 120

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

  /// How many more characters the title can take before the longest of `tracks`' titles passes
  /// PeerTube's limit. Negative when it already has.
  public static func remaining(title: String, tracks: [UploadTrack]) -> Int {
    let longest = tracks.map { make(title: title, track: $0).count }.max()
      ?? make(title: title, track: .primary).count
    return maximumLength - longest
  }

  /// Every title fits PeerTube's limits, and the field is not blank.
  public static func isValid(title: String, tracks: [UploadTrack]) -> Bool {
    guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    return tracks.allSatisfy {
      let length = make(title: title, track: $0).count
      return length >= minimumLength && length <= maximumLength
    }
  }
}

/// The instance field takes a host, not a URL. https is assumed and never stored.
public enum PeerTubeHost {
  public enum Problem: Error, Equatable, Sendable {
    case empty
    case insecure
    case notAHost
  }

  /// `videos.example.org`, `https://videos.example.org/some/page` and ` Videos.Example.org:9000 `
  /// all normalise to the bare host (with its port, if it has one). `http://…` is refused.
  public static func normalize(_ input: String) throws(Problem) -> String {
    var rest = input.trimmingCharacters(in: .whitespacesAndNewlines)
    let lowered = rest.lowercased()
    if lowered.hasPrefix("http://") { throw .insecure }
    if lowered.hasPrefix("https://") { rest = String(rest.dropFirst("https://".count)) }
    if let cut = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
      rest = String(rest[..<cut])
    }
    guard !rest.isEmpty else { throw .empty }
    guard !rest.contains("@"),
          let components = URLComponents(string: "https://\(rest)"),
          let host = components.host, !host.isEmpty, host.contains(".") || host == "localhost"
    else { throw .notAHost }
    let port = components.port.map { ":\($0)" } ?? ""
    return host.lowercased() + port
  }

  public static func baseURL(_ host: String) -> URL? {
    URL(string: "https://\(host)")
  }
}

public enum PeerTubePrivacy {
  public static let unlisted = 2
  /// Offered by Paul's instance, not by upstream PeerTube (which defines 1 to 5).
  public static let channel = 6

  /// What an upload uses when the user has not picked: 6 where the instance offers it, else
  /// unlisted.
  public static func preferred(chosen: Int?, offered: [Int]) -> Int {
    if let chosen, offered.isEmpty || offered.contains(chosen) { return chosen }
    return offered.contains(channel) ? channel : unlisted
  }
}
