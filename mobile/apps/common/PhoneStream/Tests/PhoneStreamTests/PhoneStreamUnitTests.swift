import AVFoundation
import CameramanCapture
import CameramanCore
import CoreMedia
import DirectorCore
import DirectorExport
import DirectorMedia
import DirectorSources
import Foundation
import TeamStationKit
import Testing

@testable import PhoneStream

extension PhoneStreamTests {
  @Suite("The profile, the clocks and the programme")
  struct Basics {
    @Test("The phone streams 0.5–4 Mbps opening at 2, and records at a fixed 6, in HEVC 1080p30")
    func profile() {
      let stream = PhoneStreamProfile.streamSettings
      #expect(stream.bitrateLow / 1_000 == 500)
      #expect(stream.bitrateHigh / 1_000 == 4_000)
      #expect(stream.bitrateStart.map { $0 / 1_000 } == 2_000)
      #expect(stream.openingBitrate == 2_000_000)
      #expect(stream.codec == .hevc)
      #expect(stream.resolution == .hd1080)
      #expect(stream.frameRate == 30)
      #expect(stream.gopSeconds == 2)
      let recording = PhoneStreamProfile.recordingSettings
      #expect(recording.programme.bitrate / 1_000 == 6_000)
      #expect(recording.programme.codec == .hevc)
      #expect(recording.takeEncoding.programme == recording.programme)
      #expect(recording.takeEncoding.rawCamera == recording.programme)
      #expect(recording.resumeDowntimeLimitSeconds == 3_600)
      #expect(PhoneStreamProfile.programmeSettings.bitrate == 6_000_000)
      #expect(PhoneStreamProfile.programmeSettings.gopSeconds == 2)
      #expect(PhoneStreamProfile.streamAudioBitrate == 128_000)
      #expect(PhoneStreamProfile.recordingAudioBitrate == 192_000)
      #expect(PhoneStreamProfile.audioSampleRate == 48_000)
      #expect(PhoneStreamProfile.pictureDelaySeconds == 1)
      #expect(PhoneStreamProfile.recordingMixDelaySeconds == 1)
      #expect(PhoneStreamProfile.stallRedialSeconds == 6)
    }

    @Test("A capture-clock instant becomes its steady-wall and uptime instants by its age")
    func captureClockMapping() {
      let mapping = CaptureClockMapping(
        captureNow: { 500.0 },
        wallNow: { 1_800_000_000.0 },
        uptimeNow: { 9_000.0 }
      )
      #expect(mapping.wall(forCapture: 499.75) == WallClock(seconds: 1_799_999_999.75))
      #expect(mapping.uptime(forCapture: 499.75) == 8_999.75)
      // A stamp from the future is now, never later.
      #expect(mapping.wall(forCapture: 501) == WallClock(seconds: 1_800_000_000))
      #expect(CaptureClockMapping.system.age(ofCapture: CMClockGetTime(CMClockGetHostTimeClock()).seconds) < 0.1)
    }

    @Test("The camera's pictures and sound are stamped by capture time through a fake capture clock")
    func cameraSourceStampsCaptureTime() async throws {
      let device = FakeCaptureDevice()
      let mapping = CaptureClockMapping(
        captureNow: { 100.0 },
        wallNow: { 2_000_000_000.0 },
        uptimeNow: { 50.0 }
      )
      let source = PhoneCameraSource(input: .camera(device), mapping: mapping)
      #expect(source.device === device)
      #expect(source.format?.width == 1920)
      #expect(source.displayName == "Camera")
      final class Got: @unchecked Sendable {
        var pictures: [PixelFrame] = []
        var sounds: [AudioFrame] = []
        var recordingSounds = 0
      }
      let got = Got()
      try source.start(sinks: FrameSinks(
        pixel: { got.pictures.append($0) },
        audio: { got.sounds.append($0) },
        recordingAudio: { _ in got.recordingSounds += 1 }
      ))
      try source.start(sinks: FrameSinks())
      #expect(source.isRunning)
      #expect(device.started == 1)

      device.onVideoFrame?(SampleBuffer(videoSample(at: 99.9)))
      device.onAudioFrame?(SampleBuffer(audioSample(at: 99.5)))
      #expect(got.pictures.count == 1)
      let picture = try #require(got.pictures.first)
      #expect(abs(picture.captureWallClock!.seconds - 1_999_999_999.9) < 1e-6)
      #expect(picture.wallClock == WallClock(seconds: 2_000_000_000))
      #expect(picture.width == 1920)
      let sound = try #require(got.sounds.first)
      #expect(abs(sound.wallClock.seconds - 1_999_999_999.5) < 1e-6)
      #expect(abs(sound.captureUptime! - 49.5) < 1e-6)
      #expect(sound.isCaptureTime)
      #expect(got.recordingSounds == 1)

      source.stop()
      #expect(!source.isRunning)
      #expect(device.stopped == 1)
      #expect(device.onVideoFrame == nil)
    }

