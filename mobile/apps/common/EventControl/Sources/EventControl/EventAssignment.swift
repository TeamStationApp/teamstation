import Foundation

/// The publishing event a Director assigns: the selected game's own ID, and the description the
/// apps already show for it — its teams title and its start time.
///
/// The game ID is the only destination. It is never shown; the title and start time are what a
/// receiver puts in its event row while it is controlled.
public struct EventAssignment: Sendable, Hashable, Codable {
  /// The game's own ID: trimmed, never empty, at most 128 UTF-8 bytes.
  public let gameId: String
  /// "Away at Home": trimmed, never empty, at most 256 UTF-8 bytes.
  public let title: String
  /// The start time in UTC to the second, exactly `YYYY-MM-DDTHH:MM:SSZ`.
  public let startAt: String

  public static let maxGameIdBytes = 128
  public static let maxTitleBytes = 256

  public enum Problem: Error, Equatable {
    case emptyGameId
    case gameIdTooLong
    case untrimmedGameId
    case emptyTitle
    case titleTooLong
    case untrimmedTitle
    case badStartAt
  }

  /// Built from the event a Director has selected.
  ///
  /// The game ID and title are trimmed of ASCII whitespace. An empty or over-long game ID is
  /// refused rather than shortened, since a shortened ID names some other game or none; a title
  /// over 256 bytes is cut at the last whole character that fits, since it is only a label. The
  /// start time is written in UTC, dropping fractions of a second.
  public init(gameId: String, title: String, startAt: Date) throws(Problem) {
    let id = Self.trimmed(gameId)
    guard !id.isEmpty else { throw .emptyGameId }
    guard id.utf8.count <= Self.maxGameIdBytes else { throw .gameIdTooLong }
    var label = Self.trimmed(title)
    guard !label.isEmpty else { throw .emptyTitle }
    while label.utf8.count > Self.maxTitleBytes { label.removeLast() }
    self.gameId = id
    self.title = Self.trimmed(label)
    self.startAt = Self.format(startAt)
  }

  /// The assignment from a selection that may be absent: nil when there is no event, or when it
  /// cannot be sent (an empty or over-long game ID). A missing event is never sent as an empty one.
  public static func from(gameId: String?, title: String?, startAt: Date?) -> EventAssignment? {
    guard let gameId, let title, let startAt else { return nil }
    return try? EventAssignment(gameId: gameId, title: title, startAt: startAt)
  }

  /// Exactly as received: refused unless every field already has its canonical form.
  public init(wireGameId gameId: String, title: String, startAt: String) throws(Problem) {
    guard !gameId.isEmpty else { throw .emptyGameId }
    guard gameId.utf8.count <= Self.maxGameIdBytes else { throw .gameIdTooLong }
    guard Self.trimmed(gameId) == gameId else { throw .untrimmedGameId }
    guard !title.isEmpty else { throw .emptyTitle }
    guard title.utf8.count <= Self.maxTitleBytes else { throw .titleTooLong }
    guard Self.trimmed(title) == title else { throw .untrimmedTitle }
    guard Self.parse(startAt) != nil else { throw .badStartAt }
    self.gameId = gameId
    self.title = title
    self.startAt = startAt
  }

  /// The start time as a date.
  public var startDate: Date { Self.parse(startAt)! }

  enum CodingKeys: String, CodingKey { case gameId, title, startAt }

  /// Persisted assignments are read back as strictly as received ones.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try self.init(
      wireGameId: container.decode(String.self, forKey: .gameId),
      title: container.decode(String.self, forKey: .title),
      startAt: container.decode(String.self, forKey: .startAt)
    )
  }

  // MARK: - The canonical forms

  /// Space, tab, line feed, vertical tab, form feed and carriage return, and nothing else, so that
  /// every implementation trims exactly the same characters.
  static func trimmed(_ text: String) -> String {
    let blank: Set<UInt8> = [ 0x20, 0x09, 0x0A, 0x0B, 0x0C, 0x0D ]
    let bytes = Array(text.utf8)
    guard let first = bytes.firstIndex(where: { !blank.contains($0) }) else { return "" }
    let last = bytes.lastIndex(where: { !blank.contains($0) })!
    return String(decoding: bytes[first ... last], as: UTF8.self)
  }

  private static let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }()

  /// `YYYY-MM-DDTHH:MM:SSZ`, rounding down to the second.
  static func format(_ date: Date) -> String {
    let whole = Date(timeIntervalSince1970: (date.timeIntervalSince1970).rounded(.down))
    let parts = utc.dateComponents([ .year, .month, .day, .hour, .minute, .second ], from: whole)
    func two(_ value: Int?) -> String {
      let number = value ?? 0
      return number < 10 ? "0\(number)" : "\(number)"
    }
    let year = String(parts.year ?? 0)
    let paddedYear = String(repeating: "0", count: max(0, 4 - year.count)) + year
    return "\(paddedYear)-\(two(parts.month))-\(two(parts.day))T\(two(parts.hour)):"
      + "\(two(parts.minute)):\(two(parts.second))Z"
  }

  /// The date a canonical start time names, or nil for anything else, including a date that does
  /// not exist (February 30th).
  static func parse(_ text: String) -> Date? {
    let bytes = Array(text.utf8)
    guard bytes.count == 20 else { return nil }
    let shape = Array("dddd-dd-ddTdd:dd:ddZ".utf8)
    for (byte, expected) in zip(bytes, shape) {
      if expected == UInt8(ascii: "d") {
        guard (UInt8(ascii: "0") ... UInt8(ascii: "9")).contains(byte) else { return nil }
      } else if byte != expected {
        return nil
      }
    }
    func number(_ from: Int, _ count: Int) -> Int {
      bytes[from ..< from + count].reduce(0) { $0 * 10 + Int($1 - UInt8(ascii: "0")) }
    }
    let components = DateComponents(
      year: number(0, 4), month: number(5, 2), day: number(8, 2),
      hour: number(11, 2), minute: number(14, 2), second: number(17, 2)
    )
    guard (1 ... 12).contains(components.month!), (1 ... 31).contains(components.day!),
          components.hour! < 24, components.minute! < 60, components.second! < 60,
          let date = utc.date(from: components),
          utc.dateComponents([ .year, .month, .day ], from: date).day == components.day
    else { return nil }
    return date
  }
}
