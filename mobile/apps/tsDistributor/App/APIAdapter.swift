import DirectorCore
import Distribution
import DistributorAPI
import DistributorWire
import Foundation
import LoopbackHTTP
import TeamStationKit

/// Answers TS Distributor's REST API with the model the window uses, so what the API starts is what
/// the window would start, and the window shows it.
@MainActor
final class APIAdapter: DistributorActions {
  private let model: DistributorModel
  /// What `/api/v1/events` streams.
  let events = JSONEventHub<APIEvent>(encoder: .api)

  /// Each run's id, and the runs themselves for looking up by it. The last few are kept.
  private var runIDs: [ObjectIdentifier: UUID] = [:]
  private var runs: [(id: UUID, batch: DistributionBatch)] = []
  private static let runsKept = 20

  init(model: DistributorModel) {
    self.model = model
  }

  /// Streams the status whenever it changes, and once to each new listener, checking twice a second.
  func publishChanges() async {
    var last: APIStatus?
    var listeners = 0
    while !Task.isCancelled {
      let count = events.subscriberCount
      if count > 0 {
        let now = status()
        if now != last || count > listeners {
          events.publish(APIEvent(at: Date(), status: now))
          last = now
        }
      } else {
        last = nil
      }
      listeners = count
      try? await Task.sleep(for: .milliseconds(500))
    }
  }

  // MARK: - Status

  func status() -> APIStatus {
    APIStatus(
      iPad: iPad(),
      destination: model.destination?.path,
      run: model.batch.map(snapshot),
      teamStation: account()
    )
  }

  private func iPad() -> APIIPad {
    switch model.link {
    case .waitingForIPad:
      return APIIPad(state: "none", message: DistributorModel.noIPadNotice)
    case .waitingForDirector(let serial):
      let name = model.displayName(of: serial)
      return APIIPad(state: "waitingForDirector", name: name, message: "\(name) is attached, but TS Director is not answering. Open it and bring it to the front.")
    case .connected(let hello):
      return APIIPad(
        state: "attached",
        name: hello.deviceName,
        directorVersion: hello.directorVersion,
        isRecording: model.isRecording,
        isStreaming: model.isStreaming,
        message: model.exportBlockedReason
      )
    case .failed(let reason):
      return APIIPad(state: "failed", message: reason)
    }
  }

  // MARK: - Recordings

  /// The attached iPad's recordings, else the last list seen from one.
  private func listings() -> (source: String, iPadName: String?, savedAt: Date?, recordings: [RecordingListing]) {
    if case .connected(let hello) = model.link {
      return ("iPad", hello.deviceName, nil, model.recordings)
    }
    if let cached = model.state.cachedRecordings().first {
      return ("cache", cached.director.deviceName, cached.savedAt, cached.recordings)
    }
    return ("none", nil, nil, [])
  }

  private func listing(_ id: Int64) throws(HTTPError) -> RecordingListing {
    guard let recording = listings().recordings.first(where: { $0.id == id }) else {
      throw HTTPError.notFound("no recording \(id) on the iPad, or in the last list seen from it")
    }
    return recording
  }

  func recordings() -> APIRecordingList {
    let found = listings()
    return APIRecordingList(source: found.source, iPadName: found.iPadName, savedAt: found.savedAt, recordings: found.recordings.map(describe))
  }

  func recording(_ id: Int64) throws(HTTPError) -> APIRecording {
    describe(try listing(id))
  }

