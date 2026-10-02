import DirectorCore
import Foundation
import TeamStationKit
import Testing

@testable import DirectorUI

/// An account that answers at once and writes down what it was asked.
@MainActor
private final class StubEvents: TeamStationEventService {
  var chosen: TeamStationAccount.ChosenEvent?
  var lastError: String?
  var refuse: String?
  var dropOnRefresh = false
  var asked: [String] = []
  /// Names passed into a call that claims. A pick that does not claim is absent.
  var claimedNames: [String] = []
  var refreshedNames: [String] = []

  func choose(event: TeamStationEvent, claim: Bool, cameraName: String) async -> Bool {
    asked.append(claim ? "choose+claim \(event.gameId)" : "choose \(event.gameId)")
    if claim { claimedNames.append(cameraName) }
    if claim, let refuse {
      lastError = refuse
      return false
    }
    chosen = TeamStationAccount.ChosenEvent(
      gameId: event.gameId,
      title: event.title,
      startAt: event.startAt,
      streamURL: claim ? "rtmp://ingest/live/\(event.gameId)" : nil
    )
    return true
  }

  func claimChosen(cameraName: String) async -> Bool {
    asked.append("claim")
    claimedNames.append(cameraName)
    guard let current = chosen else { return false }
    if let refuse {
      lastError = refuse
      return false
    }
    chosen = TeamStationAccount.ChosenEvent(
      gameId: current.gameId,
      title: current.title,
      startAt: current.startAt,
      streamURL: "rtmp://ingest/live/\(current.gameId)"
    )
    return true
  }

  func refreshChosen(cameraName: String) async {
    asked.append("refresh")
    refreshedNames.append(cameraName)
    if dropOnRefresh { chosen = nil }
  }

  func forgetChosenEvent() {
    asked.append("forget")
    chosen = nil
  }

  func scoreboardURL(for gameId: String) -> URL {
    URL(string: "https://teamstation.example/scoreboard/\(gameId)?quiet=1")!
  }
}

/// A take index that writes down every link it is asked for.
private final class RecordingLinker: GameLinker {
  struct Link: Equatable {
    var take: Int64
    var gameId: String
    var title: String
    var replacing: String?
  }

  var links: [Link] = []
  var fails = false

  func setGame(_ take: Int64, gameId: String, title: String, replacing: String?) throws {
    if fails { throw CocoaError(.fileWriteUnknown) }
    links.append(Link(take: take, gameId: gameId, title: title, replacing: replacing))
  }
}

private func event(_ gameId: String) -> TeamStationEvent {
  TeamStationEvent(
    gameId: gameId,
    // 2026-09-21T18:00:00Z
    startAt: Date(timeIntervalSince1970: 1_790_013_600),
    venue: nil,
    homeTeamName: "Rangers",
    awayTeamName: "Trosky \(gameId)",
    homeLogoURL: nil,
    awayLogoURL: nil,
    liveState: "none"
  )
}

@MainActor
private final class Rig {
  let events = StubEvents()
  let linker = RecordingLinker()
  var take: Int64?
  var cameraName = ""
  lazy var coordinator = EventCoordinator(
    events: events,
    linker: linker,
    currentTake: { [unowned self] in self.take },
    cameraName: { [unowned self] in self.cameraName }
  )
}

@Suite("The chosen event covers the whole take")
@MainActor
struct EventCoordinatorTests {
  @Test func picksWithoutClaimingForATypedURLAndClaimsForTheEvent() async {
    let rig = Rig()
    #expect(await rig.coordinator.pick(event: event("g1"), destination: .url))
    #expect(rig.events.asked == [ "choose g1" ])
    #expect(rig.events.chosen?.streamURL == nil)

    #expect(await rig.coordinator.pick(event: event("g2"), destination: .event))
    #expect(rig.events.asked.last == "choose+claim g2")
    #expect(rig.events.chosen?.streamURL == "rtmp://ingest/live/g2")
  }

  @Test func aRefusedPickLinksNothing() async {
    let rig = Rig()
    rig.take = 7
    rig.events.refuse = "Not yours"
    #expect(await rig.coordinator.pick(event: event("g1"), destination: .event) == false)
    #expect(rig.linker.links.isEmpty)
  }

