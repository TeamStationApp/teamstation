import AudioToolbox
import CoreMedia
import DirectorCore
@testable import DirectorPipeline
@testable import DirectorRTSP
import DirectorSources
import Foundation
import Testing

/// Each camera's sound on its own timeline, placed by capture time and read by both mixes (U-D2).
///
/// One game's live sound had 20,550 silences of 16–64 ms from the moment its sound camera
/// reconnected, and another's a silence every ~200 ms while the iPad lost programme ticks: live sound was timed from the picture's jitter-buffer offset, re-rolled
/// on every reconnect, and handed to a mix 20 ms behind only after the picture decodes.
@Suite("Source sound timeline")
struct SourceSoundTimelineTests {
  static let rate = 48_000.0
  static let chunk = 960
  static let fade = SourceSoundTimeline.fadeFrames
  static let level: Int16 = 10_000

  // MARK: - Laying sound down

  @Test("Within a run, sound is laid down by sample count whatever the capture times jitter by")
  func contiguousWithinJitter() {
    let rig = Rig(now: 101.5)
    let jitter = [0.0, 0.03, -0.03, 0.012, -0.025, 0.038, -0.039, 0.003]
    for index in 0 ..< 50 {
      rig.append(at: 100 + Double(index) * 0.02 + jitter[index % jitter.count], index: index)
    }
    let out = rig.read(from: 100, seconds: 1)
    // Fade in over the first 15 ms, the tone untouched in between, faded out over the last 15 ms.
    #expect(out[Self.fade ..< (out.count - Self.fade)].allSatisfy { $0 == Int32(Self.level) })
    #expect(out.first ?? -1 < 100)
    #expect(out.last ?? -1 < 100)
    let stats = rig.timeline.currentStatistics
    #expect(stats.timelines == 1)
    #expect(stats.steps == 0)
    #expect(stats.gaps == 0)
    #expect(abs(stats.lastErrorSeconds) < 0.04)
  }

  @Test("An error under 4 ms, or between 4 and 100 ms, moves nothing")
  func smallErrorsAreIgnored() {
    for offset in [ 0.003, 0.06, -0.09 ] {
      let rig = Rig(now: 102.5)
      for index in 0 ..< 100 {
        // From the second buffer on the mapping sits `offset` away from the run, for two seconds.
        rig.append(at: 100 + Double(index) * 0.02 + (index > 0 ? offset : 0), index: index)
      }
      let out = rig.read(from: 100, seconds: 2)
      #expect(rig.timeline.currentStatistics.steps == 0)
      #expect(rig.timeline.currentStatistics.timelines == 1)
      #expect(out[Self.fade ..< (out.count - Self.fade)].allSatisfy { $0 == Int32(Self.level) })
    }
  }

  @Test("An error over 100 ms held for a second is one step, faded out and in")
  func sustainedErrorSteps() {
    let rig = Rig(now: 103.5)
    for index in 0 ..< 150 {
      rig.append(at: 100 + Double(index) * 0.02 + (index >= 50 ? 0.15 : 0), index: index)
    }
    #expect(rig.timeline.currentStatistics.steps == 1)
    let out = rig.readInChunks(from: 100, seconds: 3.2)
    // The old run plays to 2.0 s and fades out before it; the new run starts at its mapped place,
    // 1 s of error after it began (buffer 100, captured at 102.0, mapped to 102.15).
    let end = Int(2.0 * Self.rate)
    let resume = Int(2.15 * Self.rate)
    #expect(out[(end - Self.fade) ..< end].map(abs).max() ?? 0 <= Int32(Self.level))
    #expect(out[end - 1] < 100)
    #expect(out[end ..< resume].allSatisfy { $0 == 0 })
    #expect(out[resume] < 100)
    #expect(out[(resume + Self.fade) ..< (resume + 4_800)].allSatisfy { $0 == Int32(Self.level) })
    // One fade at the step and one where the sound ends.
    #expect(rig.reader.fades == 2)
    // Nothing else: the old run is whole up to its fade.
    #expect(out[Self.fade ..< (end - Self.fade)].allSatisfy { $0 == Int32(Self.level) })
  }

  @Test("A step back supersedes what the old run left ahead of it")
  func stepBackSupersedes() {
    let rig = Rig(now: 103.5)
    for index in 0 ..< 150 {
      rig.append(at: 100 + Double(index) * 0.02 - (index >= 50 ? 0.15 : 0), index: index, value: index >= 100 ? 5_000 : Self.level)
    }
    #expect(rig.timeline.currentStatistics.steps == 1)
    let out = rig.readInChunks(from: 100, seconds: 3)
    // Buffer 100 (value 5,000) now starts at 1.85 s; the old run is cut there under a fade.
    let cut = Int(1.85 * Self.rate)
    #expect(out[cut - Self.fade - 10] == Int32(Self.level))
    #expect(out[cut - 1] < 100)
    #expect(out[cut + Self.fade + 10] == 5_000)
    // One fade at the step and one where the sound ends.
    #expect(rig.reader.fades == 2)
  }

  @Test("A new session, or an error over a second, starts a new timeline at once")
  func newTimeline() {
    let session = Rig(now: 102.5)
    for index in 0 ..< 100 {
      session.append(at: 100 + Double(index) * 0.02, index: index, session: index >= 50 ? 2 : 1)
    }
    #expect(session.timeline.currentStatistics.timelines == 2)
    let out = session.readInChunks(from: 100, seconds: 2)
    let seam = Int(1.0 * Self.rate)
    #expect(out[seam - 1] < 100)
    #expect(out[seam] < 100)
    #expect(out[seam + Self.fade + 1] == Int32(Self.level))
    // One fade at the new timeline and one where the sound ends.
    #expect(session.reader.fades == 2)

    let jump = Rig(now: 104.5)
    for index in 0 ..< 100 {
      jump.append(at: 100 + Double(index) * 0.02 + (index >= 50 ? 2 : 0), index: index)
    }
    #expect(jump.timeline.currentStatistics.timelines == 2)
    #expect(jump.timeline.currentStatistics.steps == 0)
  }

