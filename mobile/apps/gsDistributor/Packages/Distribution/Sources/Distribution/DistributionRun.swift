import AVFoundation
import CombinedVideo
import DirectorClient
import DirectorCore
import DirectorExport
import DistributorWire
import Foundation
import Observation
import PeerTubeKit

/// What goes to PeerTube once an export's files are saved, one video per file.
public struct UploadPlan: Sendable {
  public var host: String
  public var channelID: Int
  public var privacy: Int
  /// What the title field held: the recording's date and what the user typed, unless they changed it.
  public var title: String
  public var tracks: [UploadTrack]
  /// An access token good for a while yet; asked for before every chunk.
  public var token: @Sendable () async throws -> String

  public init(
    host: String,
    channelID: Int,
    privacy: Int,
    title: String,
    tracks: [UploadTrack],
    token: @escaping @Sendable () async throws -> String
  ) {
    self.host = host
    self.channelID = channelID
    self.privacy = privacy
    self.title = title
    self.tracks = tracks
    self.token = token
  }

  public func title(for track: UploadTrack) -> String {
    PeerTubeTitle.make(title: title, track: track)
  }
}

public enum UploadState: Sendable, Equatable {
  case queued
  case uploading(sent: Int64, total: Int64)
  /// Uploaded; the video's page, when PeerTube said where it is.
  case done(URL?)
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
  case fetching(worker: DistributionPlan.Worker, received: Int64, total: Int64)
  case stitching(worker: DistributionPlan.Worker, fraction: Double)
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

/// One export of one recording: the chosen tracks, stitched by the Mac and the iPad together and
/// saved into `<destination>/<yyyy-MM-dd>/` under the names GS Director gives them.
@MainActor
@Observable
public final class DistributionRun {
  public let recording: RecordingListing
  public let tracks: [Track]
  public private(set) var states: [Track: TrackState]
  public private(set) var isFinished = false
  /// Which worker stitched each track, for the record.
  public private(set) var stitchedBy: [Track: DistributionPlan.Worker] = [:]
  /// The combined video, when one was asked for.
  public let combined: CombinedPlan?
  public private(set) var combinedState: TrackState?
  /// Whose sound the combined video carries, once it is being made.
  public private(set) var combinedSound: String?
  /// The uploads, when any were asked for.
  public let upload: UploadPlan?
  public private(set) var uploadStates: [UploadTrack: UploadState] = [:]

  /// Nil with no iPad attached, which is enough when every file the run needs is already here.
  private let connection: DirectorConnection?
  private let jobs: JobWatcher
  private let destination: URL
  private let reprocess: Bool
  private let iPadMayStitch: @MainActor () -> Bool
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
    upload: UploadPlan? = nil,
    lockRenewal: Duration = .seconds(10),
    spaceCheck: SpaceCheck = .system,
    iPadMayStitch: @escaping @MainActor () -> Bool
  ) {
    self.lockRenewal = lockRenewal
    self.spaceCheck = spaceCheck
    self.recording = recording
    self.tracks = tracks
    self.combined = combined
    self.combinedState = combined == nil ? nil : .queued
    self.upload = upload
    self.uploadStates = Dictionary(uniqueKeysWithValues: (upload?.tracks ?? []).map { ($0, UploadState.queued) })
    self.connection = connection
    self.jobs = jobs
    self.destination = destination
    self.reprocess = reprocess
    self.iPadMayStitch = iPadMayStitch
    self.states = Dictionary(uniqueKeysWithValues: tracks.map { ($0, TrackState.queued) })
  }

  /// The folder this export's files go in.
  public var folder: URL { Self.folder(for: recording, in: destination) }

  /// The name GS Director gives `track`'s file, which is also the name it gets here.
  public func filename(for track: Track) -> String { Self.filename(for: track, of: recording) }

  /// `<destination>/<yyyy-MM-dd>/`, where `recording`'s files go.
  public nonisolated static func folder(for recording: RecordingListing, in destination: URL) -> URL {
    destination.appendingPathComponent(PeerTubeTitle.datePrefix(for: recording.startedAt.date), isDirectory: true)
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
  /// How often the export lock is renewed. GS Director drops one left unrenewed for half a minute.
  private let lockRenewal: Duration
  /// Asked before the export writes anything.
  private let spaceCheck: SpaceCheck
  /// GS Director dropped the export lock, so it may record or stream at any moment.
  private var lostLock = false

  /// This Mac stopped renewing the lock for long enough that GS Director dropped it (a Mac that was
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
    let reason = lostLock ? "Stopped: GS Director no longer held off recording" : "Cancelled"
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
      // iPad is asked for nothing, and this runs while GS Director records or streams.
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
    if let upload, !wasCancelled { await uploadAll(upload) }
  }

  /// Why a file the iPad would have to provide was not made.
  public nonisolated static let noIPad = "Not on this Mac, and no iPad is attached to get it from"

