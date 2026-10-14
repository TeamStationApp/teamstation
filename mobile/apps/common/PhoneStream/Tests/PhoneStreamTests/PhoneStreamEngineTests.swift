import AVFoundation
import CoreMedia
import DirectorCore
import DirectorExport
import DirectorMedia
import Foundation
import TeamStationKit
import Testing

@testable import PhoneStream

extension PhoneStreamTests {
  /// The engine from the synthetic source, through the real encoders, to an RTMP sink in the test
  /// and a stub of TeamStation's routes.
  @Suite("The engine, end to end on the simulator")
  @MainActor
  struct Engine {
    static let stream = "lst_0001"
    static let game = "gam_0001"
    static let angle = "Home Plate"
    /// How long a test waits for an upload's export: a loaded simulator's software HEVC rebuild.
    static let exportWait = 300.0

    /// An open engine recording and streaming to `sink`, once the stream is live.
    private func recording(
      _ rig: EngineRig,
      sink: TestRTMPSink,
      stream: String = Engine.stream
    ) async throws -> (PhoneStreamEngine, EventLog) {
      let engine = try rig.engine()
      let events = EventLog(engine)
      try engine.open(angleName: Self.angle)
      #expect(engine.status.phase == "idle")
      try engine.startRecording(
        rtmpUrl: sink.url,
        liveStreamId: stream,
        gameId: Self.game,
        angleName: Self.angle,
        request: rig.request
      )
      #expect(await waitUntil { engine.status.phase == "live" })
      return (engine, events)
    }

    private func partFiles(_ engine: PhoneStreamEngine, _ recording: PhoneRecording) throws -> [URL] {
      let summary = try #require(try engine.index.recordings().first { $0.id == recording.recordingID })
      return RecordingExport.programSourceFiles(
        named: try #require(summary.programFilename),
        in: engine.environment.storage.program
      )
    }