  @Test("A gap in the source's own count is left as a gap, faded around")
  func lostPacketLeavesAGap() {
    let rig = Rig(now: 101.5)
    for index in 0 ..< 50 where index != 20 {
      rig.append(at: 100 + Double(index) * 0.02, index: index)
    }
    #expect(rig.timeline.currentStatistics.gaps == 1)
    #expect(abs(rig.timeline.currentStatistics.gapSeconds - 0.02) < 0.000_1)
    let out = rig.readInChunks(from: 100, seconds: 1)
    let hole = Int(0.4 * Self.rate)
    #expect(out[hole ..< (hole + Self.chunk)].allSatisfy { $0 == 0 })
    #expect(out[hole - 1] < 100)
    #expect(out[hole + Self.chunk + Self.fade + 1] == Int32(Self.level))
    // Placed by count, not moved: the sound after the hole is where the camera's count says.
    #expect(rig.timeline.currentStatistics.steps == 0)
  }

  @Test("Sound the run already holds is not laid down twice")
  func overlapIsDropped() {
    let rig = Rig(now: 101.5)
    rig.append(at: 100, index: 0)
    // The same buffer again, half overlapping: only its second half is new.
    rig.append(at: 100.01, position: 480, frames: 960)
    rig.append(at: 100.03, position: 1_440, frames: 480)
    rig.append(at: 100.04, position: 0, frames: 960)
    let stats = rig.timeline.currentStatistics
    #expect(stats.writeEnd == Int64((100.04 * Self.rate).rounded()))
    #expect(stats.appendedBuffers == 3)
  }

  // MARK: - Reading

  @Test("An underrun fades the last 15 ms out and then contributes zeros")
  func underrunFadesOut() {
    let rig = Rig(now: 101)
    for index in 0 ..< 25 { rig.append(at: 100 + Double(index) * 0.02, index: index) }
    let out = rig.readInChunks(from: 100, seconds: 1)
    let end = Int(0.5 * Self.rate)
    let ramp = Array(out[(end - Self.fade) ..< end])
    #expect(zip(ramp, ramp.dropFirst()).allSatisfy { $0 >= $1 })
    #expect(ramp.first ?? 0 > 9_900)
    #expect(ramp.last ?? 1 < 50)
    #expect(out[end...].allSatisfy { $0 == 0 })
    #expect(rig.reader.phase == .silent)
    #expect(rig.reader.fades == 1)
    #expect(abs(rig.reader.concealedSeconds - 0.5) < 0.001)
  }

  @Test("Returning sound waits for its reserve, then fades in over 15 ms")
  func resumeAtReserveWithFadeIn() {
    let rig = Rig(now: 101.5)
    for index in 0 ..< 25 { rig.append(at: 100 + Double(index) * 0.02, index: index) }
    var out = rig.readInChunks(from: 100, seconds: 1, reserve: 2_400)
    // 40 ms comes back after a 0.5 s gap: less than the 50 ms reserve.
    for index in 50 ..< 52 { rig.append(at: 100 + Double(index) * 0.02, index: index) }
    out += rig.readInChunks(from: 101, seconds: 0.02, reserve: 2_400)
    #expect(rig.reader.phase == .buffering)
    #expect(out.suffix(Self.chunk).allSatisfy { $0 == 0 })
    // Enough arrives; the next chunk fades in where the mapping puts it.
    for index in 52 ..< 60 { rig.append(at: 100 + Double(index) * 0.02, index: index) }
    let resumed = rig.readInChunks(from: 101.02, seconds: 0.04, reserve: 2_400)
    #expect(resumed[0] < 100)
    let ramp = Array(resumed[0 ..< Self.fade])
    #expect(zip(ramp, ramp.dropFirst()).allSatisfy { $0 <= $1 })
    #expect(resumed[Self.fade] == Int32(Self.level))
    #expect(rig.reader.phase == .playing)
  }

  @Test("Sound written behind where a mix has read counts as late for that mix only")
  func lateIsPerReader() {
    let rig = Rig(now: 101)
    _ = rig.readInChunks(from: 100, seconds: 0.5)
    rig.append(at: 100.2, index: 0, session: 9)
    #expect(rig.timeline.lateBuffers(for: rig.reader.id) == 1)
    #expect(rig.timeline.lateBuffers(for: rig.reader.id + 1) == 0)
  }

  @Test("Sound placed beyond a second ahead, or beyond what the ring holds, is refused")
  func futureAndStale() {
    let rig = Rig(now: 100)
    rig.append(at: 102, index: 0, session: 1)
    rig.append(at: 80, index: 0, session: 2)
    let stats = rig.timeline.currentStatistics
    #expect(stats.futureBuffers == 1)
    #expect(stats.staleBuffers == 1)
    #expect(stats.appendedBuffers == 0)
  }

  @Test("A trim moves a camera's sound by a constant")
  func trimMovesPlacement() {
    let timelines = SourceSoundTimelines(clock: FixedClock(101), uptime: { 101 })
    timelines.setTrims([ SourceID("camera"): 0.055 ])
    timelines.append(Rig.frame(at: 100, position: 0, frames: 960, session: 1))
    #expect(timelines.existing(SourceID("camera"))?.currentStatistics.writeEnd == Int64((100.075 * Self.rate).rounded()))
    timelines.setTrims([:])
    #expect(timelines.timeline(for: SourceID("camera")).trimSeconds == 0)
    timelines.retain([])
    #expect(timelines.existing(SourceID("camera")) == nil)
    timelines.append(Rig.frame(at: 100, position: 0, frames: 960, session: 1))
    timelines.removeAll()
    #expect(timelines.existing(SourceID("camera")) == nil)
  }

  @Test("Reset forgets the run; the next buffer starts a new timeline")
  func resetStartsAgain() {
    let rig = Rig(now: 101)
    rig.append(at: 100, index: 0)
    rig.timeline.reset()
    rig.append(at: 100.5, index: 1)
    #expect(rig.timeline.currentStatistics.timelines == 2)
    #expect(rig.timeline.secondsHeld(after: Int64(100.5 * Self.rate)) ?? 0 > 0.019)
    #expect(rig.timeline.secondsHeld(after: Int64(101 * Self.rate)) == nil)
  }

