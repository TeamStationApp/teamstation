import DirectorCore
import Distribution
import DistributorWire
import GameStationKit
import SwiftUI

/// Before an export that uploads: which game it belongs to and which files go
/// up. Each file's video is titled from the game and what the file is — the
/// primary output takes the game's title unchanged, a camera adds its name —
/// because that suffix is how the library tells one angle of a take from
/// another. The ticked files are remembered on the iPad and start the sheet
/// next time.
struct UploadSheet: View {
  let recording: RecordingListing
  let tracks: [Track]
  let makesCombined: Bool
  let model: DistributorModel
  /// With where the export is going, or nil to export without uploading.
  let onContinue: (GameStationPlan?) -> Void
  let onCancel: () -> Void

  @State private var title = ""
  @State private var selection: TextSelection?
  @State private var choice = UploadChoice()
  @State private var gameId: String?
  /// The last title this sheet filled in by itself. What tells a title nobody
  /// has touched from one somebody typed: the first is replaced when the game
  /// changes, the second is theirs to keep.
  @State private var filledIn = ""
  @State private var loadingEvents = false
  @FocusState private var titleFocused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Upload to GameStation")
        .font(.title2.bold())

      TextField("Title", text: $title, selection: $selection, prompt: Text("date and what was played"))
        .focused($titleFocused)
        .accessibilityIdentifier("upload-title")
      VStack(alignment: .leading, spacing: 8) {
        if hasPrimary {
          Toggle(isOn: $choice.primary) { label(.primary, "Primary output") }
            .accessibilityIdentifier("upload-primary")
        }
        ForEach(cameraNames, id: \.self) { name in
          Toggle(isOn: cameraBinding(name)) { label(.camera(name), name) }
            .accessibilityIdentifier("upload-camera-\(name)")
        }
        if makesCombined {
          Toggle(isOn: $choice.combined) { label(.combined, "Combined video") }
            .accessibilityIdentifier("upload-combined")
        }
      }

      games
        .onChange(of: gameId) { _, _ in nameAfterTheGame() }

      HStack {
        Button("Cancel", role: .cancel) { onCancel() }
          .keyboardShortcut(.cancelAction)
        Spacer()
        Button("Export Without Uploading") { onContinue(nil) }
          .accessibilityIdentifier("upload-skip")
        Button("Export and Upload") { continueWithUpload() }
          .keyboardShortcut(.defaultAction)
          .disabled(cannotContinue)
          .accessibilityIdentifier("upload-continue")
      }
    }
    .padding(24)
    .frame(width: 560)
    .onAppear {
      choice = model.settings.upload.choice
        .applied(hasPrimary: hasPrimary, cameras: cameraNames, makesCombined: makesCombined)
      title = UploadTitle.initialTitle(for: recording.startedAt.date)
      filledIn = title
      titleFocused = true
      loadingEvents = true
      Task {
        await model.gameStation.refreshFinishedEvents()
        loadingEvents = false
      }
      // Focusing a field selects all of it; the cursor goes after the date instead, so typing adds
      // to the title rather than replacing the date.
      Task { @MainActor in selection = TextSelection(insertionPoint: title.endIndex) }
    }
  }

  // MARK: - What this export makes

  private var hasPrimary: Bool { tracks.contains(.primary) }

  private var cameraNames: [String] {
    tracks.compactMap { track in
      guard case .camera(let sourceID) = track else { return nil }
      return recording.cameras.first { $0.sourceID == sourceID }?.name ?? sourceID.rawValue
    }
  }

  /// The ticked files in upload order: primary, cameras, combined.
  private var ticked: [UploadTrack] {
    var result: [UploadTrack] = []
    if hasPrimary && choice.primary { result.append(.primary) }
    result += cameraNames.filter { choice.cameras.contains($0) }.map { .camera($0) }
    if makesCombined && choice.combined { result.append(.combined) }
    return result
  }

  /// Which game the recording belongs to: the ones already played, latest
  /// first. The opposite order from the list a Director claims a game from,
  /// and deliberately — that one is about the game starting now, this is
  /// about the game that has just finished.
  @ViewBuilder private var games: some View {
    if model.gameStation.user == nil {
      Text("Sign in to GameStation in Settings to choose a game.")
        .font(.caption)
        .foregroundStyle(.orange)
    } else if loadingEvents && model.gameStation.finishedEvents.isEmpty {
      ProgressView().controlSize(.small)
    } else if model.gameStation.finishedEvents.isEmpty {
      Text(model.gameStation.lastError ?? "No games this account runs have been played yet.")
        .font(.caption)
        .foregroundStyle(.orange)
    } else {
      Picker("Game", selection: $gameId) {
        Text("Choose a game").tag(String?.none)
        ForEach(model.gameStation.finishedEvents) { event in
          Text("\(event.title) — \(Self.when(event.startAt))").tag(String?.some(event.gameId))
        }
      }
      .accessibilityIdentifier("upload-game")
    }
  }

  private var cannotContinue: Bool { ticked.isEmpty || gameId == nil }

  /// Names the videos after the game as soon as one is chosen.
  ///
  /// The game's own dated title, because that is what its other videos are
  /// called and the library reads these titles to group a take's angles. Left
  /// alone once somebody has typed their own: the field is still theirs, and
  /// what it says is what is sent — it used to show the recording's date while
  /// the upload quietly used the game's.
  private func nameAfterTheGame() {
    guard let gameId,
      let event = model.gameStation.finishedEvents.first(where: { $0.gameId == gameId }),
      title.trimmingCharacters(in: .whitespaces) == filledIn.trimmingCharacters(in: .whitespaces)
    else { return }
    let day = DateFormatter()
    day.dateFormat = "yyyy-MM-dd"
    title = "\(day.string(from: event.startAt)) \(event.title)"
    filledIn = title
  }

  /// `Sat 20 Sep, 12:15` — two games of the same teams on one weekend are
  /// told apart by the clock.
  private static func when(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "EEE d MMM, HH:mm"
    return formatter.string(from: date)
  }

  private func label(_ track: UploadTrack, _ name: String) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(name)
      Text(UploadTitle.make(title: title, track: track))
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.middle)
    }
  }

  private func cameraBinding(_ name: String) -> Binding<Bool> {
    Binding(
      get: { choice.cameras.contains(name) },
      set: { isOn in
        choice.cameras.removeAll { $0 == name }
        if isOn { choice.cameras.append(name) }
      }
    )
  }

  private func continueWithUpload() {
    let remembered = UploadChoice(
      primary: choice.primary,
      cameras: cameraNames.filter { choice.cameras.contains($0) },
      combined: choice.combined
    )
    let available = cameraNames
    // Only what this export could offer is remembered as it was ticked; the rest stays as it was.
    let hasPrimary = self.hasPrimary
    let makesCombined = self.makesCombined
    Task {
      await model.updateSettings {
        var next = $0.upload.choice.remembering(remembered, from: available)
        if !hasPrimary { next.primary = $0.upload.choice.primary }
        if !makesCombined { next.combined = $0.upload.choice.combined }
        $0.upload.choice = next
      }
    }
    guard let gameId else { return }
    onContinue(
      model.gameStationPlan(
        gameId: gameId,
        title: title.trimmingCharacters(in: .whitespacesAndNewlines),
        tracks: ticked,
        startedAt: recording.startedAt.date
      )
    )
  }
}
