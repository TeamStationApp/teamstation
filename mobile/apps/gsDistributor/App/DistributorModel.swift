import DirectorClient
import DirectorCore
import Distribution
import DistributorWire
import Foundation
import MacState
import Observation
import PeerTubeKit
import UsbMux

/// Watches the cable for iPads, keeps a connection to GS Director on the chosen one, and holds
/// what the window shows. The settings are kept on this Mac as well as on the iPad, so
/// everything that needs only the Mac works with the iPad away; what changes meanwhile reaches the
/// iPad when it is next attached.
@MainActor
@Observable
final class DistributorModel {
  enum Link: Equatable {
    /// No iPad on the cable.
    case waitingForIPad
    /// An iPad is attached but GS Director is not answering: closed, or in the background.
    case waitingForDirector(serial: String)
    case connected(Hello)
    case failed(String)
  }

  private(set) var link: Link = .waitingForIPad
  /// iPads attached by cable, by serial.
  private(set) var devices: [UsbMuxDevice] = []
  private(set) var chosenSerial: String?
  private(set) var recordings: [RecordingListing] = []
  /// Something to tell the user once; the window shows it and clears it.
  var problem: String?
  /// GS Distributor's settings: this Mac's copy, brought together with the iPad's whenever it is
  /// attached.
  private(set) var settings: DistributorSettings

  enum PeerTubeState: Equatable {
    /// Uploads are off, or nothing has been asked yet.
    case unknown
    case signedOut
    case signedIn(PeerTubeAccountView)
    case unreachable(String)
  }

  struct PeerTubeAccountView: Equatable {
    var host: String
    var username: String
    var channels: [PeerTubeChannelInfo]
    var privacies: [Int: String]
    /// The channel of the account's last video.
    var latestChannelID: Int?
  }

  enum SignInOutcome: Equatable {
    case signedIn
    case needsCode
    case failed(String)
  }

  /// The PeerTube account this Mac uploads with, as far as it knows.
  private(set) var peerTube: PeerTubeState = .unknown
  /// Tokens lent by the iPad's account, used only while this Mac has never signed in itself.
  private var borrowedToken: PeerTubeToken?
  /// Whether this Mac has a PeerTube account of its own, so uploads need no iPad.
  private var hasOwnPeerTubeAccount = false

  /// This Mac's download folder.
  var destination: URL? {
    settings.destinations[macID].map { URL(fileURLWithPath: $0, isDirectory: true) }
  }
  /// The export under way or just finished, if any.
  private(set) var run: DistributionRun?
  /// Whether GS Director is recording right now. While it is, the iPad stitches nothing.
  private(set) var isRecording = false
  /// Whether GS Director is streaming. Nothing comes from the iPad while it records or streams.
  private(set) var isStreaming = false

  /// Why an export that needs the iPad cannot start now, if it cannot. One whose files are all on
  /// this Mac can: the combined video and the uploads need only the Mac.
  var exportBlockedReason: String? {
    if isRecording { return "GS Director is recording, so nothing can come from the iPad until the take stops." }
    if isStreaming { return "GS Director is streaming, so nothing can come from the iPad until the stream stops." }
    return nil
  }

  /// What of `recording`'s export is already in this Mac's folder; nil before a folder is chosen.
  func inventory(of recording: RecordingListing) -> ExportInventory? {
    destination.map { ExportInventory(recording: recording, destination: $0) }
  }
  /// The iPad's stitching jobs, matched to their events.
  let jobs = JobWatcher()

  var isExporting: Bool { run.map { !$0.isFinished } ?? false }

  /// This Mac's hardware UUID, which keys its download folder and stamps its changes.
  let macID = MacIdentity.platformUUID
  private(set) var connection: DirectorConnection?

  /// This Mac's folder of state and its own PeerTube account.
  let state: MacState
  let peerTubeAccount: PeerTubeAccount

  private let locator = DirectorLocator()
  private var forwarder: LoopbackForwarder?
  private var eventsTask: Task<Void, Never>?

  init(
    state: MacState = MacState(),
    peerTubeStorage: any AccountStorage = KeychainAccountStorage(service: "\(MacState.keychainPrefix).peerTubeAccount")
  ) {
    self.state = state
    self.peerTubeAccount = PeerTubeAccount(storage: peerTubeStorage)
    self.settings = state.settings()
  }