    @Test("The synthetic stand-in's pictures are converted for the encoders and captured as made")
    func syntheticSource() async throws {
      let source = PhoneCameraSource(input: .synthetic(SyntheticFrameSource(
        sourceID: PhoneCameraSource.id,
        displayName: "Synthetic",
        entropy: .low
      )))
      #expect(source.device == nil)
      final class Got: @unchecked Sendable {
        private let lock = NSLock()
        private var pictures: [PixelFrame] = []
        private var sounds: [AudioFrame] = []
        func add(_ picture: PixelFrame) { lock.withLock { pictures.append(picture) } }
        func add(_ sound: AudioFrame) { lock.withLock { sounds.append(sound) } }
        var taken: ([PixelFrame], [AudioFrame]) { lock.withLock { (pictures, sounds) } }
      }
      let got = Got()
      try source.start(sinks: FrameSinks(
        pixel: { got.add($0) },
        audio: { got.add($0) }
      ))
      try await Task.sleep(for: .milliseconds(400))
      source.stop()
      let (pictures, sounds) = got.taken
      #expect(pictures.count >= 5)
      let first = try #require(pictures.first)
      let format = first.pixelFormat
      #expect(format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
      let captured = first.captureWallClock
      #expect(captured == first.wallClock)
      #expect(sounds.allSatisfy { $0.isCaptureTime })
      #expect(!sounds.isEmpty)
    }

    @Test("A simulator Debug build stands the synthetic source in for the camera")
    func standardSourceOnSimulator() {
      let source = PhoneCameraSource.standard(camera: FakeCaptureDevice())
      if case .synthetic = source.input {} else { Issue.record("expected the synthetic source") }
    }

