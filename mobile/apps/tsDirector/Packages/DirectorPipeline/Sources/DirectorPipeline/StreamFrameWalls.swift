import CoreMedia
import DirectorCore

/// The content wall of each frame handed to the stream's encoder, kept until the encoder hands the
/// frame back.
///
/// The wall is decided when the frame is stamped, from the picture's capture time, and the encoded
/// frame comes back later on VideoToolbox's own thread with nothing but its presentation time. The
/// encoder never reorders (`AllowFrameReordering` is off), so frames come back in the order they
/// went in, and a frame it dropped comes back with no picture and no time: whatever was noted before
/// a frame that does come back was dropped, and goes with it.
struct StreamFrameWalls {
  private var pending: [(time: CMTime, wall: WallClock)] = []

  /// Notes the wall of the frame stamped `time`.
  mutating func note(_ wall: WallClock, for time: CMTime) {
    pending.append((time, wall))
  }

  /// The wall noted for the frame stamped `time`, forgetting it and everything noted before it;
  /// nil when none was.
  mutating func take(_ time: CMTime) -> WallClock? {
    guard let index = pending.firstIndex(where: { CMTimeCompare($0.time, time) == 0 }) else { return nil }
    let wall = pending[index].wall
    pending.removeFirst(index + 1)
    return wall
  }

  /// How many frames are waiting.
  var count: Int { pending.count }

  mutating func removeAll() {
    pending.removeAll()
  }
}