  /// Stitches `toStitch` on the Mac and the iPad and fetches `toFetch` from the iPad, holding GS
  /// Director's export lock throughout. False when the export stops here.
  private func workWithIPad(toStitch: [Track], toFetch: [Track], connection: DirectorConnection) async -> Bool {
    let needed = toStitch + toFetch
    let scratch = FileManager.default.temporaryDirectory
      .appendingPathComponent("gsDistributor-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: scratch) }

    // GS Director records and streams nothing while the export works with the iPad, and grants
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
    // Renewed while the export works with the iPad: GS Director drops a lock left unrenewed, so a
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
    // the request, and GS Director would stay locked until the lease ran out.
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

    // First to the Mac, second to the iPad, then whichever is free first.
    let mac = MacStitcher(connection: connection, scratch: scratch)
    let iPad = IPadStitcher(connection: connection, jobs: jobs)
    let firstForMac = plan.next(for: .mac)
    let firstForIPad = iPadMayStitch() ? plan.next(for: .iPad) : nil
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.macLoop(mac, first: firstForMac, window: window) }
      group.addTask { await self.iPadLoop(iPad, first: firstForIPad, window: window) }
    }
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

  /// One file at a time, in the order asked. A file that did not save is not uploaded. Each video's
  /// original publication date is when its recording started, which is where every file of the
  /// export starts, so highlights can be timed from the video alone.
  private func uploadAll(_ plan: UploadPlan) async {
    let api = PeerTubeAPI(host: plan.host)
    for track in plan.tracks {
      guard !Task.isCancelled else { return }
      guard let file = savedFile(for: track) else {
        uploadStates[track] = .failed("not saved, so not uploaded")
        continue
      }
      uploadStates[track] = .uploading(sent: 0, total: Self.size(of: file))
      do {
        let video = try await api.upload(
          file: file,
          name: plan.title(for: track),
          channelID: plan.channelID,
          privacy: plan.privacy,
          originallyPublishedAt: recording.startedAt.date,
          token: plan.token
        ) { sent, total in
          Task { @MainActor in
            if case .uploading = self.uploadStates[track] { self.uploadStates[track] = .uploading(sent: sent, total: total) }
          }
        }
        uploadStates[track] = .done(video.shortUUID.flatMap { URL(string: "https://\(plan.host)/w/\($0)") })
      } catch {
        uploadStates[track] = .failed("\(error)")
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
    combinedState = .stitching(worker: .mac, fraction: 0)
    do {
      try await CombinedRenderer.render(
        inputs: inputs,
        audioFrom: sound?.url,
        bitsPerSecond: CombinedLayoutRules.bitsPerSecond(cameraCount: inputs.count),
        frameRate: Int32(max(1, rate.rounded())),
        to: partial
      ) { fraction in
        Task { @MainActor in self.combinedState = .stitching(worker: .mac, fraction: fraction) }
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
      if track == nil { track = plan.next(for: .mac) }
      guard let current = track else {
        // The iPad may yet hand a track back; wait while it still holds any.
        if plan.held(by: .iPad).isEmpty { return }
        try? await Task.sleep(for: .milliseconds(200))
        continue
      }
      track = nil
      do {
        let stitched = try await stitcher.stitch(recording: recording, track: current, window: window) { stage in
          Task { @MainActor in
            switch stage {
            case let .fetching(received, total):
              self.states[current] = .fetching(worker: .mac, received: received, total: total)
            case let .stitching(fraction):
              self.states[current] = .stitching(worker: .mac, fraction: fraction)
            }
          }
        }
        let target = folder.appendingPathComponent(filename(for: current))
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: stitched, to: target)
        // The segments it was stitched from go now rather than at the end of the export, so the
        // Mac holds one camera's working copy at a time.
        if let work = stitcher.workFolder(of: stitched) { try? FileManager.default.removeItem(at: work) }
        stitchedBy[current] = .mac
        states[current] = .done(target)
      } catch {
        if !wasCancelled { states[current] = .failed("\(error)") }
      }
      plan.finish(current)
    }
  }

  private func iPadLoop(_ stitcher: IPadStitcher, first: Track?, window: ExportWindow) async {
    var track = first
    while !Task.isCancelled {
      if track == nil {
        guard iPadMayStitch() else { return }
        track = plan.next(for: .iPad)
      }
      guard let current = track else { return }
      track = nil
      do {
        let file = try await stitcher.stitch(
          recording: recording,
          track: current,
          window: window,
          reprocess: reprocess
        ) { fraction in
          Task { @MainActor in self.states[current] = .stitching(worker: .iPad, fraction: fraction) }
        }
        stitchedBy[current] = .iPad
        plan.finish(current)
        // Free for the next track at once; the download goes on alongside.
        fetch(file, for: current)
      } catch let DirectorClientError.http(status, _) where status == 409 {
        // Recording started: the iPad takes nothing more, and the Mac does this one.
        plan.giveBack(current)
        states[current] = .queued
        return
      } catch {
        plan.giveBack(current)
        states[current] = .queued
        if case DistributionError.directorGone = error { return }
      }
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
