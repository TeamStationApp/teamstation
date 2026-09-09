import DirectorUI
import Foundation
import Testing

@Suite("Status timestamp")
struct StatusTimestampTests {
  /// 2026-09-09T18:17:18.123Z, which is 11:17:18.123 in Los Angeles on that day.
  private let instant = Date(timeIntervalSince1970: 1_788_977_838.123)
  private let english = Locale(identifier: "en_US")

  private func text(_ zone: String, _ locale: Locale) -> String {
    StatusTimestamp.format(instant, zone: TimeZone(identifier: zone)!, locale: locale)
  }

  @Test("Pacific time is written PT, not PDT")
  func pacific() {
    #expect(text("America/Los_Angeles", english) == "2026-09-09 11:17:18.123 PT")
  }

  @Test("Another zone shifts the clock and names itself")
  func eastern() {
    #expect(text("America/New_York", english) == "2026-09-09 14:17:18.123 ET")
  }

  @Test("UTC is named GMT, which is what Foundation calls it")
  func utc() {
    #expect(text("UTC", english) == "2026-09-09 18:17:18.123 GMT")
  }

  /// The generic name is only two letters for US zones under a US locale. Elsewhere it is a
  /// phrase — "Los Angeles Time", "United Kingdom Time" — which is not a zone reading, so the
  /// offset abbreviation is used instead of letting a sentence onto the end of the timestamp.
  @Test("A non-US locale falls back to the abbreviation rather than a phrase")
  func nonUSLocale() {
    #expect(text("America/Los_Angeles", Locale(identifier: "en_GB")) == "2026-09-09 11:17:18.123 PDT")
  }

  @Test("A zone with no short generic name uses its offset")
  func nonUSZone() {
    #expect(text("Europe/Berlin", english) == "2026-09-09 20:17:18.123 GMT+2")
    #expect(text("Europe/London", english) == "2026-09-09 19:17:18.123 GMT+1")
  }

  @Test("Every zone and locale ends in something short enough to read as a zone")
  func alwaysShort() {
    for zone in ["America/Los_Angeles", "Europe/London", "Asia/Tokyo", "UTC", "Australia/Sydney"] {
      for locale in ["en_US", "en_GB", "de_DE", "ja_JP"] {
        let suffix = text(zone, Locale(identifier: locale))
          .split(separator: " ").last.map(String.init) ?? ""
        #expect(!suffix.isEmpty, "\(zone) \(locale)")
        #expect(suffix.count <= 6, "\(zone) \(locale) gave \(suffix)")
      }
    }
  }
}
