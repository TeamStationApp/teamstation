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
  /// `2026-09-20 Mission Trails at Bandits`; each file adds what it is.
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

  /// The recording's files this upload sends as they are. The combined video is not among them:
  /// what it is made from is the combined plan's to say.
  public func files(of recording: RecordingListing) -> [Track] {
    tracks.compactMap { track in
      switch track {
      case .primary: recording.hasPrimary ? .primary : nil
      case .camera(let name): recording.cameras.first { $0.name == name }.map { .camera($0.sourceID) }
      case .combined: nil
      }
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

  /// The files it is made from.
  public var tracks: [Track] { inputs.map(\.track) }
}

/// Where one file of an export has got to.
public enum TrackState: Sendable, Equatable {
  case queued
  case fetching(received: Int64, total: Int64)
  /// Everything it is stitched from is on this Mac, waiting its turn to be stitched.
  case fetched
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
///
/// In three steps, each started only once the one before is over: everything the export needs
/// comes off the iPad, then the Mac stitches the files and makes the combined video, then the
/// uploads go. TS Director is held off recording only for the first, and the rest need only this
/// Mac, so the iPad can be unplugged as soon as the files are in without stopping the export.
///
/// The steps are driven by a `DistributionBatch`, which takes several recordings through each step
/// together; `run()` is a batch of this one.
@MainActor
@Observable
public final class DistributionRun {
  public let recording: RecordingListing
  public let tracks: [Track]
  public private(set) var states: [Track: TrackState]
  public private(set) var isFinished = false
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
    let tracks = Self.tracks(of: recording, asked: tracks, combined: combined, teamStation: teamStation)
    self.tracks = tracks
    self.states = Dictionary(uniqueKeysWithValues: tracks.map { ($0, TrackState.queued) })
  }

  /// Every file an export has to have on this Mac: the ones asked for, the ones its uploads send,
  /// and the ones its combined video is made from — so nothing is uploaded or combined short of a
  /// file that is still on the iPad. In the recording's order: the primary output, then its cameras.
  public nonisolated static func tracks(
    of recording: RecordingListing,
    asked: [Track],
    combined: CombinedPlan?,
    teamStation: TeamStationPlan?
  ) -> [Track] {
    let wanted = Set(asked + (combined?.tracks ?? []) + (teamStation?.files(of: recording) ?? []))
    let every = (recording.hasPrimary ? [ Track.primary ] : []) + recording.cameras.map { Track.camera($0.sourceID) }
    // A track the recording does not list stays at the end rather than go missing.
    return every.filter(wanted.contains) + asked.filter { !every.contains($0) }
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
  /// How often a run of this export alone renews the export lock.
  private let lockRenewal: Duration
  /// Asked, by a run of this export alone, before it writes anything.
  private let spaceCheck: SpaceCheck
  /// The batch driving this export's steps, once it runs.
  weak var batch: DistributionBatch?

  /// The files still to stitch from segments, and the files the iPad already stitched, as
  /// `prepare()` sorted them.
  private var toStitch: [Track] = []
  private var toFetch: [Track] = []
  /// Where this take's segments are kept: they wait there between coming off the iPad and being
  /// stitched, and stay, so a file can be stitched again with no iPad (see `KeptSegments`).
  private var segments: URL?
  /// The tracks whose segments are on this Mac, waiting to be stitched, and the window every file
  /// is cut to.
  private var fetched: [MacStitcher.Fetched] = []
  private var window: ExportWindow?
  /// This export goes no further: something it needed from the iPad could not be had, or there is
  /// no room for it.
  private var stopped = false

  /// Exports this recording alone, in its three steps.
  public func run() async {
    await DistributionBatch(runs: [ self ], connection: connection, lockRenewal: lockRenewal, spaceCheck: spaceCheck).run()
  }

  /// Stops the export: stitching, downloads and uploads, and every other export of its batch. Files
  /// already saved stay, and a download stopped part way resumes next time.
  public func cancel() {
    if let batch {
      batch.cancel()
    } else {
      stop()
    }
  }

  /// Stops this export's own work; the batch stops the step it is in.
  func stop() {
    guard !isFinished, !wasCancelled else { return }
    wasCancelled = true
    for download in downloads { download.cancel() }
  }

  /// The export is over. `cancelled` says why, when it was stopped before the end.
  func finish(cancelled reason: String?) {
    // Segments a fetch did not finish go; whole ones stay, cancelled or not.
    if let segments { KeptSegments.removeIncomplete(in: segments) }
    if let reason {
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
    isFinished = true
  }

  // MARK: - Steps

  /// Makes the export's folder and sorts its files: already here, which need nothing; with their
  /// segments kept here, which are stitched from them; already stitched on the iPad, which need only
  /// fetching; and the rest, stitched here from segments off the iPad.
  func prepare() {
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    } catch {
      for track in tracks { states[track] = .failed("\(error)") }
      stopped = true
      return
    }
    // Beside the files, on the disk they are saved to, so that disk is the only one that needs the
    // room and a stitched file is saved by renaming it.
    let segments = KeptSegments.folder(for: recording, in: destination)
    self.segments = segments
    KeptSegments.removeIncomplete(in: segments)
    for track in tracks {
      let target = folder.appendingPathComponent(filename(for: track))
      if !reprocess, Self.size(of: target) > 0 {
        states[track] = .done(target)
      } else if let kept = KeptSegments.fetched(track, in: segments) {
        fetched.append(kept)
        states[track] = .fetched
      } else if !reprocess, recording.preparedTracks.contains(track) {
        toFetch.append(track)
      } else {
        toStitch.append(track)
      }
    }
  }

  /// Whether anything of this export has to come from the iPad.
  var needsIPad: Bool { !stopped && !(toStitch.isEmpty && toFetch.isEmpty) }

  /// What has to come from the iPad cannot, for `reason`, so the export goes no further.
  func stop(fetching reason: String) {
    for track in toStitch + toFetch { states[track] = .failed(reason) }
    if combinedState != nil { combinedState = .failed(reason) }
    stopped = true
  }

  /// No iPad is attached, so what would come from it fails; what is here is still combined and
  /// uploaded as far as it goes.
  func failWithoutIPad() {
    for track in toStitch + toFetch { states[track] = .failed(Self.noIPad) }
  }

  /// The room this export needs on the disk its files go to.
  struct Need {
    /// What each file it fetches comes to.
    var trackBytes: [Int64] = []
    var combinedBytes: Int64 = 0
  }

  /// With TS Director's export lock held: the window every file is cut to, from the iPad, and the
  /// room the export needs. Nil when the export stops here. An iPad that cannot say how large the
  /// files are is not a reason to stop, so that needs no room.
  func measure(connection: DirectorConnection) async -> Need? {
    guard needsIPad, let segments else { return nil }
    let window: ExportWindow
    do {
      try FileManager.default.createDirectory(at: segments, withIntermediateDirectories: true)
      window = try await connection.manifest(recordingID: recording.id, tracks: []).window
    } catch {
      // A cancelled export's requests fail too; the cancellation says why, not the request.
      if !wasCancelled {
        for track in toStitch + toFetch { states[track] = .failed("\(error)") }
      }
      stopped = true
      return nil
    }
    self.window = window
    guard let manifest = try? await connection.manifest(recordingID: recording.id, tracks: toStitch + toFetch) else {
      return Need()
    }
    let combinedBytes = combined.map {
      ExportSpace.combinedBytes(seconds: (window.end ?? window.start).seconds - window.start.seconds, cameras: $0.inputs.count)
    } ?? 0
    return Need(trackBytes: ExportSpace.bytesPerTrack(manifest.files), combinedBytes: combinedBytes)
  }

  /// With TS Director's export lock held: the segments of every file still to stitch and the
  /// iPad's own files, onto this Mac. The iPad's own files download beside the segments, one
  /// camera's segments at a time.
  func fetch(connection: DirectorConnection) async {
    guard needsIPad, window != nil, let segments else { return }
    for track in toFetch { fetchPrepared(track, from: connection) }
    let stitcher = MacStitcher(connection: connection, scratch: segments)
    for track in toStitch {
      guard !Task.isCancelled else { break }
      do {
        let root = KeptSegments.folder(for: track, in: segments)
        fetched.append(try await stitcher.fetch(recording: recording, track: track, into: root) { received, total in
          Task { @MainActor in
            // A late report never takes a fetched track back to fetching.
            switch self.states[track] {
            case .queued, .fetching: self.states[track] = .fetching(received: received, total: total)
            default: break
            }
          }
        })
        states[track] = .fetched
      } catch {
        if !wasCancelled { states[track] = .failed("\(error)") }
      }
    }
    for download in downloads { await download.value }
  }

  /// With every file already here, whether the combined video still to be made fits; when it does
  /// not, the export goes no further. Its length comes from a saved file, since the iPad is not
  /// asked.
  func checkRoomForCombined(_ spaceCheck: SpaceCheck) async {
    guard !stopped, !needsIPad, let combined,
          Self.size(of: folder.appendingPathComponent(combinedFilename)) == 0,
          let first = combined.inputs.first, case .done(let url) = states[first.track],
          let length = try? await AVURLAsset(url: url).load(.duration).seconds
    else { return }
    let shortfall = spaceCheck.shortfall(
      trackBytes: [],
      combinedBytes: ExportSpace.combinedBytes(seconds: length, cameras: combined.inputs.count),
      destination: folder,
      scratch: FileManager.default.temporaryDirectory
    )
    if let shortfall {
      combinedState = .failed(shortfall)
      stopped = true
    }
  }

  /// Stitches what came off the iPad, and what was kept from before, on this Mac alone. Every file
  /// is cut to one window: the iPad's for this export, or with nothing asked of the iPad, the one
  /// the kept segments were fetched with.
  func stitch() async {
    guard !stopped, !wasCancelled, let window = window ?? fetched.first?.response.window else { return }
    await stitchAll(fetched, window: window)
  }

  /// Makes the combined video, when one was asked for, from the saved files.
  func makeCombined() async {
    guard !stopped, !wasCancelled, let combined else { return }
    await renderCombined(combined)
  }

  /// Sends what was asked for to TeamStation.
  func upload() async {
    guard !stopped, !wasCancelled, let teamStation else { return }
    await uploadAllToTeamStation(teamStation)
  }

  /// What the name of a work folder an older export used starts with. Hidden, so it is never taken
  /// for one of the files.
  nonisolated static let workPrefix = ".tsDistributor-work-"

  nonisolated static func removeWorkFolders(in folder: URL) {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    for name in names where name.hasPrefix(workPrefix) {
      try? FileManager.default.removeItem(at: folder.appendingPathComponent(name, isDirectory: true))
    }
  }

  /// Why a file the iPad would have to provide was not made.
  public nonisolated static let noIPad = "Not on this Mac, and no iPad is attached to get it from"

  /// Stitches each fetched track from what is already on this Mac, and saves it under its name.
  private func stitchAll(_ fetched: [MacStitcher.Fetched], window: ExportWindow) async {
    var plan = DistributionPlan(tracks: fetched.map(\.track))
    while !Task.isCancelled, let track = plan.next() {
      guard let work = fetched.first(where: { $0.track == track }) else { continue }
      states[track] = .stitching(fraction: 0)
      do {
        let stitched = try await MacStitcher.stitch(work, recording: recording, window: window) { fraction in
          Task { @MainActor in
            if case .stitching = self.states[track] { self.states[track] = .stitching(fraction: fraction) }
          }
        }
        let target = folder.appendingPathComponent(filename(for: track))
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: stitched, to: target)
        states[track] = .done(target)
      } catch {
        if !wasCancelled { states[track] = .failed("\(error)") }
      }
      plan.finish(track)
    }
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

  // MARK: - Downloads

  private func fetchPrepared(_ track: Track, from connection: DirectorConnection) {
    let path = "rec-\(recording.id)/\(filename(for: track))"
    let file = RemoteFile(root: .prepared, path: path, bytes: 0)
    let target = folder.appendingPathComponent(filename(for: track))
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
