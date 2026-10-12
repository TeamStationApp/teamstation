import CoreMedia
import CoreVideo
import DirectorCore
import DirectorMedia
import DirectorSources
import Foundation

/// Where the programme's recording frames go: `ProgramEncoder`, or a fake in a test.
public protocol ProgrammeRecordingTarget: AnyObject, Sendable {
  var running: Bool { get }
  func append(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime, captureWall: WallClock?, onClockGrid: Bool)
  func append(audio frame: AudioFrame)
}

/// Where the programme's stream frames go: `ProgramStreamer`, or a fake in a test.
public protocol ProgrammeStreamTarget: AnyObject, Sendable {
  var running: Bool { get }
  /// `captureWall` is when a picture new to the stream was captured; nil for a repeat.
  func append(_ pixelBuffer: CVPixelBuffer, presentationTime: CMTime, captureWall: WallClock?)
  func append(audio frame: AudioFrame)
}

extension ProgramEncoder: ProgrammeRecordingTarget {}
extension ProgramStreamer: ProgrammeStreamTarget {}

/// The phone's programme: one camera on TS Director's programme clock.
///
/// One tick drives both outputs, exactly as Director's router does. The clock ticks at 30 fps; on
/// each tick the picture queue gives the newest picture whose moment (capture time plus the one
/// second picture delay) has come, or the last one again, and that picture goes to the recording on
/// its grid slot and to the stream. Frames a late timer skipped are written to the recording as
/// repeats, up to a quarter of a second of them, so the recording's grid has no holes.
///
/// Sound has two mixes over one set of timelines, as on Director: the live mix hears the microphone
/// a picture delay after capture, which is when the stream shows its picture; the recording's mix
/// reads it at its capture time and waits a second for it.
public final class PhoneProgramme: @unchecked Sendable {
  /// What one tick sent, for a test to read.
  public struct TickOutput: Sendable, Equatable {
    public var recordingFrames: [Int64] = []
    public var streamFrame: Int64?
    public var pictureSequence: UInt64?
  }

  private struct Picture {
    let buffer: CVPixelBuffer
    let capture: WallClock?
  }

  public let clock: DirectorClock
  public let timelines: SourceSoundTimelines
  /// The stream's mix, a picture delay behind capture.
  public let liveMix: AudioMixer
  /// The recording's mix, at capture time, a second behind the live edge.
  public let recordingMix: AudioMixer
  private let recording: any ProgrammeRecordingTarget
  private let stream: any ProgrammeStreamTarget
  private let soundSource: SourceID
  private let lock = NSLock()
  private var programmeClock: ProgrammeClock
  private var pictures: ProgrammePictureQueue<Picture>
  private var lastRecordedSequence: UInt64?
  private var lastStreamedSequence: UInt64?
  private var timer: DispatchSourceTimer?
  private let queue = DispatchQueue(label: "app.teamstation.phonestream.programme", qos: .userInteractive)
  private var soundEnabled = true
  /// Whether the recording takes this programme's pictures. Off while a part is finished: its hold
  /// fill writes the picture out to the stop on its own, and a live picture landing between two of
  /// the fill's would put the track's times out of order and fail the writer.
  private var feedsRecording = true
  /// Ticks run since `start`, and recording and stream frames sent: what a status line can show.
  public private(set) var ticks: UInt64 = 0
  public private(set) var recordingFramesSent: UInt64 = 0
  public private(set) var streamFramesSent: UInt64 = 0
  /// Told what each tick of the running clock sent, and the host uptime it ran at.
  private var tickObserver: (@Sendable (TickOutput, Double) -> Void)?

  public init(
    recording: any ProgrammeRecordingTarget,
    stream: any ProgrammeStreamTarget,
    clock: DirectorClock,
    soundSource: SourceID = PhoneCameraSource.id,
    uptime: @escaping @Sendable () -> Double = HostUptime.seconds,
    runsMixTimers: Bool = true
  ) {
    self.recording = recording
    self.stream = stream
    self.clock = clock
    self.soundSource = soundSource
    let rate = PhoneStreamProfile.frameRate
    programmeClock = ProgrammeClock(recordingRate: rate, streamRate: rate)
    pictures = ProgrammePictureQueue(delaySeconds: PhoneStreamProfile.pictureDelaySeconds)
    let timelines = SourceSoundTimelines(clock: clock, uptime: uptime)
    self.timelines = timelines
    liveMix = AudioMixer(
      clock: clock,
      readLagSeconds: PhoneStreamProfile.pictureDelaySeconds,
      uptime: uptime,
      runsTimer: runsMixTimers,
      timelines: timelines
    ) { [stream] frame in
      stream.append(audio: frame)
    }
    recordingMix = AudioMixer(
      clock: clock,
      delaySeconds: PhoneStreamProfile.recordingMixDelaySeconds,
      windowSeconds: PhoneStreamProfile.recordingMixDelaySeconds + 5,
      uptime: uptime,
      runsTimer: runsMixTimers,
      timelines: timelines
    ) { [recording] frame in
      recording.append(audio: frame)
    }
  }

  deinit {
    timer?.cancel()
  }

  // MARK: - Running

