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

  /// A timestamp further from ours than this is a sender whose clock is not set, rather than a
  /// camera an hour away. Beyond it we fall back to arrival time, because placing a segment an
  /// hour into the future breaks the DVR timeline for every other camera too.
  public static let maximumClockSkewSeconds: Double = 3_600

  /// Consecutive frames older than the last one accepted before a sender's clock is taken to have
  /// restarted rather than its frames to have been reordered.
  ///
  /// Persistence rather than size is what separates the two. A reordered frame is one frame, and
  /// the next one is in order again; a rebooted camera sends nothing but older timestamps from
  /// then on. Judging by size instead would let a single anomalous timestamp re-anchor the clock,
  /// and one bad frame is not evidence of anything. Thirty frames is half a second at 60 fps —
  /// the cost of the diagnosis, paid once per reboot.
  public static let clockRestartFrames = 30

  public struct Timing: Sendable {
    /// Monotonic on this source's own timeline, which is what the archive and the delay line both
    /// index by.
    public let presentationTime: CMTime
    public let duration: CMTime
    /// When the picture was taken, on the Director's clock. Nil only when the sender gave us
    /// nothing usable.
    public let captureWallClock: WallClock?
    /// Zero-based, per source.
    public let frameID: UInt64
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
  private var lastOffsetSampleAt: Double = 0
  /// The window's maximum, kept rather than recomputed so the per-frame cost is a comparison.
  private var cachedFilteredOffset: Double?

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

  public func reset() {
    lock.lock()
    frameID = 0
    frameRate = 0
    nextPresentation = .zero
    lastTimestamp = 0
    offsetSamples.removeAll(keepingCapacity: true)
    cachedFilteredOffset = nil
    lastOffsetSampleAt = 0
    consecutiveBackwards = 0
    rateEstimator.reset()
    lastRateSampleTimestamp = 0
    lastArrivalSeconds = 0
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
  private var filteredOffsetSeconds: Double? { cachedFilteredOffset }

  /// Nil means the frame should be dropped: its timestamp went backwards, and writing it would put
  /// a negative-duration sample into a fragmented MP4, which the muxer refuses outright.
  public func timing(for frame: NDIlib_video_frame_v2_t) -> Timing? {
    let declared = Double(frame.frame_rate_N) / Double(frame.frame_rate_D)
    let arrival = clock.now

    lock.lock()
    defer { lock.unlock() }

    let timestamp = frame.timestamp
    let hasTimestamp = timestamp != NDIlib_recv_timestamp_undefined && timestamp > 0

    if hasTimestamp {
      if lastTimestamp != 0, timestamp < lastTimestamp {
        backwardsTimestamps += 1
        consecutiveBackwards += 1
        // A camera that reboots comes back with its clock restarted, so every frame it sends is
        // older than the last one accepted before it went away. Refusing them as reordering wedges
        // the tile for good: measured on a Hollyland Cosmo C2 power-cycled mid-session, 614 frames
        // arrived in ten seconds and all 614 were refused, while the picture stayed frozen on the
        // last frame from before the reboot.
        guard consecutiveBackwards >= Self.clockRestartFrames else { return nil }
        senderClockRestarts += 1
        consecutiveBackwards = 0
        // Everything derived from the old clock goes with it. The presentation timeline does not:
        // it is a counter advancing at the measured rate, so it stays monotonic across the restart
        // and the archive keeps a continuous timeline through a camera reboot.
        lastRateSampleTimestamp = 0
        offsetSamples.removeAll(keepingCapacity: true)
        cachedFilteredOffset = nil
        lastOffsetSampleAt = 0
      } else {
        consecutiveBackwards = 0
      }
      lastTimestamp = timestamp
    }

    // Measure the rate from the sender's own clock where there is one: it is stamped at capture,
    // so it carries the sender's pacing without the network's jitter on top. Arrival spacing is
    // the fallback, and is what a sender that stamps nothing leaves us.
    if hasTimestamp {
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
    if hasTimestamp {
      let senderSeconds = Double(timestamp) / Self.ticksPerSecond
      let offset = senderSeconds - arrival.seconds
      // A sender with an unset clock reports 1970, or a date years out. Anchoring the DVR to that
      // would put every segment of this camera outside the recording's own span.
      if abs(offset) <= Self.maximumClockSkewSeconds,
         arrival.seconds - lastOffsetSampleAt >= Self.offsetSampleIntervalSeconds {
        lastOffsetSampleAt = arrival.seconds
        offsetSamples.append((atSeconds: arrival.seconds, offset: offset))
        let cutoff = arrival.seconds - Self.offsetWindowSeconds
        if let oldest = offsetSamples.first, oldest.atSeconds < cutoff {
          offsetSamples.removeAll { $0.atSeconds < cutoff }
          cachedFilteredOffset = offsetSamples.map(\.offset).max()
        } else if let current = cachedFilteredOffset {
          cachedFilteredOffset = Swift.max(current, offset)
        } else {
          cachedFilteredOffset = offset
        }
      }
      if let offset = filteredOffsetSeconds {
        capture = WallClock(seconds: senderSeconds - offset)
      }
    }

    return Timing(
      presentationTime: presentationTime,
      duration: duration,
      captureWallClock: capture ?? arrival,
      frameID: id
    )
  }

  /// Audio runs on its own counter, in its own timebase, exactly as the RTSP path treats a
  /// camera's audio clock as unrelated to its video clock.
  public func audioPresentationTime(sampleIndex: Int64, sampleRate: Double) -> CMTime {
    CMTime(value: sampleIndex, timescale: CMTimeScale(sampleRate))
  }
}
