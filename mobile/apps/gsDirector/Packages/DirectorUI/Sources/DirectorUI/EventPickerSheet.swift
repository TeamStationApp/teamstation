import GameStationKit
import SwiftUI

/// Which game a recording belongs to.
///
/// **Most recently finished first**, which is the opposite of the list the
/// claim screen shows, and deliberately: claiming is about the game starting
/// now, uploading is about the game that has just finished. An operator who
/// has walked off the field and sat down with the iPad wants yesterday's game
/// at the top, not next Saturday's.
struct EventPickerSheet: View {
  @Environment(AppEnvironment.self) private var environment

  let title: String
  let onChoose: (GameStationEvent) -> Void
  let onCancel: () -> Void

  @State private var loading = true

  var body: some View {
    NavigationStack {
      Group {
        if loading && environment.gameStation.finishedEvents.isEmpty {
          ProgressView()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if environment.gameStation.finishedEvents.isEmpty {
          VStack(spacing: 10) {
            Text("No finished games")
              .font(.system(size: 17, weight: .bold, design: .rounded))
            // What actually happened, where there is an answer. An empty list
            // with no reason is the one thing this screen must never be: it
            // sends somebody to check their sign-in when the server said
            // something else entirely.
            Text(reason)
              .font(.system(size: 14, weight: .medium))
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
              .accessibilityIdentifier("upload-no-events-reason")
          }
          .padding(32)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityIdentifier("upload-no-events")
        } else {
          List(environment.gameStation.finishedEvents) { event in
            Button {
              onChoose(event)
            } label: {
              VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                  Text(when(event.startAt))
                  if let venue = event.venue, !venue.isEmpty {
                    Text("·")
                    Text(venue)
                  }
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                Text(event.title)
                  .font(.system(size: 16, weight: .semibold))
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("upload-event-\(event.gameId)")
          }
          .listStyle(.plain)
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
            .accessibilityIdentifier("upload-cancel")
        }
      }
    }
    .task {
      await environment.gameStation.refreshFinishedEvents()
      loading = false
    }
  }

  /// Why the list is empty, in the order the answers are worth having.
  private var reason: String {
    if let said = environment.gameStation.lastError { return said }
    if !environment.gameStation.isSignedIn {
      return "Sign in to GameStation to choose a game."
    }
    return "GameStation has no games this account runs that have already been played."
  }

  private func when(_ date: Date) -> String {
    EventWhenLabel.format(date)
  }
}
