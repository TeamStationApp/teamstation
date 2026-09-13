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

/// Keeps the ledger a `CongestionSample` is read from: every media send in order, and when the
/// transport took it.
///
/// Sends complete in the order they were made, because the link is one TCP stream. So the oldest
/// unfinished send is always the first entry, and its age is how long the newest frame will wait.
public struct CongestionMeter: Sendable {
  private var waitingSince: [Double] = []
  private var waitingBytes: [Int] = []
  private var head = 0

  private var deliveredSinceSample = 0
  private var offeredSinceSample = 0
  private var lastSampleTime: Double?
  private var lastDroppedFrames = 0
  private var lastFlushes = 0
  private var lastBacklog: Int?

  public init() {}

  /// Bytes waiting in the ledger, which is this app's share of the backlog.
  public var pendingBytes: Int { waitingBytes[head...].reduce(0, +) }

  /// A frame the encoder produced for this client, counted whether it is then sent or dropped.
  public mutating func offered(bytes: Int) {
    offeredSinceSample += bytes
  }

  public mutating func sent(bytes: Int, at time: Double) {
    waitingSince.append(time)
    waitingBytes.append(bytes)
  }

  /// The transport took the oldest outstanding send.
  public mutating func delivered() {
    guard head < waitingBytes.count else { return }
    deliveredSinceSample += waitingBytes[head]
    head += 1
    // Compacted in batches so a long run does not grow the arrays forever, and a frame's delivery
    // is not an O(n) shift.
    if head >= 256, head * 2 >= waitingBytes.count {
      waitingSince.removeFirst(head)
      waitingBytes.removeFirst(head)
      head = 0
    }
  }

  /// Sends that were abandoned before the transport took them. They are the newest, because the
  /// writer takes them strictly in order.
  public mutating func discardNewest(_ count: Int) {
    let removable = min(count, waitingBytes.count - head)
    guard removable > 0 else { return }
    waitingSince.removeLast(removable)
    waitingBytes.removeLast(removable)
  }

  public func queueDelay(at now: Double) -> Double {
    guard head < waitingSince.count else { return 0 }
    return max(0, now - waitingSince[head])
  }

  /// Everything since the previous call. `droppedFrames` and `flushes` are the send queue's running
  /// totals; the sample carries how much each grew.
  public mutating func sample(
    at now: Double,
    droppedFrames: Int,
    flushes: Int,
    transportBacklogBytes: Int? = nil
  ) -> CongestionSample {
    let interval = lastSampleTime.map { max(0, now - $0) } ?? 0
    var drained = deliveredSinceSample
    if let backlog = transportBacklogBytes, let previous = lastBacklog {
      drained = max(0, deliveredSinceSample - (backlog - previous))
    }
    let sample = CongestionSample(
      interval: interval,
      queueDelay: queueDelay(at: now),
      deliveredBytes: deliveredSinceSample,
      offeredBytes: offeredSinceSample,
      transportBacklogBytes: transportBacklogBytes,
      drainedBytes: drained,
      droppedFrames: max(0, droppedFrames - lastDroppedFrames),
      flushes: max(0, flushes - lastFlushes)
    )
    lastSampleTime = now
    lastDroppedFrames = droppedFrames
    lastFlushes = flushes
    lastBacklog = transportBacklogBytes
    deliveredSinceSample = 0
    offeredSinceSample = 0
    return sample
  }
}
