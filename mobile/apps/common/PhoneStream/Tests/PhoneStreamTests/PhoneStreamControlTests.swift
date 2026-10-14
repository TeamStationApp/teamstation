import CameramanCapture
import CameramanCore
import DirectorCore
import DirectorExport
import DirectorMedia
import DirectorSources
import Foundation
import TeamStationKit
import Testing
import UIKit

@testable import PhoneStream

extension PhoneStreamTests {
  @Suite("Camera, radar, storage and the catalog")
  @MainActor
  struct Controls {
    static let angle = "Home Plate"
    /// An iPhone 13 Pro's back camera as `CameraSession` publishes it: three lenses, 0.5x to 9x.
    static func thirteenPro(deviceZoom: Double = 2) -> CameraSession.State {
      var state = CameraSession.State()
      state.position = .back
      state.mapping = ZoomMapping(
        minimumDeviceZoom: 1,
        maximumDeviceZoom: 18,
        displayMultiplier: 0.5,
        switchOverDeviceZooms: [ 2, 6 ]
      )
      state.deviceZoom = deviceZoom
      state.availableLenses = [
        CameraLens(id: "back-ultra", position: .back, deviceType: CameraDeviceTypeName.ultraWide,
                   uniqueDeviceID: "00000000-0000-4000-8000-000000000011", focalLengthMM: 13,
                   displayedZoom: 0.5, deviceZoom: 1, isSecondaryNative: false),
        CameraLens(id: "back-wide", position: .back, deviceType: CameraDeviceTypeName.wideAngle,
                   uniqueDeviceID: "00000000-0000-4000-8000-000000000012", focalLengthMM: 26,
                   displayedZoom: 1, deviceZoom: 2, isSecondaryNative: false),
        CameraLens(id: "back-tele", position: .back, deviceType: CameraDeviceTypeName.telephoto,
                   uniqueDeviceID: "00000000-0000-4000-8000-000000000013", focalLengthMM: 77,
                   displayedZoom: 3, deviceZoom: 6, isSecondaryNative: false),
        // The 48 mm crop of the wide sensor: a zoom stop, not a lens of its own.
        CameraLens(id: "back-wide-2x", position: .back, deviceType: CameraDeviceTypeName.wideAngle,
                   uniqueDeviceID: "00000000-0000-4000-8000-000000000012", focalLengthMM: 52,
                   displayedZoom: 2, deviceZoom: 4, isSecondaryNative: true)
      ]
      return state
    }

    @Test("Zoom, pinch, lenses and flip go to the camera session, and the status reads them back")
    func cameraControls() async throws {
      let rig = EngineRig(root: try scratchDirectory())
      let device = FakeCaptureDevice()
      let engine = try rig.engine(source: { PhoneCameraSource(input: .camera(device)) })
      let events = EventLog(engine)
      try engine.open(angleName: "Home Plate", audioEnabled: false, disabledLenses: [])
      #expect(engine.isOpen)
      #expect(!engine.audioEnabled)
      #expect(device.started == 1)
      #expect(device.configured.first?.0 == .back)
      #expect(device.configured.first?.1.width == 1920)
      #expect(device.configured.first?.1.frameRate == 30)
      #expect(engine.previewSession == nil)

      device.publish(Self.thirteenPro())
      #expect(engine.status.displayedZoom == 1)
      #expect(engine.status.lensLabel == "26 mm")
      #expect(engine.status.batteryPercent == 81)
      #expect(engine.status.charging)
      #expect(engine.status.thermal == "fair")
      #expect(engine.status.phase == "idle")
      #expect(!engine.status.isRecording)

      let scale = engine.zoomScale()
      #expect(scale.presets == [ 0.5, 1, 3, 9 ])
      #expect(scale.switchOvers == [ 1, 3 ])
      #expect(scale.minimum == 0.5)
      #expect(scale.maximum == 9)
      #expect(scale.current == 1)
      #expect(scale.digitalFrom == nil)

      engine.setZoom(displayed: 3)
      #expect(device.displayedZooms == [ 3 ])
      engine.pinch(scale: 2)
      engine.pinch(scale: 3)
      engine.pinch(scale: 1.5, ended: true)
      // Multiplicative against the zoom when the pinch began, device zoom 2.
      #expect(device.deviceZooms == [ 4, 6, 3 ])

      let lenses = engine.lenses()
      // One toggle per physical lens, as Cameraman's Lenses card: the wide's 2x crop is not listed.
      #expect(lenses.map { $0.lens.id } == [ "back-ultra", "back-wide", "back-tele" ])
      #expect(lenses.allSatisfy { $0.enabled })
      engine.setDisabledLenses([ "back-ultra" ])
      #expect(device.configured.count == 2)
      #expect(device.configured.last?.1.disabledLensIDs == [ "back-ultra" ])
      #expect(engine.lenses().first?.enabled == false)
      // The same set again changes nothing.
      engine.setDisabledLenses([ "back-ultra" ])
      #expect(device.configured.count == 2)
      // Opening an open engine applies the arguments.
      try engine.open(angleName: "First Base", audioEnabled: true, disabledLenses: [])
      #expect(engine.angleName == "First Base")
      #expect(engine.audioEnabled)
      #expect(device.configured.count == 3)
      engine.setAngleName("Home Plate")
      #expect(engine.angleName == "Home Plate")

      engine.flip()
      #expect(device.flips == 1)

      // Zoomed between lenses, the lens is the widest at or under it; no lenses, the zoom's label.
      device.publish(Self.thirteenPro(deviceZoom: 4))
      #expect(engine.status.lensLabel == "26 mm")
      device.publish(CameraSession.State())
      #expect(engine.status.lensLabel == "1x")

      rig.deviceStatus.level = nil
      #expect(engine.status.batteryPercent == nil)
      #expect(!engine.status.charging)

      #expect(await waitUntil(2) { events.statuses.count >= 3 })
      await engine.close()
      #expect(!engine.isOpen)
      #expect(device.stopped == 1)
      await engine.close()
    }

