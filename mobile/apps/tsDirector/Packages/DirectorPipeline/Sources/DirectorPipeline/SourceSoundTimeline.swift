import CoreMedia
import DirectorCore
import DirectorSources
import Foundation

/// One camera's decoded sound, held on the programme's master sample scale until both mixes have
/// read it.
///
/// Positions are 48 kHz samples of host uptime (`mach_continuous_time`), the same scale the
/// mixers count on. A buffer's position comes from its capture time (`AudioFrame.wallClock`, which
/// for an RTSP camera is the stream's own sender-report mapping onto the iPad clock) plus a
/// per-camera `trimSeconds`. Each mix reads the sample captured `readLag` before the moment it is
/// emitting: the live mix D (a second by default), the recording's mix none but five seconds later.
///
/// The mapping only steers. Within one continuous run the sound is laid down by sample count, so
/// the jitter in each sender report and in arrival never reaches the mix:
///
/// | Mapping's error against the write head | Action |
/// |---|---|
/// | under 4 ms | ignored |
/// | 4–100 ms | absorbed by the drift loop |
/// | over 100 ms for a second | one step: a new run at the mapped place, under a fade |
/// | over 1 s, or a new session | a new timeline: a new run at the mapped place |
///
/// A run that had to start on arrival time, because the session's first sender report had not come
/// yet, is re-anchored once to the first capture time that disagrees with it by 4 ms or more: the
/// guess is replaced, not steered.
///
/// The drift loop: each camera's sample clock runs tens of ppm off the iPad's, which without a loop
/// would build up until a step. A second-order loop on the mapping's error (the median of the last
/// two seconds, smoothed over a quarter)
/// steers a fractional resampler between the camera's samples and the master positions, clamped to
/// ±500 ppm. It converges in about 15 s and is reset by every step or new timeline. It runs only on
/// capture times; sound placed by arrival carries arrival's jitter, which would only wobble it.
///
/// A run that steps or starts again supersedes anything an older run left ahead of it. A gap in the
/// source's own sample count (a lost packet) is left as a gap, which a reader fades around.
///
/// Fed from the source's receive thread as soon as a buffer is decoded; read by the mixers on their
/// own queues. One lock guards it all, held only for copies.
public final class SourceSoundTimeline: @unchecked Sendable {
  public static let sampleRate = AudioMixer.sampleRate
  static let channelCount = AudioMixer.channelCount
  /// 15 ms: the fade in and out of every discontinuity, raised cosine.
  public static let fadeFrames = 720

  /// Errors the run ignores, below which nothing at all happens.
  public static let ignoreSeconds = 0.004
  /// An error larger than this, held for `stepHoldSeconds`, moves the run in one step.
  public static let stepSeconds = 0.1
  public static let stepHoldSeconds = 1.0
  /// An error larger than this starts a new timeline at once.
  public static let newTimelineSeconds = 1.0
  /// How far ahead of now a buffer may be placed. Further is a clock that cannot be believed.
  public static let maximumLeadSeconds = 1.0
  /// How much sound the ring holds: the recording's five-second wait, the live lead and a margin.
  public static let capacitySeconds = 12.0
  /// The drift loop: natural frequency (rad/s), damping, the error's smoothing and the clamp.
  public static let driftNaturalFrequency = 0.3
  public static let driftDamping = 0.9
  public static let driftSmoothingSeconds = 0.25
  public static let driftMedianSeconds = 2.0
  public static let driftLimit = 500e-6

  public struct Statistics: Sendable, Equatable {
    /// Runs started for a new session or an error over a second, the first one included.
    public var timelines: UInt64 = 0
    /// Of those, the ones a new session started (the first included); the rest were an error over a
    /// second within one session.
    public var sessionTimelines: UInt64 = 0
    /// The largest error a step corrected, in seconds, signed as `lastErrorSeconds`.
    public var largestStepSeconds: Double = 0
    /// Runs started by a sustained error over 100 ms.
    public var steps: UInt64 = 0
    /// Runs begun on arrival time and moved once to the first capture time.
    public var reanchors: UInt64 = 0
    /// Gaps in the source's own sample count: sound the camera sent that never arrived.
    public var gaps: UInt64 = 0
    public var gapSeconds: Double = 0
    public var appendedBuffers: UInt64 = 0
    /// Placed further ahead than `maximumLeadSeconds`, or so far behind the ring no longer holds
    /// where it belongs.
    public var futureBuffers: UInt64 = 0
    public var staleBuffers: UInt64 = 0
    /// The mapping's last error against the write head, positive when the mapping puts the sound
    /// later than the run does.
    public var lastErrorSeconds: Double = 0
    /// The drift loop's correction: how much faster than its own count the camera's sound is laid
    /// down, in parts per million. Zero after a step or a new timeline.
    public var driftPartsPerMillion: Double = 0
    /// Where the newest sample sits, nil before any.
    public var writeEnd: Int64?

