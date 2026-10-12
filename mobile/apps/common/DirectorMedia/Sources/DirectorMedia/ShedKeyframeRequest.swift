import Foundation

/// When a picture the RTMP client dropped while it waits for a keyframe may ask the encoder for one.
///
/// A shed that leaves no picture queued makes the client drop pictures until a keyframe arrives
/// (`.droppedAwaitingKeyframe`). While the link is still stuck, that keyframe is shed in its turn and
/// the wait starts again, so asking on every drop makes every picture an IDR: on a 150 kbit/s uplink
/// the encoder made 60 a second, and its rate control came out of it dropping frames and making
/// keyframes for another 15 seconds after the link recovered. One request a second is enough to resume
/// on: once the link takes pictures again, the next request is at most a second away.
public struct ShedKeyframeRequest: Sendable, Equatable {
  /// The shortest time between two requests, in seconds.
  public static let minimumInterval: Double = 1

  private var lastRequest: Double?

  public init() {}

  /// Whether a drop at `now` should ask for a keyframe, noting the request when it should. A clock
  /// that stepped back since the last request counts as a second later, not as a wait.
  public mutating func shouldRequest(now: Double) -> Bool {
    if let lastRequest, now >= lastRequest, now - lastRequest < Self.minimumInterval {
      return false
    }
    lastRequest = now
    return true
  }
}
