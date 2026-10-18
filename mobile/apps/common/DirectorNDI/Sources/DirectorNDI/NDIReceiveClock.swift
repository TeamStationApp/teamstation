import CNDI
import CoreMedia
import Foundation
import DirectorCore
import DirectorSources

/// Turns NDI's two clocks into the one timeline the pipeline needs.
///
/// NDI hands a receiver more than RTSP ever did, and the difference is worth being explicit about.
/// The RTSP path had to *reconstruct* an absolute capture time from RTCP sender reports, which
/// arrive every few seconds and are the reason two cameras rewound to the same moment could land
/// in different places. NDI stamps every frame with `timestamp`: UTC, 100 ns units, filled by the
/// sending SDK from a high-precision clock and documented as roughly microsecond-accurate. That is
/// exactly `CompressedFrame.captureWallClock`, for free and per frame.
///
/// Not every sender's clock is UTC. A Hollyland Cosmo C2 stamps time since it was powered on, so
/// its clock reads a few hours past 1970. That does not matter: what is used is the sender's clock
/// mapped onto ours through the measured offset, so only its steadiness counts, and the Cosmo's
/// stamps sit within a few milliseconds of an even 60 fps grid while its pictures arrive in
/// 100 ms bursts. A clock that jumps, which is what a reboot does, is re-measured on the spot;
/// see `clockJumpSeconds`.
///
/// `timecode` is deliberately not used for any of this. The documentation says it is generally not
/// used internally and is passed through for applications to interpret as they wish — so a sender
/// may make it a wall clock, a zero-based counter, or nothing at all, and building a timeline on it
/// would work against one camera and fail against the next.
///
/// What a sender says about its **frame rate** is not trusted either. `frame_rate_N/D` is a
/// declaration, and a Hollyland Cosmo C2 declares 120/1 while sending 60 — measured against its
/// own timestamps and the SDK's dropped-frame counters, which agree on 60.00 with nothing lost.
/// Stepping the presentation timeline by a declared 1/120 while being fed 60 fps wrote a video
/// track lasting half its own audio track, so the step comes from `FrameRateEstimator` and the
/// declaration is used only until enough frames have arrived to measure one.
public final class NDIReceiveClock: @unchecked Sendable {
  /// NDI expresses both of its clocks in 100 ns units.
  public static let ticksPerSecond: Double = 10_000_000

  /// How far a sender's clock may move against ours between two frames before it is taken to
  /// have been reset rather than to be running.
  ///
  /// How far the sender's clock is from ours does not matter. The offset between the two is
  /// measured and filtered, so a Hollyland Cosmo C2, whose clock is time since it was powered on
  /// and therefore reads 1970 plus a few hours, is mapped onto our clock as exactly as a sender
  /// set to UTC. It used to matter: anything over an hour from ours was refused as an unset clock,
  /// which put every Cosmo picture at its arrival time, and the Cosmo delivers in bursts.
  ///
  /// What does matter is the clock moving. The Cosmo reboots every half hour or so, sometimes more
  /// often when it hangs, and comes back counting from zero, so its clock falls back by however
  /// long it had been up. Nothing else moves a running clock by seconds, so a frame whose stamp has
  /// moved more than this against the time that passed here, followed by a frame that agrees with
  /// it, re-measures the offset from that second frame, a few milliseconds after the first: no
  /// frames refused. A hang does not count, because the sender's clock and ours both moved on by
  /// its length. A move of less than this is reordering, or jitter.
  ///
  /// One bad frame is not evidence of anything: a frame stamped an hour off between frames on the
  /// running clock is an outlier. It is placed at its arrival, and the clock carries on from the
  /// frame before it as if it had never come, with no restart and the offset window kept.
  ///
  /// A backlog on our side is not a jump either. After our receive thread stalls for longer than
  /// this (the Director backgrounded, say), the SDK hands over the frames queued before the stall:
  /// their stamps carry on from the last frame's, zero to this many seconds on, and only the time
  /// that passed here is large. They are taken as late frames on the running clock, placed through
  /// the existing offset and kept out of its observations, and the fresh frames after them are
  /// judged against the filtered offset, which they agree with. Nothing is re-measured.
  public static let clockJumpSeconds: Double = 10