    @Test("""
      The stream goes idle → connecting → live → retrying → live as the sink drops and comes back, \
      opening at 2 Mbps and redialling with the stream held, while the recording misses no grid slot \
      and reads back as HEVC 1080p30 at about 6 Mbps with AAC that reaches the picture's end
      """)
    func streamDropsAndRecordingCarriesOn() async throws {
      StubServer.reset()
      let sink = TestRTMPSink()
      try sink.start()
      StubServer.with { $0.streamURL = sink.url }
      // The first account of the live start finds the server out of reach, and is offered again.
      StubServer.with { $0.streamChangeFailures = 1 }
      let rig = EngineRig(root: try scratchDirectory())
      let opened = Date()
      let (engine, events) = try await recording(rig, sink: sink)
      #expect(engine.isRecording)
      #expect(engine.isStreaming)
      // Opened at 2 Mbps, and a clean link climbs from there, never past 4.
      let opening = engine.status.bitrateKbps
      #expect(opening >= 2_000 && opening < 2_600, "opened at \(opening) kbps")
      #expect(engine.streamer.metrics.rate.low == 500_000)
      #expect(engine.streamer.metrics.rate.high == 4_000_000)
      #expect(await waitUntil { sink.snapshot.keyframes > 0 && sink.snapshot.audioMessages > 0 })
      let firstPictureSeen = Date()
      #expect(sink.snapshot.fourCcList == [ "hvc1" ])
      // TeamStation is told when the first picture sent was captured, on its own clock, which here
      // reads 3 s ahead: a picture delay before it went out, after the camera opened. Refused once,
      // the same moment is offered again.
      #expect(await waitUntil(10) { StubServer.read { $0.streamChanges }.count == 2 })
      let starts = StubServer.read { $0.streamChanges }.map { $0["liveStartedAt"] as? String }
      #expect(starts.count == 2 && starts.first == starts.last)
      let instant = ISO8601DateFormatter()
      instant.formatOptions = [ .withInternetDateTime, .withFractionalSeconds ]
      let liveStartText = try #require(starts.first ?? nil)
      let liveStart = try #require(instant.date(from: liveStartText))
      let skew = StubServer.read { $0.clockSkew }
      let local = liveStart.addingTimeInterval(-skew)
      #expect(local > opened.addingTimeInterval(-0.05), "first picture captured \(local) before the camera opened \(opened)")
      let delay = PhoneStreamProfile.pictureDelaySeconds
      #expect(local < firstPictureSeen.addingTimeInterval(-delay + 0.1), "first picture captured \(local), seen \(firstPictureSeen)")
      let streamed = try #require(engine.streamer.liveTimelineStart)
      #expect(abs(streamed.date.timeIntervalSince(local)) < 0.05)
      #expect(StubServer.read { $0.clockReads } == ServerClock.samples)
      #expect(sink.snapshot.publishNames == [ "key-0000" ])
      // The first dial used the URL it was given: the server was not asked.
      #expect(StubServer.read { $0.streamRequests }.isEmpty)

      try await Task.sleep(for: .seconds(6))
      // Every tick of the programme from the drop to the stream's return, with when it ran.
      let ticks = TickLog()
      engine.programme.observeTicks { output, at in ticks.add(output, at: at) }
      let awaySeconds = 2.0
      // The first redial finds the server out of reach too, and dials the address it holds.
      StubServer.with { $0.streamFailures = 1 }
      sink.drop()
      #expect(await waitUntil { engine.status.phase == "retrying" })
      try await Task.sleep(for: .seconds(awaySeconds))
      try sink.restore()
      #expect(await waitUntil(30) { engine.status.phase == "live" && sink.snapshot.publishes >= 2 })
      engine.programme.observeTicks(nil)
      // The programme handed the recording every slot of its grid while the stream was away. This is
      // judged by the ticks that ran, not by how long a wall clock says the drop took. A loaded
      // machine runs the clock's timer late, and a tick fills only a quarter of a second of the slots
      // it was late for: a hole in the grid is allowed only behind a tick that came later than that.
      // And the clock never stopped for the stream, which was away for longer than any tick waited.
      let run = ticks.entries
      let frames = run.flatMap(\.output.recordingFrames)
      #expect(zip(frames, frames.dropFirst()).allSatisfy { $0 < $1 }, "recording frames out of order")
      let covered = (frames.last ?? 0) - (frames.first ?? 0) + 1
      #expect(covered >= Int64(awaySeconds * 30), "the ticks covered \(covered) slots")
      let hold = Double(PhoneStreamProfile.frameRate / 4) / Double(PhoneStreamProfile.frameRate)
      var unexplained: [String] = []
      for (previous, tick) in zip(run, run.dropFirst()) {
        guard let last = previous.output.recordingFrames.last, let first = tick.output.recordingFrames.first,
          first - last > 1
        else { continue }
        if tick.at - previous.at <= hold {
          unexplained.append("\(first - last - 1) slots after frame \(last), tick \(tick.at - previous.at) s late")
        }
      }
      #expect(unexplained.isEmpty, "\(frames.count) of \(covered) slots sent; holes not behind a late tick: \(unexplained)")
      let longestWait = zip(run, run.dropFirst()).map { $1.at - $0.at }.max() ?? 0
      #expect(longestWait < awaySeconds, "the clock stopped for \(longestWait) s")
      // Every redial asked the server for the stream it holds.
      let asked = StubServer.read { $0.streamRequests }
      #expect(!asked.isEmpty)
      #expect(asked.allSatisfy { $0["heldStreamId"] as? String == Self.stream })
      #expect(asked.first?["label"] as? String == Self.angle)
      #expect(asked.first?["deviceId"] as? String == rig.request.deviceId)
      #expect(asked.first?["deviceModel"] as? String == "iPhone 13 Pro")
      // The first redial waited the controller's first 3 s; the 1 s waits are its stall checks.
      #expect(rig.scheduler.waits.first { $0 != StreamStallWatch.checkSeconds } == 3)
      #expect(rig.scheduler.waits.contains(StreamStallWatch.checkSeconds))
      try await Task.sleep(for: .seconds(6))
      #expect(engine.status.recordingSeconds > 14)
      // The redial continued the server's video: its start is not offered again.
      #expect(StubServer.read { $0.streamChanges }.count == 2)

      await engine.stopRecording()
      #expect(!engine.isRecording)
      #expect(!engine.isStreaming)
      #expect(engine.status.phase == "idle")
      // The phases in the order the screen saw them.
      let phases = events.phases
      let wanted = [ "connecting", "live", "retrying", "live", "idle" ]
      var cursor = phases.startIndex
      for phase in wanted {
        guard let found = phases[cursor...].firstIndex(of: phase) else {
          Issue.record("\(phase) missing from \(phases)")
          break
        }
        cursor = found + 1
      }

      let take = try #require(try engine.recordings().first)
      #expect(take.liveStreamId == Self.stream)
      #expect(take.gameId == Self.game)
      #expect(take.parts == 1)
      #expect(take.coversWholeStream)
      let file = try #require(try partFiles(engine, take).first)
      let reading = try await readBack(file, pictures: true)
      #expect(reading.videoCodec == kCMVideoCodecType_HEVC)
      #expect(reading.width == 1920)
      #expect(reading.height == 1080)
      #expect(abs(reading.minFrameDuration - 1.0 / 30) < 0.000_1)
      #expect(reading.hasAAC)
      // The hold fill writes sound out to the picture in whole AAC packets, ending within one.
      #expect(reading.audioEnd >= reading.videoEnd - 1_024.0 / 48_000, "sound \(reading.audioEnd) picture \(reading.videoEnd)")
      // About 6 Mbps: within a tenth when the writer took nearly every slot of the grid. The simulator
      // encodes HEVC in software, and on a loaded machine its writer takes only some of the pictures
      // the grid offers (79 of 525 at a load average of 400). VideoToolbox's rate control spreads the
      // rate over the pictures it gets and misses by more on so few, within about a fifth either way
      // (7.0 and 5.3 Mbps measured), so the tolerance widens with the share of the grid it took. That
      // is the processor, not the recording: a phone's hardware encoder takes every picture.
      let share = Double(reading.pictureTimes.count) / max(1, reading.videoSeconds * 30)
      let tolerance = share >= 0.9 ? 0.1 : 0.25
      #expect(
        abs(Double(reading.bitsPerSecond) - 6_000_000) <= 6_000_000 * tolerance,
        """
        recorded at \(reading.bitsPerSecond) b/s: \(reading.pictureBytes.reduce(0, +)) bytes in \(reading.pictureTimes.count) \
        pictures, \(reading.keyFrames) key, over \(reading.videoSeconds) s, pictures from \(reading.pictureTimes.first ?? -1) \
        to \(reading.pictureTimes.last ?? -1), \(Int(share * 100))% of the grid
        """
      )
      // Every picture sits on a slot of the 30 fps grid, in order, across the drop and the redial.
      // (The simulator encodes HEVC in software, so its writer takes fewer pictures than the grid
      // offers; a phone's hardware encoder takes them all.)
      let slotsOff = reading.pictureTimes.map { abs($0 * 30 - ($0 * 30).rounded()) }
      #expect(slotsOff.allSatisfy { $0 < 0.01 }, "furthest off the grid \(slotsOff.max() ?? 0) of a slot")
      #expect(zip(reading.pictureTimes, reading.pictureTimes.dropFirst()).allSatisfy { $0 < $1 })
      let span = try #require(take.endedAt) - take.startedAt
      #expect(abs(reading.videoSeconds - (span + 1)) < 1.5, "file \(reading.videoSeconds) s for \(span) s")
      let checks = try #require(try engine.index.recordings().first?.soundChecks)
      #expect(checks.count == 1)
      #expect(checks.allSatisfy { !$0.isShort })
      await engine.close()
      sink.drop()
    }

