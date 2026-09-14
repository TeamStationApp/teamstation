#if DEBUG
import DirectorCore
import Distribution
import DistributorWire
import Foundation
import Network

/// Debug builds only, and only when launched with `-harness`: a loopback server on port 8768 so a
/// script can drive and check the app without seeing the screen. Like the Director's and
/// Cameraman's harnesses, it is never in a release.
///
///   /dump-state                          what the window is showing, and the export under way
///   /set-destination?path=/some/folder   this Mac's download folder, saved on the iPad
///   /clear-destination                   forget it again
///   /export?recording=361&tracks=primary,camera:<source id>[&reprocess=1][&combined=1[&audio=<name>]]
///          [&upload=primary,camera:<name>,combined&title=<title>]
///   /cancel                              stop the export under way
@MainActor
final class DebugHarness {
  static let port: UInt16 = 8768

  private let model: DistributorModel
  private var listener: NWListener?

  init(model: DistributorModel) {
    self.model = model
  }

  static var isRequested: Bool {
    ProcessInfo.processInfo.arguments.contains("-harness")
  }

  func start() {
    guard listener == nil else { return }
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: Self.port)!)
    guard let listener = try? NWListener(using: parameters) else { return }
    listener.newConnectionHandler = { [weak self] connection in
      Task { @MainActor in self?.serve(connection) }
    }
    listener.start(queue: .main)
    self.listener = listener
  }

  private func serve(_ connection: NWConnection) {
    connection.start(queue: .main)
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
      let head = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
      let target = head.split(separator: "\r\n").first?.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
      Task { @MainActor in
        guard let self else { return }
        let answer = await self.handle(target)
        let body = (try? JSONSerialization.data(withJSONObject: answer, options: [ .prettyPrinted, .sortedKeys ]))
          ?? Data("{}".utf8)
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(response.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
      }
    }
  }

  private func handle(_ target: String) async -> [String: Any] {
    let components = URLComponents(string: "http://harness\(target)")
    let query = Dictionary(
      (components?.queryItems ?? []).map { ($0.name, $0.value ?? "") },
      uniquingKeysWith: { _, last in last }
    )
    switch components?.path ?? "/" {
    case "/set-destination":
      guard let path = query["path"], !path.isEmpty else { return [ "ok": false, "error": "path required" ] }
      let macID = model.macID
      await model.updateSettings { $0.destinations[macID] = path }
      return [ "ok": model.destination?.path == path ]
    case "/clear-destination":
      let macID = model.macID
      await model.updateSettings { $0.destinations[macID] = nil }
      return [ "ok": model.destination == nil ]
    case "/cancel":
      model.run?.cancel()
      return [ "ok": model.run?.wasCancelled ?? false ]
    case "/export":
      guard let id = query["recording"].flatMap(Int64.init),
            let recording = model.recordings.first(where: { $0.id == id })
      else { return [ "ok": false, "error": "no such recording" ] }
      let tracks: [Track] = (query["tracks"] ?? "").split(separator: ",").compactMap { item in
        if item == "primary" { return .primary }
        if item.hasPrefix("camera:") { return .camera(SourceID(String(item.dropFirst("camera:".count)))) }
        return nil
      }
      // `combined=1` lays the combined video out from the saved layout, as the sheet would open it.
      var plan: CombinedPlan?
      if query["combined"] == "1" {
        let cameras = recording.cameras.filter { camera in tracks.contains(.camera(camera.sourceID)) }
        let saved = model.settings?.combinedLayout ?? CombinedLayoutSettings()
        let included = CombinedLayoutRules.initialInclusion(exported: cameras.map(\.name), saved: saved)
        let assignment = CombinedLayoutRules.assign(included, saved: saved)
        let solo = included.count == 3 ? CombinedGeometry.effectiveSolo(assignment: assignment, saved: saved.solo) : nil
        plan = CombinedPlan(
          cameras: cameras.filter { included.contains($0.name) }.map { (name: $0.name, sourceID: $0.sourceID) },
          frames: CombinedGeometry.frames(assignment: assignment, solo: solo),
          audioCamera: CombinedLayoutRules.audioCamera(
            included: included,
            withAudio: Set(included),
            saved: query["audio"] ?? saved.audioCamera
          )
        )
      }
      // `upload=primary,camera:<name>,combined&title=<title>` uploads those files, as the title
      // sheet would, to the channel and with the privacy it would start on. Without a title, the
      // field's starting text (the date and a space) is used.
      var upload: UploadPlan?
      if let list = query["upload"], !list.isEmpty {
        let wanted: [UploadTrack] = list.split(separator: ",").compactMap { item in
          if item == "primary" { return .primary }
          if item == "combined" { return .combined }
          if item.hasPrefix("camera:") { return .camera(String(item.dropFirst("camera:".count))) }
          return nil
        }
        let title = query["title"] ?? PeerTubeTitle.initialTitle(for: recording.startedAt.date)
        upload = model.uploadPlan(
          for: recording,
          title: title,
          channelID: model.uploadChannelID,
          privacy: model.uploadPrivacy,
          tracks: wanted
        )
        if upload == nil { return [ "ok": false, "error": "not signed in to PeerTube, or no channel" ] }
      }
      model.export(recording, tracks: tracks, reprocess: query["reprocess"] == "1", combined: plan, upload: upload)
      return [ "ok": model.run != nil ]
    default:
      return state()
    }
  }

  private func state() -> [String: Any] {
    var link: [String: Any] = [:]
    switch model.link {
    case .waitingForIPad:
      link["state"] = "waitingForIPad"
    case .waitingForDirector(let serial):
      link["state"] = "waitingForDirector"
      link["serial"] = serial
    case .connected(let hello):
      link["state"] = "connected"
      link["directorVersion"] = hello.directorVersion
      link["sessionID"] = hello.sessionID.uuidString
    case .failed(let reason):
      link["state"] = "failed"
      link["reason"] = reason
    }
    var export: Any = NSNull()
    if let run = model.run {
      export = [
        "recording": run.recording.id,
        "folder": run.folder.path,
        "isFinished": run.isFinished,
        "tracks": run.tracks.map { track -> [String: Any] in
          [
            "track": Self.name(track),
            "state": Self.describe(run.states[track] ?? .queued),
            "stitchedBy": run.stitchedBy[track]?.rawValue ?? NSNull()
          ]
        },
        "combined": run.combinedState.map { Self.describe($0) } ?? NSNull(),
        "uploads": (run.upload?.tracks ?? []).map { track -> [String: Any] in
          [
            "title": run.upload?.title(for: track) ?? "",
            "state": Self.describe(run.uploadStates[track] ?? .queued)
          ]
        }
      ] as [String: Any]
    }
    let peerTube: String = switch model.peerTube {
    case .unknown: "unknown"
    case .signedOut: "signedOut"
    case .signedIn(let account):
      "signedIn \(account.username)@\(account.host) channel=\(model.uploadChannelID.map(String.init) ?? "none") privacy=\(model.uploadPrivacy)"
    case .unreachable(let reason): "unreachable \(reason)"
    }
    return [
      "link": link,
      "isRecording": model.isRecording,
      "devices": model.devices.map { [ "serial": $0.serial, "deviceID": $0.deviceID ] },
      "recordings": model.recordings.map { recording in
        [
          "id": recording.id,
          "isLive": recording.isLive,
          "hasPrimary": recording.hasPrimary,
          "cameras": recording.cameras.map { [ "name": $0.name, "sourceID": $0.sourceID.rawValue, "bytes": $0.bytes ] as [String: Any] }
        ] as [String: Any]
      },
      "settingsLoaded": model.settings != nil,
      "destination": model.destination?.path ?? NSNull(),
      "export": export,
      "peerTube": peerTube,
      "problem": model.problem ?? NSNull()
    ]
  }

  private static func name(_ track: Track) -> String {
    switch track {
    case .primary: "primary"
    case .camera(let sourceID): "camera:\(sourceID.rawValue)"
    }
  }

  private static func describe(_ state: TrackState) -> String {
    switch state {
    case .queued: "queued"
    case let .fetching(worker, received, total): "fetching(\(worker.rawValue)) \(received)/\(total)"
    case let .stitching(worker, fraction): String(format: "stitching(%@) %.2f", worker.rawValue, fraction)
    case let .downloading(received, total): "downloading \(received)/\(total)"
    case .done(let url): "done \(url.path)"
    case .failed(let reason): "failed \(reason)"
    }
  }

  private static func describe(_ state: UploadState) -> String {
    switch state {
    case .queued: "queued"
    case let .uploading(sent, total): "uploading \(sent)/\(total)"
    case .done(let page): "done \(page?.absoluteString ?? "")"
    case .failed(let reason): "failed \(reason)"
    }
  }
}
#endif
