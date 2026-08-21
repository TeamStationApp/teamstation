import DirectorCore
import SwiftUI

public struct RemoteControlEditorView: View {
  @Environment(AppEnvironment.self) private var environment
  @Environment(\.dismiss) private var dismiss

  @State private var capturing: RemoteAction?

  public init() {}

  public var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 12) {
        typePicker
        padStatus
        HStack(alignment: .top, spacing: 16) {
          actionColumn
          chordColumn
        }
      }
      .padding(16)
      .background(Color.black)
      .navigationTitle("Remote Control")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") {
            environment.capturingRemoteAction = nil
            dismiss()
          }
          .accessibilityIdentifier("remote-editor-done")
        }
      }
    }
    .onDisappear {
      environment.capturingRemoteAction = nil
    }
  }

  @ViewBuilder
  private var typePicker: some View {
    if let template = environment.activeRemoteTemplate {
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

  private var actionColumn: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(RemoteActionCatalog.all) { action in
          Button {
            capturing = action
            environment.capturingRemoteAction = action
          } label: {
            Text(action.title(slowMotionPercent: environment.config.replaySlowMotionRate))
              .font(.system(size: 13, weight: capturing == action ? .bold : .regular))
              .foregroundStyle(capturing == action ? Color.white : Color.white.opacity(0.7))
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.vertical, 6)
              .padding(.horizontal, 8)
              .background(
                capturing == action ? Color.white.opacity(0.12) : Color.clear,
                in: RoundedRectangle(cornerRadius: 6)
              )
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("remote-action-\(action.accessibilitySuffix)")
        }
      }
    }
    .frame(maxWidth: .infinity)
    .accessibilityIdentifier("remote-action-list")
  }

  private var chordColumn: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(capturing.map { "Chord for \($0.title(slowMotionPercent: environment.config.replaySlowMotionRate))" }
        ?? "Select an action, then press pad buttons")
        .font(.footnote)
        .foregroundStyle(.secondary)
      chordField
      Spacer()
    }
    .frame(maxWidth: .infinity)
  }

  private var chordField: some View {
    HStack(spacing: 8) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(currentChord.controls, id: \.self) { id in
            pill(id)
          }
          if currentChord.isEmpty {
            Text(capturing == nil ? "—" : "Press buttons")
              .font(.system(size: 13))
              .foregroundStyle(.white.opacity(0.35))
          }
        }
      }
      Button {
        if let capturing {
          environment.clearRemoteChord(for: capturing)
        }
      } label: {
        Image(systemName: "xmark.circle.fill")
          .font(.system(size: 22))
          .foregroundStyle(.white.opacity(0.55))
      }
      .buttonStyle(.plain)
      .disabled(capturing == nil || currentChord.isEmpty)
      .accessibilityIdentifier("remote-chord-clear")
    }
    .padding(10)
    .frame(minHeight: 52)
    .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    .overlay(
      RoundedRectangle(cornerRadius: 8)
        .strokeBorder(capturing == nil ? Color.clear : Color.white.opacity(0.35), lineWidth: 1)
    )
    .accessibilityIdentifier("remote-chord-field")
    .accessibilityValue(currentChord.controls.map(\.rawValue).joined(separator: ","))
  }

  private var currentChord: RemoteChord {
    guard let capturing, let template = environment.activeRemoteTemplate else {
      return RemoteChord()
    }
    return template.chord(for: capturing)
  }

  private func pill(_ id: ControlID) -> some View {
    HStack(spacing: 4) {
      if !id.pillSymbol.isEmpty {
        Image(systemName: id.pillSymbol)
      }
      Text(id.pillTitle)
    }
    .font(.system(size: 12, weight: .semibold, design: .rounded))
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