  private func describe(_ recording: RecordingListing) -> APIRecording {
    let inventory = model.inventory(of: recording)
    let folder = model.destination.map { DistributionRun.folder(for: recording, in: $0) }
    func file(_ track: Track, name: String) -> APIFile {
      let state = inventory?.files[track] ?? .missing
      return APIFile(
        track: Self.name(track),
        name: name,
        onMac: Self.word(state),
        bytesOnMac: Self.bytes(state),
        path: folder?.appendingPathComponent(DistributionRun.filename(for: track, of: recording)).path,
        preparedOnIPad: recording.preparedTracks.contains(track),
        segmentsOnMac: inventory?.segmentsOnMac.contains(track) ?? false
      )
    }
    var files: [APIFile] = []
    if recording.hasPrimary { files.append(file(.primary, name: CombinedLayoutRules.primaryOutputName)) }
    for camera in recording.cameras { files.append(file(.camera(camera.sourceID), name: camera.name)) }
    let combined = inventory?.combined ?? .missing
    return APIRecording(
      id: recording.id,
      startedAt: recording.startedAt.date,
      endedAt: recording.endedAt?.date,
      isLive: recording.isLive,
      files: files,
      combined: APIFile(
        track: "combined",
        name: "Combined video",
        onMac: Self.word(combined),
        bytesOnMac: Self.bytes(combined),
        path: folder?.appendingPathComponent(DistributionRun.combinedFilename(of: recording)).path,
        preparedOnIPad: false
      ),
      folder: folder?.path,
      gameId: recording.gameId,
      gameTitle: recording.gameTitle
    )
  }

  func still(recording id: Int64, track text: String, at seconds: Double) async throws(HTTPError) -> Data {
    let recording = try listing(id)
    guard model.connection != nil else { throw Self.noIPad }
    if let reason = model.exportBlockedReason { throw HTTPError(423, "directorBusy", reason) }
    let track = try Self.track(text, in: recording)
    let source: SourceID = switch track {
    case .primary: SourceID(DistributorProtocol.primaryStillCamera)
    case .camera(let sourceID): sourceID
    }
    guard let jpeg = await model.still(recordingID: recording.id, camera: source, at: seconds) else {
      throw HTTPError.notFound("the iPad has no picture of \(text) there")
    }
    return jpeg
  }

  func deleteRecordings(_ ids: [Int64]) async throws(HTTPError) -> [Int64] {
    guard let connection = model.connection else { throw Self.noIPad }
    do {
      let refused = try await connection.deleteRecordings(ids)
      await model.reload()
      return refused
    } catch {
      throw HTTPError(502, "iPadFailed", "the iPad did not delete them: \(error)")
    }
  }

  func deleteSegments(_ id: Int64) throws(HTTPError) -> APISegmentsDeleted {
    let recording = try listing(id)
    guard let destination = model.destination else {
      return APISegmentsDeleted(recording: id, removed: false, bytes: 0)
    }
    let removal: KeptSegments.Removal
    do {
      removal = try KeptSegments.remove(recording, in: destination, unlessUsedBy: model.batch)
    } catch {
      throw HTTPError(500, "removeFailed", "the segments could not be removed: \(error)")
    }
    switch removal {
    case .inUse:
      throw HTTPError(409, "segmentsInUse", "the run under way is exporting recording \(id); remove its segments once it finishes")
    case .none:
      return APISegmentsDeleted(recording: id, removed: false, bytes: 0)
    case .removed(let bytes):
      return APISegmentsDeleted(recording: id, removed: true, bytes: bytes)
    }
  }

  // MARK: - Runs

  /// Starts a run of one recording or several. Every take is worked out before any starts, so a
  /// request wrong about one starts nothing.
  func startRun(_ request: APIRunRequest) async throws(HTTPError) -> APIRun {
    var takes: [DistributorModel.ExportTake] = []
    for one in try request.perTake() {
      takes.append(try await take(one))
    }
    do {
      let batch = try model.startExport(takes, reprocess: request.reprocess ?? false)
      return snapshot(batch)
    } catch {
      throw httpError(for: error)
    }
  }

