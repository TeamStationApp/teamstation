import SwiftUI

/// The window before GS Director is reachable. It says what exporting needs; what needs only this
/// Mac is there all the same.
struct ConnectionView: View {
  let model: DistributorModel

  static let notice = DistributorModel.noIPadNotice

  var body: some View {
    VStack(spacing: 12) {
      switch model.link {
      case .waitingForIPad:
        Image(systemName: "ipad.and.arrow.forward")
          .font(.largeTitle)
          .foregroundStyle(.secondary)
        Text(Self.notice)
          .font(.title3)
      case .waitingForDirector(let serial):
        Image(systemName: "ipad.and.arrow.forward")
          .font(.largeTitle)
          .foregroundStyle(.secondary)
        Text(Self.notice)
          .font(.title3)
        Text("\(model.displayName(of: serial)) is attached, but GS Director is not answering. It must be open and in front.")
          .foregroundStyle(.secondary)
      case .connected(let hello):
        ProgressView()
        Text("Connected to GS Director \(hello.directorVersion)")
          .font(.title3)
        if let serial = model.chosenDevice?.serial {
          Text(model.displayName(of: serial))
            .foregroundStyle(.secondary)
        }
      case .failed(let reason):
        Image(systemName: "exclamationmark.triangle")
          .font(.largeTitle)
        Text(reason)
      }
    }
    .padding(40)
    .multilineTextAlignment(.center)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityIdentifier("connection-state")
  }
}

/// Recordings once GS Director answers, otherwise what to do to reach it.
struct RootView: View {
  @Bindable var model: DistributorModel

  var body: some View {
    Group {
      if case .connected = model.link {
        RecordingsView(model: model)
      } else {
        ConnectionView(model: model)
      }
    }
    .toolbar {
      // The gear at the top right; ⌘, opens the same window.
      ToolbarItem(placement: .primaryAction) {
        SettingsLink {
          Label("Settings", systemImage: "gearshape")
        }
        .accessibilityIdentifier("settings-gear")
      }
      if model.devices.count > 1 {
        ToolbarItem(placement: .navigation) {
          Picker("iPad", selection: Binding(
            get: { model.chosenDevice?.serial ?? "" },
            set: { serial in Task { await model.choose(serial: serial) } }
          )) {
            ForEach(model.devices, id: \.serial) { device in
              Text(model.displayName(of: device.serial)).tag(device.serial)
            }
          }
          .accessibilityIdentifier("device-picker")
        }
      }
    }
    .alert(
      "GS Distributor",
      isPresented: Binding(get: { model.problem != nil }, set: { if !$0 { model.problem = nil } })
    ) {
      Button("OK") { model.problem = nil }
    } message: {
      Text(model.problem ?? "")
    }
  }
}