  // MARK: - Mixes

  @Test("The live mix hears a camera its read lag after capture; the recording at capture")
  func mixesReadAtTheirLag() {
    let clock = FixedClock(100)
    let uptime: @Sendable () -> Double = { clock.now.seconds }
    let timelines = SourceSoundTimelines(clock: clock, uptime: uptime)
    let live = Collected()
    let recording = Collected()
    let liveMixer = AudioMixer(clock: clock, readLagSeconds: 0.5, uptime: uptime, runsTimer: false, timelines: timelines) { live.add($0) }
    let recordingMixer = AudioMixer(clock: clock, delaySeconds: 5, uptime: uptime, runsTimer: false, timelines: timelines) { recording.add($0) }
    for mixer in [ liveMixer, recordingMixer ] {
      mixer.start()
      mixer.setContributors([ SourceID("camera") ])
    }
    for index in 0 ..< 50 {
      clock.set(100.2 + Double(index) * 0.02)
      timelines.append(Rig.frame(at: 100.2 + Double(index) * 0.02, position: Int64(index) * 960, frames: 960, session: 1))
      liveMixer.emitReadyChunks()
    }
    clock.set(107)
    liveMixer.emitReadyChunks()
    recordingMixer.emitReadyChunks()
    // Captured from 100.2 for a second: the live mix plays it from 100.7, the recording from 100.2.
    #expect(live.loudWalls.first == 100.7)
    #expect(live.loudWalls.count == 50)
    #expect(recording.loudWalls.first == 100.2)
    #expect(liveMixer.currentStatistics.lateBuffers == 0)
    #expect(liveMixer.currentStatistics.readLagSeconds == 0.5)
    #expect(liveMixer.reader(for: SourceID("camera"))?.phase == .silent)
    #expect(liveMixer.currentStatistics.fades == 1)
  }

  @Test("Moving the live mix's read lag fades every source out and in again")
  func readLagChangeFades() {
    let clock = FixedClock(100)
    let uptime: @Sendable () -> Double = { clock.now.seconds }
    let live = Collected()
    let mixer = AudioMixer(clock: clock, readLagSeconds: 0.5, uptime: uptime, runsTimer: false) { live.add($0) }
    mixer.setReadLag(seconds: 0.4)
    #expect(mixer.currentStatistics.readLagSeconds == 0.4)
    mixer.start()
    for index in 0 ..< 150 {
      clock.set(100 + Double(index) * 0.02)
      mixer.append(Rig.frame(at: 100 + Double(index) * 0.02, position: Int64(index) * 960, frames: 960, session: 1))
      mixer.emitReadyChunks()
      if index == 75 { mixer.setReadLag(seconds: 0.6) }
    }
    #expect(mixer.currentStatistics.readLagSeconds == 0.6)
    #expect(mixer.currentStatistics.fades == 1)
    // Picked up again at the new lag.
    #expect(mixer.reader(for: SourceID("camera"))?.phase == .playing)
  }

  @Test("The live sound delay is the display cap, 1 s when it is off, within 0.1–2 s")
  func liveSoundDelayFromCap() {
    #expect(TileRouter.liveSoundDelaySeconds(capEnabled: true, capMilliseconds: 500) == 0.5)
    #expect(TileRouter.liveSoundDelaySeconds(capEnabled: true, capMilliseconds: 800) == 0.8)
    #expect(TileRouter.liveSoundDelaySeconds(capEnabled: false, capMilliseconds: 800) == 1)
    #expect(TileRouter.liveSoundDelaySeconds(capEnabled: true, capMilliseconds: 0) == 1)
    #expect(TileRouter.liveSoundDelaySeconds(capEnabled: true, capMilliseconds: 20) == 0.1)
    #expect(TileRouter.liveSoundDelaySeconds(capEnabled: true, capMilliseconds: 9_000) == 2)
  }

  @Test("Raised cosine runs from 0 to 1")
  func raisedCosine() {
    #expect(SourceSoundTimeline.rise(0, of: 720) == 0)
    #expect(SourceSoundTimeline.rise(720, of: 720) == 1)
    #expect(abs(SourceSoundTimeline.rise(360, of: 720) - 0.5) < 1e-9)
    #expect(SourceSoundTimeline.rise(3, of: 0) == 1)
  }

  // MARK: - Reconnects and the receive thread

  @Test("The camera's clock offset survives a reconnect, so a delayed first report moves nothing")
  func offsetKeptAcrossReconnect() {
    let now = 1_800_000_000.0
    var audit = RTPClockAudit()
    // Session one: the camera runs 2.15 s ahead; its least-delayed report says exactly that.
    audit.note(report: report(ssrc: 7, camera: now + 2.15, rtp: 90_000), arrivalUptime: 10, wallClockNow: Date(timeIntervalSince1970: now))
    audit.note(report: report(ssrc: 7, camera: now + 3.15, rtp: 180_000), arrivalUptime: 11.2, wallClockNow: Date(timeIntervalSince1970: now + 1.2))
    #expect(abs(audit.filteredOffsetSeconds - 2.15) < 0.001)

    // A reconnect; the new session's first report spent 300 ms in flight.
    audit.reset(keepingClockOffset: true)
    #expect(audit.captureTimeOnLocalClock(rtpTimestamp: 1_000, ssrc: 9) == nil)
    audit.note(report: report(ssrc: 9, camera: now + 62.15, rtp: 1_000), arrivalUptime: 70.3, wallClockNow: Date(timeIntervalSince1970: now + 60.3))
    let capture = audit.captureTimeOnLocalClock(rtpTimestamp: 1_000, ssrc: 9) ?? 0
    // Placed where it was captured, not 300 ms later: A/V alignment is what it was before the drop.
    #expect(abs(capture - (now + 60)) < 0.001)
    #expect(audit.offsetSampleCount == 3)

    // A different device behind the same source drops the carried estimate.
    audit.reset(keepingClockOffset: false)
    audit.note(report: report(ssrc: 11, camera: now + 100.15, rtp: 1_000), arrivalUptime: 110, wallClockNow: Date(timeIntervalSince1970: now + 100.3))
    #expect(abs(audit.filteredOffsetSeconds - (-0.15)) < 0.001)
  }

