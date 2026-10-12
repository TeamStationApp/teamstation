import DirectorCore
import DirectorExport
import DirectorMedia
import Foundation
import TeamStationKit

/// Where a take's game is written down. `ArchiveIndex` is the real one.
public protocol GameLinker: AnyObject {
  /// Links a take to a game. Writes over the take's game only when it has
  /// none, or when it is `replacing`: a game set on the take any other way is
  /// never overwritten.
  func setGame(_ take: Int64, gameId: String, title: String, replacing: String?) throws
}

extension ArchiveIndex: GameLinker {}

/// Why the stream could not be given an address.
public enum EventStreamError: LocalizedError, Equatable {
  case refused(String)

  public var errorDescription: String? {
    switch self {
    case let .refused(reason): reason
    }
  }
}

/**
 * The rules for the TeamStation event chosen in Settings.
 *
 * The chosen event is the game this Director is covering. Every take that is
 * recording while it is chosen is filed under it — one started afterwards, and
 * one already running when it was picked — and when it is changed during a
 * take the latest choice wins. The game is claimed, which asks TeamStation for
 * somewhere to stream it, only when the stream is going to that event.
 *
 * `AppEnvironment` holds one and makes one-line calls into it, so these rules
 * are tested against a stub account and a recording linker.
 */
@MainActor
public final class EventCoordinator {
  private let events: any TeamStationEventService
  private let linker: any GameLinker
  private let currentTake: () -> Int64?
  /// The name the next claim sends. Read at the moment of the claim, so a name
  /// typed in Settings and then used to pick an event is the one that goes.
  private let cameraName: () -> String
  /// The one link this coordinator made for a take, which a later pick during
  /// that same take may move.
  private var linked: (take: Int64, gameId: String)?
  /// Told after a pick succeeds and after Clear, never after a pick that
  /// failed: what nearby devices are set to follows only a choice that stuck.
  private let selectionChanged: () -> Void

  public init(
    events: any TeamStationEventService,
    linker: any GameLinker,
    currentTake: @escaping () -> Int64?,
    cameraName: @escaping () -> String,
    selectionChanged: @escaping () -> Void = {}
  ) {
    self.events = events
    self.linker = linker
    self.currentTake = currentTake
    self.cameraName = cameraName
    self.selectionChanged = selectionChanged
  }

  /// Chooses an event, claiming it only when the stream goes to it, and files
  /// the take now recording, if there is one, under it.
  @discardableResult
  public func pick(event: TeamStationEvent, destination: StreamDestination) async -> Bool {
    guard await events.choose(
      event: event,
      claim: destination == .event,
      cameraName: cameraName()
    ) else {
      return false
    }
    if let take = currentTake() { link(take) }
    selectionChanged()
    return true
  }

  /// Forgets the event. Takes already filed under it stay filed.
  public func clear() {
    events.forgetChosenEvent()
    selectionChanged()
  }

  /// The stream's destination was changed in Settings. Choosing the event
  /// claims it now, so a refusal is read while somebody is looking.
  public func destinationChanged(to destination: StreamDestination) async {
    guard destination == .event,
      let chosen = events.chosen,
      chosen.streamURL == nil
    else { return }
    await events.claimChosen(cameraName: cameraName())
  }

  /**
   * The address to publish to, asked for as the stream is dialled.
   *
   * For the event: claimed now if it never was, with the server's reason
   * thrown when it refuses; asked for again quietly otherwise, because a key
   * can have been rotated since and the cached one is usually still right.
   * For a typed URL: nil, and TeamStation is asked nothing.
   *
   * `reason` is the stream controller's: a `.redial` names the stream held,
   * and a stream ended on TeamStation is thrown as
   * `TeamStationError.streamEnded` rather than put back.
   */
  public func streamURLForDial(
    destination: StreamDestination,
    reason: LiveStreamRequestReason = .start
  ) async throws -> String? {
    guard destination == .event else { return nil }
    guard events.chosen != nil else {
      throw EventStreamError.refused("Pick a TeamStation event in Settings first")
    }
    if events.chosen?.streamURL == nil {
      guard await events.claimChosen(cameraName: cameraName()) else {
        throw EventStreamError.refused(
          events.lastError ?? "TeamStation would not give this event a stream"
        )
      }
    } else {
      try await events.refreshChosen(cameraName: cameraName(), reason: reason)
    }
    guard let url = events.chosen?.streamURL else {
      throw EventStreamError.refused("Pick a TeamStation event in Settings first")
    }
    return url
  }

  /// The address for one dial of the stream controller: the event's, or the
  /// typed URL. A stream ended on TeamStation is thrown as `StreamEndedError`,
  /// which stops the controller redialling until the operator starts again.
  public func streamURL(
    for reason: StreamSessionController.DialReason,
    destination: StreamDestination,
    typed: String
  ) async throws -> String {
    do {
      return try await streamURLForDial(
        destination: destination,
        reason: reason == .redial ? .redial : .start
      ) ?? typed
    } catch TeamStationError.streamEnded {
      throw StreamEndedError(message: TeamStationError.streamEnded.localizedDescription)
    }
  }

  /// The camera was renamed in Settings. The stream already held keeps its
  /// key and its video under the new name; with none held yet, the next
  /// request carries the name.
  public func cameraRenamed(to name: String) async {
    await events.renameStream(label: name)
  }

  /// The stream's first picture went out, captured at `startedAt` on
  /// TeamStation's clock: TeamStation places the event's live video there, in step with the game's other
  /// cameras, rather than where the publish reached it. Only the event's own
  /// stream is TeamStation's to place.
  public func liveStarted(at startedAt: Date, destination: StreamDestination) async {
    guard destination == .event else { return }
    await events.reportLiveStart(startedAt: startedAt)
  }

  /// A take has started. With an event chosen it is filed under it — which
  /// includes a take started by streaming, so this is the one place a take is
  /// linked.
  public func recordingStarted(take: Int64) {
    link(take)
  }

  private func link(_ take: Int64) {
    guard let chosen = events.chosen else { return }
    let replacing = linked?.take == take ? linked?.gameId : nil
    do {
      try linker.setGame(
        take,
        gameId: chosen.gameId,
        title: Self.takeTitle(chosen),
        replacing: replacing
      )
      linked = (take, chosen.gameId)
    } catch {
      // The index is on the iPad's own disk; a write that fails there has
      // bigger problems than a take without its game, and the upload picker
      // can still file it afterwards.
    }
  }

  /// `2026-09-20 Titan at Ravens`: the game's day, then the game.
  static func takeTitle(_ chosen: TeamStationAccount.ChosenEvent) -> String {
    let day = ISO8601DateFormatter()
    day.formatOptions = [.withFullDate]
    return "\(day.string(from: chosen.startAt)) \(chosen.title)"
  }
}