  var chosenDevice: UsbMuxDevice? {
    devices.first { $0.serial == chosenSerial } ?? devices.first
  }

  /// Follows iPads coming and going until the window closes, and retries a Director that is not
  /// answering every couple of seconds. PeerTube is looked at first, since this Mac may upload
  /// with no iPad at all.
  func watch() async {
    await loadPeerTube()
    let retries = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(2))
        await self?.retryIfWaiting()
      }
    }
    defer { retries.cancel() }
    do {
      for try await event in locator.events() {
        switch event {
        case .attached(let device) where device.isUSB:
          // GS Director runs only on the iPad, so an iPhone on the cable is never offered.
          guard await isIPad(device) else { break }
          devices.removeAll { $0.serial == device.serial }
          devices.append(device)
          if chosenSerial == nil { chosenSerial = device.serial }
          await connect()
        case .detached(let deviceID):
          guard let gone = devices.first(where: { $0.deviceID == deviceID }) else { break }
          devices.removeAll { $0.deviceID == deviceID }
          if gone.serial == chosenDevice?.serial || connection == nil {
            disconnect()
            chosenSerial = devices.first?.serial
            link = devices.isEmpty ? .waitingForIPad : .waitingForDirector(serial: devices[0].serial)
            await connect()
          }
        default:
          break
        }
      }
    } catch {
      link = .failed("Cannot talk to usbmuxd: \(error)")
    }
  }

  /// What the owner calls each attached iPad, by serial, as lockdownd tells it.
  private(set) var deviceNames: [String: String] = [:]

  /// The iPad's own name where it is known, else its serial.
  func displayName(of serial: String) -> String {
    deviceNames[serial] ?? "iPad \(serial)"
  }

  /// Asks lockdownd what the device is and what its owner calls it. An iPad is kept, and so is a
  /// device that does not say, so a slow answer never hides an iPad.
  private func isIPad(_ device: UsbMuxDevice) async -> Bool {
    let identity = await Task.detached { try? UsbMuxClient().identity(deviceID: device.deviceID) }.value
    if let name = identity?.name, !name.isEmpty { deviceNames[device.serial] = name }
    return identity?.deviceClass.map { $0 == "iPad" } ?? true
  }

  func choose(serial: String) async {
    guard serial != chosenDevice?.serial else { return }
    chosenSerial = serial
    disconnect()
    recordings = []
    await connect()
  }

  /// Reads the iPad's recordings, and keeps the list on this Mac for when the iPad is away.
  func reload() async {
    guard let connection else { return }
    do {
      recordings = try await connection.recordings()
      if case .connected(let hello) = link {
        try? state.saveRecordings(recordings, director: DirectorRecord(directorID: hello.directorID, deviceName: hello.deviceName))
      }
    } catch {
      problem = "Could not read the iPad's recordings: \(error)"
    }
  }

  /// Deletes on the iPad. The take being recorded is refused there, and said so here.
  func delete(_ ids: [Int64]) async {
    guard let connection, !ids.isEmpty else { return }
    do {
      let refused = try await connection.deleteRecordings(ids)
      if !refused.isEmpty { problem = "The recording in progress was not deleted." }
    } catch {
      problem = "Delete failed: \(error)"
    }
    await reload()
  }

  /// Exports `tracks` of `recording` into this Mac's folder, the Mac and the iPad stitching side by
  /// side.
  func export(
    _ recording: RecordingListing,
    tracks: [Track],
    reprocess: Bool = false,
    combined: CombinedPlan? = nil,
    upload: UploadPlan? = nil
  ) {
    guard !isExporting, let connection else { return }
    guard let destination else {
      problem = "Choose a folder to save into in Settings first."
      return
    }
    // Files already on this Mac need nothing from the iPad, so only an export that does waits.
    if let reason = exportBlockedReason,
       ExportInventory(recording: recording, destination: destination).needsIPad(tracks, reprocess: reprocess) {
      problem = reason
      return
    }
    let run = DistributionRun(
      recording: recording,
      tracks: tracks,
      connection: connection,
      jobs: jobs,
      destination: destination,
      reprocess: reprocess,
      combined: combined,
      upload: upload
    ) { [weak self] in
      guard let self else { return false }
      return self.connection != nil && !self.isRecording && self.settings.iPadStitching
    }
    self.run = run
    Task {
      await run.run()
      await reload()
    }
  }

  /// One frame of a camera, for the combined video's previews; nil when the iPad has none.
  func still(recordingID: Int64, camera: SourceID, at seconds: Double) async -> Data? {
    try? await connection?.still(recordingID: recordingID, camera: camera, at: seconds)
  }

  // MARK: - PeerTube

  /// This Mac signs in to PeerTube with its own account, kept in its Keychain. Until it has one it
  /// borrows access tokens from the iPad's account while the iPad is attached.
  func loadPeerTube() async {
    borrowedToken = nil
    guard settings.peerTube.enabled else {
      peerTube = .unknown
      return
    }
    hasOwnPeerTubeAccount = await peerTubeAccount.current != nil
    do {
      let token = try await peerTubeAccessToken()
      let api = PeerTubeAPI(host: token.host)
      async let me = api.me(accessToken: token.accessToken)
      async let privacies = api.privacies()
      async let latest = api.latestChannelID(accessToken: token.accessToken)
      peerTube = .signedIn(PeerTubeAccountView(
        host: token.host,
        username: token.username,
        channels: try await me.channels,
        privacies: (try? await privacies) ?? [:],
        latestChannelID: try? await latest
      ))
    } catch PeerTubeError.signInAgain {
      peerTube = .signedOut
    } catch {
      peerTube = .unreachable("\(error)")
    }
  }

  /// An access token good for five more minutes at least: this Mac's own account's, else one the
  /// iPad lends, which refreshes its own.
  func peerTubeAccessToken() async throws -> PeerTubeToken {
    if await peerTubeAccount.current != nil {
      let token = try await peerTubeAccount.accessToken()
      return PeerTubeToken(host: token.host, username: token.username, accessToken: token.token, expiresAt: token.expiresAt)
    }
    if let token = borrowedToken, token.expiresAt.timeIntervalSinceNow > 300 { return token }
    guard let connection else { throw PeerTubeError.signInAgain }
    guard let token = try await connection.peerTubeToken() else {
      peerTube = .signedOut
      throw PeerTubeError.signInAgain
    }
    borrowedToken = token
    return token
  }

  /// Signs this Mac in, and notes the account in the settings.
  func signInToPeerTube(host: String, username: String, password: String, code: String?) async -> SignInOutcome {
    do {
      try await peerTubeAccount.signIn(host: host, username: username, password: password, otp: code)
    } catch PeerTubeError.otpRequired {
      return .needsCode
    } catch let error as PeerTubeError {
      return .failed(error.description)
    } catch {
      return .failed(error.localizedDescription)
    }
    await updateSettings {
      $0.peerTube.host = host
      $0.peerTube.username = username
    }
    await loadPeerTube()
    return .signedIn
  }

  /// Signs this Mac out.
  func signOutOfPeerTube() async {
    await peerTubeAccount.signOut()
    borrowedToken = nil
    hasOwnPeerTubeAccount = false
    peerTube = .signedOut
  }

  /// The channel an upload starts on: the one last uploaded to from here, else the one the
  /// account's last video went to, else its first.
  var uploadChannelID: Int? {
    guard case .signedIn(let account) = peerTube else { return nil }
    let ids = account.channels.map(\.id)
    if let chosen = settings.peerTube.channelID, ids.contains(chosen) { return chosen }
    if let latest = account.latestChannelID, ids.contains(latest) { return latest }
    return ids.first
  }

  /// The privacy an upload starts on: the one last used, else 6 where the instance has it.
  var uploadPrivacy: Int {
    let offered = if case .signedIn(let account) = peerTube { Array(account.privacies.keys) } else { [Int]() }
    return PeerTubePrivacy.preferred(chosen: settings.peerTube.privacy, offered: offered)
  }

  /// The uploads for an export of `recording`, to `channelID` with `privacy`; nil when this Mac is
  /// not signed in or there is no channel.
  func uploadPlan(
    for recording: RecordingListing,
    title: String,
    channelID: Int?,
    privacy: Int,
    tracks: [UploadTrack]
  ) -> UploadPlan? {
    guard case .signedIn(let account) = peerTube, let channelID, !tracks.isEmpty else { return nil }
    // The uploads' own token: this Mac's account's whenever it has one, else the iPad's, kept
    // through GS Director going away and coming back.
    let tokens = UploadTokenSource(
      held: borrowedToken,
      isConnected: { @MainActor [weak self] in
        guard let self else { return false }
        return self.hasOwnPeerTubeAccount || self.connection != nil
      },
      fetch: { @MainActor [weak self] in
        guard let self else { throw CancellationError() }
        return try await self.peerTubeAccessToken()
      }
    )
    return UploadPlan(
      host: account.host,
      channelID: channelID,
      privacy: privacy,
      title: title,
      tracks: tracks,
      token: { try await tokens.accessToken() }
    )
  }

  /// Puts away a finished export's progress.
  func dismissRun() {
    if run?.isFinished == true { run = nil }
  }

  // MARK: - Settings

  /// Changes the settings: at once on this Mac, and on the iPad now or when it is next attached.
  func updateSettings(_ change: (inout DistributorSettings) -> Void) async {
    var next = settings
    change(&next)
    next = next.stampingChanges(from: settings, by: macID)
    guard next != settings else { return }
    settings = next
    saveSettingsHere()
    await syncSettings()
  }

  /// Brings this Mac's settings and the iPad's together: each group from whichever changed it last.
  private func syncSettings() async {
    guard let connection else { return }
    do {
      let theirs = try await connection.settings()
      var merged = settings.reconciled(with: theirs)
      if merged != theirs {
        merged = try await connection.saveSettings(merged)
      }
      settings = merged
      saveSettingsHere()
      if case .connected(let hello) = link {
        try? state.updateJournal { $0.lastSynced[hello.directorID.uuidString] = Date() }
      }
    } catch {
      problem = "Could not bring the settings together with the iPad's: \(error)"
    }
  }

  private func saveSettingsHere() {
    do {
      try state.saveSettings(settings)
    } catch {
      problem = "Could not save the settings on this Mac: \(error)"
    }
  }

  // MARK: - Connection

  private func retryIfWaiting() async {
    if case .waitingForDirector = link { await connect() }
  }

  private func connect() async {
    guard let device = chosenDevice, connection == nil else { return }
    do {
      let (connection, forwarder, presence) = try await locator.open(device, macID: macID)
      guard case .running(let hello) = presence else {
        forwarder.stop()
        return
      }
      self.connection = connection
      self.forwarder = forwarder
      link = .connected(hello)
      isRecording = hello.isRecording
      isStreaming = hello.isStreaming
      await reload()
      await syncSettings()
      await loadPeerTube()
      listen(to: connection)
    } catch {
      disconnect()
      link = .waitingForDirector(serial: device.serial)
    }
  }

  private func listen(to connection: DirectorConnection) {
    eventsTask?.cancel()
    eventsTask = Task { [weak self] in
      do {
        for try await event in connection.events() {
          guard let self else { return }
          switch event {
          case .recordingsChanged:
            await reload()
          case .recordingStateChanged(let recording):
            isRecording = recording
            await reload()
          case .streamingStateChanged(let streaming):
            isStreaming = streaming
          case .directorBackgrounded:
            await jobs.handle(event)
            lost()
            return
          case .jobProgress, .jobFinished, .jobFailed:
            await jobs.handle(event)
          }
        }
      } catch {}
      // The stream ended: GS Director went away.
      self?.lost()
    }
  }

  private func lost() {
    guard connection != nil else { return }
    let jobs = self.jobs
    Task { await jobs.abandonAll() }
    let serial = chosenDevice?.serial
    disconnect()
    link = serial.map { .waitingForDirector(serial: $0) } ?? .waitingForIPad
  }

  /// Drops the connection. The settings and this Mac's own PeerTube account carry on; tokens the
  /// iPad lent do not, so what PeerTube shows is looked at again.
  private func disconnect() {
    let wasConnected = connection != nil
    eventsTask?.cancel()
    eventsTask = nil
    forwarder?.stop()
    forwarder = nil
    connection = nil
    borrowedToken = nil
    if wasConnected {
      Task { await loadPeerTube() }
    }
  }
}
