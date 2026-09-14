import Foundation
import DistributorWire
import Testing

@Suite("PeerTube titles, hosts and privacy")
struct PeerTubeTests {
  @Test("Titles are the field's text with the camera's name, or 'combined'; the date is only where the field starts")
  func titles() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
    let start = try #require(calendar.date(from: DateComponents(year: 2026, month: 9, day: 13, hour: 17)))
    #expect(PeerTubeTitle.datePrefix(for: start, timeZone: calendar.timeZone) == "2026-09-13")
    #expect(PeerTubeTitle.initialTitle(for: start, timeZone: calendar.timeZone) == "2026-09-13 ")

    let title = "  2026-09-13 badgers versus blueberries "
    #expect(PeerTubeTitle.make(title: title, track: .primary) == "2026-09-13 badgers versus blueberries")
    #expect(PeerTubeTitle.make(title: title, track: .camera("Home")) == "2026-09-13 badgers versus blueberries Home")
    #expect(PeerTubeTitle.make(title: title, track: .combined) == "2026-09-13 badgers versus blueberries combined")
    // With the date deleted, the title is sent as it stands.
    #expect(PeerTubeTitle.make(title: "badgers versus blueberries", track: .camera("Home")) == "badgers versus blueberries Home")
  }

  @Test("The date is the recording's local date, not UTC's")
  func localDate() throws {
    // 01:30 UTC on the 14th is still the evening of the 13th in California.
    let start = try #require(ISO8601DateFormatter().date(from: "2026-09-14T01:30:00Z"))
    let pacific = try #require(TimeZone(identifier: "America/Los_Angeles"))
    #expect(PeerTubeTitle.datePrefix(for: start, timeZone: pacific) == "2026-09-13")
  }

  @Test("The room left is measured against the longest title that will be sent")
  func remainingLength() {
    let title = "2026-09-13 " + String(repeating: "x", count: 100)
    // 111 characters; " combined" makes 120 exactly; " Third Base" makes 122.
    #expect(PeerTubeTitle.remaining(title: title, tracks: [ .primary, .combined ]) == 0)
    #expect(PeerTubeTitle.remaining(title: title, tracks: [ .camera("Third Base") ]) == -2)
    #expect(PeerTubeTitle.isValid(title: title, tracks: [ .primary, .combined ]))
    #expect(!PeerTubeTitle.isValid(title: title, tracks: [ .camera("Third Base") ]))
    #expect(!PeerTubeTitle.isValid(title: "   ", tracks: [ .primary ]))
    #expect(!PeerTubeTitle.isValid(title: "ab", tracks: [ .primary ]))
  }

  @Test("The instance field keeps only the host, and refuses plain http")
  func hosts() throws {
    #expect(try PeerTubeHost.normalize("videos.example.org") == "videos.example.org")
    #expect(try PeerTubeHost.normalize(" https://Videos.Example.org/videos/watch/abc?x=1 ") == "videos.example.org")
    #expect(try PeerTubeHost.normalize("videos.example.org:9000/") == "videos.example.org:9000")
    #expect(throws: PeerTubeHost.Problem.insecure) { try PeerTubeHost.normalize("http://videos.example.org") }
    #expect(throws: PeerTubeHost.Problem.empty) { try PeerTubeHost.normalize("https://") }
    #expect(throws: PeerTubeHost.Problem.notAHost) { try PeerTubeHost.normalize("not a host") }
    #expect(throws: PeerTubeHost.Problem.notAHost) { try PeerTubeHost.normalize("user@videos.example.org") }
    #expect(PeerTubeHost.baseURL("videos.example.org")?.absoluteString == "https://videos.example.org")
  }

  @Test("Privacy defaults to 6 where the instance offers it, else unlisted")
  func privacy() {
    #expect(PeerTubePrivacy.preferred(chosen: nil, offered: [ 1, 2, 3, 4, 5, 6 ]) == 6)
    #expect(PeerTubePrivacy.preferred(chosen: nil, offered: [ 1, 2, 3, 4, 5 ]) == 2)
    #expect(PeerTubePrivacy.preferred(chosen: 1, offered: [ 1, 2, 6 ]) == 1)
    // A choice the instance no longer offers falls back like no choice at all.
    #expect(PeerTubePrivacy.preferred(chosen: 5, offered: [ 1, 2, 6 ]) == 6)
  }
}
