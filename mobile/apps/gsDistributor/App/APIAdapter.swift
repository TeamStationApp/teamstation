import DirectorCore
import Distribution
import DistributorAPI
import DistributorWire
import Foundation
import LoopbackHTTP
import PeerTubeKit

/// Answers GS Distributor's REST API with the model the window uses, so what the API starts is what
/// the window would start, and the window shows it.
@MainActor
final class APIAdapter: DistributorActions {
  private let model: DistributorModel
  /// What `/api/v1/events` streams.
  let events = JSONEventHub<APIEvent>(encoder: .api)

  /// Each run's id, and the runs themselves for looking up by it. The last few are kept.
  private var runIDs: [ObjectIdentifier: UUID] = [:]
  private var runs: [(id: UUID, run: DistributionRun)] = []
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
      run: model.run.map(snapshot),
      peerTube: peerTube()
    )
  }

  private func iPad() -> APIIPad {
    switch model.link {
    case .waitingForIPad:
      return APIIPad(state: "none", message: DistributorModel.noIPadNotice)
    case .waitingForDirector(let serial):
      let name = model.displayName(of: serial)
      return APIIPad(state: "waitingForDirector", name: name, message: "\(name) is attached, but GS Director is not answering. Open it and bring it to the front.")
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
        preparedOnIPad: recording.preparedTracks.contains(track)
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
      folder: folder?.path
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

  // MARK: - Runs

  func startRun(_ request: APIRunRequest) async throws(HTTPError) -> APIRun {
    guard let recordingID = request.recording else { throw HTTPError.badRequest("recording is required") }
    let recording = try listing(recordingID)
    let kind = request.kind ?? .custom
    let everyFile = (recording.hasPrimary ? [ Track.primary ] : []) + recording.cameras.map { Track.camera($0.sourceID) }
    var tracks = try request.tracks.map { names throws(HTTPError) in try names.map { name throws(HTTPError) in try Self.track(name, in: recording) } } ?? everyFile
    let reprocess = request.reprocess ?? false

    var combined: CombinedPlan?
    var upload: UploadPlan?
    switch kind {
    case .download:
      break
    case .combined:
      if request.tracks == nil, let include = request.combined?.include {
        tracks = try include.map { name throws(HTTPError) in try Self.track(name, in: recording) }
      }
      combined = try automaticCombined(recording, tracks: tracks, request: request.combined ?? APICombinedRequest(), required: true)
    case .export:
      if request.combined != nil || model.settings.createCombined {
        combined = try automaticCombined(recording, tracks: tracks, request: request.combined ?? APICombinedRequest(), required: request.combined != nil)
      }
      if request.upload != nil || model.settings.peerTube.enabled {
        upload = try uploadPlan(recording, request: request.upload ?? APIUploadRequest(), makesCombined: combined != nil)
      }
    case .upload:
      // Only what is already on this Mac goes up; nothing is stitched or made for it.
      let saved = savedTracks(of: recording)
      let hasCombined = model.inventory(of: recording)?.combined.isSaved ?? false
      upload = try uploadPlan(recording, request: request.upload ?? APIUploadRequest(), makesCombined: hasCombined)
      let wanted = upload?.tracks ?? []
      for track in wanted {
        switch track {
        case .combined:
          guard hasCombined else { throw Self.notOnMac("the combined video") }
        case .primary:
          guard saved.contains(.primary) else { throw Self.notOnMac("the primary output") }
        case .camera(let name):
          guard let camera = recording.cameras.first(where: { $0.name == name }), saved.contains(.camera(camera.sourceID)) else {
            throw Self.notOnMac(name)
          }
        }
      }
      tracks = saved
      if wanted.contains(.combined) {
        // The saved combined video is found where it is and kept, so its layout does not matter.
        combined = CombinedPlan.automatic(for: recording, tracks: saved, saved: model.settings.combinedLayout)
      }
    case .custom:
      if let request = request.combined {
        combined = try automaticCombined(recording, tracks: tracks, request: request, required: true)
      }
      if let request = request.upload {
        upload = try uploadPlan(recording, request: request, makesCombined: combined != nil)
      }
    }

    do {
      let run = try model.startExport(recording, tracks: tracks, reprocess: reprocess, combined: combined, upload: upload)
      return snapshot(run)
    } catch {
      throw httpError(for: error)
    }
  }

  private func httpError(for refusal: DistributorModel.ExportRefusal) -> HTTPError {
    switch refusal {
    case .exporting:
      let current = model.run.map { " (\(id(for: $0)))" } ?? ""
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
    if let run = model.run, self.id(for: run) == id { return snapshot(run) }
    return runs.first { $0.id == id }.map { snapshot($0.run) }
  }

  func currentRun() -> APIRun? {
    model.run.map(snapshot) ?? runs.last.map { snapshot($0.run) }
  }

  func cancelRun(_ id: UUID) throws(HTTPError) -> APIRun {
    guard let run = (model.run.flatMap { self.id(for: $0) == id ? $0 : nil }) ?? runs.first(where: { $0.id == id })?.run else {
      throw HTTPError.notFound("no run \(id)")
    }
    run.cancel()
    return snapshot(run)
  }

  private func id(for run: DistributionRun) -> UUID {
    if let id = runIDs[ObjectIdentifier(run)] { return id }
    let id = UUID()
    runIDs[ObjectIdentifier(run)] = id
    runs.append((id, run))
    if runs.count > Self.runsKept {
      let gone = runs.removeFirst()
      runIDs[ObjectIdentifier(gone.run)] = nil
    }
    return id
  }

  private func snapshot(_ run: DistributionRun) -> APIRun {
    APIRun(
      id: id(for: run),
      recording: run.recording.id,
      folder: run.folder.path,
      isFinished: run.isFinished,
      wasCancelled: run.wasCancelled,
      files: run.tracks.map { track in
        Self.step(
          track: Self.name(track),
          name: Self.displayName(track, in: run.recording),
          state: run.states[track] ?? .queued,
          by: run.stitchedBy[track]
        )
      },
      combined: run.combinedState.map { state in
        var step = Self.step(track: "combined", name: "Combined video", state: state, by: nil)
        if let sound = run.combinedSound, step.detail == nil { step.detail = "sound from \(sound)" }
        return step
      },
      uploads: (run.upload?.tracks ?? []).map { track in
        Self.step(track: Self.name(track), name: run.upload?.title(for: track) ?? "", upload: run.uploadStates[track] ?? .queued)
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

  private func uploadPlan(_ recording: RecordingListing, request: APIUploadRequest, makesCombined: Bool) throws(HTTPError) -> UploadPlan {
    guard case .signedIn(let account) = model.peerTube else {
      throw HTTPError(412, "peerTubeSignedOut", "this Mac is not signed in to PeerTube: POST /api/v1/peertube/signin, and turn uploads on with PATCH /api/v1/settings {\"uploadToPeerTube\": true}")
    }
    let tracks: [UploadTrack]
    if let names = request.tracks {
      tracks = try names.map { name throws(HTTPError) in try Self.uploadTrack(name, in: recording) }
    } else {
      let choice = model.settings.peerTube.uploadChoice.applied(
        hasPrimary: recording.hasPrimary,
        cameras: recording.cameras.map(\.name),
        makesCombined: makesCombined
      )
      tracks = (choice.primary ? [ UploadTrack.primary ] : []) + choice.cameras.map { .camera($0) } + (choice.combined ? [ .combined ] : [])
    }
    guard !tracks.isEmpty else { throw HTTPError.badRequest("nothing to upload: list upload.tracks, or tick files to upload in Settings") }
    let channelID = try request.channel.map { text throws(HTTPError) in try Self.channel(text, in: account) } ?? model.uploadChannelID
    guard let channelID else { throw HTTPError(412, "noChannel", "the PeerTube account has no channel") }
    let title = request.title ?? PeerTubeTitle.initialTitle(for: recording.startedAt.date)
    guard PeerTubeTitle.isValid(title: title, tracks: tracks) else {
      throw HTTPError.badRequest("every video's title must be \(PeerTubeTitle.minimumLength) to \(PeerTubeTitle.maximumLength) characters, camera names included")
    }
    guard let plan = model.uploadPlan(for: recording, title: title, channelID: channelID, privacy: request.privacy ?? model.uploadPrivacy, tracks: tracks) else {
      throw HTTPError(412, "peerTubeSignedOut", "this Mac is not signed in to PeerTube")
    }
    return plan
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
      if let on = patch.iPadStitching { settings.iPadStitching = on }
      if let on = patch.uploadToPeerTube { settings.peerTube.enabled = on }
      if let channel = patch.peerTubeChannel { settings.peerTube.channelID = channel }
      if let privacy = patch.peerTubePrivacy { settings.peerTube.privacy = privacy }
    }
    if patch.uploadToPeerTube != nil { await model.loadPeerTube() }
    return model.settings
  }

  // MARK: - PeerTube

  func peerTube() -> APIPeerTube {
    switch model.peerTube {
    case .signedIn(let account):
      return APIPeerTube(
        state: "signedIn",
        host: account.host,
        username: account.username,
        channels: account.channels.map { APIPeerTube.Channel(id: $0.id, name: $0.name, displayName: $0.displayName) },
        privacies: Dictionary(uniqueKeysWithValues: account.privacies.map { (String($0.key), $0.value) }),
        uploadChannel: model.uploadChannelID,
        uploadPrivacy: model.uploadPrivacy
      )
    case .signedOut:
      return APIPeerTube(state: "signedOut")
    case .unknown:
      return APIPeerTube(state: model.settings.peerTube.enabled ? "unknown" : "off")
    case .unreachable(let reason):
      return APIPeerTube(state: "unreachable", detail: reason)
    }
  }

  func peerTubeSignIn(_ request: APISignIn) async throws(HTTPError) -> APIPeerTube {
    let host: String
    do {
      host = try PeerTubeHost.normalize(request.host)
    } catch {
      throw HTTPError.badRequest("host must be a PeerTube instance's host name, like videos.example.org, reached over HTTPS")
    }
    // Signing in says uploads are wanted.
    await model.updateSettings { $0.peerTube.enabled = true }
    switch await model.signInToPeerTube(host: host, username: request.username, password: request.password, code: request.code) {
    case .signedIn:
      return peerTube()
    case .needsCode:
      throw HTTPError(401, "codeRequired", "the account has two-factor sign-in: send the same again with its code")
    case .failed(let reason):
      throw HTTPError(401, "signInFailed", reason)
    }
  }

  func peerTubeSignOut() async -> APIPeerTube {
    await model.signOutOfPeerTube()
    return peerTube()
  }

  func peerTubeVideos(search: String?) async throws(HTTPError) -> [APIVideo] {
    guard case .signedIn(let account) = model.peerTube else {
      throw HTTPError(412, "peerTubeSignedOut", "this Mac is not signed in to PeerTube")
    }
    do {
      let token = try await model.peerTubeAccessToken()
      return try await PeerTubeAPI(host: account.host).myVideos(accessToken: token.accessToken, search: search).map { video in
        APIVideo(
          uuid: video.uuid,
          shortUUID: video.shortUUID,
          name: video.name,
          channel: video.channel.displayName,
          originallyPublishedAt: video.originallyPublishedAt,
          publishedAt: video.publishedAt,
          watchURL: video.watchURL(host: account.host)?.absoluteString
        )
      }
    } catch {
      throw HTTPError(502, "peerTubeFailed", "PeerTube did not list the videos: \(error)")
    }
  }

  // MARK: - Names

  static let noIPad = HTTPError(412, "iPadNotAttached", DistributorModel.noIPadNotice)

  static func notOnMac(_ what: String) -> HTTPError {
    HTTPError(412, "notOnMac", "\(what) is not on this Mac yet: download it first with POST /api/v1/recordings/{id}/download")
  }

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

  /// A channel by id, name or display name.
  static func channel(_ text: String, in account: DistributorModel.PeerTubeAccountView) throws(HTTPError) -> Int {
    let wanted = text.trimmingCharacters(in: .whitespaces).lowercased()
    guard let channel = account.channels.first(where: {
      String($0.id) == wanted || $0.name.lowercased() == wanted || $0.displayName.lowercased() == wanted
    }) else {
      let names = account.channels.map { "\($0.displayName) (\($0.id))" }.joined(separator: ", ")
      throw HTTPError.badRequest("no channel \(text); the account has \(names)")
    }
    return channel.id
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

  static func step(track: String, name: String, state: TrackState, by worker: DistributionPlan.Worker?) -> APIRunStep {
    switch state {
    case .queued:
      return APIRunStep(track: track, name: name, state: "queued")
    case let .fetching(worker, received, total):
      return APIRunStep(track: track, name: name, state: "fetching", fraction: fraction(received, total), detail: "for the \(worker.rawValue)")
    case let .stitching(worker, fraction):
      return APIRunStep(track: track, name: name, state: "stitching", fraction: fraction, detail: "on the \(worker.rawValue)")
    case let .downloading(received, total):
      return APIRunStep(track: track, name: name, state: "downloading", fraction: fraction(received, total), detail: "stitched on the iPad")
    case .done(let url):
      return APIRunStep(track: track, name: name, state: "done", detail: worker.map { "stitched on the \($0.rawValue)" }, result: url.path)
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
    case .done(let page):
      return APIRunStep(track: track, name: name, state: "done", result: page?.absoluteString)
    case .failed(let reason):
      return APIRunStep(track: track, name: name, state: "failed", detail: reason)
    }
  }

  private static func fraction(_ part: Int64, _ whole: Int64) -> Double? {
    whole > 0 ? min(1, Double(part) / Double(whole)) : nil
  }
}