  @Test func aPickDuringATakeLinksItAndTheLatestPickWins() async {
    let rig = Rig()
    rig.take = 7
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    await rig.coordinator.pick(event: event("g2"), destination: .url)
    #expect(rig.linker.links == [
      .init(take: 7, gameId: "g1", title: "2026-09-21 Trosky g1 at Rangers", replacing: nil),
      .init(take: 7, gameId: "g2", title: "2026-09-21 Trosky g2 at Rangers", replacing: "g1")
    ])
  }

  @Test func aPickReplacesTheLinkTheTakeStartedWith() async {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    rig.take = 8
    rig.coordinator.recordingStarted(take: 8)
    await rig.coordinator.pick(event: event("g2"), destination: .url)
    #expect(rig.linker.links.map(\.replacing) == [ nil, "g1" ])
    #expect(rig.linker.links.map(\.gameId) == [ "g1", "g2" ])
  }

  @Test func aPickReplacesNothingOnTheNextTake() async {
    let rig = Rig()
    rig.take = 7
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    rig.take = 8
    rig.coordinator.recordingStarted(take: 8)
    #expect(rig.linker.links.last == .init(
      take: 8, gameId: "g1", title: "2026-09-21 Trosky g1 at Rangers", replacing: nil
    ))
  }

  @Test func aPickWithNoTakeRecordingLinksNothing() async {
    let rig = Rig()
    rig.take = 7
    rig.coordinator.recordingStarted(take: 7)
    #expect(rig.linker.links.isEmpty)
    // The take stopped; the next pick is not about it.
    rig.take = nil
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    #expect(rig.linker.links.isEmpty)
  }

  @Test func recordingStartedLinksRecordOnlyAndStreamedTakes() async {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    rig.coordinator.recordingStarted(take: 1)
    await rig.coordinator.pick(event: event("g1"), destination: .event)
    rig.coordinator.recordingStarted(take: 2)
    #expect(rig.linker.links.map(\.take) == [ 1, 2 ])
    #expect(rig.linker.links.allSatisfy { $0.gameId == "g1" && $0.replacing == nil })
  }

  @Test func aFailedLinkIsNotRememberedAsOne() async {
    let rig = Rig()
    rig.take = 7
    rig.linker.fails = true
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    rig.linker.fails = false
    await rig.coordinator.pick(event: event("g2"), destination: .url)
    #expect(rig.linker.links == [
      .init(take: 7, gameId: "g2", title: "2026-09-21 Trosky g2 at Rangers", replacing: nil)
    ])
  }

  @Test func choosingTheEventDestinationClaimsAnUnclaimedEvent() async {
    let rig = Rig()
    await rig.coordinator.destinationChanged(to: .event)
    #expect(rig.events.asked.isEmpty)

    await rig.coordinator.pick(event: event("g1"), destination: .url)
    await rig.coordinator.destinationChanged(to: .url)
    #expect(rig.events.asked == [ "choose g1" ])

    await rig.coordinator.destinationChanged(to: .event)
    #expect(rig.events.asked.last == "claim")
    #expect(rig.events.chosen?.streamURL == "rtmp://ingest/live/g1")

    await rig.coordinator.destinationChanged(to: .event)
    #expect(rig.events.asked.filter { $0 == "claim" }.count == 1)
  }

  @Test func dialsTheEventByClaimingItFirst() async throws {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    let url = try await rig.coordinator.streamURLForDial(destination: .event)
    #expect(url == "rtmp://ingest/live/g1")
    #expect(rig.events.asked.last == "claim")
  }

  @Test func aRefusedClaimThrowsTheServersReason() async {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    rig.events.refuse = "This event is already being streamed"
    await #expect(throws: EventStreamError.refused("This event is already being streamed")) {
      _ = try await rig.coordinator.streamURLForDial(destination: .event)
    }
    #expect(
      EventStreamError.refused("x").localizedDescription == "x"
    )
  }

  @Test func dialsAClaimedEventAfterRefreshingIt() async throws {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .event)
    let url = try await rig.coordinator.streamURLForDial(destination: .event)
    #expect(url == "rtmp://ingest/live/g1")
    #expect(rig.events.asked == [ "choose+claim g1", "refresh" ])
  }

  @Test func dialsNoEventWithoutOne() async {
    let rig = Rig()
    await #expect(throws: EventStreamError.refused("Pick a TeamStation event in Settings first")) {
      _ = try await rig.coordinator.streamURLForDial(destination: .event)
    }
    #expect(rig.events.asked.isEmpty)
  }

  @Test func dialsNoEventThatWentAwayOnRefresh() async {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .event)
    rig.events.dropOnRefresh = true
    await #expect(throws: EventStreamError.refused("Pick a TeamStation event in Settings first")) {
      _ = try await rig.coordinator.streamURLForDial(destination: .event)
    }
    #expect(rig.events.asked == [ "choose+claim g1", "refresh" ])
  }

  @Test func aPickThatClaimsPassesTheCameraNameAndOneThatDoesNotDoesNot() async {
    let rig = Rig()
    rig.cameraName = "Center Field"
    #expect(await rig.coordinator.pick(event: event("g1"), destination: .event))
    #expect(rig.events.claimedNames == [ "Center Field" ])

    rig.cameraName = "Left Field"
    #expect(await rig.coordinator.pick(event: event("g2"), destination: .url))
    #expect(rig.events.claimedNames == [ "Center Field" ])
    #expect(rig.events.asked == [ "choose+claim g1", "choose g2" ])
  }

  @Test func dialPassesTheCameraNameOnTheFirstClaimAndOnARefresh() async throws {
    let rig = Rig()
    rig.cameraName = "Center Field"
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    let claimed = try await rig.coordinator.streamURLForDial(destination: .event)
    #expect(claimed == "rtmp://ingest/live/g1")
    #expect(rig.events.claimedNames == [ "Center Field" ])

    rig.cameraName = "Left Field"
    let refreshed = try await rig.coordinator.streamURLForDial(destination: .event)
    #expect(refreshed == "rtmp://ingest/live/g1")
    #expect(rig.events.refreshedNames == [ "Left Field" ])
  }

  @Test func aTypedURLAsksTeamStationNothing() async throws {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    #expect(try await rig.coordinator.streamURLForDial(destination: .url) == nil)
    #expect(rig.events.asked == [ "choose g1" ])
  }

  @Test func clearingForgetsTheEvent() async {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .url)
    rig.coordinator.clear()
    #expect(rig.events.chosen == nil)
    rig.coordinator.recordingStarted(take: 3)
    #expect(rig.linker.links.isEmpty)
  }
}