  /// Consecutive frames older than the last one accepted before a sender's clock is taken to have
  /// restarted rather than its frames to have been reordered.
  ///
  /// The backstop behind `clockJumpSeconds`, for a clock that went back by less than that and
  /// stayed back. Persistence rather than size is what separates it from reordering: a reordered
  /// frame is one frame, and the next one is in order again. Thirty frames is half a second at
  /// 60 fps.
  public static let clockRestartFrames = 30

  public struct Timing: Sendable {
    /// Monotonic on this source's own timeline, which is what the archive and the delay line both
    /// index by.
    public let presentationTime: CMTime
    public let duration: CMTime
    /// When the picture was taken, on the Director's clock: from the sender's stamp when
    /// `isSenderCapture`, otherwise its arrival. Never nil; optional only for the callers that
    /// share `CompressedFrame`'s shape.
    public let captureWallClock: WallClock?
    /// Zero-based, per source.
    public let frameID: UInt64
    /// The capture time came from the sender's own stamp, rather than from when the frame arrived.
    public let isSenderCapture: Bool
  }

  /// What `/dump-state` reports about this sender's clock.
  public struct Report: Sendable, Equatable {
    /// Observations the filtered offset currently rests on.
    public var offsetSamples = 0
    /// Sender clock minus ours, minimum-delay filtered, and the latest raw observation.
    public var filteredOffsetSeconds: Double = 0
    public var observedOffsetSeconds: Double = 0
    /// The last frame's capture time on our clock, and how long before its arrival that was.
    public var lastCaptureSeconds: Double = 0
    public var lastCaptureAgeSeconds: Double = 0
    /// Frames placed by the sender's stamp, and frames placed at their arrival.
    public var capturesFromSender: UInt64 = 0
    public var capturesFromArrival: UInt64 = 0
  }

  private let clock: DirectorClock
  private let lock = NSLock()

  private var frameID: UInt64 = 0
  /// The rate the timeline is currently stepping at, measured rather than declared.
  private var frameRate: Double = 0
  private var timescale: CMTimeScale = 90_000
  private var frameDuration: CMTimeValue = 1_500
  private var nextPresentation: CMTime = .zero
  private var lastTimestamp: Int64 = 0
  /// When the frame stamped `lastTimestamp` arrived, on our clock: how much time the sender's clock
  /// should have moved on since.
  private var lastTimestampArrival: Double = 0
  /// A frame that moved more than `clockJumpSeconds` and is waiting for the next to confirm it.
  private var unconfirmedJump: (timestamp: Int64, arrival: Double)?
  private var backwardsTimestamps: UInt64 = 0
  private var consecutiveBackwards = 0
  private var senderClockRestarts: UInt64 = 0

  /// Measures the rate from the sender's own timestamps, falling back to arrival spacing for a
  /// sender that stamps nothing. Its answer replaces `frame_rate_N/D` for timeline purposes.
  private var rateEstimator = FrameRateEstimator()
  private var lastRateSampleTimestamp: Int64 = 0
  private var lastArrivalSeconds: Double = 0