    @Test("""
      Turned between the two landscapes mid-recording, a capture that stops on the rotation's \
      runtime error is started again each time and its pictures keep reaching the programme, while \
      an interruption and a closed engine are left alone
      """)
    func rotationMidCaptureKeepsPicturesFlowing() async throws {
      StubServer.reset()
      let sink = TestRTMPSink()
      try sink.start()
      let rig = EngineRig(root: try scratchDirectory())
      let camera = RotationFailingCaptureDevice()
      let engine = try rig.engine(source: { PhoneCameraSource(input: .camera(camera)) })
      try engine.open(angleName: Self.angle)
      try engine.startRecording(rtmpUrl: sink.url, liveStreamId: Self.stream, gameId: Self.game,
                                angleName: Self.angle, request: rig.request)
      #expect(await waitUntil { engine.status.phase == "live" && camera.delivered > 30 })

      for turn in 1 ... 3 {
        camera.rotate()
        let stopped = camera.delivered
        // Started again within the restart's short wait, and a second of pictures follows.
        #expect(await waitUntil(3) { camera.starts == turn + 1 })
        #expect(await waitUntil(3) { camera.delivered >= stopped + 25 }, "turn \(turn): \(camera.delivered - stopped) pictures")
        #expect(engine.captureRestarts == turn)
      }
      // The programme went on taking fresh pictures, and the stream and the recording ran throughout.
      #expect(engine.status.phase == "live")
      #expect(engine.isRecording)
      // Waited for rather than slept: a loaded machine writes the next picture late, not never.
      let frames = engine.encoder.frameCount
      #expect(await waitUntil(10) { engine.encoder.frameCount > frames })

      // An interruption is AVFoundation's to end: nothing starts the camera over it.
      camera.interrupt()
      try await Task.sleep(for: .seconds(1))
      #expect(camera.starts == 4)
      #expect(engine.captureRestarts == 3)

      // Closed while a restart waits: nothing starts the camera of a closed engine.
      camera.start()
      camera.rotate()
      await engine.close()
      try await Task.sleep(for: .seconds(1))
      #expect(camera.starts == 5)
      #expect(engine.captureRestarts == 3)
      sink.drop()
    }

    @Test("""
      A 410 on the redial stops the stream at idle with streamEnded and no more redials, while the \
      recording carries on
      """)
    func endedStreamStopsRedialling() async throws {
      StubServer.reset()
      let sink = TestRTMPSink()
      try sink.start()
      let rig = EngineRig(root: try scratchDirectory())
      let (engine, _) = try await recording(rig, sink: sink)
      StubServer.with { $0.ended = true }
      sink.drop()
      #expect(await waitUntil { engine.status.error == .streamEnded })
      #expect(engine.status.phase == "idle")
      #expect(!engine.streamController.wanted)
      #expect(engine.streamController.lastError == "ended")
      // The phone replaces a connection that stops moving, which Director does not.
      #expect(engine.streamController.stallRedialSeconds == PhoneStreamProfile.stallRedialSeconds)
      let asks = StubServer.read { $0.streamRequests }.count
      #expect(asks == 1)
      let frames = engine.encoder.frameCount
      try await Task.sleep(for: .seconds(2))
      #expect(StubServer.read { $0.streamRequests }.count == asks)
      #expect(engine.isRecording)
      #expect(await waitUntil(10) { engine.encoder.frameCount > frames })
      await engine.stopRecording()
      #expect(try engine.recordings().first?.parts == 1)
      await engine.close()
    }