  @Test("A camera clock that steps back is followed once the step has held ten seconds")
  func clockStepBackIsAdopted() {
    let now = 1_800_000_000.0
    var audit = RTPClockAudit()
    // A camera 200 ms ahead, reporting once a second for a minute.
    for second in 0 ..< 60 {
      let at = Double(second)
      audit.note(report: report(ssrc: 7, camera: now + at + 0.2, rtp: UInt32(second) * 90_000), arrivalUptime: at, wallClockNow: Date(timeIntervalSince1970: now + at))
    }
    #expect(abs(audit.filteredOffsetSeconds - 0.2) < 0.001)
    // Five seconds of congestion delaying the reports by 300 ms changes nothing.
    for second in 60 ..< 65 {
      let at = Double(second)
      audit.note(report: report(ssrc: 7, camera: now + at + 0.2, rtp: UInt32(second) * 90_000), arrivalUptime: at + 0.3, wallClockNow: Date(timeIntervalSince1970: now + at + 0.3))
    }
    #expect(abs(audit.filteredOffsetSeconds - 0.2) < 0.001)
    #expect(audit.clockSteps == 0)
    // Then the camera's clock steps back 240 ms and stays there.
    for second in 65 ..< 80 {
      let at = Double(second)
      audit.note(report: report(ssrc: 7, camera: now + at - 0.04, rtp: UInt32(second) * 90_000), arrivalUptime: at, wallClockNow: Date(timeIntervalSince1970: now + at))
    }
    #expect(audit.clockSteps == 1)
    #expect(abs(audit.filteredOffsetSeconds + 0.04) < 0.001)
    // A picture captured now is placed now, not 240 ms early.
    let capture = audit.captureTimeOnLocalClock(rtpTimestamp: 79 * 90_000, ssrc: 7) ?? 0
    #expect(abs(capture - (now + 79)) < 0.001)
  }

  @Test("Reports held 0.3-2 s and released in bursts are not a clock step, however long it lasts")
  func heldReportsAreNotAStep() {
    let now = 1_800_000_000.0
    var audit = RTPClockAudit()
    for second in 0 ..< 60 {
      let at = Double(second)
      audit.note(report: report(ssrc: 7, camera: now + at + 0.2, rtp: UInt32(second) * 90_000), arrivalUptime: at, wallClockNow: Date(timeIntervalSince1970: now + at))
    }
    // Two minutes of a struggling phone: every report held, for 0.3-2 s, and the held ones released
    // together at the end of each hold.
    var state: UInt64 = 7
    func unit() -> Double {
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Double(state >> 11) / Double(UInt64(1) << 53)
    }
    var second = 60
    while second < 180 {
      let hold = 0.3 + 1.7 * unit()
      let release = Double(second) + hold
      var sent = Double(second)
      while sent < release, second < 180 {
        audit.note(report: report(ssrc: 7, camera: now + sent + 0.2, rtp: UInt32(second) * 90_000), arrivalUptime: release, wallClockNow: Date(timeIntervalSince1970: now + release))
        second += 1
        sent = Double(second)
      }
    }
    #expect(audit.clockSteps == 0)
    #expect(abs(audit.filteredOffsetSeconds - 0.2) < 0.001)
    let capture = audit.captureTimeOnLocalClock(rtpTimestamp: 179 * 90_000, ssrc: 7) ?? 0
    #expect(abs(capture - (now + 179)) < 0.001)
  }

  @Test("A few reports above the envelope do not move it; a camera that disagrees with itself gets its median")
  func isolatedHighReportsAreIgnored() {
    let now = 1_800_000_000.0
    var audit = RTPClockAudit()
    for second in 0 ..< 60 {
      let at = Double(second)
      let wrong = [ 10, 25, 40, 41 ].contains(second) ? 0.7 + Double(second) / 100 : 0
      audit.note(report: report(ssrc: 7, camera: now + at + 0.2 + wrong, rtp: UInt32(second) * 90_000), arrivalUptime: at, wallClockNow: Date(timeIntervalSince1970: now + at))
    }
    #expect(abs(audit.filteredOffsetSeconds - 0.2) < 0.001)
    #expect(RTPClockAudit.envelope([]) == nil)
    // Too few to judge: the largest, as delay only ever lowers a reading.
    #expect(RTPClockAudit.envelope([ 0.9, 0.5, 0.1 ]) == 0.9)
    let cluster = [ 0.9, 0.5, 0.49, 0.48 ] + Array(repeating: 0.3, count: 8)
    #expect(RTPClockAudit.envelope(cluster) == 0.5)
    let spread = stride(from: 1.1, to: 0.0, by: -0.1).map { $0 }
    #expect(abs((RTPClockAudit.envelope(spread) ?? 0) - 0.9) < 1e-9)
  }

  @Test("After a reconnect the camera's new reading replaces the carried one once it has held")
  func carriedOffsetGivesWay() {
    let now = 1_800_000_000.0
    var audit = RTPClockAudit()
    for second in 0 ..< 30 {
      let at = Double(second)
      audit.note(report: report(ssrc: 7, camera: now + at + 0.2, rtp: UInt32(second) * 90_000), arrivalUptime: at, wallClockNow: Date(timeIntervalSince1970: now + at))
    }
    audit.reset(keepingClockOffset: true)
    // The new session's clock sits 240 ms back: its own pairing is new, so only the carried
    // estimate contradicts it.
    for second in 40 ..< 55 {
      let at = Double(second)
      audit.note(report: report(ssrc: 8, camera: now + at - 0.04, rtp: UInt32(second - 40) * 90_000), arrivalUptime: at, wallClockNow: Date(timeIntervalSince1970: now + at))
    }
    #expect(audit.clockSteps == 1)
    #expect(abs(audit.filteredOffsetSeconds + 0.04) < 0.001)
  }