  /// What a request of one recording asks of it: the files, the combined video, and the uploads.
  ///
  /// A combined video is made only when the request asks for one, or, left to the settings, for an
  /// `export` when they make one (`createCombined`) and for an `upload` that sends one when they
  /// tick it (`upload.choice.combined`) and none is saved. `"combined": false` turns it off for
  /// either, and a `download` or `custom` run never makes one it was not asked for.
  private func take(_ request: APIRunRequest) async throws(HTTPError) -> DistributorModel.ExportTake {
    guard let recordingID = request.recording else { throw HTTPError.badRequest("recording is required") }
    let recording = try listing(recordingID)
    let kind = request.kind ?? .custom
    let everyFile = (recording.hasPrimary ? [ Track.primary ] : []) + recording.cameras.map { Track.camera($0.sourceID) }
    var tracks = try request.tracks.map { names throws(HTTPError) in try names.map { name throws(HTTPError) in try Self.track(name, in: recording) } } ?? everyFile

    var combined: CombinedPlan?
    var upload: TeamStationPlan?
    switch kind {
    case .download:
      break
    case .combined:
      guard request.combined?.wanted ?? true else {
        throw HTTPError.badRequest("a combined run with combined false has nothing to do")
      }
      if request.tracks == nil, let include = request.combined?.include {
        tracks = try include.map { name throws(HTTPError) in try Self.track(name, in: recording) }
      }
      combined = try automaticCombined(recording, tracks: tracks, request: request.combined ?? APICombinedRequest(), required: true)
    case .export:
      if request.combined?.wanted ?? model.settings.createCombined {
        combined = try automaticCombined(recording, tracks: tracks, request: request.combined ?? APICombinedRequest(), required: request.combined != nil)
      }
      if let asked = request.upload {
        upload = try await uploadPlan(recording, request: asked, makesCombined: combined != nil)
      } else if recording.gameId != nil, model.teamStation.isSignedIn {
        // TS Director said which game the take is of, so its files go there with nobody asked.
        upload = try await uploadPlan(recording, request: APIUploadRequest(), makesCombined: combined != nil)
      }
    case .upload:
      // What goes up and is not on this Mac yet is fetched first; the run adds those files itself.
      // A combined video already here is kept as it is, so its layout does not matter; one that is
      // not is made from every file, as the settings lay it out — unless the request says
      // `"combined": false`, when none goes up.
      let offered = request.combined?.wanted ?? true
      let saved = savedTracks(of: recording)
      let hasCombined = offered && (model.inventory(of: recording)?.combined.isSaved ?? false)
      let makeable = offered ? CombinedPlan.automatic(for: recording, tracks: everyFile, saved: model.settings.combinedLayout) : nil
      upload = try await uploadPlan(recording, request: request.upload ?? APIUploadRequest(), makesCombined: hasCombined || makeable != nil)
      tracks = []
      if upload?.tracks.contains(.combined) == true {
        combined = (hasCombined ? CombinedPlan.automatic(for: recording, tracks: saved, saved: model.settings.combinedLayout) : nil) ?? makeable
      }
    case .custom:
      if let request = request.combined, request.wanted {
        combined = try automaticCombined(recording, tracks: tracks, request: request, required: true)
      }
      if let request = request.upload {
        upload = try await uploadPlan(recording, request: request, makesCombined: combined != nil)
      }
    }
    return DistributorModel.ExportTake(recording: recording, tracks: tracks, combined: combined, teamStation: upload)
  }

  private func httpError(for refusal: DistributorModel.ExportRefusal) -> HTTPError {
    switch refusal {
    case .exporting:
      let current = model.batch.map { " (\(id(for: $0)))" } ?? ""
      return HTTPError(409, "runInProgress", "an export is already under way\(current); follow it, or cancel it with DELETE /api/v1/runs/{id}")
    case .noDestination:
      return HTTPError(412, "noDestination", "choose an export folder first: PATCH /api/v1/settings {\"destination\": \"/path\"}")
    case .noIPad:
      return Self.noIPad
    case .directorBusy(let reason):
      return HTTPError(423, "directorBusy", reason)
    }
  }

  func run(_ id: UUID) -> APIRun? {
    if let batch = model.batch, self.id(for: batch) == id { return snapshot(batch) }
    return runs.first { $0.id == id }.map { snapshot($0.batch) }
  }

