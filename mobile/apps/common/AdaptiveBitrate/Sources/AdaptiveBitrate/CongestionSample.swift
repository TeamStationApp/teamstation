import Foundation

/// What one client's link did over one sampling interval, seen from the sending side.
///
/// Every client is RTP interleaved on a single TCP connection, so a weak link never shows up as
/// loss. It shows up as bytes waiting on this side, and nothing comes back from the receiver to say
/// otherwise: Director sends no RTCP receiver reports. So these are the only congestion signals
/// there are, and they are all measured here.
public struct CongestionSample: Sendable, Equatable {
  /// Seconds since the previous sample of the same client.
  public var interval: Double
  /// Age of the oldest media send the transport has not yet taken. Zero when nothing is waiting.
  public var queueDelay: Double
  /// Media bytes the transport took this interval.
  public var deliveredBytes: Int
  /// Media bytes the encoder offered this client this interval, sent or dropped. Delivery can only
  /// measure the link when this is more than the link can carry; otherwise it measures the encoder.
  public var offeredBytes: Int
  /// Bytes the transport holds that have not left, when the platform can say. Nil otherwise.
  public var transportBacklogBytes: Int?
  /// Media bytes that left the transport this interval: `deliveredBytes` less whatever the
  /// transport backlog grew by. The same as `deliveredBytes` when the backlog cannot be read.
  public var drainedBytes: Int
  public var droppedFrames: Int
  public var flushes: Int

  public init(
    interval: Double,
    queueDelay: Double = 0,
    deliveredBytes: Int = 0,
    offeredBytes: Int = 0,
    transportBacklogBytes: Int? = nil,
    drainedBytes: Int? = nil,
    droppedFrames: Int = 0,
    flushes: Int = 0
  ) {
    self.interval = interval
    self.queueDelay = queueDelay
    self.deliveredBytes = deliveredBytes
    self.offeredBytes = offeredBytes
    self.transportBacklogBytes = transportBacklogBytes
    self.drainedBytes = drainedBytes ?? deliveredBytes
    self.droppedFrames = droppedFrames
    self.flushes = flushes
  }

  /// The client whose link is doing worst. One encoder feeds every client, so the rate has to suit
  /// the weakest of them: a picture sized for the best link is dropped wholesale on the worst.
  public static func worst(of samples: [CongestionSample]) -> CongestionSample? {
    samples.max { lhs, rhs in
      let lhsLost = lhs.droppedFrames + lhs.flushes > 0
      let rhsLost = rhs.droppedFrames + rhs.flushes > 0
      if lhsLost != rhsLost { return rhsLost }
      return lhs.queueDelay < rhs.queueDelay
    }
  }
}
