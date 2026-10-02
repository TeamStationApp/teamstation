import AVFoundation
import CombinedVideo
import DirectorClient
import DirectorCore
import DirectorExport
import DistributorWire
import Foundation
import Observation

/// What goes to TeamStation once an export's files are saved, one video per
/// file, all on the same game.
///
/// The sending itself is handed in rather than done here: it is
/// `UploadService` in `TeamStationKit`, which TS Director uses for exactly the
/// same job. One implementation of "send a recording in parts, ask what landed,
/// carry on where it stopped" — two apps calling it — because two of them
/// would drift, and the half that drifted would be the resume.
public struct TeamStationPlan: Sendable {
  /// The game every file of this export belongs to.
  public var gameId: String
  /// `2026-09-20 Monument Trails at Badgers`; each file adds what it is.
  public var title: String
  public var tracks: [UploadTrack]
  /// Sends one file and answers with the video it became.
  public var send: @Sendable (
    _ file: URL,
    _ title: String,
    _ kind: String,
    _ progress: @escaping @Sendable (Int64, Int64, String?) -> Void
  ) async throws -> String

  public init(
    gameId: String,
    title: String,
    tracks: [UploadTrack],
    send: @escaping @Sendable (URL, String, String, @escaping @Sendable (Int64, Int64, String?) -> Void) async throws -> String
  ) {
    self.gameId = gameId
    self.title = title
    self.tracks = tracks
    self.send = send
  }

  /// What one file is called in the library: the take's title and the camera.
  public func title(for track: UploadTrack) -> String {
    switch track {
    case .primary: title
    case .camera(let name): "\(title) \(name)"
    case .combined: "\(title) combined"
    }
  }

  /// The slot the server files it under.
  public func kind(for track: UploadTrack) -> String {
    switch track {
    case .primary: "program"
    case .camera(let name): name
    case .combined: "combined"
    }
  }
}

public enum UploadState: Sendable, Equatable {
  case queued
  case uploading(sent: Int64, total: Int64)
  /// Every byte is there and the server is turning it into a video —
  /// assembling, converting, copying to the library. Minutes, for a
  /// two-hour take, which is why it is a state of its own rather than a
  /// progress bar left sitting at full.
  case finishing(step: String)
  case done
  case failed(String)
}

/// The combined video to make once the export's files are in: which of them go in (cameras, and
/// the primary output when it is chosen), where each goes on the 4K canvas, and whose sound it
/// carries.
public struct CombinedPlan: Sendable {
  /// Each video by the name the layout knows it by, and the file of the export it comes from.
  public var inputs: [(name: String, track: Track)]
  public var frames: [String: CGRect]
  public var audioCamera: String?

  public init(inputs: [(name: String, track: Track)], frames: [String: CGRect], audioCamera: String?) {
    self.inputs = inputs
    self.frames = frames
    self.audioCamera = audioCamera
  }
}

/// Where one file of an export has got to.
public enum TrackState: Sendable, Equatable {
  case queued
  case fetching(received: Int64, total: Int64)
  case stitching(fraction: Double)
  case downloading(received: Int64, total: Int64)
  case done(URL)
  case failed(String)

  public var isFinal: Bool {
    switch self {
    case .done, .failed: true
    default: false
    }
  }
}

/// One export of one recording: the chosen tracks, stitched on the Mac and
/// saved into `<destination>/<yyyy-MM-dd>/` under the names TS Director gives them.
@MainActor
@Observable
public final class DistributionRun {
  public let recording: RecordingListing
  public let tracks: [Track]
  public private(set) var states: [Track: TrackState]
  public private(set) var isFinished = false
  /// Which worker stitched each track, for the record.
  /// The combined video, when one was asked for.
  public let combined: CombinedPlan?
  public private(set) var combinedState: TrackState?
  /// Whose sound the combined video carries, once it is being made.
  public private(set) var combinedSound: String?
  /// The uploads, when any were asked for.
  public let teamStation: TeamStationPlan?
  public private(set) var uploadStates: [UploadTrack: UploadState] = [:]

