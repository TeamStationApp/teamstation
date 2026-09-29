import DirectorCore
import GameStationKit
import SwiftUI

/// Choosing the game this Director is filming.
///
/// The list is of games the signed-in account **runs**, soonest first, reaching
/// two hours backwards — a game called for one o'clock that somebody starts
/// filming at ten past three is still the game they mean, and having to scroll
/// up to find it would be absurd.
///
/// Each row is read as `Titan at Ravens`, with the **home** team's mark on
/// the left and the away team's on the right. That is the opposite order from
/// the words, deliberately: the marks are laid out as the scoreboard has them,
/// and the sentence is spoken as a schedule is written. Paul chose both.
public struct GameStationEventPicker: View {
  @Environment(AppEnvironment.self) private var environment
  /// Where the stream is set to go. The game is claimed on picking only when
  /// the stream goes to it.
  let destination: StreamDestination
  let onChosen: () -> Void
  let onCancel: () -> Void

  init(
    destination: StreamDestination,
    onChosen: @escaping () -> Void,
    onCancel: @escaping () -> Void
  ) {
    self.destination = destination
    self.onChosen = onChosen
    self.onCancel = onCancel
  }

  public var body: some View {
    let account = environment.gameStation
    VStack(spacing: 0) {
      header
      if !account.isSignedIn {
        message("Sign in to GameStation to choose an event.")
      } else if account.isLoading, account.events.isEmpty {
        ProgressView()
          .tint(.white)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if account.events.isEmpty {
        message(
          account.lastError
            ?? "No events in the next few days. Games come from the schedule on GameStation."
        )
      } else {
        List {
          ForEach(account.events) { event in
            row(for: event)
          }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
      }
    }
    .background(Color.black)
    .task { await account.refreshEvents() }
  }

  private var header: some View {
    HStack {
      Text("Choose an event")
        .font(.title3.weight(.semibold))
      Spacer()
      Button("Refresh") {
        Task { await environment.gameStation.refreshEvents() }
      }
      .accessibilityIdentifier("event-picker-refresh")
      // The way out. This screen is a full-screen cover with no swipe to
      // dismiss, so without a button on it somebody who opened the list to see
      // what was on had to choose a game to get back — which is the one thing
      // opening a list should never make you do.
      Button("Cancel", role: .cancel) { onCancel() }
        .tint(.red)
        .accessibilityIdentifier("event-picker-cancel")
    }
    .padding()
  }

  private func message(_ text: String) -> some View {
    Text(text)
      .font(.body)
      .foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      .padding(32)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func row(for event: GameStationEvent) -> some View {
    Button {
      Task {
        let taken = await environment.pickEvent(event, destination: destination)
        if taken { onChosen() }
      }
    } label: {
      HStack(spacing: 12) {
        mark(url: event.homeLogoURL, name: event.homeTeamName)
        VStack(alignment: .leading, spacing: 2) {
          Text(event.title)
            .font(.body.weight(.semibold))
            .foregroundStyle(.primary)
          Text(Self.when(event.startAt))
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 8)
        if event.isLive {
          Text("LIVE")
            .font(.caption.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.red))
        }
        mark(url: event.awayLogoURL, name: event.awayTeamName)
      }
      .padding(.vertical, 4)
    }
    .accessibilityIdentifier("event-picker-row-\(event.gameId)")
    .listRowBackground(Color.black)
  }

  /// A team's mark, or its initials when it has none — which is most of them.
  private func mark(url: URL?, name: String) -> some View {
    ZStack {
      Circle().fill(Color.white.opacity(0.12))
      if let url {
        AsyncImage(url: url) { image in
          image.resizable().scaledToFit()
        } placeholder: {
          Text(Self.initials(name)).font(.caption.weight(.bold))
        }
        .clipShape(Circle())
      } else {
        Text(Self.initials(name)).font(.caption.weight(.bold))
      }
    }
    .frame(width: 36, height: 36)
  }

  /// `nonisolated`, and it has to be: a `View` is main-actor-isolated, so a
  /// static helper on one inherits that, and the closure inside this would trap
  /// the moment anything called it off the main queue. It is a function of a
  /// string and nothing else — it has no business belonging to an actor.
  public nonisolated static func initials(_ name: String) -> String {
    let words = name.split(separator: " ").prefix(2)
    return words.compactMap { $0.first }.map(String.init).joined().uppercased()
  }

  /// `Thursday, September 17, 3:15 pm`, in the iPad's own clock.
  ///
  /// `nonisolated` for the same reason as `initials`.
  public nonisolated static func when(_ date: Date) -> String {
    date.formatted(
      .dateTime
        .weekday(.wide)
        .month(.wide)
        .day()
        .hour(.defaultDigits(amPM: .abbreviated))
        .minute()
    )
  }
}