    public init() {}
  }

  /// What one mix is doing with this source. Kept by the mix, advanced by `read`.
  public struct Reader: Sendable {
    public enum Phase: String, Sendable {
      case playing, fadingOut, silent, buffering, fadingIn
    }

    public internal(set) var phase: Phase = .silent
    /// The run being played; nil while silent.
    var run: Int?
    var fadeInDone = 0
    /// A fade out under way: it ends at `end`, having started at `start`, whatever arrives meanwhile.
    var fadeOut: (start: Int64, end: Int64)?
    var hasPlayed = false
    /// Fades out into silence: underruns, steps, new timelines.
    public internal(set) var fades: UInt64 = 0
    /// Samples of silence emitted after this source had first been heard.
    public internal(set) var concealedFrames: UInt64 = 0
    let id: Int

    public init(id: Int) {
      self.id = id
    }

    public var concealedSeconds: Double { Double(concealedFrames) / SourceSoundTimeline.sampleRate }
  }

  struct Segment: Equatable {
    let run: Int
    var start: Int64
    var end: Int64
  }

  private let clock: DirectorClock
  private let uptime: @Sendable () -> Double
  private let lock = NSLock()
  private var ring: [Int16]
  private let capacityFrames: Int
  private var segments: [Segment] = []
  private var runID = 0
  private var session: UInt64?
  private var expectedSourcePosition: Int64?
  /// The next sample's master position, fractional while the drift loop is steering.
  private var writeHead: Double?
  /// The previous buffer's last sample, so the resampler interpolates across buffers.
  private var lastSample: (Int16, Int16)?
  private var drift = DriftLoop()
  private var offTargetSince: Double?
  /// The current run was placed by arrival, and the first capture time will move it.
  private var provisional = false
  private var wallOffset: Double?
  private var trim: Double = 0
  private var statistics = Statistics()
  /// Each reader's last read end, so a buffer written behind it is counted as late for that mix.
  private var readHeads: [Int: Int64] = [:]
  private var lateByReader: [Int: UInt64] = [:]

  public init(
    clock: DirectorClock,
    uptime: @escaping @Sendable () -> Double = HostUptime.seconds,
    capacitySeconds: Double = SourceSoundTimeline.capacitySeconds
  ) {
    self.clock = clock
    self.uptime = uptime
    capacityFrames = Int(Self.sampleRate * capacitySeconds)
    ring = [Int16](repeating: 0, count: capacityFrames * Self.channelCount)
  }

  public var currentStatistics: Statistics {
    lock.lock()
    defer { lock.unlock() }
    return statistics
  }

  /// A per-camera constant added to every capture time: a camera whose sound is stamped early by a
  /// known amount is moved later by it.
  public var trimSeconds: Double {
    get {
      lock.lock()
      defer { lock.unlock() }
      return trim
    }
    set {
      lock.lock()
      trim = newValue
      lock.unlock()
    }
  }

