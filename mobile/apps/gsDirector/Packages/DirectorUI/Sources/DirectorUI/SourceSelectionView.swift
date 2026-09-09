import DirectorCore
import DirectorSources
import SwiftUI

/// Spec 6.1: discovered sources, enable toggles capped at five, inline rename from the name itself.
public struct SourceSelectionView: View {
  @Environment(AppEnvironment.self) private var environment
  @State private var renamingID: SourceID?
  @State private var draftName = ""
  @State private var waveformID: SourceID?
  /// Without this the field appears but the keyboard goes to nobody, so the first thing the operator
  /// types is lost.
  @FocusState private var isNamingFocused: Bool

  public init() {}

  public var body: some View {
    ZStack {
      Color.deckBackground.ignoresSafeArea(.container)

      VStack(alignment: .leading, spacing: 0) {
        header
        Divider().overlay(Color.white.opacity(0.08))
        list
      }
      .safeAreaInset(edge: .bottom) {
        footer
      }

      if let waveformID,
         let selection = environment.selections.first(where: { $0.id == waveformID }) {
        ZStack {
          Color.black.opacity(0.55)
            .ignoresSafeArea()
            .onTapGesture { self.waveformID = nil }
          SourceWaveformDetailView(
            selection: selection,
            monitor: environment.router.waveformMonitor,
            onClose: { self.waveformID = nil },
            onGain: { environment.setInputGain($0, for: selection.id) }
          )
          .padding(28)
        }
      }

      if environment.config.showDebugHUD {
        VStack {
          HStack {
            DebugHUD(snapshot: environment.snapshot)
            Spacer()
          }
          Spacer()
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
    ScrollViewReader { proxy in
      ScrollView {
        VStack(spacing: 8) {
          // Display order: a linked phone sits directly under the row it controls. Row numbers in
          // identifiers count this order, which is the one the operator sees.
          ForEach(Array(displayRows.enumerated()), id: \.element.id) { index, selection in
            if environment.isLinkedControl(selection.id) {
              linkedControlRow(index: index, selection: selection)
                .id(selection.id)
            } else {
              row(index: index, selection: selection)
                .id(selection.id)
            }
          }
          if environment.selections.isEmpty {
            emptyState
          }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: isNamingFocused) { _, focused in
        // Done is one way out of the editor; dismissing the keyboard or tapping elsewhere is the
        // other, and both mean "keep what I typed". There is no cancel: clear and Done is one.
        guard !focused, let id = renamingID,
              let selection = environment.selections.first(where: { $0.id == id })
        else { return }
        commitRename(for: selection)
      }
      .onChange(of: renamingID) { _, id in
        guard let id else {
          isNamingFocused = false
          return
        }
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(50))
          withAnimation(.easeInOut(duration: 0.22)) {
            proxy.scrollTo(id, anchor: .center)
          }
        }
      }
    }
  }

  private var displayRows: [SourceSelection] {
    SourceSelectionRules.displayOrder(environment.selections)
  }

  /// One-based row number of `id` as displayed, for identifiers and the `link=` value.
  private func displayNumber(of id: SourceID) -> Int? {
    displayRows.firstIndex { $0.id == id }.map { $0 + 1 }
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
          renameField(index: index, selection: selection)
        } else {
          nameButton(index: index, selection: selection)
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

        // What the camera is actually sending. Read from the telemetry snapshot rather than the
        // source, so it follows the camera changing format mid-session instead of being sampled once.
        if let format = formatLabel(for: selection) {
          Text(format)
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            // Off-white, not blue: blue is what the tappable things in this row wear.
            .foregroundStyle(.white.opacity(0.7))
            .lineLimit(1)
            .accessibilityIdentifier("source-format-\(index + 1)")
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

      if let slot = selection.sourceIndex {
        Menu {
          Section("Assign camera to source.") {
            ForEach(0 ..< SourceIndex.count, id: \.self) { index in
              Button {
                environment.assignSource(slot: index, to: selection.id)
              } label: {
                if let other = environment.selections.first(where: {
                  $0.id != selection.id && $0.sourceIndex == index
                }) {
                  Text("Source \(index + 1) · \(other.displayName)")
                } else {
                  Text("Source \(index + 1)")
                }
              }
              .accessibilityIdentifier("source-assign-\(index + 1)")
            }
          }
        } label: {
          Text("SOURCE \(slot + 1)")
            .font(.system(size: 13, weight: .heavy, design: .rounded))
            .tracking(0.6)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.sourceBlue, in: RoundedRectangle(cornerRadius: 8))
            .foregroundStyle(.white)
        }
        .accessibilityIdentifier("source-slot-\(index + 1)")
        .accessibilityValue("source=\(slot + 1)")
      }

      linkMenu(index: index, selection: selection)

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

      SourceWaveformThumb(
        index: index,
        sourceID: selection.id,
        gain: selection.inputGain,
        monitor: environment.router.waveformMonitor
      ) {
        waveformID = selection.id
      }
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
        + "format=\(formatLabel(for: selection) ?? "") "
        + "gain=\(SourceWaveformThumb.percent(selection.inputGain)) "
        + "host=\(environment.endpoint(for: selection.id)?.host ?? "") "
        + "origin=\(environment.bindingOrigin(for: selection.id).rawValue) "
        // Both, because a flow asserting on a rename has to tell "the camera renamed itself and we
        // followed" apart from "the operator renamed it and the camera's name is being ignored".
        + "advertised=\(environment.boundCamera(for: selection.id)?.advertisedName ?? "") "
        + "nameOrigin=\(environment.boundCamera(for: selection.id)?.nameOrigin.rawValue ?? "") "
        + "link=\(SourceLinkLabel.accessibilityLink(video: selection.linkedControlID.flatMap(displayNumber)))"
    )
  }

  /// A phone that is another row's control: no picture, no slot, no place in the mix. What is left
  /// is its name and address, so the operator can tell which phone this is, and one way out.
  private func linkedControlRow(index: Int, selection: SourceSelection) -> some View {
    let video = environment.linkedVideo(forControl: selection.id)

    return HStack(spacing: 14) {
      LinkIndentMark()
        .frame(width: 128, height: 72)
        .accessibilityIdentifier("source-link-mark-\(index + 1)")

      Circle()
        .fill(selection.isPresent ? Color.programGreen : Color.white.opacity(0.18))
        .frame(width: 8, height: 8)

      VStack(alignment: .leading, spacing: 2) {
        if renamingID == selection.id {
          renameField(index: index, selection: selection)
        } else {
          nameButton(index: index, selection: selection)
        }
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

      Text(SourceLinkLabel.linkedForControl)
        .font(.system(size: 12, weight: .semibold, design: .rounded))
        .foregroundStyle(.white.opacity(0.7))
        .accessibilityIdentifier("source-link-status-\(index + 1)")

      Button {
        environment.unlinkSource(control: selection.id)
      } label: {
        Image(systemName: "xmark.circle.fill")
          .font(.system(size: 22, weight: .semibold))
          .frame(width: 34, height: 30)
          .foregroundStyle(Color.recordRed)
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("source-unlink-\(index + 1)")
      .accessibilityLabel("Unlink \(rowName(for: selection))")
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .frame(minHeight: 84)
    .background(Color.deckPanel.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("source-row-\(index + 1)")
    .accessibilityValue(
      "name=\(rowName(for: selection)) on=0 audio=0 format= "
        + "gain=\(SourceWaveformThumb.percent(selection.inputGain)) "
        + "host=\(environment.endpoint(for: selection.id)?.host ?? "") "
        + "origin=\(environment.bindingOrigin(for: selection.id).rawValue) "
        + "advertised=\(environment.boundCamera(for: selection.id)?.advertisedName ?? "") "
        + "nameOrigin=\(environment.boundCamera(for: selection.id)?.nameOrigin.rawValue ?? "") "
        + "link=\(SourceLinkLabel.accessibilityLink(control: video.flatMap { displayNumber(of: $0.id) }))"
    )
  }

  /// The chain: broken while the row has no link, whole once it has one. Tapping either opens the
  /// picker, which lists every Cameraman that could take the job.
  private func linkMenu(index: Int, selection: SourceSelection) -> some View {
    let candidates = environment.linkCandidates(for: selection.id)
    let linked = environment.linkedControl(for: selection.id)

    return Menu {
      Section(SourceLinkLabel.pickerTitle) {
        if candidates.isEmpty {
          Text(SourceLinkLabel.noCandidates)
        }
        ForEach(candidates) { candidate in
          Button {
            environment.linkSource(video: selection.id, control: candidate.id)
          } label: {
            if candidate.id == linked?.id {
              Label(linkChoiceLabel(for: candidate), systemImage: "checkmark")
            } else {
              Text(linkChoiceLabel(for: candidate))
            }
          }
          .accessibilityIdentifier("link-choice-\(displayNumber(of: candidate.id) ?? 0)")
        }
      }
      if let linked {
        Divider()
        Button("Unlink \(rowName(for: linked))", role: .destructive) {
          environment.unlinkSource(video: selection.id)
        }
        .accessibilityIdentifier("link-remove-\(index + 1)")
      }
    } label: {
      ChainLinkGlyph(broken: linked == nil, color: linked == nil ? Color.white.opacity(0.75) : Color.sourceBlue)
        .frame(width: 34, height: 30)
        .contentShape(Rectangle())
    }
    .accessibilityIdentifier("source-link-\(index + 1)")
    .accessibilityLabel(linked.map { "Linked to \(rowName(for: $0))" } ?? "Link a camera for remote control")
  }

  private func linkChoiceLabel(for candidate: SourceSelection) -> String {
    SourceLinkLabel.candidate(
      name: rowName(for: candidate),
      host: environment.endpoint(for: candidate.id)?.host
    )
  }

  /// Codec, size and rate for an enabled camera, or nil while it has none of them yet.
  ///
  /// A disabled camera has no session and therefore nothing to report: the codec is in the SDP, which
  /// is only fetched once the toggle is on.
  private func formatLabel(for selection: SourceSelection) -> String? {
    guard selection.isEnabled, let slot = selection.sourceIndex else { return nil }
    guard let tile = environment.snapshot.tiles.first(where: { $0.index == slot }) else { return nil }
    return SourceFormatLabel.text(for: tile)
  }

  /// What the row is called on screen. A live camera with no record is "Unnamed" rather than its
  /// address, so an assertion about naming reads the same thing the operator does.
  private func rowName(for selection: SourceSelection) -> String {
    guard environment.endpoint(for: selection.id) != nil else { return selection.displayName }
    return environment.boundCamera(for: selection.id)?.name ?? "Unnamed"
  }

  private func renameField(index: Int, selection: SourceSelection) -> some View {
    ClearableTextField(
      text: $draftName,
      clearIdentifier: "source-name-field-clear-\(index + 1)"
    ) {
      TextField("Name", text: $draftName)
        .textFieldStyle(.plain)
        .font(.system(size: 16, weight: .semibold, design: .rounded))
        .foregroundStyle(.white)
        .focused($isNamingFocused)
        // "Done" on the keyboard, because a return key on a one-line name field reads as
        // "new line" to an operator who is not thinking about text fields.
        .submitLabel(.done)
        .accessibilityIdentifier("source-name-field-\(index + 1)")
        .onSubmit { commitRename(for: selection) }
        .onAppear {
          // Keyboard avoidance steals first responder if focus is claimed in the same turn
          // the field appears — especially on the last row.
          Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            isNamingFocused = true
          }
        }
    }
  }

  /// The name is the rename control: one tap opens the inline editor. Blue, because blue is what
  /// tappable things wear in this row. A live camera with no record shows "Unnamed" in amber so
  /// the operator can see which tripod still needs a label.
  private func nameButton(index: Int, selection: SourceSelection) -> some View {
    let endpoint = environment.endpoint(for: selection.id)
    let bound = environment.boundCamera(for: selection.id)
    let unnamed = endpoint != nil && bound == nil

    return Button {
      renamingID = selection.id
      // Empty for an unnamed camera: the address is already the caption, and nobody wants to
      // edit an IP into "Third Base".
      draftName = endpoint != nil ? (bound?.name ?? "") : selection.displayName
    } label: {
      Text(rowName(for: selection))
        .font(.system(size: 16, weight: .semibold, design: .rounded))
        .foregroundStyle(unnamed ? Color.replayAmber : Color.sourceBlue)
        .lineLimit(1)
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("source-name-\(index + 1)")
    .accessibilityLabel(endpoint.map { "Camera name for \($0.host)" } ?? "Name for \(selection.displayName)")
  }

  /// Why this camera is on this row. `ID` is automatic matching on NearStream TXT or RTSP CNAME.
  /// Address is never a match, so there is no IP badge — the socket is already the caption.
  private func originBadge(for selection: SourceSelection) -> String? {
    switch environment.bindingOrigin(for: selection.id) {
    case .autoByIdentity, .autoByCNAME: "ID"
    case .manual: "MANUAL"
    case .unbound: nil
    }
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

      ModalPrimaryButton(
        title: "DONE",
        identifier: "start-directing",
        action: { Task { await environment.enterDirecting() } }
      )
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
