import Foundation
import GameStationKit
import Testing

@testable import DirectorUI

/// What a row in the event picker says.
///
/// Paul specified this to the word — `Titan at Ravens, Thursday, September
/// 17, 3:15 pm` — so it is worth pinning without a screen to look at.
@Suite("The event picker's rows")
struct EventPickerRowTests {
  private func event(
    home: String,
    away: String,
    at when: String
  ) -> GameStationEvent {
    GameStationEvent(
      gameId: "gam_1",
      startAt: ISO8601DateFormatter().date(from: when)!,
      venue: nil,
      homeTeamName: home,
      awayTeamName: away,
      homeLogoURL: nil,
      awayLogoURL: nil,
      liveState: "none"
    )
  }

  @Test("The away side is named first, however the marks are laid out")
  func titleReadsAsASchedule() {
    let game = event(home: "Ravens", away: "Titan", at: "2026-09-17T22:15:00Z")
    // The marks go home on the left and away on the right, as a scoreboard has
    // them; the words go away first, as a schedule is written. Both on purpose.
    #expect(game.title == "Titan at Ravens")
  }

  @Test("The day and the time read as somebody would say them")
  func whenReadsPlainly() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    let at = calendar.date(
      from: DateComponents(year: 2026, month: 9, day: 17, hour: 15, minute: 15)
    )!
    let text = GameStationEventPicker.when(at)
    #expect(text.contains("Thursday"))
    #expect(text.contains("September"))
    #expect(text.contains("17"))
    // Lower-cased `pm` is the formatter's business, not ours; what matters is
    // that the hour is there in a form somebody reads rather than 15:15.
    #expect(text.lowercased().contains("3:15"))
  }

  @Test("A team with no mark gets its initials")
  func initialsStandInForAMissingMark() {
    #expect(GameStationEventPicker.initials("Titan Force 11U") == "TF")
    #expect(GameStationEventPicker.initials("Ravens") == "R")
    #expect(GameStationEventPicker.initials("") == "")
  }

  @Test("A game being played now is known from its state")
  func liveIsReadFromTheState() {
    let quiet = event(home: "A", away: "B", at: "2026-09-17T22:15:00Z")
    #expect(quiet.isLive == false)
    let live = GameStationEvent(
      gameId: "gam_2",
      startAt: Date(),
      venue: nil,
      homeTeamName: "A",
      awayTeamName: "B",
      homeLogoURL: nil,
      awayLogoURL: nil,
      liveState: "publishing"
    )
    #expect(live.isLive)
  }
}
