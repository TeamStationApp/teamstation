import Foundation

/// Where the recording's mix goes on the programme master's timeline.
///
/// The mix is placed by when its sound was captured, and each picture's moment is known the same
/// way: the encoder keeps, frame by frame, how far its timeline sits from the capture clock (the
/// frame's programme time less the wall time its picture was captured). Sound captured at `wall`
/// belongs at `wall + contentOffset`, beside the picture of the same moment, however long the mix
/// waited for it.
///
/// It is laid down contiguously from there, and moved only when it has strayed more than
/// `reseatSeconds` from where the pictures say it belongs: when the display delay settles, or a cut
/// lands on a camera held differently. Following every frame's jitter instead would cut the track
/// into slivers. Moving later leaves a short gap; moving earlier drops what the track already holds.
struct RecordingSoundPlacement {
  /// Well inside what a viewer notices of sound against picture: broadcast practice allows 45 ms
  /// early and 125 ms late.
  static let reseatSeconds = 0.1

  /// A capture wall time and the programme time it was placed at, which later sound follows on.
  private var epoch: (wall: Double, time: Double)?

  /// The programme time, in seconds, for a buffer captured at `wall` lasting `duration`; nil when it
  /// lies before the part began or on sound the track already holds. `writtenUntil` is the end of
  /// what the track holds.
  mutating func place(wall: Double, duration: Double, contentOffset: Double, writtenUntil: Double?) -> Double? {
    let expected = wall + contentOffset
    var time: Double
    if let epoch, abs(epoch.time + (wall - epoch.wall) - expected) <= Self.reseatSeconds {
      time = epoch.time + (wall - epoch.wall)
    } else {
      epoch = (wall, expected)
      time = expected
    }
    let floor = writtenUntil ?? 0
    // Sub-millisecond overlaps are rounding between clocks, not sound already written.
    guard time + duration > floor + 0.0005 else { return nil }
    return max(time, floor)
  }

  mutating func reset() {
    epoch = nil
  }
}
