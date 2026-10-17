import DirectorCore
import DirectorMedia
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

  /// The stream held was ended on TeamStation: a redial is refused with a 410, and a start gets a
  /// fresh stream.
  var ended = false
  var renamed: [String] = []
  /// Fresh streams handed out by a start after an end.
  var made = 0

  func refreshChosen(cameraName: String, reason: LiveStreamRequestReason) async throws {
    asked.append("refresh \(reason.rawValue)")
    refreshedNames.append(cameraName)
    if dropOnRefresh { chosen = nil }
    guard ended, let current = chosen else { return }
    guard reason == .start else { throw TeamStationError.streamEnded }
    ended = false
    made += 1
    chosen = TeamStationAccount.ChosenEvent(
      gameId: current.gameId,
      title: current.title,
      startAt: current.startAt,
      streamURL: "rtmp://ingest/live/\(current.gameId)-\(made)",
      streamId: "lst_\(made)"
    )
  }

  func renameStream(label: String) async -> Bool {
    asked.append("rename")
    renamed.append(label)
    return true
  }

  var liveStarts: [Date] = []

  func reportLiveStart(startedAt: Date) async -> Bool {
    liveStarts.append(startedAt)
    return true
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
    homeTeamName: "Ravens",
    awayTeamName: "Titan \(gameId)",
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
  /// The chosen event each time nearby devices were told the selection changed.
  var told: [String?] = []
  lazy var coordinator = EventCoordinator(
    events: events,
    linker: linker,
    currentTake: { [unowned self] in self.take },
    cameraName: { [unowned self] in self.cameraName },
    selectionChanged: { [unowned self] in self.told.append(self.events.chosen?.gameId) }
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
      .init(take: 7, gameId: "g1", title: "2026-09-21 Titan g1 at Ravens", replacing: nil),
      .init(take: 7, gameId: "g2", title: "2026-09-21 Titan g2 at Ravens", replacing: "g1")
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
      take: 8, gameId: "g1", title: "2026-09-21 Titan g1 at Ravens", replacing: nil
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
      .init(take: 7, gameId: "g2", title: "2026-09-21 Titan g2 at Ravens", replacing: nil)
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
    #expect(rig.events.asked == [ "choose+claim g1", "refresh start" ])
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
    #expect(rig.events.asked == [ "choose+claim g1", "refresh start" ])
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

  @Test func onlyPicksThatSucceedAndClearReachNearbyDevices() async {
    let rig = Rig()
    #expect(await rig.coordinator.pick(event: event("g1"), destination: .url))
    #expect(rig.told == [ "g1" ])
    rig.events.refuse = "Not yours"
    #expect(await rig.coordinator.pick(event: event("g2"), destination: .event) == false)
    #expect(rig.told == [ "g1" ])
    rig.events.refuse = nil
    #expect(await rig.coordinator.pick(event: event("g2"), destination: .event))
    #expect(rig.told == [ "g1", "g2" ])
    rig.coordinator.clear()
    #expect(rig.told == [ "g1", "g2", nil ])
  }

  @Test func aCoordinatorMadeWithoutAListenerStillPicks() async {
    let events = StubEvents()
    let coordinator = EventCoordinator(
      events: events,
      linker: RecordingLinker(),
      currentTake: { nil },
      cameraName: { "" }
    )
    #expect(await coordinator.pick(event: event("g1"), destination: .url))
    coordinator.clear()
    #expect(events.chosen == nil)
  }
}


/// An End pressed on TeamStation, as Director's stream sees it: the coordinator asks with the
/// controller's reason, and the controller stops on the 410 until the operator starts again.
@Suite("A stream ended on TeamStation", .serialized)
@MainActor
struct StreamEndedTests {
  private func wire(_ rig: Rig, publisher: FakePublisher, scheduler: ManualScheduler) -> StreamSessionController {
    StreamSessionController(
      publisher: publisher,
      host: .init(
        requestURL: { reason in
          try await rig.coordinator.streamURL(for: reason, destination: .event, typed: "")
        },
        settings: { StreamSettings(config: .default) }
      ),
      scheduler: scheduler
    )
  }

  /// Waits, up to five seconds, for the controller's dial to get where the test needs it.
  /// The dial runs in a task of its own, so how many turns it takes depends on the load.
  private func until(_ condition: @MainActor () -> Bool) async {
    let deadline = Date().addingTimeInterval(5)
    while !condition(), Date() < deadline {
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  @Test("A redial carries the controller's reason, and an ended stream is StreamEndedError")
  func redialReason() async throws {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .event)
    _ = try await rig.coordinator.streamURL(for: .redial, destination: .event, typed: "")
    #expect(rig.events.asked.last == "refresh redial")
    rig.events.ended = true
    await #expect(throws: StreamEndedError.self) {
      _ = try await rig.coordinator.streamURL(for: .redial, destination: .event, typed: "")
    }
    #expect(try await rig.coordinator.streamURL(for: .start, destination: .url, typed: "rtmp://x/live/k") == "rtmp://x/live/k")
  }

  @Test("End then Start: the redial stays off the air, and Start goes live on a fresh stream")
  func endThenStart() async {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .event)
    let publisher = FakePublisher()
    let scheduler = ManualScheduler()
    let controller = wire(rig, publisher: publisher, scheduler: scheduler)
    controller.start()
    await until { controller.phase == .live }
    #expect(controller.phase == .live)

    rig.events.ended = true
    publisher.drop()
    await until { controller.phase == .retrying }
    #expect(controller.phase == .retrying)
    scheduler.fire()
    await until { controller.phase == .idle }
    #expect(controller.phase == .idle)
    #expect(controller.lastError == "ended")
    #expect(rig.events.made == 0)
    #expect(publisher.dialled == [ "rtmp://ingest/live/g1" ])

    controller.start()
    await until { controller.phase == .live }
    #expect(controller.phase == .live)
    #expect(rig.events.asked.suffix(2) == [ "refresh redial", "refresh start" ])
    #expect(rig.events.made == 1)
    #expect(publisher.dialled.last == "rtmp://ingest/live/g1-1")
  }

  @Test("A relaunch that resumes streaming redials, and an ended stream creates nothing")
  func relaunchAfterEnd() async {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .event)
    rig.events.ended = true
    let publisher = FakePublisher()
    let controller = wire(rig, publisher: publisher, scheduler: ManualScheduler())
    // `applyResumedStream`: the stream was live when the app stopped.
    controller.start(reason: .redial)
    await until { controller.phase == .idle }
    #expect(controller.phase == .idle)
    #expect(rig.events.asked.last == "refresh redial")
    #expect(rig.events.made == 0)
    #expect(publisher.dialled.isEmpty)
  }

  @Test("A camera rename in Settings renames the held stream")
  func renameSendsAPatch() async {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .event)
    await rig.coordinator.cameraRenamed(to: "Left Field")
    #expect(rig.events.renamed == [ "Left Field" ])
  }

  @Test("The first picture's capture places the event's live video, and nothing else's")
  func liveStartGoesToTheEventOnly() async {
    let rig = Rig()
    await rig.coordinator.pick(event: event("g1"), destination: .event)
    let started = Date(timeIntervalSince1970: 1_790_013_600.25)
    await rig.coordinator.liveStarted(at: started, destination: .url)
    #expect(rig.events.liveStarts.isEmpty)
    await rig.coordinator.liveStarted(at: started, destination: .event)
    #expect(rig.events.liveStarts == [ started ])
  }
}
