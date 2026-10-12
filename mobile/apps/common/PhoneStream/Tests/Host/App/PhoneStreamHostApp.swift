import PhoneStream
import SwiftUI

/// The host the PhoneStream unit tests run inside, and a driver for the engine end to end on a
/// simulator.
///
/// Launched with nothing set, it does nothing: the unit tests make their own engines. Launched with
/// `PHONESTREAM_RTMP_URL` (and the stream's id, game, angle, server and token), it opens the shared
/// engine, continues a take a kill interrupted, or starts recording, and logs every status once a
/// second to `Documents/host.log`. Two Darwin notifications drive it from the Mac:
///
///   xcrun simctl spawn <udid> notifyutil -p app.teamstation.phonestreamhost.stop
///   xcrun simctl spawn <udid> notifyutil -p app.teamstation.phonestreamhost.upload
///
/// `stop` stops recording; `upload` stops and uploads the take. The launch settings are kept, so a
/// relaunch after a kill needs none.
@main
struct PhoneStreamHostApp: App {
  @State private var driver = HostDriver()

  var body: some Scene {
    WindowGroup {
      VStack(spacing: 12) {
        Text("PhoneStream test host").font(.headline)
        Text(driver.line).font(.system(.footnote, design: .monospaced))
      }
      .padding()
      .task { await driver.launch() }
    }
  }
}

@MainActor
@Observable
final class HostDriver {
  var line = "idle"
  private var observation: PhoneStreamObservation?
  private var lastLogged = Date.distantPast
  private let keys = [
    "PHONESTREAM_RTMP_URL", "PHONESTREAM_LIVE_STREAM_ID", "PHONESTREAM_GAME_ID",
    "PHONESTREAM_ANGLE", "PHONESTREAM_API_BASE", "PHONESTREAM_TOKEN", "PHONESTREAM_DEVICE_ID"
  ]

  /// The launch settings, from the environment, or as the first launch kept them.
  private var settings: [String: String] {
    let environment = ProcessInfo.processInfo.environment
    let defaults = UserDefaults.standard
    if environment["PHONESTREAM_RTMP_URL"] != nil {
      for key in keys { defaults.set(environment[key], forKey: key) }
    }
    return Dictionary(uniqueKeysWithValues: keys.compactMap { key in
      defaults.string(forKey: key).map { (key, $0) }
    })
  }

  private var request: PhoneStreamRequest? {
    let settings = self.settings
    guard let base = settings["PHONESTREAM_API_BASE"].flatMap(URL.init(string:)),
      let token = settings["PHONESTREAM_TOKEN"],
      let device = settings["PHONESTREAM_DEVICE_ID"]
    else { return nil }
    return PhoneStreamRequest(apiBase: base, token: token, deviceId: device)
  }

  func log(_ message: String) {
    line = message
    let stamped = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    print(stamped, terminator: "")
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("host.log")
    if let handle = try? FileHandle(forWritingTo: url) {
      handle.seekToEndOfFile()
      handle.write(Data(stamped.utf8))
      try? handle.close()
    } else {
      try? Data(stamped.utf8).write(to: url)
    }
  }

  static let commands = [ "app.teamstation.phonestreamhost.stop", "app.teamstation.phonestreamhost.upload" ]

  /// Listens for the Mac's commands.
  private func listen() {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = Unmanaged.passUnretained(self).toOpaque()
    for command in Self.commands {
      CFNotificationCenterAddObserver(center, observer, { _, observer, name, _, _ in
        guard let observer, let name else { return }
        let driver = Unmanaged<HostDriver>.fromOpaque(observer).takeUnretainedValue()
        let command = name.rawValue as String
        Task { @MainActor in await driver.handle(command) }
      }, command as CFString, nil, .deliverImmediately)
    }
  }

  func launch() async {
    listen()
    let settings = self.settings
    guard let rtmpURL = settings["PHONESTREAM_RTMP_URL"], let request,
      let liveStreamId = settings["PHONESTREAM_LIVE_STREAM_ID"],
      let gameId = settings["PHONESTREAM_GAME_ID"]
    else { return }
    let angle = settings["PHONESTREAM_ANGLE"] ?? "Home Plate"
    let engine = PhoneStreamEngine.shared
    observation = engine.observe { [weak self] event in self?.report(event) }
    do {
      try engine.open(angleName: angle)
      if let interrupted = engine.interruptedSession() {
        log("launch: interrupted take \(interrupted.recordingID.map(String.init) ?? "-") away \(String(format: "%.1f", interrupted.downtime)) s")
        let resumed = try engine.resumeInterrupted(request: request)
        log("launch: resumed \(resumed)")
      } else if (try engine.recordings()).contains(where: { $0.liveStreamId == liveStreamId && $0.isUploaded }) {
        log("launch: take already uploaded")
      } else {
        try engine.startRecording(
          rtmpUrl: rtmpURL,
          liveStreamId: liveStreamId,
          gameId: gameId,
          angleName: angle,
          request: request
        )
        log("launch: recording started")
      }
    } catch {
      log("launch: failed \(error)")
    }
  }

  func handle(_ command: String) async {
    let engine = PhoneStreamEngine.shared
    switch command.split(separator: ".").last {
    case "stop":
      await engine.stopRecording()
      log("stop: done \(describe(try? engine.recordings()))")
    case "upload":
      await engine.stopRecording()
      let settings = self.settings
      guard let request, let liveStreamId = settings["PHONESTREAM_LIVE_STREAM_ID"] else { return }
      log("upload: started \(describe(try? engine.recordings()))")
      do {
        let video = try await engine.uploadRecording(
          liveStreamId: liveStreamId,
          apiBase: request.apiBase,
          token: request.token,
          title: settings["PHONESTREAM_ANGLE"] ?? "Home Plate"
        )
        log("upload: done video \(video) \(describe(try? engine.recordings()))")
      } catch {
        log("upload: failed \(error)")
      }
    default:
      log("unknown command \(command)")
    }
  }

  private func describe(_ recordings: [PhoneRecording]?) -> String {
    (recordings ?? []).map { recording in
      let span = recording.endedAt.map { String(format: "%.3f", $0.seconds - recording.startedAt.seconds) } ?? "open"
      return "take \(recording.recordingID) parts \(recording.parts) span \(span) s"
        + " whole \(recording.coversWholeStream) uploaded \(recording.isUploaded)"
    }.joined(separator: "; ")
  }

  private func report(_ event: PhoneStreamEvent) {
    switch event {
    case let .status(status):
      guard Date().timeIntervalSince(lastLogged) >= 1 else { return }
      lastLogged = Date()
      log("status phase \(status.phase) retry \(status.retryInSeconds.map { String(format: "%.0f", $0) } ?? "-")"
        + " kbps \(status.bitrateKbps) recording \(status.isRecording) \(String(format: "%.1f", status.recordingSeconds)) s"
        + " error \(status.error?.rawValue ?? "-")")
    case let .upload(progress):
      log("upload \(progress.state.rawValue) \(String(format: "%.2f", progress.fraction)) \(progress.step ?? "")")
    case .radar:
      break
    }
  }
}
