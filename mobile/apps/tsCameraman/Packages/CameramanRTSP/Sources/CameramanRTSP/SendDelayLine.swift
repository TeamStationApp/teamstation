import Foundation

/// Holds outgoing frames back so a receiver sees late delivery with an honest timestamp.
///
/// Test-only. This is the fault the synchronisation design claims to absorb: a frame that arrives
/// after its display deadline but still carries the capture time it was stamped with. Blanking a
/// source — what the harness did before — exercises none of that, which is very likely why the
/// export-under-loss bug survived every earlier test run.
///
/// `EncodedVideoFrame.presentationTime` is on the capture clock and the RTP timestamp is derived
/// from it at packetization, so holding a frame here changes *when* it arrives without touching
/// *when it says it was taken*. Nothing else is needed to keep the stamp truthful.
///
/// Three shapes, because they fail differently:
///
/// - `delay` alone is the weak case. A constant offset is just added latency, and any correct
///   receiver absorbs it without noticing. Useful only as a control.
/// - `jitter` spreads arrivals either side of the delay, which is what a lightly loaded link does.
/// - `burst` is the one that matters. Frames accumulate for the window and are released together,
///   reproducing what Wi-Fi actually does under contention — we measured 118–270 ms arrival gaps
///   with the largest landing on keyframes. A design that survives constant delay can still fall
///   over here.
public final class SendDelayLine: @unchecked Sendable {
  private struct Pending {
    let due: Double
    let sequence: UInt64
    let deliver: () -> Void
  }

  private let lock = NSLock()
  private var delaySeconds: Double = 0
  private var jitterSeconds: Double = 0
  private var burstSeconds: Double = 0
  private var pending: [Pending] = []
  private var nextSequence: UInt64 = 0
  private var burstOpenedAt: Double?
  private var timer: DispatchSourceTimer?
  private var heldFrames: UInt64 = 0

  private let queue = DispatchQueue(label: "app.teamstation.cameraman.senddelay")
  /// The struggling-phone hold: given uptime now, when a packet handed over now may leave, or nil
  /// for at once. Holds every packet of both streams and releases them in one burst.
  private var holdRelease: (@Sendable (Double) -> Double?)?
  /// True while a drain is handing packets on, outside the lock. A send arriving then waits its
  /// turn rather than going out at once ahead of them: it used to, so the first packets after a
  /// hold overtook the hold's own, and the audio stamps, which follow capture order, jumped ahead
  /// and paired a later sound with an earlier capture time in the next sender report.
  private var delivering = false

  public func setHoldRelease(_ release: (@Sendable (Double) -> Double?)?) {
    lock.lock()
    holdRelease = release
    lock.unlock()
  }

  public init() {}

  /// Frames currently waiting, and the configuration, for telemetry. A run that reports zero held
  /// frames while a delay is set has not actually injected anything, which is the failure mode a
  /// fault harness must never report as a pass.
  public var summary: (delayMilliseconds: Double, jitterMilliseconds: Double, burstMilliseconds: Double, held: Int, totalHeld: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    return (delaySeconds * 1000, jitterSeconds * 1000, burstSeconds * 1000, pending.count, heldFrames)
  }

  public var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return delaySeconds > 0 || jitterSeconds > 0 || burstSeconds > 0
  }

  /// Passing all zeros restores immediate delivery and flushes anything still held, so a test can
  /// return the camera to normal without restarting it.
  public func configure(delayMilliseconds: Double, jitterMilliseconds: Double, burstMilliseconds: Double) {
    lock.lock()
    delaySeconds = max(0, delayMilliseconds) / 1000
    jitterSeconds = max(0, jitterMilliseconds) / 1000
    burstSeconds = max(0, burstMilliseconds) / 1000
    let idle = delaySeconds == 0 && jitterSeconds == 0 && burstSeconds == 0
    let draining = idle ? pending : []
    if idle {
      pending.removeAll()
      burstOpenedAt = nil
      timer?.cancel()
      timer = nil
    }
    lock.unlock()
    for item in draining.sorted(by: { $0.sequence < $1.sequence }) { item.deliver() }
  }

  /// Routes one send. Returns immediately either way; `deliver` runs now or later on the delay queue.
  public func submit(_ deliver: @escaping () -> Void) {
    lock.lock()
    let now = Self.now()
    let held = holdRelease?(now)
    guard delaySeconds > 0 || jitterSeconds > 0 || burstSeconds > 0 || held != nil || !pending.isEmpty || delivering else {
      lock.unlock()
      deliver()
      return
    }
    // Jitter is symmetric about the delay and never pulls a frame earlier than the moment it was
    // handed over: a negative total would deliver out of order, which is a different fault.
    let spread = jitterSeconds > 0 ? Double.random(in: -jitterSeconds ... jitterSeconds) : 0
    var due = now + max(0, delaySeconds + spread)
    if burstSeconds > 0 {
      let opened = burstOpenedAt ?? now
      burstOpenedAt = opened
      // Everything in this window leaves together at its end, which is the clumping that matters.
      due = max(due, opened + burstSeconds)
    }
    // While a hold is set, nothing overtakes what is already waiting: a packet after a hold leaves
    // with or after the hold's burst, never before it.
    if holdRelease != nil, let latest = pending.map(\.due).max() { due = max(due, latest) }
    if let held { due = max(due, held) }
    pending.append(Pending(due: due, sequence: nextSequence, deliver: deliver))
    nextSequence &+= 1
    heldFrames &+= 1
    scheduleLocked()
    lock.unlock()
  }

  private func scheduleLocked() {
    guard timer == nil, let soonest = pending.map(\.due).min() else { return }
    let delay = max(0, soonest - Self.now())
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + delay)
    t.setEventHandler { [weak self] in self?.drain() }
    timer = t
    t.resume()
  }

  private func drain() {
    lock.lock()
    timer?.cancel()
    timer = nil
    let now = Self.now()
    // Sequence order, not due order: two frames sharing a burst deadline must still leave in the
    // order they were encoded or the receiver sees reordering rather than lateness.
    let ready = pending.filter { $0.due <= now }.sorted { $0.sequence < $1.sequence }
    pending.removeAll { $0.due <= now }
    if pending.isEmpty { burstOpenedAt = nil }
    scheduleLocked()
    delivering = true
    lock.unlock()
    for item in ready { item.deliver() }
    lock.lock()
    delivering = false
    lock.unlock()
  }

  private static func now() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000_000
  }
}
