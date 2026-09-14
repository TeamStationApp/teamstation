import DirectorClient
import DirectorCore
import Distribution
import DistributorWire
import Foundation
import Observation
import PeerTubeKit
import UsbMux

/// Watches the cable for iPads, keeps a connection to GS Director on the chosen one, and holds
/// what the window shows. Nothing here is saved on the Mac.
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
  /// GS Distributor's settings, read from and saved to the iPad. Nil until GS Director answers.
  private(set) var settings: DistributorSettings?

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

  /// The PeerTube account GS Director holds, as far as the Mac knows.
  private(set) var peerTube: PeerTubeState = .unknown
  private var peerTubeToken: PeerTubeToken?

  /// This Mac's download folder, as the iPad remembers it.
  var destination: URL? {
    settings?.destinations[macID].map { URL(fileURLWithPath: $0, isDirectory: true) }
  }
  /// The export under way or just finished, if any.
  private(set) var run: DistributionRun?
  /// Whether GS Director is recording right now. While it is, the iPad stitches nothing.
  private(set) var isRecording = false
  /// Whether GS Director is streaming. No export starts while it records or streams.
  private(set) var isStreaming = false

  /// Why an export cannot start now, if it cannot.
  var exportBlockedReason: String? {
    if isRecording { return "GS Director is recording. Export once the take has stopped." }
    if isStreaming { return "GS Director is streaming. Export once the stream has stopped." }
    return nil
  }
  /// The iPad's stitching jobs, matched to their events.
  let jobs = JobWatcher()

  var isExporting: Bool { run.map { !$0.isFinished } ?? false }

  /// This Mac's hardware UUID, which keys its download folder on the iPad.
  let macID = MacIdentity.platformUUID
  private(set) var connection: DirectorConnection?

  private let locator = DirectorLocator()
  private var forwarder: LoopbackForwarder?
  private var eventsTask: Task<Void, Never>?

  var chosenDevice: UsbMuxDevice? {
    devices.first { $0.serial == chosenSerial } ?? devices.first
  }

  /// Follows iPads coming and going until the window closes, and retries a Director that is not
  /// answering every couple of seconds.
  func watch() async {
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

  func reload() async {
    guard let connection else { return }
    do {
      recordings = try await connection.recordings()
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
    if let reason = exportBlockedReason {
      problem = reason
      return
    }
    guard let destination else {
      problem = "Choose a folder to save into in Settings first."
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
      return self.connection != nil && !self.isRecording
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

  /// GS Director signs in; the Mac reads the account's channels and privacy settings, and uploads,
  /// with access tokens the iPad hands it.
  func loadPeerTube() async {
    peerTubeToken = nil
    guard settings?.peerTube.enabled == true, connection != nil else {
      peerTube = .unknown
      return
    }
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

  /// An access token good for five more minutes at least: the one already fetched, else a new one
  /// from the iPad, which refreshes its own.
  func peerTubeAccessToken() async throws -> PeerTubeToken {
    if let token = peerTubeToken, token.expiresAt.timeIntervalSinceNow > 300 { return token }
    guard let connection else { throw PeerTubeError.signInAgain }
    guard let token = try await connection.peerTubeToken() else {
      peerTube = .signedOut
      throw PeerTubeError.signInAgain
    }
    peerTubeToken = token
    return token
  }

  func signInToPeerTube(host: String, username: String, password: String, code: String?) async -> SignInOutcome {
    guard let connection else { return .failed("GS Director is not connected.") }
    do {
      let result = try await connection.peerTubeSignIn(
        PeerTubeSignIn(host: host, username: username, password: password, otp: code)
      )
      switch result {
      case .otpRequired:
        return .needsCode
      case .signedIn:
        await loadSettings()
        await loadPeerTube()
        return .signedIn
      }
    } catch DirectorClientError.http(_, let message) {
      return .failed(message)
    } catch {
      return .failed("\(error)")
    }
  }

  func signOutOfPeerTube() async {
    try? await connection?.peerTubeSignOut()
    peerTubeToken = nil
    peerTube = .signedOut
  }

  /// The channel an upload starts on: the one last uploaded to from here, else the one the
  /// account's last video went to, else its first.
  var uploadChannelID: Int? {
    guard case .signedIn(let account) = peerTube else { return nil }
    let ids = account.channels.map(\.id)
    if let chosen = settings?.peerTube.channelID, ids.contains(chosen) { return chosen }
    if let latest = account.latestChannelID, ids.contains(latest) { return latest }
    return ids.first
  }

  /// The privacy an upload starts on: the one last used, else 6 where the instance has it.
  var uploadPrivacy: Int {
    let offered = if case .signedIn(let account) = peerTube { Array(account.privacies.keys) } else { [Int]() }
    return PeerTubePrivacy.preferred(chosen: settings?.peerTube.privacy, offered: offered)
  }

  /// The uploads for an export of `recording`, to `channelID` with `privacy`; nil when GS Director
  /// is not signed in or there is no channel.
  func uploadPlan(
    for recording: RecordingListing,
    title: String,
    channelID: Int?,
    privacy: Int,
    tracks: [UploadTrack]
  ) -> UploadPlan? {
    guard case .signedIn(let account) = peerTube, let channelID, !tracks.isEmpty else { return nil }
    // The uploads' own token, kept through GS Director going away and coming back.
    let tokens = UploadTokenSource(
      held: peerTubeToken,
      isConnected: { @MainActor [weak self] in self?.connection != nil },
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

  func loadSettings() async {
    guard let connection else {
      settings = nil
      return
    }
    do {
      settings = try await connection.settings()
    } catch {
      problem = "Could not read the settings on the iPad: \(error)"
    }
  }

  /// Changes the settings on the iPad. Shown at once; put back as they were if the save fails.
  func updateSettings(_ change: (inout DistributorSettings) -> Void) async {
    guard let connection, var next = settings else { return }
    change(&next)
    settings = next
    do {
      settings = try await connection.saveSettings(next)
    } catch {
      problem = "Could not save the settings on the iPad: \(error)"
      await loadSettings()
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
      await loadSettings()
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

  private func disconnect() {
    eventsTask?.cancel()
    eventsTask = nil
    forwarder?.stop()
    forwarder = nil
    connection = nil
    settings = nil
    peerTube = .unknown
    peerTubeToken = nil
  }
}