  @Test("Sound reaches its timeline while a picture decode holds the drain queue")
  func soundNotBehindPictureDecode() throws {
    let source = RTSPFrameSource(
      sourceID: SourceID("camera"),
      displayName: "camera",
      configuration: RTSPSession.Configuration(host: "127.0.0.1", port: 9)
    )
    let delivered = DispatchSemaphore(value: 0)
    let timelines = SourceSoundTimelines(clock: SystemClock())
    source.installSinks(FrameSinks(
      pixel: { _ in },
      recordingAudio: { frame in
        timelines.append(frame)
        delivered.signal()
      }
    ))
    // A picture decode that takes a second, on the drain queue.
    let release = DispatchSemaphore(value: 0)
    source.drainQueue.async { _ = release.wait(timeout: .now() + 5) }

    let output = AACAudioDecoder.Output(
      samples: [Int16](repeating: 1_000, count: 1_024 * 2),
      sampleRate: 48_000,
      channelCount: 2
    )
    DispatchQueue.global().async {
      source.deliverDecodedSound(output, rtpTimestamp: 0, sourceRate: 48_000, capture: Date().timeIntervalSince1970, arrival: WallClock(seconds: Date().timeIntervalSince1970))
    }
    // Delivered while the drain queue is still blocked.
    #expect(delivered.wait(timeout: .now() + 1) == .success)
    #expect(timelines.existing(SourceID("camera"))?.currentStatistics.appendedBuffers == 1)
    release.signal()
  }

  @Test("A run begun on arrival time moves once to the first capture time, and only once")
  func provisionalRunReanchors() {
    let rig = Rig(now: 102)
    // Before the first sender report: placed where it arrived, 60 ms after it was captured.
    for index in 0 ..< 10 {
      rig.timeline.append(Rig.frame(at: 100.06 + Double(index) * 0.02, position: Int64(index) * 960, frames: 960, session: 1))
    }
    // The report lands: capture times put the same sound 60 ms earlier.
    for index in 10 ..< 60 {
      rig.timeline.append(Rig.frame(at: 100 + Double(index) * 0.02, position: Int64(index) * 960, frames: 960, session: 1, isCaptureTime: true))
    }
    let stats = rig.timeline.currentStatistics
    #expect(stats.reanchors == 1)
    #expect(stats.steps == 0)
    #expect(stats.timelines == 1)
    #expect(abs(stats.lastErrorSeconds) < 0.001)
    #expect(stats.writeEnd == Int64((101.2 * Self.rate).rounded()))

    // A run that starts on its capture time is never re-anchored; one within 4 ms is just confirmed.
    let exact = Rig(now: 102)
    exact.timeline.append(Rig.frame(at: 100.002, position: 0, frames: 960, session: 1))
    exact.timeline.append(Rig.frame(at: 100.02, position: 960, frames: 960, session: 1, isCaptureTime: true))
    exact.timeline.append(Rig.frame(at: 100.1, position: 1_920, frames: 960, session: 1, isCaptureTime: true))
    #expect(exact.timeline.currentStatistics.reanchors == 0)
  }

  @Test("A gap of any length within a session is a gap where it was lost, not a new timeline")
  func longGapIsAGap() {
    let rig = Rig(now: 103)
    rig.append(at: 100, index: 0)
    rig.append(at: 101.5, index: 75)
    #expect(rig.timeline.currentStatistics.timelines == 1)
    #expect(rig.timeline.currentStatistics.sessionTimelines == 1)
    #expect(rig.timeline.currentStatistics.gaps == 1)
    #expect(abs(rig.timeline.currentStatistics.gapSeconds - 1.48) < 0.000_1)
    // A new session is a new timeline, and is counted as one.
    rig.append(at: 102, index: 0, session: 2)
    #expect(rig.timeline.currentStatistics.timelines == 2)
    #expect(rig.timeline.currentStatistics.sessionTimelines == 2)
  }

  @Test("A step of the iPad's wall clock either way moves nothing placed by capture uptime")
  func wallClockStepChangesNothing() {
    for step in [ 0.1, -0.1 ] {
      let clock = FixedClock(1_800_000_000)
      let uptime = Locked(500.0)
      let timeline = SourceSoundTimeline(clock: clock, uptime: { uptime.value })
      for index in 0 ..< 150 {
        let at = 500 + Double(index) * 0.02
        uptime.value = at + 0.05
        // Halfway through, the wall clock jumps; the uptime the sound is placed on does not.
        clock.set(1_800_000_000 + at + 0.05 - 500 + (index >= 75 ? step : 0))
        let frame = Rig.frame(at: clock.now.seconds - 0.05, position: Int64(index) * 960, frames: 960, session: 1, isCaptureTime: true)
        timeline.append(AudioFrame(
          sourceID: frame.sourceID,
          sampleBuffer: frame.sampleBuffer,
          wallClock: frame.wallClock,
          sessionID: 1,
          sourceSamplePosition: Int64(index) * 960,
          isCaptureTime: true,
          captureUptime: at
        ))
      }
      let stats = timeline.currentStatistics
      #expect(stats.steps == 0, "a \(step) s wall step")
      #expect(stats.timelines == 1)
      #expect(abs(stats.lastErrorSeconds) < 0.001)
    }
  }

  @Test("A connection's first, held-up report is not placed by until two more agree, or five seconds pass")
  func offsetWaitsForAgreement() {
    let now = 1_800_000_000.0
    var audit = RTPClockAudit()
    #expect(!audit.offsetIsAgreed(at: 1_000))
    // Report k is sent at uptime 1,000 + k. The first two wait in the connection and arrive at
    // 1,002 together; from the third on they take 10 ms.
    let delays = [ 2.0, 1.0, 0.01, 0.01, 0.01 ]
    for (k, delay) in delays.enumerated() {
      let arrival = 1_000 + Double(k) + delay
      audit.note(report: report(ssrc: 7, camera: now + 0.2 + Double(k), rtp: UInt32(k) * 90_000), arrivalUptime: arrival, wallClockNow: Date(timeIntervalSince1970: now + arrival - 1_000))
      // Agreed only once three reports sit within 30 ms at the top: after the fifth.
      #expect(audit.offsetIsAgreed(at: arrival) == (k == 4), "after report \(k)")
    }
    // A camera whose reports never agree is placed anyway after five seconds.
    var noisy = RTPClockAudit()
    noisy.note(report: report(ssrc: 7, camera: now + 0.2, rtp: 0), arrivalUptime: 1_000, wallClockNow: Date(timeIntervalSince1970: now))
    #expect(!noisy.offsetIsAgreed(at: 1_004.9))
    #expect(noisy.offsetIsAgreed(at: 1_005))
    // After a reconnect the carried observations agree at once.
    audit.reset(keepingClockOffset: true)
    #expect(audit.offsetIsAgreed(at: 1_006))
  }

