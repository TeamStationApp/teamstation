#if DEBUG
import DirectorCore
import Distribution
import DistributorWire
import Foundation
import Network

/// Debug builds only, and only when launched with `-harness`: a loopback server on port 8768 so a
/// script can drive and check the app without seeing the screen. Like the Director's and
/// Cameraman's harnesses, it is never in a release. Add `-noIPad` to keep the app off the cable.
///
///   /dump-state                          what the window is showing, and the export under way
///   /set-destination?path=/some/folder   this Mac's download folder, saved here and on the iPad
///   /clear-destination                   forget it again
///   /export?recording=361&tracks=primary,camera:<source id>[&reprocess=1][&combined=1[&audio=<name>]]
///          [&upload=primary,camera:<name>,combined&game=<game id>[&title=<title>]]
///   /inventory?recording=361             which of its files are already on this Mac
///   /cancel                              stop the export under way
///   /dismiss-export                      put a finished export's progress away, as Done does
///   /games                               the TeamStation account, and the games an upload can name
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

  /// `-noIPad`: the Distributor never looks at the cable, as if no iPad were attached.
  static var ignoresCable: Bool {
    ProcessInfo.processInfo.arguments.contains("-noIPad")
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
    case "/inventory":
      guard let id = query["recording"].flatMap(Int64.init),
            let recording = model.recordings.first(where: { $0.id == id }),
            let inventory = model.inventory(of: recording)
      else { return [ "ok": false, "error": "unknown recording, or no folder chosen" ] }
      var files: [String: String] = [:]
      for (track, state) in inventory.files {
        switch track {
        case .primary: files["primary"] = "\(state)"
        case .camera(let sourceID): files["camera:\(sourceID.rawValue)"] = "\(state)"
        }
      }
      return [
        "ok": true,
        "files": files,
        "combined": "\(inventory.combined)",
        "allOnMac": !inventory.needsIPad(Array(inventory.files.keys))
      ]
    case "/cancel":
      model.batch?.cancel()
      return [ "ok": model.batch?.wasCancelled ?? false ]
    case "/dismiss-export":
      // As Done does. AppKit will not quit while the progress sheet is up.
      model.dismissRun()
      return [ "ok": model.batch == nil ]
    case "/games":
      await model.teamStation.refreshFinishedEvents()
      return [
        "ok": model.teamStation.isSignedIn,
        "account": model.teamStation.user?.email ?? NSNull(),
        "games": model.teamStation.finishedEvents.map { [ "id": $0.gameId, "title": $0.title ] }
      ]
    case "/export":
      guard let id = query["recording"].flatMap(Int64.init),
            let recording = model.recordings.first(where: { $0.id == id })
      else { return [ "ok": false, "error": "no such recording" ] }
      let tracks: [Track] = (query["tracks"] ?? "").split(separator: ",").compactMap { item in
        if item == "primary" { return .primary }
        if item.hasPrefix("camera:") { return .camera(SourceID(String(item.dropFirst("camera:".count)))) }
        return nil
      }
      // `combined=1` puts every file of the export the combined video can take in (up to four, the
      // primary output first), placed as the saved layout places them.
      var plan: CombinedPlan?
      if query["combined"] == "1" {
        // curl's --data-urlencode sends spaces as `+`.
        let audio = query["audio"].map { $0.replacingOccurrences(of: "+", with: " ") }
        plan = CombinedPlan.automatic(for: recording, tracks: tracks, saved: model.settings.combinedLayout, audioCamera: audio)
      }
      // `upload=primary,camera:<name>,combined&game=<id>` sends those files to
      // that game, as the sheet would. The title is the game's own unless one
      // is given; `/games` lists the ids.
      var upload: TeamStationPlan?
      if let list = query["upload"], !list.isEmpty {
        let wanted: [UploadTrack] = list.split(separator: ",").compactMap { item in
          if item == "primary" { return .primary }
          if item == "combined" { return .combined }
          if item.hasPrefix("camera:") { return .camera(String(item.dropFirst("camera:".count))) }
          return nil
        }
        await model.teamStation.refreshFinishedEvents()
        guard let gameId = query["game"],
              let game = model.teamStation.finishedEvents.first(where: { $0.gameId == gameId })
        else { return [ "ok": false, "error": "game=<id> required; /games lists them" ] }
        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        upload = model.teamStationPlan(
          gameId: gameId,
          title: query["title"] ?? "\(day.string(from: game.startAt)) \(game.title)",
          tracks: wanted,
          startedAt: recording.startedAt.date
        )
      }
      model.export(recording, tracks: tracks, reprocess: query["reprocess"] == "1", combined: plan, teamStation: upload)
      return [ "ok": model.batch != nil ]
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
    if let batch = model.batch {
      export = [
        "step": batch.step.rawValue,
        "isDoneWithIPad": batch.isDoneWithIPad,
        "isFinished": batch.isFinished,
        "takes": batch.runs.map(Self.describe)
      ] as [String: Any]
    }
    let teamStation = model.teamStation.user.map { "signedIn \($0.email ?? $0.displayName)" } ?? "signedOut"
    return [
      "link": link,
      "isRecording": model.isRecording,
      "isStreaming": model.isStreaming,
      "devices": model.devices.map { [ "serial": $0.serial, "deviceID": $0.deviceID ] },
      "recordings": model.recordings.map { recording in
        [
          "id": recording.id,
          "isLive": recording.isLive,
          "hasPrimary": recording.hasPrimary,
          "cameras": recording.cameras.map { [ "name": $0.name, "sourceID": $0.sourceID.rawValue, "bytes": $0.bytes ] as [String: Any] }
        ] as [String: Any]
      },
      "destination": model.destination?.path ?? NSNull(),
      "export": export,
      "teamStation": teamStation,
      "problem": model.problem ?? NSNull()
    ]
  }

  /// One recording of the export under way.
  private static func describe(_ run: DistributionRun) -> [String: Any] {
    [
      "recording": run.recording.id,
      "folder": run.folder.path,
      "isFinished": run.isFinished,
      "tracks": run.tracks.map { track -> [String: Any] in
        [
          "track": Self.name(track),
          "state": Self.describe(run.states[track] ?? .queued),
        ]
      },
      "combined": run.combinedState.map { Self.describe($0) } ?? NSNull(),
      "combinedSound": run.combinedSound ?? NSNull(),
      "uploads": (run.teamStation?.tracks ?? []).map { track -> [String: Any] in
        [
          "title": run.teamStation?.title(for: track) ?? "",
          "state": Self.describe(run.uploadStates[track] ?? .queued)
        ]
      }
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
    case let .fetching(received, total): "fetching \(received)/\(total)"
    case .fetched: "fetched"
    case let .stitching(fraction): String(format: "stitching %.2f", fraction)
    case let .downloading(received, total): "downloading \(received)/\(total)"
    case .done(let url): "done \(url.path)"
    case .failed(let reason): "failed \(reason)"
    }
  }

  private static func describe(_ state: UploadState) -> String {
    switch state {
    case .queued: "queued"
    case let .uploading(sent, total): "uploading \(sent)/\(total)"
    case .finishing(let step): "finishing \(step)"
    case .done: "done"
    case .failed(let reason): "failed \(reason)"
    }
  }
}
#endif