    @Test("""
      A take carries sound from its first picture: the recording's sound track starts within one AAC \
      packet of 0 with the microphone's sound, and its export holds sound under the same head as its \
      pictures, so a reader that ignores the edit list finds both starting together
      """)
    func soundFromTheFirstPicture() async throws {
      StubServer.reset()
      let sink = TestRTMPSink()
      try sink.start()
      StubServer.with { $0.streamURL = sink.url }
      let rig = EngineRig(root: try scratchDirectory())
      let engine = try rig.engine()
      try engine.open(angleName: Self.angle)
      // The preview runs a moment before Record, as on the phone, so the microphone has sound for
      // the picture the part opens on, which was captured a picture delay before Record. Waited for
      // on the programme itself, half a second of ticks after its first picture fell due: a loaded
      // machine starts the camera late, and a part opened before then starts on a picture captured
      // after Record, with no picture delay for the window to open into.
      let opening = TickLog()
      engine.programme.observeTicks { output, at in opening.add(output, at: at) }
      #expect(await waitUntil(30) { opening.picturesDue >= 15 })
      engine.programme.observeTicks(nil)
      try engine.startRecording(
        rtmpUrl: sink.url,
        liveStreamId: Self.stream,
        gameId: Self.game,
        angleName: Self.angle,
        request: rig.request
      )
      #expect(await waitUntil { engine.status.phase == "live" })
      try await Task.sleep(for: .seconds(4))
      await engine.stopRecording()
      let packet = 1_024.0 / 48_000

      // The recording: sound from 0, and the microphone's from its first packet or two (the mix's
      // first chunk lands within one of the part's start).
      let take = try #require(try engine.recordings().first)
      let master = try #require(try partFiles(engine, take).first)
      let recorded = try await readBack(master)
      #expect(abs(recorded.audioStart) <= packet, "the recording's sound starts at \(recorded.audioStart)")
      let heard = try #require(try await firstSound(in: master))
      #expect(heard <= 2 * packet, "the microphone is first heard \(heard) s into the recording")

      // The export: played, sound from the window's start; in the file, the sound's head reaches
      // back as far as the pictures' does.
      let summary = try #require(try engine.index.recordings().first)
      let export = try #require(try await ExportService(
        index: engine.index,
        archives: engine.environment.storage.fileRoots.archives,
        programDirectory: engine.environment.storage.program,
        fallbackEncoding: { PhoneStreamProfile.takeEncoding }
      ).exportRecording(
        summary,
        cameras: [],
        includeProgram: true,
        programDirectory: engine.environment.storage.program,
        preparedRoot: engine.environment.storage.prepared
      ).first)
      let exported = try await readBack(export)
      #expect(abs(exported.audioStart) <= packet, "the export's sound starts at \(exported.audioStart)")
      let exportHeard = try #require(try await firstSound(in: export))
      #expect(exportHeard <= 2 * packet, "the microphone is first heard \(exportHeard) s into the export")
      // The heads are the copy's: the window cut from the part behind an edit list. A loaded machine
      // can send the export to a rebuild instead (its hold at Stop fell short of the take's end, "part
      // ends 0.885 s early" at a load average of 260), which starts both tracks at the window with no
      // edit list to judge. The take's master is then copied here over the same window, as the export
      // copies an unbroken take, so the heads are judged on every run.
      let anchors = try engine.index.programAnchors(recordingID: summary.id)
      let plan = ProgrammeExport.plan(
        partCount: 1,
        resumeCount: summary.resumeCount,
        anchors: anchors,
        reading: try await ProgrammeExport.read(master),
        windowStart: summary.startedAt,
        windowEnd: summary.endedAt,
        frameRate: PhoneStreamProfile.frameRate
      )
      var copy = export
      if case .reencode = plan {
        let partStart = try #require(ArchiveIndex.partStarts(anchors)[1])
        copy = master.deletingLastPathComponent().appendingPathComponent("window-copy.mp4")
        try await ArchiveRemux.copyProgramme(
          part: master,
          offset: summary.startedAt - partStart,
          length: summary.endedAt.map { $0 - summary.startedAt },
          destination: copy
        )
      }
      let asset = AVURLAsset(url: copy)
      let pictureHead = try await head(of: try #require(try await asset.loadTracks(withMediaType: .video).first))
      let soundHead = try await head(of: try #require(try await asset.loadTracks(withMediaType: .audio).first))
      #expect(pictureHead > 0.5, "the window opens \(pictureHead) s into the part: the picture delay; plan \(plan)")
      #expect(soundHead >= pictureHead - packet, "sound head \(soundHead) s, picture head \(pictureHead) s")
      await engine.close()
      sink.drop()
    }

    /// How long the track's media runs before its first edit: what a reader that ignores the edit
    /// list plays ahead of the window.
    private func head(of track: AVAssetTrack) async throws -> Double {
      let segments = try await track.load(.segments)
      return try #require(segments.first { !$0.isEmpty }).timeMapping.source.start.seconds
    }

    /// When the file's sound is first louder than a whisper, played as AVFoundation plays it.
    private func firstSound(in url: URL) async throws -> Double? {
      let asset = AVURLAsset(url: url)
      guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return nil }
      let reader = try AVAssetReader(asset: asset)
      let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
        AVSampleRateKey: 48_000,
        AVNumberOfChannelsKey: 1
      ])
      reader.add(output)
      reader.startReading()
      defer { reader.cancelReading() }
      while let sample = output.copyNextSampleBuffer() {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
        let start = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        let length = CMBlockBufferGetDataLength(block)
        var values = [Int16](repeating: 0, count: length / 2)
        _ = values.withUnsafeMutableBytes {
          CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!)
        }
        if let index = values.firstIndex(where: { abs(Int($0)) > 1_000 }) {
          return start + Double(index) / 48_000
        }
      }
      return nil
    }

    @Test("""
      After a kill the take resumes within the limit as part 2 from its first picture, the stream \
      redials with the stream held, the export spans the wall clock to a frame, and the upload sends \
      liveStreamId, startAt and wholeStream, resumes after its second part, and marks the take uploaded
      """)
    func killResumeExportAndUpload() async throws {
      StubServer.reset()
      let sink = TestRTMPSink()
      try sink.start()
      StubServer.with { $0.streamURL = sink.url }
      let rig = EngineRig(root: try scratchDirectory())
      let (first, _) = try await recording(rig, sink: sink)
      try await Task.sleep(for: .seconds(5))
      await first.abandonForTesting()
      try await Task.sleep(for: .seconds(2))

      // The relaunch.
      let engine = try rig.engine()
      try engine.open(angleName: Self.angle)
      let interrupted = try #require(engine.interruptedSession())
      #expect(interrupted.liveStreamId == Self.stream)
      #expect(interrupted.gameId == Self.game)
      #expect(interrupted.angleName == Self.angle)
      #expect(interrupted.streaming)
      #expect(interrupted.downtime > 1 && interrupted.downtime < 10)
      let resumedAt = engine.environment.clock.now
      #expect(try engine.resumeInterrupted(request: rig.request))
      #expect(engine.isRecording)
      #expect(await waitUntil { engine.status.phase == "live" })
      #expect(StubServer.read { $0.streamRequests }.first?["heldStreamId"] as? String == Self.stream)
      try await Task.sleep(for: .seconds(5))
      await engine.stopRecording()

      let take = try #require(try engine.recordings().first)
      #expect(take.parts == 2)
      #expect(take.coversWholeStream)
      #expect(try engine.index.recordings().first?.resumeCount == 1)
      // Part 2 is timed from its first picture, a picture delay after the resume, not from the resume.
      let anchors = try engine.index.programAnchors(recordingID: take.recordingID)
      let starts = ArchiveIndex.partStarts(anchors)
      let partTwo = try #require(starts[2])
      #expect(partTwo.seconds > resumedAt.seconds - 1.1)
      #expect(partTwo.seconds < resumedAt.seconds + 2)

      // The programme export: both parts placed by wall clock, as long as the take to a frame.
      let summary = try #require(try engine.index.recordings().first)
      let exported = try await ExportService(
        index: engine.index,
        archives: engine.environment.storage.fileRoots.archives,
        programDirectory: engine.environment.storage.program,
        fallbackEncoding: { PhoneStreamProfile.takeEncoding }
      ).exportRecording(
        summary,
        cameras: [],
        includeProgram: true,
        programDirectory: engine.environment.storage.program,
        preparedRoot: engine.environment.storage.prepared
      )
      let export = try #require(exported.first)
      let reading = try await readBack(export)
      let span = try #require(take.endedAt) - take.startedAt
      #expect(abs(reading.videoSeconds - span) <= 1.0 / 30 + 0.001, "export \(reading.videoSeconds) s, take \(span) s")
      #expect(reading.videoCodec == kCMVideoCodecType_HEVC)

      // A Record on the stream while its upload is cut off would add a part after the export. The
      // server's clock now reads 5 s ahead, as a phone's drifting clock would make it.
      StubServer.with { $0.holdFromPart = 2 }
      StubServer.with { $0.clockSkew = 5 }
      let log = EventLog(engine)
      let upload = Task { @MainActor in
        try await engine.uploadRecording(
          liveStreamId: Self.stream,
          apiBase: rig.request.apiBase,
          token: rig.request.token,
          title: Self.angle
        )
      }
      // The upload opens only once the export is made, and a take of more than one part is rebuilt:
      // the simulator encodes that HEVC in software, which a loaded machine slows to minutes. The
      // wait ends as soon as the parts arrive, so its bound is a loaded machine's, not a quiet one's.
      #expect(
        await waitUntil(Self.exportWait) { StubServer.read { $0.partsSent }.count == 2 },
        "upload: \(log.uploads.map { "\($0.state.rawValue) \($0.message ?? "")" })"
      )
      #expect(engine.runningUploads == [ take.recordingID ])
      try engine.open(angleName: Self.angle)
      #expect(throws: PhoneStreamError.uploadInProgress) {
        try engine.startRecording(rtmpUrl: sink.url, liveStreamId: Self.stream, gameId: Self.game,
                                  angleName: Self.angle, request: rig.request)
      }
      await #expect(throws: PhoneStreamError.uploadInProgress) { try await engine.deleteRecording(liveStreamId: Self.stream) }
      await engine.interruptUploads()
      _ = await upload.result
      #expect(log.uploads.contains { $0.state == .exporting })
      #expect(log.uploads.contains { $0.state == .uploading })
      #expect(log.uploads.last?.state == .failed)
      let opened = try #require(StubServer.read { $0.opens }.first)
      #expect(opened["liveStreamId"] as? String == Self.stream)
      #expect(opened["wholeStream"] as? Bool == true)
      #expect(opened["kind"] as? String == "program")
      #expect(opened["gameId"] as? String == Self.game)
      // The export starts at the take's start, and so does the upload: on the server's clock, 3 s ahead
      // of this machine's, by the offset the take kept from its recording rather than one read now.
      let startAt = try #require(opened["startAt"] as? String)
      let reader = ISO8601DateFormatter()
      reader.formatOptions = [ .withInternetDateTime, .withFractionalSeconds ]
      #expect(abs(try #require(reader.date(from: startAt)).timeIntervalSince(take.startedAt.date) - 3) < 0.05)
      let kept = try #require(try engine.recordings().first?.serverClockOffset)
      #expect(abs(kept - 3) < 0.05)
      await engine.close()

      // Relaunched again: the cut-off upload is still the take's, and Record on its stream refuses.
      StubServer.with { $0.holdFromPart = nil }
      let again = try rig.engine()
      try again.open(angleName: Self.angle)
      let pending = try #require(try again.recordings().first)
      #expect(pending.uploadId == "upl_0001")
      #expect(pending.hasPendingUpload)
      #expect(throws: PhoneStreamError.uploadInProgress) {
        try again.startRecording(rtmpUrl: sink.url, liveStreamId: Self.stream, gameId: Self.game,
                                 angleName: Self.angle, request: rig.request)
      }
      // Called twice in a row, one upload runs, and it carries on from the server's parts. Nothing
      // listens to this engine, as at a launch before any screen is up: where the upload stands is
      // read from it, from the half the server already had on.
      StubServer.with { $0.holdFromPart = 3 }
      #expect(again.resumePendingUploads(apiBase: rig.request.apiBase, token: rig.request.token) == 1)
      #expect(again.resumePendingUploads(apiBase: rig.request.apiBase, token: rig.request.token) == 0)
      #expect(
        await waitUntil(Self.exportWait) { (again.runningUploadProgress[take.recordingID]?.fraction ?? 0) >= 0.74 },
        "progress: \(String(describing: again.runningUploadProgress[take.recordingID]))"
      )
      let partway = try #require(again.runningUploadProgress[take.recordingID])
      #expect(partway.state == .uploading)
      #expect(partway.liveStreamId == Self.stream)
      #expect(partway.bytesSent < partway.bytesTotal)
      await again.interruptUploads()
      #expect(again.runningUploadProgress.isEmpty)
      StubServer.with { $0.holdFromPart = nil }
      #expect(again.resumePendingUploads(apiBase: rig.request.apiBase, token: rig.request.token) == 1)
      let video = try await again.uploadRecording(
        liveStreamId: Self.stream,
        apiBase: rig.request.apiBase,
        token: rig.request.token,
        title: Self.angle
      )
      #expect(video == "vid_0001")
      #expect(StubServer.read { $0.opens }.count == 1)
      #expect(StubServer.read { $0.stateAsks } >= 1)
      #expect(StubServer.read { $0.finishes } == 1)
      #expect(StubServer.read { $0.partsSent } == [ 0, 1, 2, 3 ])
      #expect(again.runningUploadProgress.isEmpty)
      let uploaded = try #require(try again.recordings().first)
      #expect(uploaded.isUploaded)
      #expect(uploaded.videoId == "vid_0001")
      #expect(!FileManager.default.fileExists(atPath: RecordingExport.preparedDirectory(
        recordingID: uploaded.recordingID,
        in: again.environment.storage.prepared
      ).path))
      // Finished rows are skipped, and asking again answers the video it became.
      #expect(again.resumePendingUploads(apiBase: rig.request.apiBase, token: rig.request.token) == 0)
      #expect(try await again.uploadRecording(liveStreamId: Self.stream, apiBase: rig.request.apiBase,
                                              token: rig.request.token, title: Self.angle) == "vid_0001")
      // Uploaded, the take is kept for a week, then swept; and it can be deleted by hand.
      try await again.deleteRecording(liveStreamId: Self.stream)
      #expect(try again.recordings().isEmpty)
      try await again.deleteRecording(liveStreamId: Self.stream)
      await again.close()
      sink.drop()
    }

    @Test("""
      A part finishes cleanly when free space falls under 500 MB while the stream goes on, and the \
      take's upload then sends no wholeStream
      """)
    func lowStorageStopsThePart() async throws {
      StubServer.reset()
      let sink = TestRTMPSink()
      try sink.start()
      let rig = EngineRig(root: try scratchDirectory())
      let (engine, _) = try await recording(rig, sink: sink)
      try await Task.sleep(for: .seconds(3))
      rig.free.bytes = 400_000_000
      #expect(await waitUntil { engine.status.error == .recordingStoppedLowStorage })
      #expect(await waitUntil { !engine.isRecording })
      #expect(engine.status.phase == "live")
      #expect(engine.isStreaming)
      // On the air with no part recording, ten statuses a second here: the take is marked as
      // published outside its parts once, not at every status.
      try await Task.sleep(for: .seconds(1))
      #expect(engine.outsidePartsWrites == 1)
      #expect(try engine.recordings().first?.publishedOutsideParts == true)
      await #expect(throws: PhoneStreamError.stillRecording) { try await engine.deleteRecording(liveStreamId: Self.stream) }
      await #expect(throws: PhoneStreamError.stillRecording) {
        try await engine.uploadRecording(liveStreamId: Self.stream, apiBase: rig.request.apiBase,
                                         token: rig.request.token, title: Self.angle)
      }
      await engine.stopRecording()
      let take = try #require(try engine.recordings().first)
      #expect(take.stoppedForLowStorage)
      #expect(!take.coversWholeStream)
      #expect(take.endedAt != nil)

      _ = try await engine.uploadRecording(
        liveStreamId: Self.stream,
        apiBase: rig.request.apiBase,
        token: rig.request.token,
        title: Self.angle
      )
      let opened = try #require(StubServer.read { $0.opens }.first)
      #expect(opened["liveStreamId"] as? String == Self.stream)
      #expect(opened["wholeStream"] == nil)
      await #expect(throws: PhoneStreamError.noRecording) {
        try await engine.uploadRecording(liveStreamId: "lst_0009", apiBase: rig.request.apiBase,
                                         token: rig.request.token, title: Self.angle)
      }

      // Deleted straight after Stop, a take waits for its part's file to be closed first.
      rig.free.bytes = 50_000_000_000
      try engine.startRecording(rtmpUrl: sink.url, liveStreamId: "lst_0002", gameId: Self.game,
                                angleName: "First Base", request: rig.request)
      try await Task.sleep(for: .seconds(2))
      let second = try #require(try engine.recordings().first { $0.liveStreamId == "lst_0002" })
      let stopping = Task { @MainActor in await engine.stopRecording() }
      #expect(await waitUntil { engine.isFinishingPart })
      try await engine.deleteRecording(liveStreamId: "lst_0002")
      #expect(!engine.isFinishingPart)
      #expect(try engine.recordings().allSatisfy { $0.liveStreamId != "lst_0002" })
      #expect(try engine.index.recordings().allSatisfy { $0.id != second.recordingID })
      await stopping.value
      await engine.close()
      sink.drop()
    }

    @Test("""
      Going to the background finishes the part and drops the stream; the foreground continues the \
      take as its next part, and a second Record on the stream continues it again
      """)
    func backgroundAndRecordAgain() async throws {
      StubServer.reset()
      let sink = TestRTMPSink()
      try sink.start()
      StubServer.with { $0.streamURL = sink.url }
      let rig = EngineRig(root: try scratchDirectory())
      let work = WorkLog()
      let engine = try rig.engine(backgroundWork: work.work)
      try engine.open(angleName: Self.angle)
      try engine.startRecording(rtmpUrl: sink.url, liveStreamId: Self.stream, gameId: Self.game,
                                angleName: Self.angle, request: rig.request)
      #expect(await waitUntil { engine.status.phase == "live" })
      try await Task.sleep(for: .seconds(3))
      // Back in the foreground while the background is still finishing the part: the foreground
      // waits for the finish and continues the take, whichever of the two the finish wakes first.
      let background = Task { @MainActor in await engine.enterBackground() }
      #expect(await waitUntil { engine.isFinishingPart })
      #expect(!engine.isRecording)
      #expect(engine.status.phase == "idle")
      await engine.enterBackground()
      await engine.enterForeground()
      await background.value
      #expect(engine.isRecording)
      #expect(engine.status.error == nil)
      // The background's finish ran under a background task, ended once it was done.
      let finishTask = try #require(work.id(of: "Finish part"))
      #expect(work.ended == [ finishTask ])
      #expect(await waitUntil { engine.status.phase == "live" })
      try await Task.sleep(for: .seconds(3))
      await engine.stopRecording()
      #expect(try engine.recordings().first?.parts == 2)
      await engine.enterForeground()
      #expect(!engine.isRecording)

      // A later Record on the same stream is the same take, as part 3.
      try engine.startRecording(rtmpUrl: sink.url, liveStreamId: Self.stream, gameId: Self.game,
                                angleName: Self.angle, request: rig.request)
      #expect(await waitUntil { engine.status.phase == "live" })
      try await Task.sleep(for: .seconds(3))
      await engine.stopRecording()
      let take = try #require(try engine.recordings().first)
      #expect(try engine.recordings().count == 1)
      #expect(take.parts == 3)
      #expect(take.endedAt != nil)
      #expect(try engine.index.recordings().first?.resumeCount == 2)

      // Another stream is a new take; one cancelled upload leaves it free to record on.
      StubServer.with { $0.holdFromPart = 0 }
      let log = EventLog(engine)
      let upload = Task { @MainActor in
        try await engine.uploadRecording(liveStreamId: Self.stream, apiBase: rig.request.apiBase,
                                         token: rig.request.token, title: Self.angle)
      }
      // While the three-part rebuild is still being made, before the server has an upload for it,
      // Record on its stream is refused all the same: a part added now would not be in the file.
      #expect(await waitUntil { engine.runningUploads == [ take.recordingID ] })
      #expect(try engine.recordings().first?.uploadId == nil)
      #expect(throws: PhoneStreamError.uploadInProgress) {
        try engine.startRecording(rtmpUrl: sink.url, liveStreamId: Self.stream, gameId: Self.game,
                                  angleName: Self.angle, request: rig.request)
      }
      #expect(!engine.isRecording)
      // Opened after the three-part rebuild, as above.
      #expect(
        await waitUntil(Self.exportWait) { (try? engine.recordings().first?.uploadId) != nil },
        "upload: \(log.uploads.map { "\($0.state.rawValue) \($0.message ?? "")" })"
      )
      // The background time runs out: the upload stops where it is, keeps its id to resume, and
      // its task is ended once.
      let uploadTask = try #require(work.id(of: "Upload Home Plate"))
      work.expire("Upload Home Plate")
      _ = await upload.result
      #expect(engine.runningUploads.isEmpty)
      #expect(try engine.recordings().first?.uploadId == "upl_0001")
      #expect(work.ended.filter { $0 == uploadTask }.count == 1)
      await engine.cancelUpload(liveStreamId: Self.stream)
      #expect(try engine.recordings().first?.uploadId == nil)
      #expect(engine.runningUploads.isEmpty)
      await engine.cancelUpload(liveStreamId: "lst_0009")
      await engine.close()
      sink.drop()
    }

    @Test("A foreground resume that cannot run says so in the status instead of going quiet")
    func foregroundResumeThatFails() async throws {
      StubServer.reset()
      let sink = TestRTMPSink()
      try sink.start()
      let rig = EngineRig(root: try scratchDirectory())
      let (engine, _) = try await recording(rig, sink: sink)
      try await Task.sleep(for: .seconds(2))
      await engine.enterBackground()
      // The stream kept for the resume cannot be read back.
      let store = try SQLiteStore(url: PhoneStorage(root: rig.root).index)
      try store.execute("DROP TABLE phone_live;")
      await engine.enterForeground()
      #expect(!engine.isStreaming)
      #expect(!engine.isRecording)
      #expect(engine.status.error == .recordingFailed)
      await engine.close()
      sink.drop()
    }

    @Test("""
      A take a kill left open is closed where it got to when another stream starts, continues \
      without recording when space is short, and is not resumed past the hour
      """)
    func interruptedTakesThatDoNotResume() async throws {
      StubServer.reset()
      let sink = TestRTMPSink()
      try sink.start()
      StubServer.with { $0.streamURL = sink.url }
      let rig = EngineRig(root: try scratchDirectory())
      let (first, _) = try await recording(rig, sink: sink)
      try await Task.sleep(for: .seconds(3))
      await first.abandonForTesting()

      // Relaunched, and Record on another stream: the interrupted take ends where it got to.
      let second = try rig.engine()
      try second.open(angleName: "First Base")
      #expect(second.interruptedSession()?.liveStreamId == Self.stream)
      try second.startRecording(rtmpUrl: sink.url, liveStreamId: "lst_0002", gameId: Self.game,
                                angleName: "First Base", request: rig.request)
      let closed = try #require(try second.recordings().first { $0.liveStreamId == Self.stream })
      #expect(closed.endedAt != nil)
      #expect(await waitUntil { second.status.phase == "live" })
      try await Task.sleep(for: .seconds(3))
      await second.abandonForTesting()

      // Relaunched with too little space: the stream comes back, the take does not.
      rig.free.bytes = 1_000_000_000
      let third = try rig.engine()
      try third.open(angleName: "First Base")
      #expect(try third.resumeInterrupted(request: rig.request))
      #expect(!third.isRecording)
      #expect(third.isStreaming)
      #expect(third.status.error == .recordingStoppedLowStorage)
      #expect(await waitUntil { third.status.phase == "live" })
      // On the air with no part recording: the take no longer covers the whole stream.
      #expect(await waitUntil {
        (try? third.recordings().first { $0.liveStreamId == "lst_0002" })?.publishedOutsideParts == true
      })
      let short = try #require(try third.recordings().first { $0.liveStreamId == "lst_0002" })
      #expect(short.stoppedForLowStorage)
      #expect(short.endedAt != nil)
      await third.stopRecording()
      #expect(!third.isFinishingPart)

      // A take away for longer than the hour is closed, not resumed.
      rig.free.bytes = 50_000_000_000
      try third.startRecording(rtmpUrl: sink.url, liveStreamId: "lst_0003", gameId: Self.game,
                               angleName: "Third Base", request: rig.request)
      #expect(await waitUntil { third.status.phase == "live" })
      try await Task.sleep(for: .seconds(3))
      await third.abandonForTesting()
      let store = try SQLiteStore(url: PhoneStorage(root: rig.root).index)
      try store.execute("UPDATE live_session SET last_alive = last_alive - 3660;")
      let engine = try rig.engine()
      try engine.open(angleName: "Third Base")
      #expect(engine.interruptedSession() == nil)
      #expect(try engine.resumeInterrupted(request: rig.request) == false)
      let take = try #require(try engine.recordings().first { $0.liveStreamId == "lst_0003" })
      #expect(take.endedAt != nil)
      #expect(try engine.index.liveSession() == nil)
      #expect(!engine.isRecording)
      #expect(try engine.recordings().count == 3)
      await engine.close()
      sink.drop()
    }
  }
}
