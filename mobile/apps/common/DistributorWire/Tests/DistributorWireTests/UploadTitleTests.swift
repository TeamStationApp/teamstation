import Foundation
import DistributorWire
import Testing

@Suite("Titles for the files of an export")
struct UploadTitleTests {
  @Test("Titles are the field's text with the camera's name, or 'combined'; the date is only where the field starts")
  func titles() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
    let start = try #require(calendar.date(from: DateComponents(year: 2026, month: 9, day: 13, hour: 17)))
    #expect(UploadTitle.datePrefix(for: start, timeZone: calendar.timeZone) == "2026-09-13")
    #expect(UploadTitle.initialTitle(for: start, timeZone: calendar.timeZone) == "2026-09-13 ")

    let title = "  2026-09-13 bandits versus blueberries "
    #expect(UploadTitle.make(title: title, track: .primary) == "2026-09-13 bandits versus blueberries")
    #expect(UploadTitle.make(title: title, track: .camera("Home")) == "2026-09-13 bandits versus blueberries Home")
    #expect(UploadTitle.make(title: title, track: .combined) == "2026-09-13 bandits versus blueberries combined")
    // With the date deleted, the title is sent as it stands.
    #expect(UploadTitle.make(title: "bandits versus blueberries", track: .camera("Home")) == "bandits versus blueberries Home")
  }

  @Test("The date is the recording's local date, not UTC's")
  func localDate() throws {
    // 01:30 UTC on the 14th is still the evening of the 13th in California.
    let start = try #require(ISO8601DateFormatter().date(from: "2026-09-14T01:30:00Z"))
    let pacific = try #require(TimeZone(identifier: "America/Los_Angeles"))
    #expect(UploadTitle.datePrefix(for: start, timeZone: pacific) == "2026-09-13")
  }
}