  /// Buffers written entirely behind where `reader` had already read: silence in that mix.
  public func lateBuffers(for reader: Int) -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return lateByReader[reader] ?? 0
  }

  /// Seconds of sound held ahead of `position`, nil when nothing covers it.
  public func secondsHeld(after position: Int64) -> Double? {
    lock.lock()
    defer { lock.unlock() }
    guard let end = statistics.writeEnd, end > position else { return nil }
    return Double(end - position) / Self.sampleRate
  }

  // MARK: - Positions

  /// The uptime sample of a wall-clock instant. Called with `lock` held.
  private func position(ofWall wall: Double) -> Int64 {
    let offset = clock.now.seconds - uptime()
    if let current = wallOffset, abs(offset - current) <= AudioMixer.wallOffsetToleranceSeconds {
      // Within the jitter of reading two clocks one after the other: keep what we have.
    } else {
      wallOffset = offset
    }
    return Int64(((wall - (wallOffset ?? offset)) * Self.sampleRate).rounded())
  }

  // MARK: - Writing

  /// Lays one decoded buffer down. Never blocks on a reader for longer than a copy.
  public func append(_ frame: AudioFrame) {
    guard let converted = AudioPCM.stereoSamples(
      from: frame.sampleBuffer,
      sampleRate: Self.sampleRate,
      channelCount: Self.channelCount
    ) else { return }
    var samples = converted[...]
    var count = samples.count / Self.channelCount
    guard count > 0 else { return }

    lock.lock()
    defer { lock.unlock() }

    let now = Int64((uptime() * Self.sampleRate).rounded())
    // On uptime when the source maps there, which no wall-clock step can move; through the wall
    // clock only for a source that maps nowhere else.
    var mapped = frame.captureUptime.map { Int64((($0 + trim) * Self.sampleRate).rounded()) }
      ?? position(ofWall: frame.wallClock.seconds + trim)
    let sourceEnd = frame.sourceSamplePosition.map { $0 + Int64(count) }
    var startsRun = writeHead == nil || frame.sessionID != session
    var place = Double(mapped)

    if !startsRun, var head = writeHead {
      let ratio = drift.ratio
      if let source = frame.sourceSamplePosition, let expected = expectedSourcePosition {
        let gap = source - expected
        if gap < 0 {
          // Sound the run already holds: keep only what is new.
          let drop = Int(-gap)
          guard drop < count else {
            expectedSourcePosition = max(expected, source + Int64(count))
            return
          }
          samples = samples.dropFirst(drop * Self.channelCount)
          count -= drop
          mapped += Int64(drop)
        } else if gap > 0 {
          // However long: the same session counts on the same clock, so a lost stretch is a gap
          // where it was lost. A new timeline is for a new session, or a mapping a second out.
          head += Double(gap) * ratio
          lastSample = nil
          statistics.gaps &+= 1
          statistics.gapSeconds += Double(gap) / Self.sampleRate
        }
      }
      if !startsRun {
        let error = (Double(mapped) - head) / Self.sampleRate
        statistics.lastErrorSeconds = error
        place = head
        if provisional, frame.isCaptureTime {
          provisional = false
          if abs(error) >= Self.ignoreSeconds {
            runID += 1
            statistics.reanchors &+= 1
            offTargetSince = nil
            place = Double(mapped)
            restartRun()
          }
        } else if abs(error) > Self.newTimelineSeconds {
          startsRun = true
        } else if abs(error) > Self.stepSeconds {
          let at = frame.wallClock.seconds
          if let since = offTargetSince {
            if at - since >= Self.stepHoldSeconds - 1e-9 {
              runID += 1
              statistics.steps &+= 1
              if abs(error) > abs(statistics.largestStepSeconds) { statistics.largestStepSeconds = error }
              offTargetSince = nil
              place = Double(mapped)
              restartRun()
            }
          } else {
            offTargetSince = at
          }
        } else {
          offTargetSince = nil
        }
        if frame.isCaptureTime, !provisional, place == head {
          drift.update(errorSeconds: error, over: Double(count) / Self.sampleRate)
        }
      }
    }
    if startsRun {
      runID += 1
      statistics.timelines &+= 1
      if writeHead == nil || frame.sessionID != session { statistics.sessionTimelines &+= 1 }
      offTargetSince = nil
      place = Double(mapped)
      provisional = !frame.isCaptureTime
      restartRun()
    }
    session = frame.sessionID
    expectedSourcePosition = sourceEnd
    let ratio = drift.ratio
    statistics.driftPartsPerMillion = drift.correction * 1_000_000
    let previous = lastSample
    writeHead = place + Double(count) * ratio
    let first = samples.startIndex
    lastSample = (samples[first + (count - 1) * Self.channelCount], samples[first + (count - 1) * Self.channelCount + 1])

    // Master positions this buffer covers: after the previous buffer's last sample (place - ratio)
    // up to its own last (place + (count - 1) * ratio).
    let low = Int64((place - ratio).rounded(.down)) + 1
    let high = Int64((place + Double(count - 1) * ratio).rounded(.down))
    guard high >= low else { return }
    if Double(low) > Double(now) + Self.maximumLeadSeconds * Self.sampleRate {
      statistics.futureBuffers &+= 1
      return
    }
    if high < now - Int64(capacityFrames) + Int64(Self.sampleRate) {
      statistics.staleBuffers &+= 1
      return
    }
    statistics.appendedBuffers &+= 1
    for (reader, head) in readHeads where high < head {
      lateByReader[reader, default: 0] &+= 1
    }

    func input(_ index: Int) -> (Double, Double) {
      if index < 0 {
        let held = previous ?? (samples[first], samples[first + 1])
        return (Double(held.0), Double(held.1))
      }
      let at = first + min(index, count - 1) * Self.channelCount
      return (Double(samples[at]), Double(samples[at + 1]))
    }
    for position in low ... high {
      let x = (Double(position) - place) / ratio
      let whole = Int(x.rounded(.down))
      let fraction = x - Double(whole)
      let a = input(whole)
      let slot = slot(position) * Self.channelCount
      if fraction < 1e-9 {
        ring[slot] = Int16(a.0)
        ring[slot + 1] = Int16(a.1)
      } else {
        let b = input(whole + 1)
        ring[slot] = Self.sample(a.0 + (b.0 - a.0) * fraction)
        ring[slot + 1] = Self.sample(a.1 + (b.1 - a.1) * fraction)
      }
    }
    record(Segment(run: runID, start: low, end: high + 1))
    statistics.writeEnd = max(statistics.writeEnd ?? Int64.min, high + 1)
    prune(before: (statistics.writeEnd ?? now) - Int64(capacityFrames) + Int64(Self.sampleRate))
  }

  /// A new run: the resampler and the drift loop start again.
  private func restartRun() {
    lastSample = nil
    drift = DriftLoop()
  }

  private static func sample(_ value: Double) -> Int16 {
    Int16(max(Double(Int16.min), min(Double(Int16.max), value.rounded())))
  }

  /// Extends the run's last segment or adds one, and cuts every older run off where this one
  /// starts: a run that stepped back supersedes what the old one left ahead of it.
  private func record(_ segment: Segment) {
    if let last = segments.indices.last,
       segments[last].run == segment.run,
       segments[last].end == segment.start {
      segments[last].end = segment.end
      return
    }
    segments = segments.compactMap { existing in
      guard existing.run < segment.run, existing.end > segment.start else { return existing }
      guard existing.start < segment.start else { return nil }
      var cut = existing
      cut.end = segment.start
      return cut
    }
    segments.append(segment)
  }

  private func prune(before floor: Int64) {
    segments = segments.compactMap { existing in
      guard existing.end > floor else { return nil }
      var kept = existing
      kept.start = max(kept.start, floor)
      return kept
    }
  }

  /// Forgets everything; the next buffer starts a new timeline.
  public func reset() {
    lock.lock()
    segments.removeAll()
    writeHead = nil
    lastSample = nil
    drift = DriftLoop()
    provisional = false
    session = nil
    expectedSourcePosition = nil
    offTargetSince = nil
    lock.unlock()
  }

  // MARK: - Reading

  /// The newest run's segment covering `position`.
  private func covering(_ position: Int64) -> Segment? {
    segments.last { $0.start <= position && position < $0.end }
  }

  /// The first segment starting in `range`, newest run first on a tie.
  private func firstStart(in range: Range<Int64>) -> Segment? {
    segments
      .filter { range.contains($0.start) }
      .min { $0.start == $1.start ? $0.run > $1.run : $0.start < $1.start }
  }

  /// Adds `count` frames of this source from `position` into `mix`, through `reader`.
  ///
  /// `reserveFrames` is how much sound must be held ahead before a source that went quiet is heard
  /// again, so a trickle does not chop on and off; `flushing` waives it at the end of a take.
  /// `stopAt` fades the source out by that position whatever it holds: the mix moving its read head.
  public func read(
    _ reader: inout Reader,
    at position: Int64,
    count: Int,
    gain: Double,
    reserveFrames: Int,
    flushing: Bool = false,
    stopAt: Int64? = nil,
    into mix: inout [Int32]
  ) {
    lock.lock()
    defer { lock.unlock() }
    let end = position + Int64(count)
    readHeads[reader.id] = max(readHeads[reader.id] ?? Int64.min, end)
    let fade = Int64(Self.fadeFrames)
    var cursor = position

    while cursor < end {
      if let run = reader.run {
        guard let segment = covering(cursor), segment.run == run else {
          // Gone without warning: the run was cut where nothing newer begins. Go quiet.
          reader.run = nil
          reader.fadeOut = nil
          reader.phase = .silent
          reader.fades &+= 1
          continue
        }
        if reader.fadeOut == nil {
          // A newer run never starts inside this segment: `record` cut it off where that one begins.
          var cut = segment.end
          if let stopAt { cut = min(cut, max(stopAt, cursor)) }
          if cut < end + fade {
            reader.fadeOut = (max(cursor, cut - fade), cut)
          }
        }
        guard let fadeOut = reader.fadeOut else {
          copy(from: cursor, to: end, reader: &reader, fadeOutStart: nil, fadeOutEnd: nil, gain: gain, into: &mix, base: position)
          reader.phase = reader.fadeInDone < Self.fadeFrames ? .fadingIn : .playing
          cursor = end
          continue
        }
        let stop = min(fadeOut.end, end, segment.end)
        copy(from: cursor, to: stop, reader: &reader, fadeOutStart: fadeOut.start, fadeOutEnd: fadeOut.end, gain: gain, into: &mix, base: position)
        if stop >= fadeOut.end || stop >= segment.end {
          reader.run = nil
          reader.fadeOut = nil
          reader.phase = .silent
          reader.fades &+= 1
        } else {
          // The fade runs on into the next chunk.
          reader.phase = .fadingOut
        }
        cursor = max(stop, cursor)
      } else {
        let candidate: Segment
        if let here = covering(cursor) {
          candidate = here
        } else if let next = firstStart(in: (cursor + 1) ..< end) {
          if reader.hasPlayed { reader.concealedFrames &+= UInt64(next.start - cursor) }
          cursor = next.start
          continue
        } else {
          if reader.hasPlayed { reader.concealedFrames &+= UInt64(end - cursor) }
          reader.phase = .silent
          return
        }
        if let stopAt, cursor >= stopAt {
          if reader.hasPlayed { reader.concealedFrames &+= UInt64(end - cursor) }
          return
        }
        let held = runEnd(of: candidate) - cursor
        guard flushing || held >= Int64(reserveFrames) else {
          if reader.hasPlayed { reader.concealedFrames &+= UInt64(end - cursor) }
          reader.phase = .buffering
          return
        }
        reader.run = candidate.run
        reader.fadeInDone = 0
        reader.hasPlayed = true
        reader.phase = .fadingIn
      }
    }
  }

  /// Where `segment`'s run stops being contiguous.
  private func runEnd(of segment: Segment) -> Int64 {
    var end = segment.end
    for other in segments where other.run == segment.run && other.start == end {
      end = other.end
    }
    return end
  }

  private func copy(
    from start: Int64,
    to stop: Int64,
    reader: inout Reader,
    fadeOutStart: Int64?,
    fadeOutEnd: Int64?,
    gain: Double,
    into mix: inout [Int32],
    base: Int64
  ) {
    guard stop > start else { return }
    for position in start ..< stop {
      var level = gain
      if reader.fadeInDone < Self.fadeFrames {
        reader.fadeInDone += 1
        level *= Self.rise(reader.fadeInDone, of: Self.fadeFrames)
      }
      if let fadeOutStart, let fadeOutEnd, position >= fadeOutStart {
        let length = Int(fadeOutEnd - fadeOutStart)
        let done = Int(position - fadeOutStart) + 1
        level *= 1 - Self.rise(done, of: length)
      }
      let slot = slot(position) * Self.channelCount
      let out = Int(position - base) * Self.channelCount
      mix[out] += Int32((Double(ring[slot]) * level).rounded())
      mix[out + 1] += Int32((Double(ring[slot + 1]) * level).rounded())
    }
  }

  /// Raised cosine from 0 to 1 over `length` steps; step `length` is 1.
  static func rise(_ step: Int, of length: Int) -> Double {
    guard length > 0 else { return 1 }
    let x = min(1, max(0, Double(step) / Double(length)))
    return 0.5 * (1 - cos(Double.pi * x))
  }

  private func slot(_ position: Int64) -> Int {
    let remainder = position % Int64(capacityFrames)
    return Int(remainder < 0 ? remainder + Int64(capacityFrames) : remainder)
  }
}