  /// Nil with no iPad attached, which is enough when every file the run needs is already here.
  private let connection: DirectorConnection?
  private let jobs: JobWatcher
  private let destination: URL
  private let reprocess: Bool
  private var plan = DistributionPlan(tracks: [])
  private var downloads: [Task<Void, Never>] = []

  public init(
    recording: RecordingListing,
    tracks: [Track],
    connection: DirectorConnection?,
    jobs: JobWatcher,
    destination: URL,
    reprocess: Bool = false,
    combined: CombinedPlan? = nil,
    teamStation: TeamStationPlan? = nil,
    lockRenewal: Duration = .seconds(10),
    spaceCheck: SpaceCheck = .system,
  ) {
    self.lockRenewal = lockRenewal
    self.spaceCheck = spaceCheck
    self.recording = recording
    self.tracks = tracks
    self.combined = combined
    self.combinedState = combined == nil ? nil : .queued
    self.teamStation = teamStation
    self.uploadStates = Dictionary(
      uniqueKeysWithValues: (teamStation?.tracks ?? []).map { ($0, UploadState.queued) }
    )
    self.connection = connection
    self.jobs = jobs
    self.destination = destination
    self.reprocess = reprocess
    self.states = Dictionary(uniqueKeysWithValues: tracks.map { ($0, TrackState.queued) })
  }

  /// The folder this export's files go in.
  public var folder: URL { Self.folder(for: recording, in: destination) }

  /// The name TS Director gives `track`'s file, which is also the name it gets here.
  public func filename(for track: Track) -> String { Self.filename(for: track, of: recording) }

  /// `<destination>/<yyyy-MM-dd>/`, where `recording`'s files go.
  public nonisolated static func folder(for recording: RecordingListing, in destination: URL) -> URL {
    destination.appendingPathComponent(UploadTitle.datePrefix(for: recording.startedAt.date), isDirectory: true)
  }

  public nonisolated static func filename(for track: Track, of recording: RecordingListing) -> String {
    switch track {
    case .primary:
      return RecordingExport.programFilename(startedAt: recording.startedAt)
    case .camera(let sourceID):
      let name = recording.cameras.first { $0.sourceID == sourceID }?.name ?? sourceID.rawValue
      return RecordingExport.cameraFilename(startedAt: recording.startedAt, cameraName: name)
    }
  }

  /// True once `cancel()` was called.
  public private(set) var wasCancelled = false
  private var work: Task<Void, Never>?
  /// How often the export lock is renewed. TS Director drops one left unrenewed for half a minute.
  private let lockRenewal: Duration
  /// Asked before the export writes anything.
  private let spaceCheck: SpaceCheck
  /// TS Director dropped the export lock, so it may record or stream at any moment.
  private var lostLock = false

  /// This Mac stopped renewing the lock for long enough that TS Director dropped it (a Mac that was
  /// asleep or hung). The export stops rather than go on alongside a recording or a stream.
  private func lockLost() {
    guard !isFinished, !wasCancelled else { return }
    lostLock = true
    cancel()
  }