  /// Starts the frame clock and both mixes. The mixes count from here whether or not the microphone
  /// speaks, so both outputs carry sound, silence until it does, from their first picture.
  public func start(runsTimer: Bool = true) {
    liveMix.start()
    recordingMix.start()
    applySound()
    guard runsTimer else { return }
    lock.lock()
    defer { lock.unlock() }
    guard timer == nil else { return }
    let rate = programmeClock.rate
    let period = DispatchTimeInterval.nanoseconds(Int(1_000_000_000 / Double(rate)))
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + period, repeating: period, leeway: .milliseconds(1))
    timer.setEventHandler { [weak self] in self?.tickNow() }
    self.timer = timer
    timer.resume()
  }

  public func stop() {
    lock.lock()
    let timer = self.timer
    self.timer = nil
    pictures = ProgrammePictureQueue(delaySeconds: PhoneStreamProfile.pictureDelaySeconds)
    let rate = PhoneStreamProfile.frameRate
    programmeClock = ProgrammeClock(recordingRate: rate, streamRate: rate)
    lastRecordedSequence = nil
    lastStreamedSequence = nil
    lock.unlock()
    timer?.cancel()
    liveMix.stop()
    recordingMix.stop()
  }

  // MARK: - Input

  /// A picture from the camera, queued for its moment.
  public func add(picture frame: PixelFrame) {
    lock.lock()
    pictures.add(Picture(buffer: frame.pixelBuffer, capture: frame.captureWallClock), capture: frame.captureWallClock?.seconds)
    lock.unlock()
  }

  /// Sound from the microphone, laid on its timeline by capture time.
  public func add(sound frame: AudioFrame) {
    timelines.append(frame)
  }

  /// Muting takes the microphone out of both mixes, which then write silence in its place.
  public func setSoundEnabled(_ enabled: Bool) {
    lock.lock()
    soundEnabled = enabled
    lock.unlock()
    applySound()
  }

  private func applySound() {
    lock.lock()
    let heard: Set<SourceID> = soundEnabled ? [ soundSource ] : []
    lock.unlock()
    liveMix.setContributors(heard)
    recordingMix.setContributors(heard)
  }

  /// Whether the recording takes this programme's pictures; see `feedsRecording`.
  public func setFeedsRecording(_ feeds: Bool) {
    lock.lock()
    feedsRecording = feeds
    lock.unlock()
  }

  // MARK: - The tick

  private func tickNow() {
    let now = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
    guard let output = tick(at: now, wallNow: clock.now.seconds) else { return }
    lock.lock()
    let observer = tickObserver
    lock.unlock()
    observer?(output, now)
  }

  /// Calls `observer` after every tick of the running clock with what the tick sent and the host
  /// uptime it ran at, or stops calling it on nil. A test judges the grid by the ticks that actually
  /// ran, which a loaded machine delays, rather than by the time a wall clock says has passed.
  public func observeTicks(_ observer: (@Sendable (TickOutput, Double) -> Void)?) {
    lock.lock()
    tickObserver = observer
    lock.unlock()
  }

  /// One tick of the programme clock at host uptime `now` and steady wall `wallNow`: the picture due
  /// goes to the recording when a recording frame falls on this tick, and to the stream when a
  /// stream frame does. Answers what it sent, nil when no tick was due.
  @discardableResult
  public func tick(at now: Double, wallNow: Double) -> TickOutput? {
    lock.lock()
    guard let (tick, due) = programmeClock.tick(at: now, wallNow: wallNow, from: &pictures) else {
      lock.unlock()
      return nil
    }
    ticks &+= 1
    guard let entry = due else {
      lock.unlock()
      return TickOutput()
    }
    let picture = entry.picture
    var fresh = false
    if tick.recordingFrame != nil {
      fresh = entry.sequence != lastRecordedSequence
      lastRecordedSequence = entry.sequence
    }
    var freshToStream = false
    if tick.streamFrame != nil {
      freshToStream = entry.sequence != lastStreamedSequence
      lastStreamedSequence = entry.sequence
    }
    let rate = programmeClock.recordingRate
    let streamRate = programmeClock.streamRate
    let feedsRecording = self.feedsRecording
    lock.unlock()

    var output = TickOutput(pictureSequence: entry.sequence)
    if let frame = tick.recordingFrame, feedsRecording, recording.running {
      let missed = min(tick.recordingFramesMissed, Int64(max(1, rate / 4)))
      for skipped in stride(from: frame - missed, to: frame, by: 1) {
        recording.append(
          picture.buffer,
          presentationTime: CMTime(value: skipped, timescale: CMTimeScale(rate)),
          captureWall: nil,
          onClockGrid: true
        )
        output.recordingFrames.append(skipped)
      }
      recording.append(
        picture.buffer,
        presentationTime: CMTime(value: frame, timescale: CMTimeScale(rate)),
        captureWall: fresh ? picture.capture : nil,
        onClockGrid: true
      )
      output.recordingFrames.append(frame)
    }
    if let frame = tick.streamFrame, stream.running {
      stream.append(
        picture.buffer,
        presentationTime: CMTime(value: frame, timescale: CMTimeScale(streamRate)),
        captureWall: freshToStream ? picture.capture : nil
      )
      output.streamFrame = frame
    }
    lock.lock()
    recordingFramesSent &+= UInt64(output.recordingFrames.count)
    if output.streamFrame != nil { streamFramesSent &+= 1 }
    lock.unlock()
    return output
  }
}
