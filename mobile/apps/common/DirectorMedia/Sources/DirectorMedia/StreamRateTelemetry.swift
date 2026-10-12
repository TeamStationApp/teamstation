import Foundation

/// The stream's bitrate controller as it last decided: where the rate is in the operator's range,
/// why it last moved, and what the link was doing when it did. `dump-state` and a soak read this to
/// tell a stream that adapted from one that shed frames.
public struct StreamRateTelemetry: Sendable, Codable, Equatable {
  /// `hevc` or `h264`, empty while not streaming.
  public var codec = ""
  /// What the encoder has been told, in bits per second.
  public var bitrate = 0
  /// The operator's range; the controller moves only between these.
  public var low = 0
  public var high = 0
  /// `hold`, `emergency`, `congested`, `growing` or `increase`.
  public var lastDecision = ""
  /// The queue delay the last decision was made on: the oldest unsent write in the client, plus
  /// the kernel's standing backlog while the link is falling short.
  public var queueMilliseconds = 0
  /// What the link carried for the video over the last second; zero until a second is measured.
  public var deliveryBitsPerSecond = 0
  /// What the kernel holds on a clean link, which is flight time rather than queue.
  public var transportBaseMilliseconds = 0
  public var decreases = 0
  public var increases = 0

  public init() {}
}