  public func run() async {
    // Work the user asked for: macOS neither naps the app nor lets the Mac idle to sleep while an
    // export runs, whether or not the window is in front.
    let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "Exporting a recording")
    defer { ProcessInfo.processInfo.endActivity(activity) }
    guard !wasCancelled else {
      markCancelled()
      isFinished = true
      return
    }
    let work = Task { await self.perform() }
    self.work = work
    await work.value
  }

  /// Stops the export: stitching on both sides, downloads and uploads. Files already saved stay,
  /// and a download stopped part way resumes next time.
  public func cancel() {
    guard !isFinished, !wasCancelled else { return }
    wasCancelled = true
    work?.cancel()
    for download in downloads { download.cancel() }
  }

  private func markCancelled() {
    let reason = lostLock ? "Stopped: TS Director no longer held off recording" : "Cancelled"
    for track in tracks where !(states[track]?.isFinal ?? false) {
      states[track] = .failed(reason)
    }
    if let state = combinedState, !state.isFinal { combinedState = .failed(reason) }
    for (track, state) in uploadStates {
      switch state {
      case .done, .failed: continue
      default: uploadStates[track] = .failed(reason)
      }
    }
  }

  private func perform() async {
    defer {
      if wasCancelled { markCancelled() }
      isFinished = true
    }
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    } catch {
      for track in tracks { states[track] = .failed("\(error)") }
      return
    }

    // Files already here need nothing; files already stitched on the iPad need only fetching.
    var toStitch: [Track] = []
    var toFetch: [Track] = []
    for track in tracks {
      let target = folder.appendingPathComponent(filename(for: track))
      if !reprocess, Self.size(of: target) > 0 {
        states[track] = .done(target)
      } else if !reprocess, recording.preparedTracks.contains(track) {
        toFetch.append(track)
      } else {
        toStitch.append(track)
      }
    }

    if toStitch.isEmpty && toFetch.isEmpty {
      // Every file is already here, so the combined video and the uploads need only this Mac: the
      // iPad is asked for nothing, and this runs while TS Director records or streams.
      if let shortfall = await roomForCombinedAlone() {
        combinedState = .failed(shortfall)
        return
      }
    } else if let connection {
      guard await workWithIPad(toStitch: toStitch, toFetch: toFetch, connection: connection) else { return }
    } else {
      // Nothing can come from an iPad that is not there; what is here is still combined and
      // uploaded as far as it goes.
      for track in toStitch + toFetch { states[track] = .failed(Self.noIPad) }
    }
    if let combined, !wasCancelled { await renderCombined(combined) }
    if let teamStation, !wasCancelled { await uploadAllToTeamStation(teamStation) }
  }

  /// Why a file the iPad would have to provide was not made.
  public nonisolated static let noIPad = "Not on this Mac, and no iPad is attached to get it from"

  /// Stitches `toStitch` on the Mac and fetches `toFetch` from the iPad, holding TS
  /// Director's export lock throughout. False when the export stops here.
  private func workWithIPad(toStitch: [Track], toFetch: [Track], connection: DirectorConnection) async -> Bool {
    let needed = toStitch + toFetch
    let scratch = FileManager.default.temporaryDirectory
      .appendingPathComponent("tsDistributor-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: scratch) }

    // TS Director records and streams nothing while the export works with the iPad, and grants
    // none of it while it does either. Handed back once every file is saved; the combined video and
    // the uploads need only this Mac.
    let lock: UUID
    do {
      lock = try await connection.beginExport()
    } catch {
      for track in needed { states[track] = .failed("\(error)") }
      if combinedState != nil { combinedState = .failed("\(error)") }
      return false
    }
    var released = false
    // Renewed while the export works with the iPad: TS Director drops a lock left unrenewed, so a
    // Mac that dies mid-export cannot keep it from recording.
    let every = lockRenewal
    let renewing = Task.detached { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: every)
        guard !Task.isCancelled else { return }
        // A refusal, not a failed request: the lock is gone, and the export must not go on.
        if let held = try? await connection.renewExport(lock), !held {
          await self?.lockLost()
          return
        }
      }
    }
    // Handed back from a task of its own: a cancelled export's task would have URLSession refuse
    // the request, and TS Director would stay locked until the lease ran out.
    func release() async {
      guard !released else { return }
      released = true
      renewing.cancel()
      await Task.detached { try? await connection.endExport(lock) }.value
    }
    defer {
      renewing.cancel()
      if !released { Task.detached { try? await connection.endExport(lock) } }
    }

    let window: ExportWindow
    do {
      try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
      window = try await connection.manifest(recordingID: recording.id, tracks: []).window
    } catch {
      // A cancelled export's requests fail too; the cancellation says why, not the request.
      if !wasCancelled {
        for track in needed { states[track] = .failed("\(error)") }
      }
      await release()
      return false
    }

    // Nothing is written until the whole export is known to fit.
    if let shortfall = await roomShortfall(for: needed, window: window, connection: connection) {
      for track in needed { states[track] = .failed(shortfall) }
      if combinedState != nil { combinedState = .failed(shortfall) }
      await release()
      return false
    }
    for track in toFetch { fetchPrepared(track) }
    plan = DistributionPlan(tracks: toStitch)

    // Every track, on the Mac.
    let mac = MacStitcher(connection: connection, scratch: scratch)
    await macLoop(mac, first: plan.next(), window: window)
    for download in downloads { await download.value }
    await release()
    return true
  }

  /// With every file already here, whether the combined video still to be made fits. Its length
  /// comes from a saved file, since the iPad is not asked.
  private func roomForCombinedAlone() async -> String? {
    guard let combined, Self.size(of: folder.appendingPathComponent(combinedFilename)) == 0,
          let first = combined.inputs.first, case .done(let url) = states[first.track],
          let length = try? await AVURLAsset(url: url).load(.duration).seconds
    else { return nil }
    return spaceCheck.shortfall(
      trackBytes: [],
      combinedBytes: ExportSpace.combinedBytes(seconds: length, cameras: combined.inputs.count),
      destination: folder,
      scratch: FileManager.default.temporaryDirectory
    )
  }

  /// Every saved file of this export, to one game on TeamStation.
  ///
  /// The primary output leads, so the game's own recording is the first thing
  /// to land and the live stream steps aside as early as it can. A file that
  /// fails stops the run: the rest belong to the same game, and sending three
  /// of four is a game that looks complete and is not.
  private func uploadAllToTeamStation(_ plan: TeamStationPlan) async {
    let ordered = plan.tracks.sorted { a, _ in a == .primary }
    for track in ordered {
      guard !Task.isCancelled else { return }
      guard let file = savedFile(for: track) else {
        uploadStates[track] = .failed("not saved, so not uploaded")
        continue
      }
      let total = Self.size(of: file)
      uploadStates[track] = .uploading(sent: 0, total: total)
      do {
        _ = try await plan.send(
          file,
          plan.title(for: track),
          plan.kind(for: track)
        ) { sent, of, step in
          Task { @MainActor in
            switch self.uploadStates[track] {
            case .uploading, .finishing:
              self.uploadStates[track] = step.map { UploadState.finishing(step: $0) }
                ?? .uploading(sent: sent, total: of)
            default:
              break
            }
          }
        }
        uploadStates[track] = .done
      } catch {
        uploadStates[track] = .failed("\(error)")
        return
      }
    }
  }

  /// Where this export saved `track`'s file, if it did.
  public func savedFile(for track: UploadTrack) -> URL? {
    let state: TrackState?
    switch track {
    case .primary:
      state = states[.primary]
    case .camera(let name):
      state = recording.cameras.first { $0.name == name }.flatMap { states[.camera($0.sourceID)] }
    case .combined:
      state = combinedState
    }
    if case .done(let url) = state { return url }
    return nil
  }

  /// Nil when the export fits on this Mac; otherwise why it does not. An iPad that cannot say how
  /// large the files are is not a reason to stop.
  private func roomShortfall(for work: [Track], window: ExportWindow, connection: DirectorConnection) async -> String? {
    var trackBytes: [Int64] = []
    if !work.isEmpty {
      guard let manifest = try? await connection.manifest(recordingID: recording.id, tracks: work) else { return nil }
      trackBytes = ExportSpace.bytesPerTrack(manifest.files)
    }
    let combinedBytes = combined.map {
      ExportSpace.combinedBytes(seconds: (window.end ?? window.start).seconds - window.start.seconds, cameras: $0.inputs.count)
    } ?? 0
    return spaceCheck.shortfall(
      trackBytes: trackBytes,
      combinedBytes: combinedBytes,
      destination: folder,
      scratch: FileManager.default.temporaryDirectory
    )
  }

  public var combinedFilename: String { Self.combinedFilename(of: recording) }

  /// `<stamp>-combined.mov`, beside the export's other files.
  public nonisolated static func combinedFilename(of recording: RecordingListing) -> String {
    RecordingExport.programFilename(startedAt: recording.startedAt)
      .replacingOccurrences(of: ".mov", with: "-combined.mov")
  }

  /// Every chosen camera at once, from the files this export just saved.
  private func renderCombined(_ plan: CombinedPlan) async {
    var inputs: [CombinedInput] = []
    for source in plan.inputs {
      guard case .done(let url) = states[source.track], let frame = plan.frames[source.name] else {
        combinedState = .failed("\(source.name) did not export, so there is no combined video")
        return
      }
      inputs.append(CombinedInput(camera: source.name, url: url, frame: frame))
    }
    let target = folder.appendingPathComponent(combinedFilename)
    if !reprocess, Self.size(of: target) > 0 {
      combinedState = .done(target)
      return
    }
    // The chosen file's sound; when it recorded none, the first file that has some, so the combined
    // video is never silent while one of its videos has sound.
    var sound = plan.audioCamera.flatMap { name in inputs.first { $0.camera == name } }
    if let chosen = sound, await !Self.hasSound(chosen.url) { sound = nil }
    if sound == nil {
      for input in inputs where await Self.hasSound(input.url) {
        sound = input
        break
      }
    }
    combinedSound = sound?.camera
    let rate = (try? await AVURLAsset(url: inputs[0].url).loadTracks(withMediaType: .video).first?.load(.nominalFrameRate)) ?? 30
    let partial = folder.appendingPathComponent(combinedFilename + ".partial.mov")
    combinedState = .stitching(fraction: 0)
    do {
      try await CombinedRenderer.render(
        inputs: inputs,
        audioFrom: sound?.url,
        bitsPerSecond: CombinedLayoutRules.bitsPerSecond(cameraCount: inputs.count),
        frameRate: Int32(max(1, rate.rounded())),
        to: partial
      ) { fraction in
        Task { @MainActor in self.combinedState = .stitching(fraction: fraction) }
      }
      try? FileManager.default.removeItem(at: target)
      try FileManager.default.moveItem(at: partial, to: target)
      combinedState = .done(target)
    } catch {
      try? FileManager.default.removeItem(at: partial)
      combinedState = .failed("\(error)")
    }
  }

  // MARK: - Workers

  private func macLoop(_ stitcher: MacStitcher, first: Track?, window: ExportWindow) async {
    var track = first
    while !Task.isCancelled {
      if track == nil { track = plan.next() }
      guard let current = track else { return }
      track = nil
      do {
        let stitched = try await stitcher.stitch(recording: recording, track: current, window: window) { stage in
          Task { @MainActor in
            switch stage {
            case let .fetching(received, total):
              self.states[current] = .fetching(received: received, total: total)
            case let .stitching(fraction):
              self.states[current] = .stitching(fraction: fraction)
            }
          }
        }
        let target = folder.appendingPathComponent(filename(for: current))
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: stitched, to: target)
        // The segments it was stitched from go now rather than at the end of the export, so the
        // Mac holds one camera's working copy at a time.
        if let work = stitcher.workFolder(of: stitched) { try? FileManager.default.removeItem(at: work) }
        states[current] = .done(target)
      } catch {
        if !wasCancelled { states[current] = .failed("\(error)") }
      }
      plan.finish(current)
    }
  }


  // MARK: - Downloads

  private func fetchPrepared(_ track: Track) {
    let path = "rec-\(recording.id)/\(filename(for: track))"
    fetch(RemoteFile(root: .prepared, path: path, bytes: 0), for: track)
  }

  private func fetch(_ file: RemoteFile, for track: Track) {
    let target = folder.appendingPathComponent(filename(for: track))
    guard let connection = self.connection else {
      states[track] = .failed(Self.noIPad)
      return
    }
    downloads.append(Task { [weak self] in
      do {
        try await connection.download(file, to: target) { received, total in
          Task { @MainActor in self?.states[track] = .downloading(received: received, total: total) }
        }
        self?.states[track] = .done(target)
      } catch {
        if self?.wasCancelled == false { self?.states[track] = .failed("\(error)") }
      }
    })
  }

  static func hasSound(_ url: URL) async -> Bool {
    (try? await AVURLAsset(url: url).loadTracks(withMediaType: .audio).isEmpty == false) ?? false
  }

  nonisolated static func size(of url: URL) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
  }
}