/// Every contributing camera's timeline, shared by the live and the recording mixes, so each
/// camera's sound is decoded and laid down once.
public final class SourceSoundTimelines: @unchecked Sendable {
  private let clock: DirectorClock
  private let uptime: @Sendable () -> Double
  private let lock = NSLock()
  private var timelines: [SourceID: SourceSoundTimeline] = [:]
  private var trims: [SourceID: Double] = [:]

  public init(clock: DirectorClock, uptime: @escaping @Sendable () -> Double = HostUptime.seconds) {
    self.clock = clock
    self.uptime = uptime
  }

  /// The source's timeline, made on first use.
  public func timeline(for id: SourceID) -> SourceSoundTimeline {
    lock.lock()
    defer { lock.unlock() }
    if let existing = timelines[id] { return existing }
    let made = SourceSoundTimeline(clock: clock, uptime: uptime)
    made.trimSeconds = trims[id] ?? 0
    timelines[id] = made
    return made
  }

  public func existing(_ id: SourceID) -> SourceSoundTimeline? {
    lock.lock()
    defer { lock.unlock() }
    return timelines[id]
  }

  public func append(_ frame: AudioFrame) {
    timeline(for: frame.sourceID).append(frame)
  }

  /// Drops the timelines of sources no longer contributing.
  public func retain(_ ids: Set<SourceID>) {
    lock.lock()
    timelines = timelines.filter { ids.contains($0.key) }
    lock.unlock()
  }

