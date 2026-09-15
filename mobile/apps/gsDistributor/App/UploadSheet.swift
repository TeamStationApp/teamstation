import DirectorCore
import Distribution
import DistributorWire
import SwiftUI

/// Before an export that uploads: the title every file's video gets, which files go up, and the
/// channel and privacy they go up with. The title field starts with the recording's date and a
/// space, with the cursor after them; it is an ordinary field, so the date can be changed or
/// deleted. Each file's title adds what it is. The ticked files, the channel and the privacy are
/// remembered on the iPad and start the sheet next time.
struct UploadSheet: View {
  let recording: RecordingListing
  let tracks: [Track]
  let makesCombined: Bool
  let model: DistributorModel
  /// With the uploads to make, or nil to export without uploading.
  let onContinue: (UploadPlan?) -> Void
  let onCancel: () -> Void

  @State private var title = ""
  @State private var selection: TextSelection?
  @State private var choice = UploadChoice()
  @State private var channelID: Int?
  @State private var privacy = PeerTubePrivacy.channel
  @FocusState private var titleFocused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Upload to PeerTube")
        .font(.title2.bold())

      TextField("Title", text: $title, selection: $selection, prompt: Text("date and what was played"))
        .focused($titleFocused)
        .accessibilityIdentifier("upload-title")
      let remaining = PeerTubeTitle.remaining(title: title, tracks: ticked.isEmpty ? [ .primary ] : ticked)
      Text(remaining >= 0 ? "\(remaining) characters left" : "\(-remaining) characters too long")
        .font(.caption)
        .foregroundStyle(remaining >= 0 ? Color.secondary : Color.red)

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

      destination

      HStack {
        Button("Cancel", role: .cancel) { onCancel() }
          .keyboardShortcut(.cancelAction)
        Spacer()
        Button("Export Without Uploading") { onContinue(nil) }
          .accessibilityIdentifier("upload-skip")
        Button("Export and Upload") { continueWithUpload() }
          .keyboardShortcut(.defaultAction)
          .disabled(ticked.isEmpty || channelID == nil || !PeerTubeTitle.isValid(title: title, tracks: ticked))
          .accessibilityIdentifier("upload-continue")
      }
    }
    .padding(24)
    .frame(width: 560)
    .onAppear {
      choice = model.settings.peerTube.uploadChoice
        .applied(hasPrimary: hasPrimary, cameras: cameraNames, makesCombined: makesCombined)
      channelID = model.uploadChannelID
      privacy = model.uploadPrivacy
      title = PeerTubeTitle.initialTitle(for: recording.startedAt.date)
      titleFocused = true
      // Focusing a field selects all of it; the cursor goes after the date instead, so typing adds
      // to the title rather than replacing the date.
      Task { @MainActor in selection = TextSelection(insertionPoint: title.endIndex) }
    }
  }

  // MARK: - Where the videos go

  /// The channel and privacy for this upload, starting on the last ones used.
  @ViewBuilder private var destination: some View {
    if case .signedIn(let account) = model.peerTube {
      VStack(alignment: .leading, spacing: 8) {
        if account.channels.isEmpty {
          Text("This account has no channel to upload to.")
            .foregroundStyle(.red)
        } else {
          Picker("Channel", selection: $channelID) {
            ForEach(account.channels, id: \.id) { Text($0.displayName).tag(Optional($0.id)) }
          }
          .accessibilityIdentifier("upload-channel")
        }
        if !account.privacies.isEmpty {
          Picker("Privacy", selection: $privacy) {
            ForEach(account.privacies.keys.sorted(), id: \.self) { id in
              Text(account.privacies[id] ?? "\(id)").tag(id)
            }
          }
          .accessibilityIdentifier("upload-privacy")
        }
        Text("As \(account.username) on \(account.host).")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: 380, alignment: .leading)
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

  private func label(_ track: UploadTrack, _ name: String) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(name)
      Text(PeerTubeTitle.make(title: title, track: track))
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
    let channelID = self.channelID
    let privacy = self.privacy
    Task {
      await model.updateSettings {
        var next = $0.peerTube.uploadChoice.remembering(remembered, from: available)
        if !hasPrimary { next.primary = $0.peerTube.uploadChoice.primary }
        if !makesCombined { next.combined = $0.peerTube.uploadChoice.combined }
        $0.peerTube.uploadChoice = next
        $0.peerTube.channelID = channelID
        $0.peerTube.privacy = privacy
      }
    }
    onContinue(model.uploadPlan(for: recording, title: title, channelID: channelID, privacy: privacy, tracks: ticked))
  }
}