  func currentRun() -> APIRun? {
    model.batch.map(snapshot) ?? runs.last.map { snapshot($0.batch) }
  }

  func cancelRun(_ id: UUID) throws(HTTPError) -> APIRun {
    guard let batch = (model.batch.flatMap { self.id(for: $0) == id ? $0 : nil }) ?? runs.first(where: { $0.id == id })?.batch else {
      throw HTTPError.notFound("no run \(id)")
    }
    batch.cancel()
    return snapshot(batch)
  }

  private func id(for batch: DistributionBatch) -> UUID {
    if let id = runIDs[ObjectIdentifier(batch)] { return id }
    let id = UUID()
    runIDs[ObjectIdentifier(batch)] = id
    runs.append((id, batch))
    if runs.count > Self.runsKept {
      let gone = runs.removeFirst()
      runIDs[ObjectIdentifier(gone.batch)] = nil
    }
    return id
  }

  private func snapshot(_ batch: DistributionBatch) -> APIRun {
    APIRun(
      id: id(for: batch),
      isFinished: batch.isFinished,
      wasCancelled: batch.wasCancelled,
      step: batch.step.rawValue,
      isDoneWithIPad: batch.isDoneWithIPad,
      takes: batch.runs.map(snapshot(take:))
    )
  }

  private func snapshot(take run: DistributionRun) -> APIRunTake {
    APIRunTake(
      recording: run.recording.id,
      folder: run.folder.path,
      files: run.tracks.map { track in
        Self.step(
          track: Self.name(track),
          name: Self.displayName(track, in: run.recording),
          state: run.states[track] ?? .queued
        )
      },
      combined: run.combinedState.map { state in
        var step = Self.step(track: "combined", name: "Combined video", state: state)
        if let sound = run.combinedSound, step.detail == nil { step.detail = "sound from \(sound)" }
        return step
      },
      uploads: (run.teamStation?.tracks ?? []).map { track in
        Self.step(track: Self.name(track), name: run.teamStation?.title(for: track) ?? "", upload: run.uploadStates[track] ?? .queued)
      }
    )
  }

  private func savedTracks(of recording: RecordingListing) -> [Track] {
    guard let inventory = model.inventory(of: recording) else { return [] }
    let every = (recording.hasPrimary ? [ Track.primary ] : []) + recording.cameras.map { Track.camera($0.sourceID) }
    return every.filter { inventory.files[$0]?.isSaved ?? false }
  }

  private func automaticCombined(
    _ recording: RecordingListing,
    tracks: [Track],
    request: APICombinedRequest,
    required: Bool
  ) throws(HTTPError) -> CombinedPlan? {
    let plan = CombinedPlan.automatic(
      for: recording,
      tracks: tracks,
      saved: model.settings.combinedLayout,
      include: request.include,
      audioCamera: request.audioCamera
    )
    if plan == nil, required {
      throw HTTPError.badRequest("a combined video needs two or more of the recording's videos among the files asked for")
    }
    return plan
  }

