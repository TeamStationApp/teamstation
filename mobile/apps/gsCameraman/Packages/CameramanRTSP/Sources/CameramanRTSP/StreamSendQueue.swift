import CameramanCore
import Foundation

/// Decides what to drop when a client cannot keep up.
///
/// A camera encodes at a fixed rate whatever the network is doing. Without this, a client on a weak
/// link makes the app's memory grow until it is killed, and the stream it eventually receives is
/// minutes stale. Dropping to the next keyframe instead keeps latency bounded and recovers cleanly,
/// because a keyframe is the one place a decoder can resynchronise.
public struct StreamSendQueue: Sendable {
  public enum Decision: Sendable, Equatable {
    case send
    /// Queue is over budget and this frame is not a keyframe, so it is discarded.
    case drop
    /// Queue is over budget and this is a keyframe, so the backlog is discarded and this frame
    /// becomes the new start point.
    case flushThenSend
  }

  /// Roughly half a second at 6 Mbps. Small enough that a recovered client is near-live rather than
  /// replaying a backlog, large enough to absorb an ordinary Wi-Fi hiccup.
  public static let defaultHighWaterMark = 384 * 1024

  public let highWaterMark: Int
  public private(set) var pendingBytes = 0
  public private(set) var droppedFrames = 0
  public private(set) var flushes = 0
  /// Bumped on `flushThenSend`. Completions from sends queued before the flush must not debit the
  /// new keyframe; Network.framework cannot retract bytes already handed to `NWConnection`.
  public private(set) var generation = 0
  /// True between a drop and the keyframe that ends it. Only whole frames are ever dropped, but a
  /// receiver still needs to know the picture sequence was broken.
  public private(set) var isDropping = false

  public init(highWaterMark: Int = StreamSendQueue.defaultHighWaterMark) {
    self.highWaterMark = highWaterMark
  }

  public mutating func decide(frameBytes: Int, isKeyframe: Bool) -> Decision {
    guard pendingBytes > highWaterMark else {
      isDropping = false
      pendingBytes += frameBytes
      return .send
    }

    if isKeyframe {
      flushes += 1
      isDropping = false
      generation += 1
      // The backlog is abandoned, so only this frame is outstanding.
      pendingBytes = frameBytes
      return .flushThenSend
    }

    droppedFrames += 1
    isDropping = true
    return .drop
  }

  /// Called when the transport reports bytes have left, which is the only honest measure of what the
  /// client has taken. A queue credited on enqueue rather than completion never reports backpressure.
  ///
  /// Pass the `generation` captured at send time. Completions from a flushed generation are ignored
  /// so they cannot subtract from the keyframe that replaced them.
  public mutating func complete(bytes: Int, generation: Int? = nil) {
    if let generation, generation != self.generation { return }
    pendingBytes = max(0, pendingBytes - bytes)
  }

  /// Audio is never dropped. It is a few percent of the bitrate, and a gap in it is far more
  /// noticeable than a dropped picture.
  public mutating func enqueueAudio(bytes: Int) {
    pendingBytes += bytes
  }
}