  @Test("Before any offset has been observed there is no capture uptime, not one decades out")
  func noOffsetNoCaptureUptime() {
    let now = 1_800_000_000.0
    var audit = RTPClockAudit()
    #expect(audit.captureUptimeOnLocalClock(rtpTimestamp: 0, ssrc: 7) == nil)
    audit.note(report: report(ssrc: 7, camera: now + 0.2, rtp: 0), arrivalUptime: 1_000, wallClockNow: Date(timeIntervalSince1970: now))
    #expect(abs((audit.captureUptimeOnLocalClock(rtpTimestamp: 0, ssrc: 7) ?? 0) - 1_000) < 0.001)
  }

  @Test("The camera's offset is measured against uptime: a wall-clock step moves no capture uptime")
  func auditIgnoresWallClockSteps() {
    for step in [ 0.1, -0.1 ] {
      let now = 1_800_000_000.0
      var audit = RTPClockAudit()
      for second in 0 ..< 80 {
        let up = 1_000 + Double(second)
        let wall = now + Double(second) + (second >= 40 ? step : 0)
        audit.note(report: report(ssrc: 7, camera: now + Double(second) + 0.2, rtp: UInt32(second) * 90_000), arrivalUptime: up, wallClockNow: Date(timeIntervalSince1970: wall))
      }
      #expect(audit.clockSteps == 0)
      let capture = audit.captureUptimeOnLocalClock(rtpTimestamp: 79 * 90_000, ssrc: 7) ?? 0
      #expect(abs(capture - 1_079) < 0.001)
      // On the wall clock it follows the step, as a picture placed on the wall clock should.
      #expect(abs((audit.captureTimeOnLocalClock(rtpTimestamp: 79 * 90_000, ssrc: 7) ?? 0) - (now + 79 + step)) < 0.001)
    }
  }

  @Test("A run that vanishes under a reader leaves it quiet, counted as a fade")
  func runVanishes() {
    let rig = Rig(now: 101.5)
    for index in 0 ..< 50 { rig.append(at: 100 + Double(index) * 0.02, index: index) }
    _ = rig.readInChunks(from: 100, seconds: 0.1)
    #expect(rig.reader.phase == .playing)
    rig.timeline.reset()
    let after = rig.readInChunks(from: 100.1, seconds: 0.04)
    #expect(after.allSatisfy { $0 == 0 })
    #expect(rig.reader.phase == .silent)
    #expect(rig.reader.fades == 1)
  }

  @Test("A read lag moved while running and stopped is taken on the next start")
  func pendingLagTakenAtStart() {
    let clock = FixedClock(100)
    let mixer = AudioMixer(clock: clock, readLagSeconds: 0.5, uptime: { clock.now.seconds }, runsTimer: false) { _ in }
    mixer.start()
    mixer.setReadLag(seconds: 0.7)
    mixer.stop()
    mixer.start()
    #expect(mixer.currentStatistics.readLagSeconds == 0.7)
  }

  @Test("The router lays a contributing camera's sound on its timeline and reports it")
  func routerSoundStatus() throws {
    let router = try Self.router()
    let source = TappableSource()
    let pipeline = SourcePipeline(
      sourceID: source.sourceID,
      sourceIndex: 2,
      source: source,
      converter: PixelConverter(),
      telemetry: PipelineTelemetry()
    )
    router.add(pipeline)
    try pipeline.start()
    let now = Date().timeIntervalSince1970

    // Not contributing: heard by the oscilloscope only.
    source.emit(Rig.frame(at: now, position: 0, frames: 960, session: 1).with(source.sourceID))
    #expect(router.soundStatus().isEmpty)
    #expect(router.soundTimelines.existing(source.sourceID) == nil)

    router.setAudioContributors([ source.sourceID ])
    router.setSoundTrims([ source.sourceID: 0.055 ])
    router.setLiveSoundDelay(seconds: 0.6)
    source.emit(Rig.frame(at: now, position: 960, frames: 960, session: 1).with(source.sourceID))
    let status = try #require(router.soundStatus()[2])
    #expect(status.timeline.timelines == 1)
    #expect(status.live == nil)
    #expect(router.soundTimelines.existing(source.sourceID)?.trimSeconds == 0.055)
    #expect(router.audioMixer.currentStatistics.readLagSeconds == 0.6)

    // Removed, the camera's run is forgotten.
    router.remove(sourceIndex: 2)
    #expect(router.soundTimelines.existing(source.sourceID)?.currentStatistics.writeEnd != nil)
  }

  @Test("A new device behind the same source drops the clock offset it carried")
  func newDeviceDropsCarriedOffset() {
    let source = RTSPFrameSource(
      sourceID: SourceID("camera"),
      displayName: "camera",
      configuration: RTSPSession.Configuration(host: "127.0.0.1", port: 9)
    )
    let now = Date().timeIntervalSince1970
    source.handle(.playing(description: Self.sdp(cname: "phone-a"), channels: .init(video: 0, audio: 2)))
    source.handle(.rtcp(report(ssrc: 7, camera: now + 2, rtp: 90_000)))
    #expect(source.receiveStats.cameraClockOffsetSamples == 1)
    // The same phone again: its offset is kept.
    source.handle(.playing(description: Self.sdp(cname: "phone-a"), channels: .init(video: 0, audio: 2)))
    #expect(source.receiveStats.cameraClockOffsetSamples == 1)
    // A different phone: dropped.
    source.handle(.playing(description: Self.sdp(cname: "phone-b"), channels: .init(video: 0, audio: 2)))
    #expect(source.receiveStats.cameraClockOffsetSamples == 0)
    // Sound that does not decode goes nowhere and breaks nothing.
    var bytes: [UInt8] = [ 0x80, 98, 0, 1, 0, 0, 0, 0, 0, 0, 0, 8, 0x00, 0x10, 0x00, 0x08 ]
    bytes += [UInt8](repeating: 0xFF, count: 1)
    if let packet = RTPPacket.parse(Data(bytes)) {
      source.handle(.packet(channel: 2, packet: packet))
    }
    #expect(source.receiveStats.packetsLost == 0)
  }

