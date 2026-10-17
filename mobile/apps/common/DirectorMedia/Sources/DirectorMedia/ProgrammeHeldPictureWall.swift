import DirectorCore
import Foundation

/// The capture time a programme frame carries: its camera's, for a picture new to the output, and
/// for the same picture shown again, that capture time plus how long the picture has been on air.
///
/// A frame's wall clock comes from the camera that captured its picture, never from Director's own
/// clock. A repeat used to carry none and borrow the lag the output's last new picture measured
/// (`ProgrammeContentWall`), but an output that has just started has measured none. After a cut the
/// old camera's last picture stays on air until the new camera's first is due, the live delay after
/// it was captured, so a stream started on a cut stamped half a second of that held picture as of
/// now: a whole live delay late, and TeamStation placed the publish by its first frame.
///
/// Kept by the programme clock, which sees every picture come on air whether or not the stream or
/// the recording is running, so a repeat is placed from its picture however long ago that was.
public struct ProgrammeHeldPictureWall: Sendable, Equatable {
  /// The picture this output last took, and the wall clock of the tick that first took it.
  private var sequence: UInt64?
  private var onAirSince: Double = 0

  public init() {}

  /// The capture time to send with picture `sequence`, captured at `capture`, on the tick at wall
  /// clock `wallNow`; nil for a picture with no capture time, such as a replay's.
  public mutating func capture(sequence: UInt64, capture: WallClock?, at wallNow: Double) -> WallClock? {
    if sequence != self.sequence {
      self.sequence = sequence
      onAirSince = wallNow
    }
    return capture.map { WallClock(seconds: $0.seconds + (wallNow - onAirSince)) }
  }
}
