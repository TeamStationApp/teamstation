import CNDI
import CoreMedia
import Foundation
import DirectorCore

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
public final class NDIReceiveClock: @unchecked Sendable {
  /// NDI expresses both of its clocks in 100 ns units.
  public static let ticksPerSecond: Double = 10_000_000

  /// A timestamp further from ours than this is a sender whose clock is not set, rather than a
  /// camera an hour away. Beyond it we fall back to arrival time, because placing a segment an
  /// hour into the future breaks the DVR timeline for every other camera too.
  public static let maximumClockSkewSeconds: Double = 3_600

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
  private var frameRate: Double = 0
  private var timescale: CMTimeScale = 90_000
  private var nextPresentation: CMTime = .zero
  private var lastTimestamp: Int64 = 0
  /// Sender UTC minus ours, from the first frame that carried a timestamp. Held rather than
  /// recomputed so a camera whose clock steps mid-game does not drag its archive with it.
  private var clockOffsetSeconds: Double?
  private var backwardsTimestamps: UInt64 = 0

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

  public func reset() {
    lock.lock()
    frameID = 0
    frameRate = 0
    nextPresentation = .zero
    lastTimestamp = 0
    clockOffsetSeconds = nil
    lock.unlock()
  }

  /// Nil means the frame should be dropped: its timestamp went backwards, and writing it would put
  /// a negative-duration sample into a fragmented MP4, which the muxer refuses outright.
  public func timing(for frame: NDIlib_video_frame_v2_t) -> Timing? {
    let rate = Double(frame.frame_rate_N) / Double(frame.frame_rate_D)
    let arrival = clock.now

    lock.lock()
    defer { lock.unlock() }

    // A rate change restarts the presentation timeline's step but not its position: the archive
    // writer handles the format change, and the frames before it keep the times they were written
    // with.
    if rate != frameRate {
      frameRate = rate
      // 90 kHz is the MPEG timebase and divides 30, 60, 25 and 50 exactly; 59.94 lands on
      // 90000/59.94 = 1501.5, so the timescale is scaled by the denominator instead.
      timescale = CMTimeScale(max(1, frame.frame_rate_N))
    }

    let timestamp = frame.timestamp
    let hasTimestamp = timestamp != NDIlib_recv_timestamp_undefined && timestamp > 0

    if hasTimestamp {
      if lastTimestamp != 0, timestamp < lastTimestamp {
        backwardsTimestamps += 1
        return nil
      }
      lastTimestamp = timestamp
    }

    let presentationTime = nextPresentation
    let duration = CMTime(
      value: CMTimeValue(frame.frame_rate_D),
      timescale: timescale
    )
    nextPresentation = CMTimeAdd(presentationTime, duration)

    let id = frameID
    frameID += 1

    var capture: WallClock?
    if hasTimestamp {
      let senderSeconds = Double(timestamp) / Self.ticksPerSecond
      if clockOffsetSeconds == nil {
        let offset = senderSeconds - arrival.seconds
        // A sender with an unset clock reports 1970, or a date years out. Anchoring the DVR to
        // that would put every segment of this camera outside the recording's own span.
        clockOffsetSeconds = abs(offset) <= Self.maximumClockSkewSeconds ? offset : nil
      }
      if let offset = clockOffsetSeconds {
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
