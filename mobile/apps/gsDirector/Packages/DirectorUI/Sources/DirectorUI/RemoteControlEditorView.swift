import DirectorCore
import SwiftUI

public struct RemoteControlEditorView: View {
  var onClose: () -> Void
  @Environment(AppEnvironment.self) private var environment

  @State private var capturing: RemoteAction?
  @State private var showingRename = false
  @State private var renameText = ""

  public init(onClose: @escaping () -> Void) {
    self.onClose = onClose
  }

  public var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 12) {
        typePicker
        padStatus
        bindingList
      }
      .padding(16)
      .background(Color.black)
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        ModalActionFooter(
          primaryTitle: "DONE",
          primaryIdentifier: "remote-editor-done",
          action: {
            environment.capturingRemoteAction = nil
            onClose()
          }
        )
      }
      .toolbar {
        ToolbarItem(placement: .principal) {
          HStack(spacing: 8) {
            Button {
              beginRename()
            } label: {
              Text(templateName)
                .font(.headline)
                .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("remote-editor-rename-title")
            Button {
              beginRename()
            } label: {
              Image(systemName: "pencil")
            }
            .accessibilityIdentifier("remote-editor-rename")
            .accessibilityLabel("Rename template")
          }
        }
      }
      .overlay {
        if showingRename {
          CenteredHover(onCancel: { showingRename = false }) {
            TemplateRenameSheet(
              title: "Rename template",
              name: $renameText,
              fieldIdentifier: "remote-editor-rename-field",
              clearIdentifier: "remote-editor-rename-clear",
              onCancel: { showingRename = false },
              onSave: {
                environment.renameRemoteTemplate(
                  id: environment.editingRemoteTemplateID ?? environment.activeRemoteTemplateID,
                  name: renameText
                )
                showingRename = false
              }
            )
          }
        }
      }
    }
    .onDisappear {
      environment.capturingRemoteAction = nil
    }
  }

  private var templateName: String {
    environment.editingRemoteTemplate?.name ?? RemoteControlTemplate.defaultName
  }

  private func beginRename() {
    renameText = templateName
    showingRename = true
  }

  @ViewBuilder
  private var typePicker: some View {
    if let template = environment.editingRemoteTemplate {
      Picker("Remote", selection: remoteTypeBinding(template.id, current: template.remoteType)) {
        ForEach(RemoteType.allCases) { type in
          Text(type.displayName).tag(type)
        }
      }
      .pickerStyle(.menu)
      .accessibilityIdentifier("remote-editor-type")
    }
  }

  private var padStatus: some View {
    Text(padStatusText)
      .font(.footnote)
      .foregroundStyle(.secondary)
      .accessibilityIdentifier("remote-editor-pad")
      .accessibilityValue(padStatusText)
  }

  private var padStatusText: String {
    if let name = environment.remoteInput.connectedName {
      return "Pad: \(name)"
    }
    return "No pad connected — pair in iPad Settings, or inject chords in tests"
  }

  private var bindingList: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(RemoteActionCatalog.editorActions) { action in
          row(for: action)
        }
      }
    }
    .accessibilityIdentifier("remote-action-list")
  }

  private func row(for action: RemoteAction) -> some View {
    let isCapturing = capturing == action
    return HStack(alignment: .center, spacing: 12) {
      Button {
        select(action)
      } label: {
        Text(action.editorTargetLabel(slowMotionPercent: environment.config.replaySlowMotionRate))
          .font(.system(size: 16, weight: isCapturing ? .bold : .regular))
          .foregroundStyle(isCapturing ? Color.white : Color.white.opacity(0.7))
          .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
          .padding(.horizontal, 12)
          .padding(.vertical, 12)
      }
      .buttonStyle(.plain)
      .frame(minWidth: 220, maxWidth: 280, alignment: .leading)
      .accessibilityIdentifier("remote-action-\(action.accessibilitySuffix)")

      Text(action.editorRoleLabel)
        .font(.system(size: 15, weight: .semibold, design: .rounded))
        .foregroundStyle(.white.opacity(0.55))
        .frame(width: 88, alignment: .leading)
        .accessibilityIdentifier("remote-role-\(action.accessibilitySuffix)")

      chordField(for: action, isCapturing: isCapturing)
    }
  }

  private func chordField(for action: RemoteAction, isCapturing: Bool) -> some View {
    let control = fieldControl(for: action)
    return HStack(spacing: 8) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          if let control {
            pill(control)
          } else {
            Text(isCapturing ? "Press a button" : "—")
              .font(.system(size: 15))
              .foregroundStyle(.white.opacity(0.35))
          }
        }
      }
      Button {
        environment.clearRemoteChord(for: action)
        select(action)
      } label: {
        Image(systemName: "xmark.circle.fill")
          .symbolRenderingMode(.hierarchical)
          .font(.system(size: 22))
          .foregroundStyle(.white.opacity(0.55), Color.white.opacity(0.22))
      }
      .buttonStyle(.plain)
      .tint(Color.white.opacity(0.55))
      .disabled(control == nil)
      .accessibilityIdentifier(
        isCapturing ? "remote-chord-clear" : "remote-chord-clear-\(action.accessibilitySuffix)"
      )
    }
    .padding(12)
    .frame(maxWidth: .infinity, minHeight: 72)
    .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    .overlay(
      RoundedRectangle(cornerRadius: 8)
        .strokeBorder(isCapturing ? Color.blue : Color.clear, lineWidth: 2)
    )
    .contentShape(Rectangle())
    .onTapGesture { select(action) }
    .accessibilityIdentifier("remote-chord-field-\(action.accessibilitySuffix)")
    .accessibilityValue(control?.rawValue ?? "")
  }

  private func fieldControl(for action: RemoteAction) -> ControlID? {
    guard let template = environment.editingRemoteTemplate else { return nil }
    return RemoteChordRules.fieldControl(for: action, in: template.bindings)
  }

  private func select(_ action: RemoteAction) {
    capturing = action
    environment.capturingRemoteAction = action
  }

  private func pill(_ id: ControlID) -> some View {
    HStack(spacing: 4) {
      if !id.pillSymbol.isEmpty {
        Image(systemName: id.pillSymbol)
      }
      Text(id.pillTitle)
    }
    .font(.system(size: 13, weight: .semibold, design: .rounded))
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(Color.white.opacity(0.16), in: Capsule())
    .foregroundStyle(.white)
    .accessibilityIdentifier("remote-pill-\(id.rawValue)")
  }

  private func remoteTypeBinding(_ id: UUID, current: RemoteType) -> Binding<RemoteType> {
    Binding(
      get: { environment.remoteTemplates.first { $0.id == id }?.remoteType ?? current },
      set: { environment.setRemoteType($0, for: id) }
    )
  }
}