  /// Rolling window of sender-UTC-minus-ours observations.
  ///
  /// A single observation was held for the whole session so that a camera whose clock steps could
  /// not drag its archive with it. That also pinned the estimate to whatever the first frame's
  /// transit happened to be and let a long session drift with the sender's crystal. A window fixes
  /// both, and the presentation timeline no longer depends on this at all — it steps at the
  /// measured rate — so a clock correction moves only where segments sit in the DVR, which is
  /// exactly what it should move.
  private var offsetSamples: [(atSeconds: Double, offset: Double)] = []
  private static let offsetWindowSeconds: Double = 600
  /// One observation a second is plenty for a clock difference, and it is what keeps this cheap:
  /// NDI offers an offset on *every frame*, so an unthrottled window would hold 36,000 samples at
  /// 1080p60 and be scanned for its maximum once per frame, on the receive thread.
  private static let offsetSampleIntervalSeconds: Double = 1
  /// Nil until the first observation after (re)anchoring, which is therefore taken from the first
  /// frame, never a second later.
  private var lastOffsetSampleAt: Double?
  /// Every frame is an observation for this long after (re)anchoring. The first frame after a
  /// reboot is as likely as any to be the first of a burst, 80 ms late; sampling a second's worth
  /// of frames finds the least-delayed one within a burst or two, where one a second would take
  /// several seconds and move every capture time as it did.
  private static let offsetWarmupSeconds: Double = 1
  private var offsetWarmupEndsAt: Double?
  /// The best observation so far in the second not yet committed to the window.
  private var pendingBestOffset: Double?
  /// The best observation this second that sat more than `stepThresholdSeconds` above the
  /// committed offset, outside warmup; see `timing(for:)`.
  private var pendingHighOffset: Double?
  /// Consecutive frames whose observation sat that far above the committed offset, and the best of
  /// them. A late stamp is one frame; a clock that stepped forward reads high on every frame.
  private var highRun: (count: Int, best: Double)?
  /// Frames in a row adopted as a forward step: a sixth of a second at 60 fps, two bursts from a
  /// Cosmo.
  static let forwardStepFrames = 10
  /// The backlog frames in a row so far, and when the first of them arrived.
  private var backlogRun: (count: Int, firstArrival: Double)?
  /// How long a backlog may last before it is taken for a clock that paused. A real backlog is the
  /// few frames the SDK queued during our stall, handed over together and followed by fresh ones.
  /// A sender whose clock stopped while it was down (a hang loop on a Cosmo that resumes within
  /// `clockJumpSeconds` of where it stopped, a playback sender, a sleeping uptime sender) reads as
  /// backlog on every frame, at its usual pace, for ever; past this many frames, or this much of
  /// our time, it is re-measured as a restart.
  static let backlogFrames = 30
  static let backlogSeconds: Double = 0.5
  /// When every second's observations started sitting that far above the committed offset.
  private var highSince: Double?
  private var report = Report()
  /// The window's maximum, kept rather than recomputed so the per-frame cost is a comparison.
  private var cachedFilteredOffset: Double?

  /// Sound with no timestamp: arrival less the sample count's own time, the smallest in the window.
  /// Arrival is capture plus transit, and transit only ever adds, so the least-delayed buffer is the
  /// one closest to when the sound was made: the same minimum-delay filter as the clock offset.
  private var audioArrivalOffsets: [(atSeconds: Double, offset: Double)] = []
  /// Sender UTC minus ours as the sound's own frames observe it, the largest in the window: what
  /// stands in for the pictures' offset before any picture has measured one.
  private var audioTimestampOffsets: [(atSeconds: Double, offset: Double)] = []
  /// When every offset sample started reading more than `stepThresholdSeconds` below the filtered
  /// offset; see `RTPClockAudit` for why ten seconds of that is a clock step and not transit.
  private var lowSince: Double?
  private var senderClockSteps: UInt64 = 0
  static let stepThresholdSeconds: Double = 0.05
  static let stepHoldSeconds: Double = 10