  public func removeAll() {
    lock.lock()
    timelines.removeAll()
    lock.unlock()
  }

  /// Per-camera trims, applied to timelines now and made later.
  public func setTrims(_ values: [SourceID: Double]) {
    lock.lock()
    trims = values
    let current = timelines
    lock.unlock()
    for (id, timeline) in current { timeline.trimSeconds = values[id] ?? 0 }
  }
}

/// The second-order loop that steers one camera's resampler: proportional and integral on the
/// mapping's error, smoothed over `driftSmoothingSeconds`, clamped to `driftLimit` either way.
struct DriftLoop {
  /// The last `driftMedianSeconds` of errors, oldest first, each with the seconds it covers. The
  /// loop is driven by their median: a sender report that moves the mapping for a moment (seen on
  /// the bench at -72 ms for one report) would otherwise throw the correction to its clamp. Two
  /// seconds rejects a jump lasting up to a second and still converges within 15 s.
  private var recent: [(error: Double, seconds: Double)] = []
  private var recentSeconds = 0.0
  private(set) var smoothedError = 0.0
  private(set) var integral = 0.0
  private(set) var correction = 0.0

  /// Output samples per input sample.
  var ratio: Double { 1 + correction }

  mutating func update(errorSeconds error: Double, over seconds: Double) {
    guard seconds > 0 else { return }
    let omega = SourceSoundTimeline.driftNaturalFrequency
    let limit = SourceSoundTimeline.driftLimit
    recent.append((error, seconds))
    recentSeconds += seconds
    while recentSeconds > SourceSoundTimeline.driftMedianSeconds + 1e-9, recent.count > 1 {
      recentSeconds -= recent.removeFirst().seconds
    }
    let sorted = recent.map(\.error).sorted()
    let median = sorted[sorted.count / 2]
    let alpha = seconds / (SourceSoundTimeline.driftSmoothingSeconds + seconds)
    smoothedError += alpha * (median - smoothedError)
    integral = min(limit, max(-limit, integral + omega * omega * smoothedError * seconds))
    let proportional = 2 * SourceSoundTimeline.driftDamping * omega * smoothedError
    correction = min(limit, max(-limit, proportional + integral))
  }
}
