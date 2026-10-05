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
/// emitting: the live mix half a second, the recording's mix none but five seconds later.
///
/// The mapping only steers. Within one continuous run the sound is laid down by sample count, so
/// the jitter in each sender report and in arrival never reaches the mix:
///
/// | Mapping's error against the write head | Action |
/// |---|---|
/// | under 4 ms | ignored |
/// | 4–100 ms | left to the drift loop (D3); nothing moves here |
/// | over 100 ms for a second | one step: a new run at the mapped place, under a fade |
/// | over 1 s, or a new session | a new timeline: a new run at the mapped place |
///
/// A run that had to start on arrival time, because the session's first sender report had not come
/// yet, is re-anchored once to the first capture time that disagrees with it by 4 ms or more: the
/// guess is replaced, not steered.
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
  private var writeHead: Int64?
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
    var place = mapped

    if !startsRun, var head = writeHead {
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
          head += gap
          statistics.gaps &+= 1
          statistics.gapSeconds += Double(gap) / Self.sampleRate
        }
      }
      if !startsRun {
        let error = Double(mapped - head) / Self.sampleRate
        statistics.lastErrorSeconds = error
        place = head
        if provisional, frame.isCaptureTime {
          provisional = false
          if abs(error) >= Self.ignoreSeconds {
            runID += 1
            statistics.reanchors &+= 1
            offTargetSince = nil
            place = mapped
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
              place = mapped
            }
          } else {
            offTargetSince = at
          }
        } else {
          offTargetSince = nil
        }
      }
    }
    if startsRun {
      runID += 1
      statistics.timelines &+= 1
      if writeHead == nil || frame.sessionID != session { statistics.sessionTimelines &+= 1 }
      offTargetSince = nil
      place = mapped
      provisional = !frame.isCaptureTime
    }
    session = frame.sessionID
    expectedSourcePosition = sourceEnd
    writeHead = place + Int64(count)

    if place > now + Int64(Self.maximumLeadSeconds * Self.sampleRate) {
      statistics.futureBuffers &+= 1
      return
    }
    if place + Int64(count) <= now - Int64(capacityFrames) + Int64(Self.sampleRate) {
      statistics.staleBuffers &+= 1
      return
    }
    statistics.appendedBuffers &+= 1
    for (reader, head) in readHeads where place + Int64(count) <= head {
      lateByReader[reader, default: 0] &+= 1
    }

    var index = samples.startIndex
    for offset in 0 ..< count {
      let slot = slot(place + Int64(offset)) * Self.channelCount
      ring[slot] = samples[index]
      ring[slot + 1] = samples[index + 1]
      index += Self.channelCount
    }
    record(Segment(run: runID, start: place, end: place + Int64(count)))
    statistics.writeEnd = max(statistics.writeEnd ?? Int64.min, place + Int64(count))
    prune(before: (statistics.writeEnd ?? now) - Int64(capacityFrames) + Int64(Self.sampleRate))
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
