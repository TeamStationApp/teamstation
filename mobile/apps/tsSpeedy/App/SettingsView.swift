import SpeedyCore
import SwiftUI

/// Settings holds one thing: pairing the radar.
struct SettingsView: View {
  @Bindable var model: SpeedyModel

  var body: some View {
    NavigationStack {
      ScrollView {
        radarCard
          .padding(16)
      }
      .background(Color.black.ignoresSafeArea())
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { model.closeSettings() }
            .accessibilityIdentifier("settings-done")
        }
      }
    }
    .preferredColorScheme(.dark)
  }

  private var status: RadarStatus { model.radarStatus }

  private var radarCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Radar")
        .font(.headline)
      Text("Pair a TAG One to show and speak its pitch and exit speeds.")
        .font(.footnote)
        .foregroundStyle(.secondary)
      HStack {
        Text("Status")
        Spacer()
        Text(status.text)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("settings-radar-status")
      }
      if let serial = status.serial {
        HStack {
          Text(serial)
            .accessibilityIdentifier("settings-radar-serial")
          Spacer()
          if let battery = status.batteryPercent {
            Text("⚡\(battery)%")
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("settings-radar-battery")
          }
        }
        Button("Unpair", role: .destructive) { model.unpair() }
          .accessibilityIdentifier("settings-radar-unpair")
      }
      if status.pairing {
        if status.nearby.isEmpty {
          Text("No radars in range")
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("settings-radar-none")
        }
        ForEach(status.nearby, id: \.self) { name in
          Button(name) { model.pair(name) }
            .accessibilityIdentifier("settings-radar-option-\(name)")
        }
        Button("Close") { model.stopPairing() }
          .accessibilityIdentifier("settings-radar-close")
      } else {
        Button(status.isPaired ? "Pair another radar" : "Pair") { model.startPairing() }
          .accessibilityIdentifier("settings-radar-pair")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .background(Color(white: 0.11), in: RoundedRectangle(cornerRadius: 14))
  }
}