    @Test("On a single-source programme every grid tick reaches both the recording and the stream")
    func programmeTickFeedsBoth() throws {
      let recording = FakeRecording()
      let stream = FakeStream()
      let programme = PhoneProgramme(recording: recording, stream: stream, clock: FixedClock(1_000), runsMixTimers: false)
      programme.start(runsTimer: false)
      // Before any picture: ticks, but nothing to send.
      #expect(programme.tick(at: 10, wallNow: 1_000) == PhoneProgramme.TickOutput())
      #expect(programme.tick(at: 10.001, wallNow: 1_000) == nil)
      // One picture captured at 999, due at 1,000 with the second's delay.
      programme.add(picture: PixelFrame(
        sourceID: PhoneCameraSource.id,
        pixelBuffer: CMSampleBufferGetImageBuffer(videoSample(at: 0))!,
        presentationTime: .zero,
        wallClock: WallClock(seconds: 999),
        captureWallClock: WallClock(seconds: 999),
        frameID: 0
      ))
      var sent: [PhoneProgramme.TickOutput] = []
      for tick in 1 ... 30 {
        let now = 10 + Double(tick) / 30
        sent.append(try #require(programme.tick(at: now, wallNow: 1_000 + Double(tick) / 30)))
      }
      #expect(sent.map { $0.recordingFrames } == (1 ... 30).map { [ Int64($0) ] })
      #expect(sent.map { $0.streamFrame } == (1 ... 30).map { Int64($0) })
      #expect(recording.frames.map { $0.value } == (1 ... 30).map { Int64($0) })
      #expect(stream.frames.map { $0.value } == (1 ... 30).map { Int64($0) })
      // The first recording frame of a picture carries its capture time; its repeats do not. So
      // does the stream's, which places the live video by it.
      #expect(recording.captures.first == WallClock(seconds: 999))
      #expect(recording.captures.dropFirst().allSatisfy { $0 == nil })
      #expect(stream.captures.first == WallClock(seconds: 999))
      #expect(stream.captures.dropFirst().allSatisfy { $0 == nil })
      #expect(recording.onGrid.allSatisfy { $0 })
      // A late timer: the recording frames it skipped are written as repeats.
      let late = try #require(programme.tick(at: 10 + 34.0 / 30, wallNow: 1_002))
      #expect(late.recordingFrames == [ 31, 32, 33, 34 ])
      #expect(late.streamFrame == 34)
      #expect(programme.recordingFramesSent == 34)
      #expect(programme.streamFramesSent == 31)
      #expect(programme.ticks == 32)
      // While a part is being finished the recording takes no pictures; the stream still does.
      programme.setFeedsRecording(false)
      let finishing = try #require(programme.tick(at: 10 + 34.5 / 30 + 0.02, wallNow: 1_002.05))
      #expect(finishing.recordingFrames.isEmpty)
      programme.setFeedsRecording(true)
      // Neither output running: nothing is sent.
      recording.isRunning = false
      stream.isRunning = false
      let idle = try #require(programme.tick(at: 10 + 36.0 / 30, wallNow: 1_002.1))
      #expect(idle.recordingFrames.isEmpty)
      #expect(idle.streamFrame == nil)
      programme.setSoundEnabled(false)
      #expect(programme.liveMix.currentContributors.isEmpty)
      programme.setSoundEnabled(true)
      #expect(programme.recordingMix.currentContributors == [ PhoneCameraSource.id ])
      programme.stop()
    }

    @Test("The programme's own timer ticks at 30 fps and both mixes write sound")
    func programmeRuns() async throws {
      let recording = FakeRecording()
      let stream = FakeStream()
      let programme = PhoneProgramme(recording: recording, stream: stream, clock: SystemClock())
      programme.start()
      programme.start()
      let source = PhoneCameraSource(input: .synthetic(SyntheticFrameSource(
        sourceID: PhoneCameraSource.id,
        displayName: "Synthetic",
        entropy: .low
      )))
      try source.start(sinks: FrameSinks(
        pixel: { programme.add(picture: $0) },
        audio: { programme.add(sound: $0) }
      ))
      try await Task.sleep(for: .milliseconds(2_500))
      source.stop()
      programme.stop()
      // A second of picture delay, then about 1.5 s of frames at 30 fps.
      #expect(recording.frames.count >= 30)
      #expect(stream.frames.count >= 30)
      #expect(recording.sounds > 0)
      #expect(stream.sounds > 0)
    }
  }
}

// MARK: - Doubles for the programme

final class FixedClock: DirectorClock, @unchecked Sendable {
  var seconds: Double
  init(_ seconds: Double) { self.seconds = seconds }
  var now: WallClock { WallClock(seconds: seconds) }
}

final class FakeRecording: ProgrammeRecordingTarget, @unchecked Sendable {
  private let lock = NSLock()
  var isRunning = true
  private var _frames: [CMTime] = []
  private var _captures: [WallClock?] = []
  private var _onGrid: [Bool] = []
  private var _sounds = 0
  var running: Bool { isRunning }
  var frames: [CMTime] { lock.lock(); defer { lock.unlock() }; return _frames }
  var captures: [WallClock?] { lock.lock(); defer { lock.unlock() }; return _captures }
  var onGrid: [Bool] { lock.lock(); defer { lock.unlock() }; return _onGrid }
  var sounds: Int { lock.lock(); defer { lock.unlock() }; return _sounds }

  func append(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime, captureWall: WallClock?, onClockGrid: Bool) {
    lock.lock()
    _frames.append(presentationTime)
    _captures.append(captureWall)
    _onGrid.append(onClockGrid)
    lock.unlock()
  }

  func append(audio frame: AudioFrame) {
    lock.lock()
    _sounds += 1
    lock.unlock()
  }
}

final class FakeStream: ProgrammeStreamTarget, @unchecked Sendable {
  private let lock = NSLock()
  var isRunning = true
  private var _frames: [CMTime] = []
  private var _captures: [WallClock?] = []
  private var _sounds = 0
  var running: Bool { isRunning }
  var frames: [CMTime] { lock.lock(); defer { lock.unlock() }; return _frames }
  var captures: [WallClock?] { lock.lock(); defer { lock.unlock() }; return _captures }
  var sounds: Int { lock.lock(); defer { lock.unlock() }; return _sounds }

  func append(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime, captureWall: WallClock?) {
    lock.lock()
    _frames.append(presentationTime)
    _captures.append(captureWall)
    lock.unlock()
  }

  func append(audio frame: AudioFrame) {
    lock.lock()
    _sounds += 1
    lock.unlock()
  }
}
