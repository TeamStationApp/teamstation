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
  private static let driftReportThreshold: Double = 0.05

  private(set) var clockUnusable = false
  private var epoch: CMTime?
  private var anchor: CMTime?
  /// End of the last buffer placed. Every candidate is clamped forward to this, which makes the
  /// track monotonic by construction no matter what the source clock does — a sample that starts
  /// before the previous one ended stalls the muxer, and the muxer then stops accepting video too.
  private var next: CMTime?

  mutating func place(sourceTime: CMTime, duration: CMTime, videoTime: CMTime) -> Placement? {
    guard videoTime.isNumeric, duration.isNumeric, duration > .zero else { return nil }

    var candidate: CMTime
    if !clockUnusable, sourceTime.isNumeric {
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
    if !candidate.isNumeric || abs(offset) > Self.clockTolerance {
      if !clockUnusable {
        clockUnusable = true
        rejectedClock = true
      }
      candidate = next ?? videoTime
    }

    var resynced = false
    var drift: Double?
    let behind = CMTimeSubtract(videoTime, candidate).seconds
    if behind > Self.resyncThreshold {
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
