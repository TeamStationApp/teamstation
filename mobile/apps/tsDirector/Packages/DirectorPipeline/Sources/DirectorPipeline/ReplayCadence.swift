import Foundation

/// When each picture of a replay is due, from its own time on the tape.
///
/// A replay of tape starting at `anchorMedia`, begun at host time `anchorWall` and played at `rate`,
/// puts the picture at tape time `m` on screen at `anchorWall + (m - anchorMedia) / rate`. That is the
/// replay's equivalent of a live picture's capture time plus D, and the programme takes it by the same
/// rule (`ProgrammePictureQueue`): on each tick, the newest picture whose moment has come. A camera's
/// frame rate, steady, swinging or thinned by a struggling phone, then only changes how often a
/// picture repeats, and every picture is shown once, in order, at its own moment.
///
/// The pump hands each picture on `leadSeconds` before its moment, newest first when several are
/// ready, and the programme's queue takes it on the first tick at or after its moment. The lead is
/// what makes that the tick that takes it: an archive's pictures sit on an exact frame grid, so a
/// replay's moments keep one phase against the programme's tick, and a picture handed on at its
/// moment by a pump not locked to the tick lands either side of a tick it falls close to; each one
/// was then held one tick or three, and at 60 fps one lands on the next one's tick and is lost.
/// Half a tick of lead covers the pump's own few milliseconds, and the picture still goes on air at
/// its moment, not before.
public struct ReplayCadence: Sendable, Equatable {
  public let anchorWall: Double
  public let anchorMedia: Double
  public let rate: Double

  /// The slowest rate a replay plays at, so a picture is always due eventually.
  public static let minimumRate = 0.05
  /// How far ahead of its moment a picture is handed on: half a 60 fps programme tick.
  public static let leadSeconds = 0.008

  public init(anchorWall: Double, anchorMedia: Double, rate: Double) {
    self.anchorWall = anchorWall
    self.anchorMedia = anchorMedia
    self.rate = max(rate, Self.minimumRate)
  }

  /// When the picture at tape time `media` is due, on the clock `anchorWall` is on.
  public func due(media: Double) -> Double {
    anchorWall + (media - anchorMedia) / rate
  }

  /// The tape time that is due at `now`.
  public func media(at now: Double) -> Double {
    anchorMedia + rate * (now - anchorWall)
  }

  /// The latest tape time to hand on at `now`: due within the lead.
  public func handOnThrough(_ now: Double) -> Double {
    media(at: now + Self.leadSeconds)
  }
}
