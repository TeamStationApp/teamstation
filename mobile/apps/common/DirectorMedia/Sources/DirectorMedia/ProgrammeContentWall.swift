import DirectorCore
import Foundation

/// The wall a programme frame stands for: when its picture was *captured*, not when it was composed.
///
/// The programme is built from pictures the delay line has already held for half a second, so
/// stamping composition time placed rec-401's programme master about 0.55 s behind the camera files
/// it was cut from. A live frame says exactly how old it is, a repeat included
/// (`ProgrammeHeldPictureWall`); a replay frame does not, so it borrows the lag the last live frame
/// measured, which keeps the timeline continuous.
///
/// The recording's anchors (`program_anchors`) and the stream's wall-clock SEI both read it, so a
/// frame is put at the same moment whether it is watched live or in the take.
struct ProgrammeContentWall: Sendable, Equatable {
  /// A capture time further back than this is not believed: it is a camera whose clock is wrong,
  /// not a picture that old.
  static let maximumLagSeconds: Double = 10

  /// How far behind real time the on-air picture was when it was captured, from the last live
  /// frame that said.
  private(set) var lagSeconds: Double?

  /// The content wall of a frame stamped at `now` (seconds since 1970 on the steady wall clock),
  /// whose picture was captured at `captureWall`, or nil for a replay.
  mutating func wall(at now: Double, captureWall: WallClock?) -> WallClock {
    if let captureWall, now - captureWall.seconds >= 0, now - captureWall.seconds < Self.maximumLagSeconds {
      lagSeconds = now - captureWall.seconds
    }
    return WallClock(seconds: now - (lagSeconds ?? 0))
  }

  /// Forgets the lag, for a new take or stream.
  mutating func reset() {
    lagSeconds = nil
  }
}
