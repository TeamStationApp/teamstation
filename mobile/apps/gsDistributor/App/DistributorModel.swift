import DirectorClient
import Distribution
import DistributorWire
import Foundation
import Observation
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

  /// This Mac's download folder, as the iPad remembers it.
  var destination: URL? {
    settings?.destinations[macID].map { URL(fileURLWithPath: $0, isDirectory: true) }
  }
  /// The export under way or just finished, if any.
  private(set) var run: DistributionRun?
  /// Whether GS Director is recording right now. While it is, the iPad stitches nothing.
  private(set) var isRecording = false
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
  func export(_ recording: RecordingListing, tracks: [Track], reprocess: Bool = false) {
    guard !isExporting, let connection else { return }
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
      reprocess: reprocess
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
      await reload()
      await loadSettings()
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
  }
}
