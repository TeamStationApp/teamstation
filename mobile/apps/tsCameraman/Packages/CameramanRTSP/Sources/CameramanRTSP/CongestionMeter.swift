import AdaptiveBitrate
import Foundation

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

  public func queueDelay(at now: Double) -> Double {
    guard head < waitingSince.count else { return 0 }
    return max(0, now - waitingSince[head])
  }

  /// Everything since the previous call. `droppedFrames` and `flushes` are the send queue's running
  /// totals; the sample carries how much each grew. `waitingHere` is how long the oldest media not
  /// yet handed to the transport has waited, which counts toward the delay as much as the ledger's.
  public mutating func sample(
    at now: Double,
    droppedFrames: Int,
    flushes: Int,
    transportBacklogBytes: Int? = nil,
    waitingHere: Double = 0
  ) -> CongestionSample {
    let interval = lastSampleTime.map { max(0, now - $0) } ?? 0
    var drained = deliveredSinceSample
    if let backlog = transportBacklogBytes, let previous = lastBacklog {
      drained = max(0, deliveredSinceSample - (backlog - previous))
    }
    let sample = CongestionSample(
      interval: interval,
      queueDelay: max(queueDelay(at: now), waitingHere),
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
