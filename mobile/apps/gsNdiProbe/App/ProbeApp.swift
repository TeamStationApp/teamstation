import SwiftUI

/// The whole app. A screen of numbers over a receive loop, so the bench camera can read how long
/// it has been up without the control server, the telemetry stack, or anything else that would put
/// Director's code back into the picture this is meant to exclude.
@main
struct ProbeApp: App {
  @State private var probe = Probe(
    wantedReceivers: Self.integerArgument("receivers") ?? 3,
    readsPixels: Self.flagArgument("readPixels"),
    lowBandwidth: Self.flagArgument("lowBandwidth"),
    nameFilter: Self.stringArgument("nameFilter") ?? ""
  )

  var body: some Scene {
    WindowGroup {
      ProbeView(probe: probe)
        .onAppear { probe.start() }
    }
  }

  private static func integerArgument(_ key: String) -> Int? {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-\(key)"), index + 1 < arguments.count else {
      return nil
    }
    return Int(arguments[index + 1])
  }

  private static func stringArgument(_ key: String) -> String? {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-\(key)"), index + 1 < arguments.count else {
      return nil
    }
    return arguments[index + 1]
  }

  private static func flagArgument(_ key: String) -> Bool {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-\(key)"), index + 1 < arguments.count else {
      return false
    }
    return ["1", "true", "YES"].contains(arguments[index + 1])
  }
}

struct ProbeView: View {
  let probe: Probe
  @State private var snapshot: Probe.Snapshot?
  private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("NDI PROBE")
        .font(.system(size: 34, weight: .bold, design: .monospaced))
      if let snapshot {
        Text("UP \(Int(snapshot.uptime))s")
          .font(.system(size: 96, weight: .heavy, design: .monospaced))
          .foregroundStyle(.green)
        Text("sources \(snapshot.sourcesFound) · \(snapshot.note)")
          .font(.system(size: 22, design: .monospaced))
          .foregroundStyle(.secondary)
        ForEach(Array(snapshot.receivers.enumerated()), id: \.offset) { _, reading in
          Text("\(reading.name.prefix(20)) \(reading.width)x\(reading.height) \(reading.framesPerSecond, specifier: "%.0f")fps n=\(reading.videoFrames) drop=\(reading.droppedBySDK)")
            .font(.system(size: 24, design: .monospaced))
        }
      } else {
        Text("starting…").font(.system(size: 28, design: .monospaced))
      }
      Spacer()
    }
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(.black)
    .onReceive(tick) { _ in snapshot = probe.snapshot }
  }
}