  /// The upload an API request asks for: which files, to which game.
  ///
  /// The game is the one TS Director filed the take under, unless the request
  /// names another by id. The title is the game's own, dated, unless the
  /// request says otherwise — the library reads these titles to tell a take's
  /// primary output from its cameras.
  private func uploadPlan(
    _ recording: RecordingListing,
    request: APIUploadRequest,
    makesCombined: Bool
  ) async throws(HTTPError) -> TeamStationPlan {
    guard model.teamStation.isSignedIn else {
      throw HTTPError(412, "teamStationSignedOut", "this Mac is not signed in to TeamStation: sign in from Settings in the app, which takes a code from an e-mail")
    }
    let gameId: String
    let gameTitle: String
    await model.teamStation.refreshFinishedEvents()
    // A game's title as TeamStation has it now, which a game edited since TS Director filed the
    // take under it (its sides swapped, say) has changed.
    func current(_ id: String) -> String? {
      model.teamStation.finishedEvents.first { $0.gameId == id }
        .map { "\(UploadTitle.datePrefix(for: $0.startAt)) \($0.title)" }
    }
    if let named = request.game, named != recording.gameId {
      guard let title = current(named) else {
        throw HTTPError.badRequest("no game \(named) among the games this account runs that have been played: GET /api/v1/teamstation")
      }
      gameId = named
      gameTitle = title
    } else if let marked = recording.gameId {
      gameId = marked
      gameTitle = current(marked) ?? recording.gameTitle ?? UploadTitle.datePrefix(for: recording.startedAt.date)
    } else {
      throw HTTPError(412, "noGame", "TS Director filed recording \(recording.id) under no game: name one with upload.game, a game id from GET /api/v1/teamstation")
    }

    let tracks: [UploadTrack]
    if let names = request.tracks {
      tracks = try names.map { name throws(HTTPError) in try Self.uploadTrack(name, in: recording) }
    } else {
      let choice = model.settings.upload.choice.applied(
        hasPrimary: recording.hasPrimary,
        cameras: recording.cameras.map(\.name),
        makesCombined: makesCombined
      )
      tracks = (choice.primary ? [ UploadTrack.primary ] : []) + choice.cameras.map { .camera($0) } + (choice.combined ? [ .combined ] : [])
    }
    guard !tracks.isEmpty else { throw HTTPError.badRequest("nothing to upload: list upload.tracks, or tick files to upload in the app") }
    if tracks.contains(.combined), !makesCombined {
      throw HTTPError.badRequest("recording \(recording.id) gets no combined video in this run, so none can go up: ask for one with combined, or leave combined out of upload.tracks")
    }

    return model.teamStationPlan(
      gameId: gameId,
      title: request.title ?? gameTitle,
      tracks: tracks,
      startedAt: recording.startedAt.date
    )
  }

  // MARK: - Settings

  func settings() -> DistributorSettings { model.settings }