  @Test("A camera's own sound waits for its clock reports to agree, then goes on at its capture time")
  func receivedSoundWaitsForAgreedClock() throws {
    let source = RTSPFrameSource(
      sourceID: SourceID("camera"),
      displayName: "camera",
      configuration: RTSPSession.Configuration(host: "127.0.0.1", port: 9)
    )
    let received = Received()
    source.installSinks(FrameSinks(recordingAudio: { received.add($0) }))
    source.handle(.playing(description: Self.sdp(cname: "phone", audioConfig: "1188", channels: 1), channels: .init(video: 0, audio: 2)))
    let units = try Self.aacUnits(count: 30)
    var sequence: UInt16 = 0
    func send(_ unit: Data) {
      let stamp = UInt32(sequence) * 1_024
      let header: [UInt8] = [ 0x80, 98, UInt8(sequence >> 8), UInt8(sequence & 0xFF) ]
        + withUnsafeBytes(of: stamp.bigEndian, Array.init)
        + [ 0, 0, 0, 8 ]
        + [ 0x00, 0x10, UInt8(unit.count >> 5), UInt8((unit.count & 0x1F) << 3) ]
      sequence &+= 1
      if let packet = RTPPacket.parse(Data(header) + unit) {
        source.handle(.packet(channel: 2, packet: packet))
      }
    }

    // Before any sender report the sound goes on by arrival.
    for unit in units[0 ..< 10] { send(unit) }
    #expect(!received.frames.isEmpty)
    #expect(received.frames.allSatisfy { !$0.isCaptureTime })
    let byArrival = received.frames.count

    // One report is not yet a clock: the sound waits rather than start a timeline it would move.
    let now = Date().timeIntervalSince1970
    source.handle(.rtcp(report(ssrc: 8, camera: now + 2, rtp: 0)))
    for unit in units[10 ..< 12] { send(unit) }
    #expect(received.frames.count == byArrival)
    #expect(source.receiveStats.soundAwaitingClock == 2)

    // Three that agree are: from here the sound is placed by its capture time.
    for _ in 0 ..< 2 {
      let later = Date().timeIntervalSince1970
      source.handle(.rtcp(report(ssrc: 8, camera: later + 2, rtp: UInt32(((later - now) * Self.rate).rounded()))))
    }
    for unit in units[12...] { send(unit) }
    let placed = received.frames.dropFirst(byArrival)
    #expect(!placed.isEmpty)
    #expect(placed.allSatisfy { $0.isCaptureTime })
    #expect(source.receiveStats.soundAwaitingClock == 2)
  }

  final class Received: @unchecked Sendable {
    private let lock = NSLock()
    private var collected: [AudioFrame] = []
    var frames: [AudioFrame] { lock.withLock { collected } }
    func add(_ frame: AudioFrame) { lock.withLock { collected.append(frame) } }
  }

