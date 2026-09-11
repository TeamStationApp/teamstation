import CoreMedia
import Foundation

/// Places a camera's audio on the timeline its video established.
///
/// A camera's audio and video clocks need not share a timebase, and two of the cameras on the bench
/// prove it: one stamps audio with the wall clock while video uses a media clock, and another's
/// audio clock runs several times faster than real time. Reusing the video base for audio put one
/// recording's sound 56 years into the future and left the muxer unable to finalise the file at all.
///
/// The source's own clock is preferred, mapped onto the video timeline by a single offset taken from
/// the first buffer, because that preserves real pacing: when buffers are lost upstream the gap
/// belongs in the track, whereas counting from sample totals would slide every later sample earlier
/// and drift out of sync for the rest of the recording.
struct ArchiveAudioTimeline {
  struct Placement: Equatable {
    let start: CMTime
    /// The source clock was given up on permanently, this buffer being the one that proved it.
    let rejectedClock: Bool
    /// Audio was so far behind the picture that the gap was left in the track rather than closed.
    let resynced: Bool
    /// How far behind the picture this buffer landed, when that is worth reporting.
    let drift: Double?
  }

  /// Beyond this the source clock has failed, whatever it claims.
  private static let clockTolerance: Double = 2
  /// Beyond this, closing the gap would cost lip sync for the rest of the recording.
  private static let resyncThreshold: Double = 0.5
  /// The same guard for audio placed through the recording's wall anchor. There the source clock is
  /// trusted, and a buffer landing behind the newest picture has only arrived late: rec-403's Pixel,
  /// thermally throttled, delivered its sound one to two seconds behind its picture, and moving that
  /// sound up to the picture is what cut holes in it. Only a disagreement this large is a clock that
  /// has failed.
  private static let anchoredClockTolerance: Double = 10
  /// Audio with its own capture time follows it, but not to the millisecond: each sender report
  /// re-anchors the mapping and moves it by a little, and following those steps would cut the track
  /// into slivers — the same thing that made the Pixel's picture drift in exports. Within one AAC
  /// packet of the previous buffer's end it stays contiguous; beyond that it is a real gap.
  private static let captureSnapSeconds: Double = 0.02
  private static let driftReportThreshold: Double = 0.05

  private(set) var clockUnusable = false
  private var epoch: CMTime?
  private var anchor: CMTime?
  /// End of the last buffer placed. `SegmentWriter` fills `[endTime, nextStart)` with coded
  /// silence when the source clock jumps, so a mute that dropped packets is still a hole of
  /// silence rather than a squeeze of the later live audio.
  var endTime: CMTime? { next }
  /// Every candidate is clamped forward to this, which makes the track monotonic by construction
  /// no matter what the source clock does — a sample that starts before the previous one ended
  /// stalls the muxer, and the muxer then stops accepting video too.
  private var next: CMTime?

  /// Where the source's audio clock sits on the recording's wall clock, fixed once per recording.
  ///
  /// Anchoring each segment's audio to wherever the video happened to be when that segment's first
  /// audio buffer was written ties it to *arrival*, and arrival is not steady: a Pixel running
  /// Cameraman delivered its audio later and later relative to its picture, 129 ms per 1,000 s, and
  /// every three-second segment baked the latest lag in. Measured with a clapperboard on rec-402,
  /// the export's sound went from 39 ms early to 70 ms late over fourteen minutes while the live
  /// programme, which schedules audio by its own timestamps, stayed flat. With this, each segment
  /// places audio from the source's own clock through one mapping held for the whole recording.
  struct WallAnchor: Equatable {
    /// A source audio time, in seconds on the source's clock.
    let sourceSeconds: Double
    /// The recording wall-clock time that source time corresponds to.
    let wallSeconds: Double
  }

  mutating func place(
    sourceTime: CMTime,
    duration: CMTime,
    videoTime: CMTime,
    wallAnchor: WallAnchor? = nil,
    segmentBaseWall: Double? = nil,
    captureWall: Double? = nil
  ) -> Placement? {
    guard videoTime.isNumeric, duration.isNumeric, duration > .zero else { return nil }

    var candidate: CMTime
    var anchored = false
    if !clockUnusable, let captureWall, let segmentBaseWall {
      // The camera said when it captured this audio: that is where it goes.
      candidate = CMTime(seconds: captureWall - segmentBaseWall, preferredTimescale: duration.timescale)
      if let next, abs(CMTimeSubtract(candidate, next).seconds) < Self.captureSnapSeconds {
        candidate = next
      }
      anchored = true
    } else if !clockUnusable, sourceTime.isNumeric, let wallAnchor, let segmentBaseWall {
      let wall = wallAnchor.wallSeconds + (sourceTime.seconds - wallAnchor.sourceSeconds)
      candidate = CMTime(seconds: wall - segmentBaseWall, preferredTimescale: sourceTime.timescale)
      anchored = true
    } else if !clockUnusable, sourceTime.isNumeric {
      if epoch == nil {
        epoch = sourceTime
        anchor = videoTime
      }
      candidate = CMTimeAdd(
        anchor ?? videoTime,
        CMTimeSubtract(sourceTime, epoch ?? sourceTime)
      )
    } else {
      candidate = next ?? videoTime
    }

    // Give up on a bad clock permanently rather than per-buffer: alternating between two timebases
    // is worse than committing to the wrong one.
    var rejectedClock = false
    let offset = CMTimeSubtract(candidate, videoTime).seconds
    let tolerance = anchored ? Self.anchoredClockTolerance : Self.clockTolerance
    if !candidate.isNumeric || abs(offset) > tolerance {
      if !clockUnusable {
        clockUnusable = true
        rejectedClock = true
      }
      candidate = next ?? videoTime
      anchored = false
    }

    var resynced = false
    var drift: Double?
    let behind = CMTimeSubtract(videoTime, candidate).seconds
    if behind > Self.resyncThreshold, !anchored {
      candidate = videoTime
      resynced = true
      drift = behind
    } else if abs(behind) > Self.driftReportThreshold {
      drift = behind
    }

    if let next, candidate < next { candidate = next }
    next = CMTimeAdd(candidate, duration)
    return Placement(start: candidate, rejectedClock: rejectedClock, resynced: resynced, drift: drift)
  }
}

/// Decides where one segment ends and the next begins.
///
/// A segment can only start on a keyframe, so the interval is a floor rather than a period: with a
/// camera sending one keyframe a second and a six-second target, segments come out at six seconds.
struct SegmentBoundary: Equatable {
  let interval: Double
  private(set) var lastFlushSeconds: Double = 0

  init(interval: Double) {
    self.interval = max(1, interval)
  }

  mutating func shouldFlush(at seconds: Double, isKeyframe: Bool) -> Bool {
    guard isKeyframe, seconds - lastFlushSeconds >= interval else { return false }
    lastFlushSeconds = seconds
    return true
  }
}