  func updateSettings(_ patch: APISettingsPatch) async throws(HTTPError) -> DistributorSettings {
    if let path = patch.destination {
      var isDirectory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
        throw HTTPError.badRequest("\(path) is not a folder on this Mac")
      }
    }
    let macID = model.macID
    await model.updateSettings { settings in
      if let path = patch.destination { settings.destinations[macID] = path }
      if let on = patch.createCombined { settings.createCombined = on }
      if let choice = patch.upload?.choice { settings.upload.choice = choice.applied(to: settings.upload.choice) }
    }
    return model.settings
  }

  // MARK: - TeamStation

  /// The account alone, for the status, which is asked for constantly and must
  /// not put a request on the network each time. The games come from
  /// `GET /teamstation`, which is allowed to ask the server.
  private func account(games: [APIGame] = []) -> APITeamStation {
    guard let user = model.teamStation.user else {
      return APITeamStation(state: "signedOut", detail: model.teamStation.lastError)
    }
    return APITeamStation(state: "signedIn", email: user.email, games: games, detail: model.teamStation.lastError)
  }

  func teamStation() async -> APITeamStation {
    await model.teamStation.refreshFinishedEvents()
    return account(games: model.teamStation.finishedEvents.map {
      APIGame(id: $0.gameId, title: $0.title, startAt: $0.startAt, venue: $0.venue)
    })
  }

  // MARK: - Names

  static let noIPad = HTTPError(412, "iPadNotAttached", DistributorModel.noIPadNotice)

  static func name(_ track: Track) -> String {
    switch track {
    case .primary: "primary"
    case .camera(let sourceID): "camera:\(sourceID.rawValue)"
    }
  }

  static func name(_ track: UploadTrack) -> String {
    switch track {
    case .primary: "primary"
    case .combined: "combined"
    case .camera(let name): "camera:\(name)"
    }
  }

  static func displayName(_ track: Track, in recording: RecordingListing) -> String {
    switch track {
    case .primary: CombinedLayoutRules.primaryOutputName
    case .camera(let sourceID): recording.cameras.first { $0.sourceID == sourceID }?.name ?? sourceID.rawValue
    }
  }

  /// `primary`, `camera:<source id>`, `camera:<name>` or a camera's name.
  static func track(_ text: String, in recording: RecordingListing) throws(HTTPError) -> Track {
    let wanted = text.trimmingCharacters(in: .whitespaces)
    if wanted.lowercased() == "primary" || wanted == CombinedLayoutRules.primaryOutputName {
      guard recording.hasPrimary else { throw HTTPError.badRequest("recording \(recording.id) has no primary output") }
      return .primary
    }
    let key = wanted.hasPrefix("camera:") ? String(wanted.dropFirst("camera:".count)) : wanted
    if let camera = recording.cameras.first(where: { $0.sourceID.rawValue == key || $0.name.caseInsensitiveCompare(key) == .orderedSame }) {
      return .camera(camera.sourceID)
    }
    let known = ([ "primary" ] + recording.cameras.map(\.name)).joined(separator: ", ")
    throw HTTPError.badRequest("recording \(recording.id) has no file \(text); it has \(known)")
  }

  /// `primary`, `combined`, `camera:<name>`, `camera:<source id>` or a camera's name.
  static func uploadTrack(_ text: String, in recording: RecordingListing) throws(HTTPError) -> UploadTrack {
    if text.lowercased() == "combined" { return .combined }
    switch try track(text, in: recording) {
    case .primary: return .primary
    case .camera(let sourceID): return .camera(recording.cameras.first { $0.sourceID == sourceID }?.name ?? sourceID.rawValue)
    }
  }

  static func word(_ state: ExportInventory.FileState) -> String {
    switch state {
    case .saved: "saved"
    case .interrupted: "interrupted"
    case .missing: "missing"
    }
  }

  static func bytes(_ state: ExportInventory.FileState) -> Int64? {
    switch state {
    case .saved(let bytes), .interrupted(let bytes): bytes
    case .missing: nil
    }
  }

  /// One line of a run, as the API reports it.
  ///
  /// Nothing says which machine did the work any more: this Mac stitches
  /// every file. A file the iPad had already prepared is still fetched rather
  /// than made again, and that one says so, because it is the only case where
  /// where it came from changes what the operator should expect.
  static func step(track: String, name: String, state: TrackState) -> APIRunStep {
    switch state {
    case .queued:
      return APIRunStep(track: track, name: name, state: "queued")
    case let .fetching(received, total):
      return APIRunStep(track: track, name: name, state: "fetching", fraction: fraction(received, total))
    case .fetched:
      return APIRunStep(track: track, name: name, state: "fetched", detail: "off the iPad, waiting to be stitched")
    case let .stitching(fraction):
      return APIRunStep(track: track, name: name, state: "stitching", fraction: fraction)
    case let .downloading(received, total):
      return APIRunStep(track: track, name: name, state: "downloading", fraction: fraction(received, total), detail: "already stitched on the iPad")
    case .done(let url):
      return APIRunStep(track: track, name: name, state: "done", result: url.path)
    case .failed(let reason):
      return APIRunStep(track: track, name: name, state: "failed", detail: reason)
    }
  }

  static func step(track: String, name: String, upload state: UploadState) -> APIRunStep {
    switch state {
    case .queued:
      return APIRunStep(track: track, name: name, state: "queued")
    case let .uploading(sent, total):
      return APIRunStep(track: track, name: name, state: "uploading", fraction: fraction(sent, total))
    case .finishing(let step):
      // Every byte is up and the server is making a video of it. No fraction
      // to give: the caller is told which part of that work is under way.
      return APIRunStep(track: track, name: name, state: "finishing", detail: step)
    case .done:
      return APIRunStep(track: track, name: name, state: "done")
    case .failed(let reason):
      return APIRunStep(track: track, name: name, state: "failed", detail: reason)
    }
  }

  private static func fraction(_ part: Int64, _ whole: Int64) -> Double? {
    whole > 0 ? min(1, Double(part) / Double(whole)) : nil
  }
}