  /// `count` AAC-LC access units of a 48 kHz mono tone, as a camera sends them.
  static func aacUnits(count: Int) throws -> [Data] {
    var input = AudioStreamBasicDescription(
      mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
      mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0
    )
    var output = AudioStreamBasicDescription(
      mSampleRate: rate, mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0,
      mBytesPerPacket: 0, mFramesPerPacket: 1_024, mBytesPerFrame: 0,
      mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0
    )
    var made: AudioConverterRef?
    try #require(AudioConverterNew(&input, &output, &made) == noErr)
    let converter = try #require(made)
    defer { AudioConverterDispose(converter) }

    final class Tone {
      var samples: [Int16]
      var position = 0
      init(_ samples: [Int16]) { self.samples = samples }
    }
    let tone = Tone((0 ..< (count + 4) * 1_024).map { Int16(8_000 * sin(2 * .pi * 440 * Double($0) / rate)) })
    var units: [Data] = []
    while units.count < count {
      var bytes = [UInt8](repeating: 0, count: 4_096)
      var description = AudioStreamPacketDescription()
      var wanted: UInt32 = 1
      let status = bytes.withUnsafeMutableBytes { raw -> OSStatus in
        var list = AudioBufferList(
          mNumberBuffers: 1,
          mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(raw.count), mData: raw.baseAddress)
        )
        return AudioConverterFillComplexBuffer(
          converter,
          { _, packetCount, data, _, user in
            let tone = Unmanaged<Tone>.fromOpaque(user!).takeUnretainedValue()
            let left = tone.samples.count - tone.position
            guard left > 0 else {
              packetCount.pointee = 0
              return noErr
            }
            let taken = min(Int(packetCount.pointee), left)
            tone.samples.withUnsafeMutableBytes { samples in
              data.pointee.mBuffers.mData = samples.baseAddress!.advanced(by: tone.position * 2)
            }
            data.pointee.mBuffers.mDataByteSize = UInt32(taken * 2)
            packetCount.pointee = UInt32(taken)
            tone.position += taken
            return noErr
          },
          Unmanaged.passUnretained(tone).toOpaque(),
          &wanted,
          &list,
          &description
        )
      }
      guard status == noErr, wanted > 0 else { break }
      units.append(Data(bytes[0 ..< Int(description.mDataByteSize)]))
    }
    try #require(units.count == count)
    return units
  }

  static func sdp(cname: String, audioConfig: String = "1190", channels: Int = 2) -> SDPDescription {
    SDPDescription.parse([
      "v=0", "o=- 0 0 IN IP4 0.0.0.0", "s=test", "t=0 0",
      "m=video 0 RTP/AVP 96",
      "a=rtpmap:96 H265/90000",
      "a=fmtp:96 sprop-vps=QAEMAf//AWAAAAMAgAAAAwAAAwB4vAk=; sprop-sps=QgEBAWAAAAMAgAAAAwAAAwB4oAPAgBDljb5JMrgEAAADAAQAAAMAeCA=; sprop-pps=RAHA8vATZA==",
      "a=ssrc:7 cname:\(cname)",
      "a=control:trackID=0",
      "m=audio 0 RTP/AVP 98",
      "a=rtpmap:98 mpeg4-generic/48000/\(channels)",
      "a=fmtp:98 streamtype=5;profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=\(audioConfig)",
      "a=control:trackID=1",
    ].joined(separator: "\r\n") + "\r\n")
  }

  static func router() throws -> TileRouter {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("sound-timeline-router-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let clock = SystemClock()
    let telemetry = PipelineTelemetry(clock: clock)
    let converter = PixelConverter()
    let encoder = ProgramEncoder(
      telemetry: telemetry,
      converter: converter,
      config: AppConfig(programResolution: .hd720, programFrameRate: 30),
      directory: root
    )
    return TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: nil,
      programEncoder: encoder,
      programStreamer: ProgramStreamer(telemetry: telemetry, converter: converter),
      clock: clock
    )
  }

  // MARK: - Helpers

  private func ntp(_ unixSeconds: Double) -> UInt64 {
    let ntpSeconds = unixSeconds + 2_208_988_800
    let whole = UInt64(ntpSeconds)
    let fraction = UInt64((ntpSeconds - Double(whole)) * 4_294_967_296)
    return (whole << 32) | fraction
  }

  private func report(ssrc: UInt32, camera: Double, rtp: UInt32) -> RTCPReport {
    RTCPReport(senderReports: [
      RTCPReport.SenderReport(ssrc: ssrc, ntpTimestamp: ntp(camera), rtpTimestamp: rtp, packetCount: 1, octetCount: 100_000)
    ])
  }

  /// A timeline on a wall clock equal to uptime, fed 20 ms buffers of a constant tone.
  final class Rig: @unchecked Sendable {
    let clock: FixedClock
    let timeline: SourceSoundTimeline
    var reader = SourceSoundTimeline.Reader(id: 1)

    init(now: Double) {
      let clock = FixedClock(now)
      self.clock = clock
      timeline = SourceSoundTimeline(clock: clock, uptime: { clock.now.seconds })
    }

    func append(at wall: Double, index: Int, session: UInt64 = 1, value: Int16 = SourceSoundTimelineTests.level) {
      timeline.append(Self.frame(at: wall, position: Int64(index) * 960, frames: 960, session: session, value: value))
    }

    func append(at wall: Double, position: Int64, frames: Int) {
      timeline.append(Self.frame(at: wall, position: position, frames: frames, session: 1))
    }

    /// Reads in one go, with no reserve.
    func read(from wall: Double, seconds: Double) -> [Int32] {
      readInChunks(from: wall, seconds: seconds, chunk: Int(seconds * SourceSoundTimelineTests.rate))
    }

    /// Reads as a mix does, a chunk at a time; returns the left channel.
    func readInChunks(from wall: Double, seconds: Double, reserve: Int = 0, chunk: Int = SourceSoundTimelineTests.chunk) -> [Int32] {
      var left: [Int32] = []
      var position = Int64((wall * SourceSoundTimelineTests.rate).rounded())
      let end = position + Int64((seconds * SourceSoundTimelineTests.rate).rounded())
      while position < end {
        var mix = [Int32](repeating: 0, count: chunk * 2)
        timeline.read(&reader, at: position, count: chunk, gain: 1, reserveFrames: reserve, into: &mix)
        left += stride(from: 0, to: mix.count, by: 2).map { mix[$0] }
        position += Int64(chunk)
      }
      return left
    }

    static func frame(
      at wall: Double,
      position: Int64,
      frames: Int,
      session: UInt64,
      value: Int16 = SourceSoundTimelineTests.level,
      isCaptureTime: Bool = false
    ) -> AudioFrame {
      let format = AudioSampleBuilder.makeFormatDescription(
        AudioSampleBuilder.interleavedInt16Description(sampleRate: 48_000, channels: 2)
      )!
      let buffer = AudioSampleBuilder.makeSampleBuffer(
        samples: [Int16](repeating: value, count: frames * 2),
        formatDescription: format,
        presentationTime: CMTime(value: position, timescale: 48_000)
      )!
      return AudioFrame(
        sourceID: SourceID("camera"),
        sampleBuffer: buffer,
        wallClock: WallClock(seconds: wall),
        sessionID: session,
        sourceSamplePosition: position,
        isCaptureTime: isCaptureTime
      )
    }
  }

  final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var chunks: [(wall: Double, loud: Bool)] = []

    func add(_ frame: AudioFrame) {
      let samples = AudioPCM.stereoSamples(from: frame.sampleBuffer, sampleRate: 48_000, channelCount: 2) ?? []
      lock.lock()
      chunks.append((frame.wallClock.seconds, samples.contains { abs(Int($0)) > 100 }))
      lock.unlock()
    }

    var loudWalls: [Double] {
      lock.lock()
      defer { lock.unlock() }
      return chunks.filter(\.loud).map { ($0.wall * 100).rounded() / 100 }
    }
  }
}

/// A camera that hands over whatever sound the test gives it, on both sound sinks.
private final class TappableSource: FrameSource, @unchecked Sendable {
  let sourceID = SourceID("tappable")
  let displayName = "TAP"
  private let lock = NSLock()
  private var sinks = FrameSinks()
  private(set) var isRunning = false
  var format: SourceFormat? { nil }

  func start(sinks: FrameSinks) throws {
    lock.lock()
    self.sinks = sinks
    isRunning = true
    lock.unlock()
  }

  func stop() { isRunning = false }

  func emit(_ frame: AudioFrame) {
    lock.lock()
    let sinks = self.sinks
    lock.unlock()
    sinks.audio?(frame)
    sinks.recordingAudio?(frame)
  }
}

private extension AudioFrame {
  func with(_ id: SourceID) -> AudioFrame {
    AudioFrame(
      sourceID: id,
      sampleBuffer: sampleBuffer,
      wallClock: wallClock,
      sessionID: sessionID,
      sourceSamplePosition: sourceSamplePosition
    )
  }
}

final class Locked<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value
  init(_ value: Value) { stored = value }
  var value: Value {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }
}