    @Test("Recording does not start before open, nor without 2 GB free")
    func startingNeedsAnOpenEngineAndSpace() async throws {
      let rig = EngineRig(root: try scratchDirectory())
      let engine = try rig.engine()
      #expect(throws: PhoneStreamError.notReady) {
        try engine.startRecording(rtmpUrl: "rtmp://127.0.0.1:1/live/key-0000", liveStreamId: "lst_0001",
                                  gameId: "gam_0001", angleName: "Home Plate", request: rig.request)
      }
      #expect(throws: PhoneStreamError.notReady) { try engine.resumeInterrupted(request: rig.request) }
      try engine.open(angleName: "Home Plate")
      rig.free.bytes = 1_900_000_000
      #expect(throws: PhoneStreamError.insufficientStorage) {
        try engine.startRecording(rtmpUrl: "rtmp://127.0.0.1:1/live/key-0000", liveStreamId: "lst_0001",
                                  gameId: "gam_0001", angleName: "Home Plate", request: rig.request)
      }
      #expect(engine.status.error == .insufficientStorage)
      #expect(try engine.recordings().isEmpty)
      #expect(engine.interruptedSession() == nil)
      #expect(try engine.resumeInterrupted(request: rig.request) == false)
      await engine.stopRecording()
      await engine.close()
    }

    @Test("Any number of radars pair under the phone's own keys, and each change is an event")
    func radars() async throws {
      let rig = EngineRig(root: try scratchDirectory())
      let engine = try rig.engine()
      let events = EventLog(engine)
      try engine.open(angleName: "Home Plate")
      engine.radar.setEnabled(true)
      engine.radar.scan()
      let scanner = try #require(rig.radios.made.first)
      #expect(scanner.scanning)
      scanner.listener?.radioDiscovered("ADFA00000001")
      scanner.listener?.radioDiscovered("ADFA00000002")
      #expect(engine.radar.state.nearby == [ "ADFA00000001", "ADFA00000002" ])
      #expect(engine.radar.state.scanning)
      #expect(engine.radar.pair("ADFA00000001"))
      #expect(engine.radar.pair("ADFA00000002"))
      #expect(!engine.radar.pair("not a radar"))
      engine.radar.stopScan()
      let state = engine.radar.state
      #expect(state.enabled)
      #expect(!state.scanning)
      #expect(state.bluetooth == .on)
      #expect(state.devices.map { $0.serial } == [ "ADFA00000001", "ADFA00000002" ])
      #expect(rig.defaults.bool(forKey: RadarFleet.Storage.phoneStream.enabledKey))
      #expect(rig.defaults.object(forKey: RadarFleet.Storage.phoneStream.serialsKey) as? [String]
        == [ "ADFA00000001", "ADFA00000002" ])
      engine.radar.unpair("ADFA00000001")
      #expect(engine.radar.state.devices.map { $0.serial } == [ "ADFA00000002" ])
      engine.radar.start()
      #expect(events.radars.count >= 5)
      #expect(events.radars.last?.devices.count == 1)
      await engine.close()
    }

    @Test("The events also arrive as a stream")
    func eventStream() async throws {
      let rig = EngineRig(root: try scratchDirectory())
      let engine = try rig.engine()
      let stream = engine.events()
      try engine.open(angleName: "Home Plate")
      var first: PhoneStreamStatus?
      for await event in stream {
        if case let .status(status) = event {
          first = status
          break
        }
      }
      #expect(first?.phase == "idle")
      let observation = engine.observe { _ in }
      observation.cancel()
      observation.cancel()
      await engine.close()
    }

    @Test("Storage lives under PhoneStream/, out of the backup, and its floors are 2 GB and 500 MB")
    func storage() throws {
      let root = try scratchDirectory().appendingPathComponent("PhoneStream", isDirectory: true)
      let storage = PhoneStorage(root: root)
      try storage.prepare()
      #expect(FileManager.default.fileExists(atPath: storage.program.path))
      #expect(FileManager.default.fileExists(atPath: storage.prepared.path))
      #expect(try root.resourceValues(forKeys: [ .isExcludedFromBackupKey ]).isExcludedFromBackup == true)
      #expect(storage.index.lastPathComponent == "index.sqlite")
      #expect(storage.fileRoots.program == storage.program)
      #expect(storage.freeBytes() > 0)
      // Before its tree exists, the volume it will be on is measured.
      #expect(PhoneStorage(root: root.appendingPathComponent("not/yet/made")).freeBytes() > 0)
      #expect(PhoneStorage.standard.root.path.hasSuffix("Application Support/PhoneStream"))
      let rules = PhoneStorageRules.standard
      #expect(rules.canStart(freeBytes: 2_000_000_000))
      #expect(!rules.canStart(freeBytes: 1_999_999_999))
      #expect(rules.mustStop(freeBytes: 499_999_999))
      #expect(!rules.mustStop(freeBytes: 500_000_000))
    }

    @Test("Retention keeps every take that has not been uploaded, and one uploaded for under a week")
    func retention() throws {
      let root = try scratchDirectory()
      let storage = PhoneStorage(root: root)
      try storage.prepare()
      let store = try SQLiteStore(url: storage.index)
      let index = try ArchiveIndex(store: store)
      let catalog = try PhoneCatalog(store: store, index: index)
      let day = 86_400.0
      let start = WallClock(seconds: 1_800_000_000)
      var ids: [Int64] = []
      for (offset, stream) in [ "lst_0001", "lst_0002", "lst_0003", "lst_0004" ].enumerated() {
        let id = try index.beginRecording(at: start + Double(offset))
        try index.endRecording(id, at: start + Double(offset) + 60)
        try catalog.add(recordingID: id, liveStreamId: stream, gameId: "gam_0001", angleName: "Home Plate")
        ids.append(id)
      }
      let file = storage.program.appendingPathComponent("program-20270115-080000.mp4")
      try Data([ 1, 2, 3 ]).write(to: file)
      try index.setProgramFilename(file.lastPathComponent, for: ids[0])
      try catalog.markUploaded(ids[0], videoId: "vid_0001", at: start + 60)
      try catalog.markUploaded(ids[1], videoId: "vid_0002", at: start + 6 * day)
      try catalog.setUpload(id: "upl_0003", title: "Home Plate", for: ids[2])
      try catalog.markUploaded(ids[3], videoId: "vid_0004", at: start + 60)

      let now = start + 8 * day
      let policy = PhoneRetentionPolicy()
      #expect(policy.keepUploadedSeconds == 7 * day)
      let doomed = policy.expired(try catalog.recordings(), now: now, protecting: [ ids[3] ])
      #expect(doomed.map { $0.recordingID } == [ ids[0] ])
      #expect(try policy.sweep(catalog: catalog, index: index, storage: storage, now: now, protecting: [ ids[3] ]) == 1)
      #expect(!FileManager.default.fileExists(atPath: file.path))
      let left = try catalog.recordings()
      #expect(Set(left.map { $0.recordingID }) == Set([ ids[1], ids[2], ids[3] ]))
      // Nothing un-uploaded ever goes, however old.
      #expect(try policy.sweep(catalog: catalog, index: index, storage: storage, now: now + 365 * day) == 2)
      #expect(try catalog.recordings().map { $0.recordingID } == [ ids[2] ])
    }

    @Test("The catalog files a take under its stream, game and angle, and tracks its upload")
    func catalog() throws {
      let storage = PhoneStorage(root: try scratchDirectory())
      try storage.prepare()
      let store = try SQLiteStore(url: storage.index)
      let index = try ArchiveIndex(store: store)
      let catalog = try PhoneCatalog(store: store, index: index)
      let id = try index.beginRecording(at: WallClock(seconds: 1_000))
      try catalog.add(recordingID: id, liveStreamId: "lst_0001", gameId: "gam_0001", angleName: "Home Plate")
      try index.setProgramFilename("program-a.mp4, program-a-2.mp4", for: id)
      let summary = try #require(try index.recordings().first)
      #expect(summary.liveStreamId == "lst_0001")
      #expect(summary.gameId == "gam_0001")

      var recording = try #require(try catalog.recording(id))
      #expect(recording.parts == 2)
      #expect(recording.angleName == "Home Plate")
      #expect(recording.coversWholeStream)
      #expect(!recording.hasPendingUpload)
      #expect(try catalog.current(forLiveStream: "lst_0001")?.recordingID == id)
      #expect(try catalog.current(forLiveStream: "lst_0009") == nil)

      try catalog.setUpload(id: "upl_0001", title: "Home Plate", for: id)
      recording = try #require(try catalog.recording(id))
      #expect(recording.hasPendingUpload)
      #expect(recording.uploadTitle == "Home Plate")
      try catalog.markStoppedForLowStorage(id)
      try catalog.markPublishedOutsideParts(id)
      recording = try #require(try catalog.recording(id))
      #expect(recording.stoppedForLowStorage)
      #expect(recording.publishedOutsideParts)
      #expect(!recording.coversWholeStream)
      // The first clock offset measured for a take holds: it is the one taken while recording.
      #expect(recording.serverClockOffset == nil)
      try catalog.setServerClockOffset(1.04, for: id)
      try catalog.setServerClockOffset(1.14, for: id)
      #expect(try catalog.recording(id)?.serverClockOffset == 1.04)
      try catalog.markUploaded(id, videoId: "vid_0001", at: WallClock(seconds: 2_000))
      recording = try #require(try catalog.recording(id))
      #expect(recording.isUploaded)
      #expect(!recording.hasPendingUpload)
      #expect(recording.videoId == "vid_0001")
      #expect(try catalog.current(forLiveStream: "lst_0001") == nil)

      // A take a kill left open closes at the last moment its programme reached.
      try index.insertProgramAnchor(recordingID: id, part: 1, programSeconds: 0, wall: WallClock(seconds: 1_001))
      try index.insertProgramAnchor(recordingID: id, part: 1, programSeconds: 30, wall: WallClock(seconds: 1_031))
      try catalog.closeAtLastAnchor(id)
      #expect(try index.recordings().first?.endedAt == WallClock(seconds: 1_031))
      try catalog.reopen(id)
      #expect(try index.recordings().first?.endedAt == nil)
      try catalog.closeAtLastAnchor(999)

      try catalog.setLive(.init(liveStreamId: "lst_0001", gameId: "gam_0001", angleName: "Home Plate"))
      #expect(try catalog.live()?.angleName == "Home Plate")
      try catalog.clearLive()
      #expect(try catalog.live() == nil)
      try catalog.delete(id)
      #expect(try catalog.recordings().isEmpty)
    }

    @Test("A catalog made before takes kept their clock offset gains the column")
    func catalogGainsTheOffsetColumn() throws {
      let storage = PhoneStorage(root: try scratchDirectory())
      try storage.prepare()
      let store = try SQLiteStore(url: storage.index)
      let index = try ArchiveIndex(store: store)
      try store.execute("""
        CREATE TABLE phone_recordings (
          recording_id INTEGER PRIMARY KEY, live_stream_id TEXT NOT NULL, game_id TEXT NOT NULL,
          angle_name TEXT NOT NULL, upload_id TEXT, upload_title TEXT, uploaded_at REAL, video_id TEXT,
          low_storage_stop INTEGER NOT NULL DEFAULT 0, published_outside_parts INTEGER NOT NULL DEFAULT 0
        );
        """)
      let catalog = try PhoneCatalog(store: store, index: index)
      let id = try index.beginRecording(at: WallClock(seconds: 1_000))
      try catalog.add(recordingID: id, liveStreamId: "lst_0001", gameId: "gam_0001", angleName: "Home Plate")
      try catalog.setServerClockOffset(-0.25, for: id)
      #expect(try catalog.recording(id)?.serverClockOffset == -0.25)
      // Opening it again finds the column there.
      #expect(try PhoneCatalog(store: store, index: index).recording(id)?.serverClockOffset == -0.25)
    }

    @Test("The device is named by model, and every iPhone the app installs on can stream")
    func capabilitiesAndModel() {
      #expect(DeviceModelName.name(for: "iPhone14,2") == "iPhone 13 Pro")
      #expect(DeviceModelName.name(for: "iPhone17,1") == "iPhone 16 Pro")
      #expect(DeviceModelName.name(for: "iPad16,3") == "iPad Pro")
      #expect(DeviceModelName.name(for: "iPhone99,9") == "iPhone")
      #expect(DeviceModelName.name(for: "iPad99,9") == "iPad")
      #expect(DeviceModelName.name(for: "Watch7,1") == "Watch7,1")
      #expect(PhoneStreamCapabilities.isSupported)
      #expect(PhoneStreamCapabilities.deviceModel == DeviceModelName.current)
      // The per-branch simulator is an iPhone 13 Pro, and says so.
      if ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] == "iPhone14,2" {
        #expect(PhoneStreamCapabilities.deviceModel == "iPhone 13 Pro")
      }
    }

    @Test("The app's own environment: its storage, the camera or the synthetic source, the system's services")
    func liveEnvironment() async throws {
      let environment = PhoneStreamEnvironment.live()
      #expect(environment.storage.root == PhoneStorage.standard.root)
      #expect(environment.observesApplication)
      #expect(environment.statusInterval == 0.25)
      #expect(environment.storageCheckInterval == 5)
      #expect(environment.stopTailSeconds == 1)
      #expect(environment.freeDiskBytes() > 0)
      #expect(environment.makePathMonitor() is SystemNetworkPathMonitor)
      #expect(environment.makeRetryScheduler() == nil)
      let status = environment.makeDeviceStatus()
      #expect(status is SystemDeviceStatus)
      // A simulator has no battery to read; its heat is nominal.
      _ = status.battery()
      #expect(ThermalBadgeLevel.allCases.contains(status.thermal()))
      #expect(environment.makeRadarFleet().limit == .max)
      if case .synthetic = environment.makeSource().input {} else { Issue.record("expected the synthetic source") }
      let work = PhoneBackgroundWork.system.begin("A test") {}
      PhoneBackgroundWork.system.end(work)
      PhoneBackgroundWork.none.end(PhoneBackgroundWork.none.begin("Nothing") {})
      #expect(!PhoneStreamEngine.shared.isOpen)
    }

    @Test("A background task that runs out of time winds its work down and is ended exactly once")
    func backgroundTasksExpire() {
      let next = Counter()
      let calls = Calls()
      let work = PhoneBackgroundWork.tasks(
        begin: { name, handler in
          calls.begun.append(name)
          let id = next.take()
          calls.handlers[id] = handler
          return id
        },
        end: { calls.ended.append($0) }
      )
      let expired = Heard()
      let first = work.begin("Upload Home Plate") { expired.add() }
      #expect(calls.begun == [ "Upload Home Plate" ])
      // Its time runs out: the work's own handler runs, then the task ends; the owner's end later
      // finds it ended.
      calls.handlers[first]?()
      #expect(expired.count == 1)
      #expect(calls.ended == [ first ])
      work.end(first)
      #expect(calls.ended == [ first ])
      // Ended by its owner in time: ended once, and a second end does nothing.
      let second = work.begin("Finish part") { expired.add() }
      work.end(second)
      work.end(second)
      #expect(calls.ended == [ first, second ])
    }

    @Test("A stopped camera keeps its callbacks, which the capture queue reads, and delivers nothing more")
    func cameraCallbacksAfterStop() throws {
      let device = FakeCaptureDevice()
      let source = PhoneCameraSource(input: .camera(device))
      let delivered = Heard()
      try source.start(sinks: FrameSinks(pixel: { _ in delivered.add() }, audio: { _ in delivered.add() }))
      let video = try #require(device.onVideoFrame)
      let audio = try #require(device.onAudioFrame)
      video(SampleBuffer(videoSample(at: 1)))
      audio(SampleBuffer(audioSample(at: 1)))
      #expect(delivered.count == 2)
      source.stop()
      // Not cleared from here: the device reads them on its own queue until it has stopped.
      #expect(device.onVideoFrame != nil)
      #expect(device.onAudioFrame != nil)
      #expect(device.stopped == 1)
      // A buffer the session delivers while stopping goes nowhere.
      video(SampleBuffer(videoSample(at: 2)))
      audio(SampleBuffer(audioSample(at: 2)))
      #expect(delivered.count == 2)
      // Started again, the same callbacks deliver to the new sinks.
      try source.start(sinks: FrameSinks(pixel: { _ in delivered.add() }, audio: { _ in delivered.add() }))
      device.onVideoFrame?(SampleBuffer(videoSample(at: 3)))
      #expect(delivered.count == 3)
      source.stop()
    }

    @Test("The engine follows the app into the background and back")
    func followsTheApplication() async throws {
      let rig = EngineRig(root: try scratchDirectory())
      var environment = try rig.engine().environment
      environment.observesApplication = true
      let engine = try PhoneStreamEngine(environment: environment)
      try engine.open(angleName: Self.angle)
      NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
      NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
      try await Task.sleep(for: .milliseconds(200))
      #expect(engine.isOpen)
      #expect(!engine.isStreaming)
      await engine.close()
    }

    @Test("A request's server is its origin, with or without /api/v1")
    func requestServer() {
      let device = "00000000-0000-4000-8000-000000000001"
      #expect(PhoneStreamRequest(apiBase: URL(string: "https://ts.example.test/api/v1/")!, token: "t", deviceId: device)
        .serverURL.absoluteString == "https://ts.example.test")
      #expect(PhoneStreamRequest(apiBase: URL(string: "https://ts.example.test")!, token: "t", deviceId: device)
        .serverURL.absoluteString == "https://ts.example.test")
    }

    @Test("The phone's telemetry keeps its counters and last errors")
    func telemetry() {
      let telemetry = PhoneMediaTelemetry()
      telemetry.recordEncodeSessionChange(delta: 1)
      telemetry.recordStreamKeyframe(ageSeconds: 2)
      telemetry.recordStreamKeyframeAge(1)
      telemetry.recordStreamPendingEncodes(2)
      telemetry.recordStreamEncodeCallbackAge(0.1)
      telemetry.recordProgramFrameAge(1)
      telemetry.recordStreamIdleKeyframe()
      telemetry.recordStreamEncoderReset()
      telemetry.recordEncodeFailure(code: -1)
      telemetry.recordProgramFinish("finished")
      telemetry.recordError("dropped")
      telemetry.recordRecordingError("writer")
      let snapshot = telemetry.snapshot
      #expect(snapshot.encodeSessions == 1)
      #expect(snapshot.streamKeyframes == 1)
      #expect(snapshot.streamPendingEncodes == 2)
      #expect(snapshot.idleKeyframes == 1)
      #expect(snapshot.encoderResets == 1)
      #expect(snapshot.encodeFailures == 1)
      #expect(snapshot.lastProgramFinish == "finished")
      #expect(snapshot.lastError == "dropped")
      #expect(snapshot.lastRecordingError == "writer")
    }
  }
}

/// Counts, from any thread.
final class Heard: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func add() {
    lock.lock()
    value += 1
    lock.unlock()
  }
  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

/// Hands out ids 1, 2, 3, ….
final class Counter: @unchecked Sendable {
  private var value = 0
  func take() -> Int {
    value += 1
    return value
  }
}

/// What a fake system's background-task calls were asked.
final class Calls: @unchecked Sendable {
  var begun: [String] = []
  var ended: [Int] = []
  var handlers: [Int: @Sendable () -> Void] = [:]
}