  /// Times the sender's wall clock stepped back and the offset followed it.
  public var clockSteps: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return senderClockSteps
  }
  private static let audioArrivalWindowSeconds: Double = 30

  public init(clock: DirectorClock = SystemClock()) {
    self.clock = clock
  }

  /// How many frames were refused for going backwards in time. Counted rather than tolerated: a
  /// handful is a sender reordering, a count that climbs at the frame rate is a stalled timeline,
  /// and the two look identical on a frozen tile.
  public var outOfOrderFrames: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return backwardsTimestamps
  }

  /// How many times this source's clock has been seen to restart — a camera rebooting, in
  /// practice. Worth surfacing rather than absorbing silently: it explains a discontinuity in
  /// capture times, and a count that climbs steadily is a sender with an unstable clock rather
  /// than one that was power-cycled once.
  public var clockRestarts: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return senderClockRestarts
  }

  /// The sender's clock as `/dump-state` reports it.
  public var clockReport: Report {
    lock.lock()
    defer { lock.unlock() }
    var snapshot = report
    snapshot.offsetSamples = offsetSamples.count
    snapshot.filteredOffsetSeconds = filteredOffsetSeconds ?? 0
    return snapshot
  }

  public func reset() {
    lock.lock()
    frameID = 0
    frameRate = 0
    nextPresentation = .zero
    lastTimestamp = 0
    lastTimestampArrival = 0
    offsetSamples.removeAll(keepingCapacity: true)
    cachedFilteredOffset = nil
    lastOffsetSampleAt = nil
    offsetWarmupEndsAt = nil
    pendingBestOffset = nil
    pendingHighOffset = nil
    highSince = nil
    highRun = nil
    backlogRun = nil
    unconfirmedJump = nil
    report = Report()
    consecutiveBackwards = 0
    rateEstimator.reset()
    lastRateSampleTimestamp = 0
    lastArrivalSeconds = 0
    audioArrivalOffsets.removeAll(keepingCapacity: true)
    audioTimestampOffsets.removeAll(keepingCapacity: true)
    lowSince = nil
    lock.unlock()
  }

  /// The measured frame rate, once there is one. Published as the source's format so that the
  /// archive encoder's keyframe cadence and instant replay's pacing both run on a measurement
  /// rather than on what the camera claimed.
  public var measuredFrameRate: Double? {
    lock.lock()
    defer { lock.unlock() }
    return rateEstimator.frameRate
  }

  /// Sender UTC minus ours: the **largest** observation in the window.
  ///
  /// Transit delay only ever makes an observation smaller, so the least-delayed frame in the
  /// window is the one closest to the true difference between the clocks. Same minimum-delay
  /// filtering, and the same sign convention, as the RTSP path's sender-report offset.
  private var filteredOffsetSeconds: Double? {
    guard let committed = cachedFilteredOffset else { return pendingBestOffset }
    return Swift.max(committed, pendingBestOffset ?? committed)
  }

  /// Nil means the frame should be dropped: its timestamp went backwards, and writing it would put
  /// a negative-duration sample into a fragmented MP4, which the muxer refuses outright.
  public func timing(for frame: NDIlib_video_frame_v2_t) -> Timing? {
    let declared = Double(frame.frame_rate_N) / Double(frame.frame_rate_D)
    let arrival = clock.now

    lock.lock()
    defer { lock.unlock() }

    let timestamp = frame.timestamp
    let hasTimestamp = timestamp != NDIlib_recv_timestamp_undefined && timestamp > 0

    // A frame that has jumped and is not yet confirmed is placed at its arrival and leaves the
    // clock as it was; see `clockJumpSeconds`.
    var isUnconfirmedJump = false
    // A frame from a backlog on our side: its stamp carries on from the last, but it reached us
    // long after it was taken. Placed through the running offset, which is right for it, merely
    // old, and kept out of the offset's observations.
    var isBacklog = false
    if hasTimestamp {
      if lastTimestamp != 0 {
        let senderSeconds = Double(timestamp) / Self.ticksPerSecond
        // How far the sender's clock moved against ours: against the filtered offset where there
        // is one, so a frame is judged by the running mapping, not by when the frame before it
        // happened to reach us; against the time that passed here otherwise. A hang moves both.
        let drift = filteredOffsetSeconds.map { senderSeconds - arrival.seconds - $0 }
          ?? Self.moved(timestamp, at: arrival.seconds, since: lastTimestamp, at: lastTimestampArrival)
        // How far its own stamps stepped. A step of zero to `clockJumpSeconds` is the sender's clock
        // running on, however late the frame arrives: a backlog, never a jump.
        let stepped = Double(timestamp - lastTimestamp) / Self.ticksPerSecond
        let ranOn = stepped >= 0 && stepped <= Self.clockJumpSeconds
        isBacklog = ranOn && drift < -Self.clockJumpSeconds
        if isBacklog {
          let run = (count: (backlogRun?.count ?? 0) + 1, firstArrival: backlogRun?.firstArrival ?? arrival.seconds)
          if run.count > Self.backlogFrames || arrival.seconds - run.firstArrival >= Self.backlogSeconds {
            // Not a backlog: a clock that paused while the sender was down. Re-measured from this
            // frame, as a reboot is.
            backlogRun = nil
            isBacklog = false
            reanchor()
          } else {
            backlogRun = run
          }
        } else {
          backlogRun = nil
        }
        if !ranOn, abs(drift) > Self.clockJumpSeconds || stepped < -Self.clockJumpSeconds {
          if let jump = unconfirmedJump,
             abs(Self.moved(timestamp, at: arrival.seconds, since: jump.timestamp, at: jump.arrival))
             <= Self.clockJumpSeconds {
            // A reboot, or a sender setting its clock, confirmed by a second frame on the new
            // clock: re-measured from this frame, which is kept. Refusing a rebooted camera's
            // frames as reordering wedged the tile: measured on a Cosmo C2 power-cycled
            // mid-session, 614 frames arrived in ten seconds and all were refused.
            unconfirmedJump = nil
            reanchor()
          } else {
            unconfirmedJump = (timestamp, arrival.seconds)
            isUnconfirmedJump = true
          }
        } else if timestamp < lastTimestamp {
          unconfirmedJump = nil
          backwardsTimestamps += 1
          consecutiveBackwards += 1
          guard consecutiveBackwards >= Self.clockRestartFrames else { return nil }
          reanchor()
        } else {
          unconfirmedJump = nil
          consecutiveBackwards = 0
        }
      }
      if !isUnconfirmedJump {
        lastTimestamp = timestamp
        lastTimestampArrival = arrival.seconds
      }
    }
    let usesTimestamp = hasTimestamp && !isUnconfirmedJump

    // Measure the rate from the sender's own clock where there is one: it is stamped at capture,
    // so it carries the sender's pacing without the network's jitter on top. Arrival spacing is
    // the fallback, and is what a sender that stamps nothing leaves us.
    if isUnconfirmedJump {
      // Neither clock's interval means anything across it.
    } else if hasTimestamp {
      if lastRateSampleTimestamp != 0 {
        rateEstimator.note(
          intervalSeconds: Double(timestamp - lastRateSampleTimestamp) / Self.ticksPerSecond
        )
      }
      lastRateSampleTimestamp = timestamp
    } else {
      if lastArrivalSeconds != 0 {
        rateEstimator.note(intervalSeconds: arrival.seconds - lastArrivalSeconds)
      }
      lastArrivalSeconds = arrival.seconds
    }

    // The declaration is the bootstrap only: it gets the first dozen frames onto a sane timeline
    // while the measurement fills its window, and is then replaced by it for good.
    let rate = rateEstimator.frameRate ?? declared
    // A rate change restarts the presentation timeline's step but not its position: the archive
    // writer handles the format change, and the frames before it keep the times they were written
    // with.
    if rate != frameRate {
      frameRate = rate
      // Kept as an exact rational so a broadcast rate does not drift: 90000/59.94 is 1501.5, which
      // no integer timescale expresses, but 1001/60000 does exactly.
      let (numerator, denominator) = FrameRateEstimator.rational(for: rate)
      timescale = CMTimeScale(max(1, numerator))
      frameDuration = CMTimeValue(max(1, denominator))
    }

    let presentationTime = nextPresentation
    let duration = CMTime(value: frameDuration, timescale: timescale)
    nextPresentation = CMTimeAdd(presentationTime, duration)

    let id = frameID
    frameID += 1

    var capture: WallClock?
    if usesTimestamp {
      let senderSeconds = Double(timestamp) / Self.ticksPerSecond
      if isBacklog {
        if let offset = filteredOffsetSeconds { capture = WallClock(seconds: senderSeconds - offset) }
      } else {
        let offset = senderSeconds - arrival.seconds
        report.observedOffsetSeconds = offset
        // However far the sender's clock is from ours: the offset maps one onto the other, and a
        // clock that moves is caught above. Sampled from the first frame after anchoring, every frame
        // for the first second, then once a second.
        //
        // Every frame counts toward the current second's best observation, and the second's best is
        // what the window keeps. Keeping one frame a second instead kept whichever frame came first
        // once the second was up, which from a sender that bursts is the first of a burst, the most
        // delayed frame there is. On the bench Cosmo that biased every sample 50-100 ms low, held
        // for ten seconds, read as a clock step, and moved every capture time 60 ms late.
        //
        // Outside warmup, an observation more than `stepThresholdSeconds` (three frame periods at
        // 60 fps) above the committed offset is kept apart rather than folded into the second's
        // best. Transit only ever lowers an observation, so one that high is a picture the sender
        // stamped late, and as the window's maximum it would place every capture early by as much
        // for ten minutes. A clock that really stepped forward reads that high on every frame: once
        // no second has had an ordinary observation for `stepHoldSeconds`, the high ones are adopted
        // as the new offset. A step smaller than the threshold is followed at once, as before, and a
        // high percentile was not used instead because it would discard the least-delayed frames the
        // minimum-delay filter exists to find.
        let warmupEnds = offsetWarmupEndsAt ?? (arrival.seconds + Self.offsetWarmupSeconds)
        offsetWarmupEndsAt = warmupEnds
        let inWarmup = arrival.seconds < warmupEnds
        //
        // A forward step is told from a late stamp by persistence, not by waiting: transit can
        // only lower an observation, so a run of `forwardStepFrames` consecutive frames all reading
        // high is the clock, and the best of them is adopted at once. Holding a forward step for
        // `stepHoldSeconds` placed every capture in the future by the step for that long, ageing
        // the archive's queue into outages and skips. Ten seconds stays for steps back, where
        // transit can fake low readings for seconds.
        var forwardStep: Double?
        // A frame of a high run not yet long enough to be a step: placed at its arrival, as an
        // unconfirmed jump is. Through the old offset it would sit as far in the future as the step,
        // and a step past a quarter second put those pictures into the archive's queue behind the
        // correctly placed ones that follow, which were then refused as late for as long as the
        // step, leaving that long a hole in the recording.
        var isUnconfirmedHigh = false
        if !inWarmup, let committed = cachedFilteredOffset, offset > committed + Self.stepThresholdSeconds {
          pendingHighOffset = Swift.max(pendingHighOffset ?? offset, offset)
          let run = (count: (highRun?.count ?? 0) + 1, best: Swift.max(highRun?.best ?? offset, offset))
          highRun = run
          if run.count >= Self.forwardStepFrames {
            forwardStep = run.best
            highRun = nil
            highSince = nil
            senderClockSteps &+= 1
          } else {
            isUnconfirmedHigh = true
          }
        } else {
          highRun = nil
          pendingBestOffset = Swift.max(pendingBestOffset ?? offset, offset)
        }
        let due = lastOffsetSampleAt.map { arrival.seconds - $0 >= Self.offsetSampleIntervalSeconds } ?? true
        var committedSample: Double? = forwardStep
        if forwardStep != nil {
          lastOffsetSampleAt = arrival.seconds
          pendingBestOffset = nil
          pendingHighOffset = nil
        } else if due || inWarmup {
          lastOffsetSampleAt = arrival.seconds
          if let best = pendingBestOffset {
            committedSample = best
            highSince = nil
          } else if let high = pendingHighOffset {
            let since = highSince ?? arrival.seconds
            highSince = since
            if arrival.seconds - since >= Self.stepHoldSeconds {
              committedSample = high
              highSince = nil
              senderClockSteps &+= 1
            }
          }
          pendingBestOffset = nil
          pendingHighOffset = nil
        }
        if let sample = committedSample {
          // A sender clock that steps back reads low on every frame; held for ten seconds it is the
          // clock, not transit, and what was measured before the step is dropped.
          if let filtered = cachedFilteredOffset, sample < filtered - Self.stepThresholdSeconds {
            let since = lowSince ?? arrival.seconds
            lowSince = since
            if arrival.seconds - since >= Self.stepHoldSeconds {
              offsetSamples.removeAll { $0.atSeconds < since }
              cachedFilteredOffset = offsetSamples.map(\.offset).max()
              senderClockSteps &+= 1
              lowSince = nil
            }
          } else {
            lowSince = nil
          }
          offsetSamples.append((atSeconds: arrival.seconds, offset: sample))
          let cutoff = arrival.seconds - Self.offsetWindowSeconds
          if let oldest = offsetSamples.first, oldest.atSeconds < cutoff {
            offsetSamples.removeAll { $0.atSeconds < cutoff }
            cachedFilteredOffset = offsetSamples.map(\.offset).max()
          } else if let current = cachedFilteredOffset {
            cachedFilteredOffset = Swift.max(current, sample)
          } else {
            cachedFilteredOffset = sample
          }
        }
        if !isUnconfirmedHigh, let offset = filteredOffsetSeconds {
          capture = WallClock(seconds: senderSeconds - offset)
        }
      }
    }

    let placed = capture ?? arrival
    if capture == nil {
      report.capturesFromArrival &+= 1
    } else {
      report.capturesFromSender &+= 1
    }
    report.lastCaptureSeconds = placed.seconds
    report.lastCaptureAgeSeconds = arrival.seconds - placed.seconds

    return Timing(
      presentationTime: presentationTime,
      duration: duration,
      captureWallClock: placed,
      frameID: id,
      isSenderCapture: capture != nil
    )
  }

  /// Drops everything measured against the sender's old clock, so the next observation, taken from
  /// the current frame, anchors the new one. Called with the lock held.
  ///
  /// The presentation timeline is left alone: it is a counter advancing at the measured rate, so it
  /// stays monotonic across the restart and the archive keeps a continuous timeline through a camera
  /// reboot.
  private func reanchor() {
    senderClockRestarts += 1
    consecutiveBackwards = 0
    lastRateSampleTimestamp = 0
    offsetSamples.removeAll(keepingCapacity: true)
    cachedFilteredOffset = nil
    lastOffsetSampleAt = nil
    offsetWarmupEndsAt = nil
    pendingBestOffset = nil
    pendingHighOffset = nil
    highSince = nil
    highRun = nil
    backlogRun = nil
    lowSince = nil
    audioTimestampOffsets.removeAll(keepingCapacity: true)
  }

  /// How far a sender's clock moved from `earlier` to `later` beyond the time that passed here
  /// between their arrivals.
  private static func moved(_ later: Int64, at laterArrival: Double, since earlier: Int64, at earlierArrival: Double) -> Double {
    let elapsed = Swift.max(0, laterArrival - earlierArrival)
    return Double(later - earlier) / ticksPerSecond - elapsed
  }

  /// When a buffer of sound was captured, on our clock.
  ///
  /// By its NDI `timestamp` (the sender's UTC at its first sample) through the same clock offset
  /// as the pictures, so the sound lands where the pictures of the same moment do. Before any
  /// picture has measured the offset, the sound's own observations stand in, through the same
  /// minimum-delay filter. A buffer with no
  /// usable timestamp is placed by its sample count against the least-delayed arrival seen in the
  /// last 30 s, which is jitter-free where arrival is not.
  public func audioCaptureSeconds(timestamp: Int64, sampleIndex: Int64, sampleRate: Double) -> Double {
    let arrival = clock.now.seconds
    lock.lock()
    defer { lock.unlock() }
    if timestamp != NDIlib_recv_timestamp_undefined, timestamp > 0 {
      let senderSeconds = Double(timestamp) / Self.ticksPerSecond
      let observed = senderSeconds - arrival
      // The pictures' offset, unless this sound is on a clock it does not describe: a sender that
      // has just rebooted, whose sound can arrive before any picture has re-measured. Through the
      // old offset it would land as far in the past as the camera had been up.
      if let filteredOffsetSeconds, abs(observed - filteredOffsetSeconds) <= Self.clockJumpSeconds {
        return senderSeconds - filteredOffsetSeconds
      }
      let cutoff = arrival - Self.audioArrivalWindowSeconds
      audioTimestampOffsets.removeAll {
        $0.atSeconds < cutoff || abs($0.offset - observed) > Self.clockJumpSeconds
      }
      audioTimestampOffsets.append((arrival, observed))
      return senderSeconds - (audioTimestampOffsets.map(\.offset).max() ?? observed)
    }
    let counted = sampleRate > 0 ? Double(sampleIndex) / sampleRate : 0
    let offset = arrival - counted
    let cutoff = arrival - Self.audioArrivalWindowSeconds
    audioArrivalOffsets.removeAll { $0.atSeconds < cutoff }
    audioArrivalOffsets.append((arrival, offset))
    return counted + (audioArrivalOffsets.map(\.offset).min() ?? offset)
  }

  /// Audio runs on its own counter, in its own timebase, exactly as the RTSP path treats a
  /// camera's audio clock as unrelated to its video clock.
  public func audioPresentationTime(sampleIndex: Int64, sampleRate: Double) -> CMTime {
    CMTime(value: sampleIndex, timescale: CMTimeScale(sampleRate))
  }
}
