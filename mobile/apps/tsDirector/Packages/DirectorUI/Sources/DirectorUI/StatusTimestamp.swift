import Foundation

/// The instant a toast was posted, written the way an operator reads a clock: full date, time to
/// the millisecond, then the shortest name the zone has.
///
/// `2026-09-09 11:17:18.123 PT`
public enum StatusTimestamp {
  public static func format(
    _ date: Date,
    zone: TimeZone = .current,
    locale: Locale = .current
  ) -> String {
    let formatter = DateFormatter()
    // A fixed locale, or the pattern is reordered and repunctuated to taste. The zone name
    // below is the only part the device's own locale should influence.
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = zone
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
    return formatter.string(from: date) + " " + zoneName(zone, at: date, locale: locale)
  }

  /// The shortest unambiguous name for `zone`, which is not always the generic one.
  ///
  /// `.shortGeneric` gives the two-letter form the operator wants — `PT` rather than `PDT` — but
  /// only for the US zones, and only under a US locale. Everywhere else it is a phrase:
  /// `Los Angeles Time` on an iPad set to English (UK), `United Kingdom Time` in London,
  /// `Germany Time` in Berlin. A phrase on the end of a timestamp is not a zone reading, so it
  /// is taken only when it is genuinely short, and the offset abbreviation — `PDT`, `GMT+1` —
  /// is used when it is not.
  static func zoneName(_ zone: TimeZone, at date: Date, locale: Locale) -> String {
    let candidates = [
      zone.localizedName(for: .shortGeneric, locale: locale),
      zone.abbreviation(for: date),
      zone.localizedName(for: .shortStandard, locale: locale)
    ]
    for candidate in candidates.compactMap({ $0 }) where isCompact(candidate) {
      return candidate
    }
    return zone.abbreviation(for: date) ?? zone.identifier
  }

  /// Short enough to read as a zone rather than as a sentence.
  private static func isCompact(_ name: String) -> Bool {
    !name.contains(" ") && name.count <= 6
  }
}
