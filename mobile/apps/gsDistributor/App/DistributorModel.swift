import DirectorClient
import DirectorCore
import Distribution
import DistributorWire
import Foundation
import GameStationKit
import MacState
import Observation
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

  /// What exporting needs while no GS Director is attached.
  nonisolated static let noIPadNotice = "Connect iPad with GS Director in the foreground to export videos."

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

  /// This Mac's folder of state.
  let state: MacState

  private let locator = DirectorLocator()
  private var forwarder: LoopbackForwarder?
  private var eventsTask: Task<Void, Never>?

  /// This Mac's own GameStation sign-in.
  ///
  /// The same account object GS Director uses — one implementation of signing
  /// in, listing the games an account runs, and holding the token — under this
  /// app's own keychain service, because the Mac and the iPad are two devices
  /// and each holds its own session.
  let gameStation: GameStationAccount

  init(state: MacState = MacState()) {
    self.state = state
    self.settings = state.settings()
    self.gameStation = GameStationAccount(
      serverURL: AppServer.url,
      deviceName: Host.current().localizedName ?? "Mac",
      keychain: KeychainStore(service: "\(MacState.keychainPrefix).gameStation")
    )
    Task { await gameStation.restore() }
  }

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

  /// Why an export did not start.
  enum ExportRefusal: Error, Equatable {
    case exporting
    case noDestination
    case noIPad
    /// GS Director is recording or streaming, and the export needs a file from it.
    case directorBusy(String)

    var message: String {
      switch self {
      case .exporting: "An export is already under way."
      case .noDestination: "Choose a folder to save into in Settings first."
      case .noIPad: DistributorModel.noIPadNotice
      case .directorBusy(let reason): reason
      }
    }
  }

  /// Exports `tracks` of `recording` into this Mac's folder, the Mac and the iPad stitching side by
  /// side. What stops it is shown in the window.
  func export(
    _ recording: RecordingListing,
    tracks: [Track],
    reprocess: Bool = false,
    combined: CombinedPlan? = nil,
    gameStation: GameStationPlan? = nil
  ) {
    do {
      try startExport(
        recording,
        tracks: tracks,
        reprocess: reprocess,
        combined: combined,
        gameStation: gameStation
      )
    } catch .exporting {
      // The window offers no second export while one runs.
    } catch {
      problem = error.message
    }
  }

  /// Starts an export and returns it, or says why it cannot start.
  @discardableResult
  func startExport(
    _ recording: RecordingListing,
    tracks: [Track],
    reprocess: Bool = false,
    combined: CombinedPlan? = nil,
    gameStation: GameStationPlan? = nil
  ) throws(ExportRefusal) -> DistributionRun {
    guard !isExporting else { throw .exporting }
    guard let destination else { throw .noDestination }
    // Files already on this Mac need nothing from the iPad, so only an export that does needs it
    // attached and waits while it records or streams.
    let needsIPad = ExportInventory(recording: recording, destination: destination).needsIPad(tracks, reprocess: reprocess)
    if needsIPad, connection == nil { throw .noIPad }
    if needsIPad, let reason = exportBlockedReason { throw .directorBusy(reason) }
    let run = DistributionRun(
      recording: recording,
      tracks: tracks,
      connection: connection,
      jobs: jobs,
      destination: destination,
      reprocess: reprocess,
      combined: combined,
      gameStation: gameStation
    )
    self.run = run
    Task {
      await run.run()
      await reload()
    }
    return run
  }

  /// One frame of a camera, for the combined video's previews; nil when the iPad has none.
  func still(recordingID: Int64, camera: SourceID, at seconds: Double) async -> Data? {
    try? await connection?.still(recordingID: recordingID, camera: camera, at: seconds)
  }

  /// An export bound for a game on GameStation.
  ///
  /// The sending is `UploadService`, through this Mac's account — the same
  /// path GS Director takes, so a broken upload resumes the same way on both.
  func gameStationPlan(
    gameId: String,
    title: String,
    tracks: [UploadTrack],
    startedAt: Date
  ) -> GameStationPlan {
    let account = gameStation
    return GameStationPlan(
      gameId: gameId,
      title: title,
      tracks: tracks
    ) { file, fileTitle, kind, progress in
      try await account.send(
        file: file,
        gameId: gameId,
        title: fileTitle,
        kind: kind,
        // The take's wall clock, not this upload's: every file of the export
        // starts there, and the library lays a take's cameras out against it.
        startedAt: startedAt,
        onProgress: progress
      )
    }
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
        // What the iPad kept, brought together with what was sent rather than taken as it is: a
        // GS Director from before a group existed answers without it.
        let kept = try await connection.saveSettings(merged)
        merged = merged.reconciled(with: kept)
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

  /// Drops the connection. The settings this Mac holds carry on.
  private func disconnect() {
    eventsTask?.cancel()
    eventsTask = nil
    forwarder?.stop()
    forwarder = nil
    connection = nil
  }
}
