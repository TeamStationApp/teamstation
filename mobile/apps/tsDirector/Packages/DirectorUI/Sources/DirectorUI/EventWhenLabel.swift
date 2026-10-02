import Foundation

/// `Tue Dec 22, 2026 4:35 PM` in `zone`.
enum EventWhenLabel {
  static func format(_ date: Date, zone: TimeZone = .current) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = zone
    formatter.dateFormat = "EEE MMM d, yyyy h:mm a"
    return formatter.string(from: date)
  }
}
