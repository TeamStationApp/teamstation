import DirectorCore
import DirectorSources
import SwiftUI

/// Spec 6.1: discovered sources, enable toggles capped at five, inline rename.
public struct SourceSelectionView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var renamingID: SourceID?
  @State private var draftName = ""
  /// Without this the field appears but the keyboard goes to nobody, so the first thing the operator
  /// types is lost.
  @FocusState private var isNamingFocused: Bool

  public init() {}

  public var body: some View {
    ZStack {
      Color.deckBackground.ignoresSafeArea()

      VStack(alignment: .leading, spacing: 0) {
        header
        Divider().overlay(Color.white.opacity(0.08))
        list
        footer
      }

      if environment.config.showDebugHUD {
        VStack {
          Spacer()
          HStack {
            DebugHUD(snapshot: environment.snapshot)
            Spacer()
          }
        }
        .padding(14)
        .allowsHitTesting(false)
      }
    }
  }

  private var header: some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 6) {
        Text("GS DIRECTOR")
          .font(.system(size: 22, weight: .black, design: .rounded))
          .tracking(3)
          .foregroundStyle(.white)
        Text("Cameras")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(.white.opacity(0.7))
        Text("Choose up to five cameras for the director grid, and whose audio to mix.")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(.white.opacity(0.55))
        if let reason = environment.discoveryUnavailableReason {
          Text(reason)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.replayAmber)
            .accessibilityIdentifier("discovery-unavailable")
        }
      }
      Spacer()
    }
    .padding(24)
  }

  private var list: some View {
    ScrollView {
      LazyVStack(spacing: 8) {
        ForEach(Array(environment.selections.enumerated()), id: \.element.id) { index, selection in
          row(index: index, selection: selection)
        }
        if environment.selections.isEmpty {
          emptyState
        }
      }
      .padding(.horizontal, 24)
      .padding(.vertical, 12)
    }
  }

  private func row(index: Int, selection: SourceSelection) -> some View {
    HStack(spacing: 14) {
      if selection.isEnabled, let pipeline = environment.router.pipeline(for: selection.id) {
        CameraPreviewView(renderer: pipeline.renderer)
          .frame(width: 128, height: 72)
          .clipShape(RoundedRectangle(cornerRadius: 8))
          .accessibilityIdentifier("source-preview-\(index + 1)")
      } else {
        RoundedRectangle(cornerRadius: 8)
          .fill(Color.black.opacity(0.45))
          .frame(width: 128, height: 72)
          .overlay {
            Image(systemName: "video.slash")
              .font(.system(size: 18, weight: .light))
              .foregroundStyle(.white.opacity(0.25))
          }
      }

      Circle()
        .fill(selection.isPresent ? Color.programGreen : Color.white.opacity(0.18))
        .frame(width: 8, height: 8)

      VStack(alignment: .leading, spacing: 2) {
        if renamingID == selection.id {
          TextField("Name", text: $draftName)
            .textFieldStyle(.plain)
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .focused($isNamingFocused)
            .accessibilityIdentifier("source-name-field-\(index + 1)")
            .onSubmit { commitRename(for: selection) }
            .onAppear { isNamingFocused = true }
        } else if let endpoint = environment.endpoint(for: selection.id) {
          nameMenu(index: index, selection: selection, endpoint: endpoint)
        } else {
          Text(selection.displayName)
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
        }

        // A camera's address is what the operator checks against the label on its tripod when a
        // name looks wrong, so it takes the caption slot on live rows. Everything else keeps
        // showing the identifier the archive is keyed by.
        if let endpoint = environment.endpoint(for: selection.id) {
          Text("\(endpoint.host):\(endpoint.port)")
            .font(.system(size: 11, weight: .regular, design: .monospaced))
            .foregroundStyle(.white.opacity(0.35))
            .lineLimit(1)
            .accessibilityIdentifier("source-endpoint-\(index + 1)")
        } else {
          Text(selection.id.rawValue)
            .font(.system(size: 11, weight: .regular, design: .monospaced))
            .foregroundStyle(.white.opacity(0.35))
            .lineLimit(1)
        }
      }

      Spacer()

      if let badge = originBadge(for: selection) {
        Text(badge)
          .font(.system(size: 9, weight: .heavy, design: .rounded))
          .tracking(1)
          .padding(.horizontal, 6)
          .padding(.vertical, 3)
          .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 4))
          .foregroundStyle(.white.opacity(0.55))
          .accessibilityIdentifier("source-origin-\(index + 1)")
          .accessibilityValue(
            "origin=\(environment.bindingOrigin(for: selection.id).rawValue)"
          )
      }

      if let tile = selection.tileIndex, selection.isEnabled {
        Text("TILE \(tile + 1)")
          .font(.system(size: 10, weight: .heavy, design: .rounded))
          .tracking(1)
          .padding(.horizontal, 7)
          .padding(.vertical, 3)
          .background(Color.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 4))
          .foregroundStyle(.white.opacity(0.7))
      }

      Button {
        if renamingID == selection.id {
          commitRename(for: selection)
        } else {
          renamingID = selection.id
          draftName = selection.displayName
        }
      } label: {
        Image(systemName: renamingID == selection.id ? "checkmark" : "pencil")
          .font(.system(size: 14, weight: .semibold))
          .frame(width: 34, height: 30)
          .foregroundStyle(.white.opacity(0.75))
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("source-rename-\(index + 1)")

      // Two independent decisions, so two switches: whether the camera gets a tile, and whether its
      // microphone is in the programme mix. Labelled, because an unlabelled pair of toggles is a
      // coin flip under pressure.
      toggle(
        label: "VIDEO",
        identifier: "source-toggle-\(index + 1)",
        tint: .programGreen,
        isOn: selection.isEnabled
      ) { environment.setEnabled($0, for: selection.id) }

      toggle(
        label: "AUDIO",
        identifier: "source-audio-toggle-\(index + 1)",
        tint: .replayAmber,
        isOn: selection.usesAudio
      ) { environment.setUsesAudio($0, for: selection.id) }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 16)
    .frame(minHeight: 104)
    .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 10))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("source-row-\(index + 1)")
    .accessibilityValue(
      "name=\(rowName(for: selection)) on=\(selection.isEnabled ? 1 : 0) "
        + "audio=\(selection.usesAudio ? 1 : 0) "
        + "host=\(environment.endpoint(for: selection.id)?.host ?? "") "
        + "origin=\(environment.bindingOrigin(for: selection.id).rawValue) "
        // Both, because a flow asserting on a rename has to tell "the camera renamed itself and we
        // followed" apart from "the operator renamed it and the camera's name is being ignored".
        + "advertised=\(environment.boundCamera(for: selection.id)?.advertisedName ?? "") "
        + "nameOrigin=\(environment.boundCamera(for: selection.id)?.nameOrigin.rawValue ?? "")"
    )
  }

  /// What the row is called on screen. A live camera with no record is "Unnamed" rather than its
  /// address, so an assertion about naming reads the same thing the operator does.
  private func rowName(for selection: SourceSelection) -> String {
    guard environment.endpoint(for: selection.id) != nil else { return selection.displayName }
    return environment.boundCamera(for: selection.id)?.name ?? "Unnamed"
  }

  /// The naming control for a live camera. A menu rather than a text field because the answer is
  /// usually a camera the operator has already named at a previous game — typing it again is both
  /// slower and a chance to create a second record for the same camera.
  private func nameMenu(index: Int, selection: SourceSelection, endpoint: CameraEndpoint) -> some View {
    let bound = environment.boundCamera(for: selection.id)

    return Menu {
      Button(bound == nil ? "Name…" : "Rename…") {
        renamingID = selection.id
        // Empty for an unnamed camera: its "name" today is an IP address, and nobody wants to edit
        // one into "Third Base".
        draftName = bound?.name ?? ""
      }
      .accessibilityIdentifier("camera-rename-\(index + 1)")

      // Only worth offering when it would change something: the camera has a name of its own and
      // the operator has overridden it. Otherwise this is already what the row is doing.
      if let advertised = bound?.advertisedName, bound?.nameOrigin == .operatorAssigned {
        Button("Use camera's name (\"\(advertised)\")") {
          environment.followCamera(for: selection.id)
        }
        .accessibilityIdentifier("camera-use-advertised-\(index + 1)")
      }

      Button("New camera…") {
        environment.nameCamera(
          CameraIdentityRules.nextDefaultName(in: environment.cameraRecords),
          for: selection.id
        )
      }
      .accessibilityIdentifier("camera-new-\(index + 1)")

      if !choices(besides: bound).isEmpty {
        Divider()
        ForEach(choices(besides: bound)) { record in
          Button(choiceLabel(for: record)) {
            environment.bindCamera(record.id, to: selection.id)
          }
          .accessibilityIdentifier("camera-choice-\(slug(record.name))")
        }
      }

      if let bound {
        Divider()
        Button("Forget this camera", role: .destructive) {
          environment.forgetCamera(for: selection.id)
        }
        .accessibilityIdentifier("camera-forget-\(index + 1)")
      }
    } label: {
      HStack(spacing: 5) {
        Text(bound?.name ?? "Unnamed")
          .font(.system(size: 16, weight: .semibold, design: .rounded))
          .foregroundStyle(bound == nil ? Color.replayAmber : .white)
        Image(systemName: "chevron.down")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(.white.opacity(0.4))
      }
    }
    .accessibilityIdentifier("source-name-menu-\(index + 1)")
    .accessibilityLabel("Camera name for \(endpoint.host)")
  }

  /// Every named camera except the one this row already has. A camera answering on another address
  /// stays in the list: choosing it is how the operator corrects two cameras that swapped leases.
  private func choices(besides bound: CameraRecord?) -> [CameraRecord] {
    environment.cameraRecords
      .filter { $0.id != bound?.id }
      .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  private func choiceLabel(for record: CameraRecord) -> String {
    if let host = environment.presentHost(forCamera: record.id) {
      return "\(record.name) · in use by \(host)"
    }
    if record.lastKnownHost.isEmpty {
      return record.name
    }
    return "\(record.name) · last seen \(record.lastKnownHost)"
  }

  /// Why this camera is on this row. `ID` and `IP` are both automatic but are not equally
  /// trustworthy: an identifier match is the camera saying who it is, an address match is a guess
  /// that two cameras swapping leases will get wrong, and that difference is what the operator
  /// needs when a tile shows the wrong field.
  private func originBadge(for selection: SourceSelection) -> String? {
    switch environment.bindingOrigin(for: selection.id) {
    case .autoByIdentity, .autoByCNAME: "ID"
    case .autoByHost: "IP"
    case .manual: "MANUAL"
    case .unbound: nil
    }
  }

  /// Menu rows are addressed by name in flows, so the identifier has to be derived from it.
  private func slug(_ name: String) -> String {
    let allowed = name.lowercased().map { character -> Character in
      character.isLetter || character.isNumber ? character : "-"
    }
    return String(allowed)
      .split(separator: "-", omittingEmptySubsequences: true)
      .joined(separator: "-")
  }

  private func toggle(
    label: String,
    identifier: String,
    tint: Color,
    isOn: Bool,
    set: @escaping (Bool) -> Void
  ) -> some View {
    VStack(spacing: 3) {
      Text(label)
        .font(.system(size: 8, weight: .heavy, design: .rounded))
        .tracking(1)
        .foregroundStyle(.white.opacity(0.4))
      Button {
        set(!isOn)
      } label: {
        Capsule()
          .fill(isOn ? tint : Color.white.opacity(0.14))
          .frame(width: 50, height: 30)
          .overlay(alignment: isOn ? .trailing : .leading) {
            Circle()
              .fill(Color.white)
              .padding(3)
          }
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier(identifier)
      .accessibilityValue(isOn ? "1" : "0")
      .accessibilityLabel(label)
    }
  }

  private var emptyState: some View {
    VStack(spacing: 12) {
      ProgressView().tint(.white.opacity(0.4))
      Text("Looking for sources…")
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(.white.opacity(0.45))
      if environment.isUsingLiveCameras {
        Text("Cameras on this Wi-Fi should appear here. If the list stays empty, check that GS Director has Local Network access in Settings.")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(.white.opacity(0.45))
          .multilineTextAlignment(.center)
          .padding(.horizontal, 32)
        Button {
          environment.openAppSettings()
        } label: {
          Text("OPEN SETTINGS")
            .font(.system(size: 12, weight: .heavy, design: .rounded))
            .tracking(1)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Color.deckPanel, in: RoundedRectangle(cornerRadius: 8))
            .foregroundStyle(.white.opacity(0.85))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("open-settings")
        // A subnet sweep takes seconds, and an operator watching a spinner has no way to tell a
        // scan that is working from one that never started.
        if !environment.snapshot.discoveryStatus.isEmpty {
          Text(environment.snapshot.discoveryStatus)
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(.white.opacity(0.35))
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
            .accessibilityIdentifier("discovery-status")
        }
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 60)
    .accessibilityIdentifier("sources-empty")
  }

  private var footer: some View {
    HStack(spacing: 16) {
      Spacer()

      Text("\(environment.enabledSelections.count)/\(SourceSelectionRules.maximumEnabled) enabled")
        .font(.system(size: 12, weight: .semibold, design: .monospaced))
        .foregroundStyle(.white.opacity(0.5))
        .accessibilityIdentifier("enabled-count")

      Button {
        Task { await environment.enterDirecting() }
      } label: {
        Text("DONE")
          .font(.system(size: 13, weight: .heavy, design: .rounded))
          .tracking(1)
          .padding(.horizontal, 20)
          .padding(.vertical, 11)
          .background(Color.programGreen, in: RoundedRectangle(cornerRadius: 8))
          .foregroundStyle(.black)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("start-directing")
    }
    .padding(24)
  }

  /// A live camera's name belongs to the camera, not the row, so it goes to the record cache and is
  /// offered again next time that camera appears. Synthetic and file rows have no camera to name.
  private func commitRename(for selection: SourceSelection) {
    let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
    if environment.endpoint(for: selection.id) != nil {
      // An empty name would create a record called nothing, which is worse than staying unnamed.
      if !trimmed.isEmpty { environment.nameCamera(trimmed, for: selection.id) }
    } else {
      environment.rename(trimmed, for: selection.id)
    }
    renamingID = nil
    draftName = ""
    isNamingFocused = false
  }
}
