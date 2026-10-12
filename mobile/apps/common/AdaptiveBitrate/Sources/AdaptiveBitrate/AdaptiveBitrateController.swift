import Foundation

/// Chooses the encoder's bitrate from what the link to the weakest client is doing.
///
/// The operator's bitrate is the ceiling. When the link backs up the rate comes down, never below
/// the floor, and it climbs back once the link has been clean for a while. Below the floor, a softer
/// picture stops being a better trade than the dropped frames it is there to prevent.
///
/// Every signal is measured on the sender, because nothing comes back from Director: no receiver
/// reports, and on TCP no loss. The rules and constants are taken from controllers built on the same
/// kind of signal, and each constant below names where it came from:
///
/// - OBS's dynamic bitrate (`plugins/obs-outputs/rtmp-stream.c`) is the closest relative: RTMP over
///   TCP, sender-side only. It measures the queue as the age of what is waiting, cuts when that
///   passes 200 ms, cuts straight to the measured delivery rate, and adds a tenth of the ceiling
///   every 4 s.
/// - GCC (draft-ietf-rmcat-gcc-02) decreases to 0.85 of the measured rate and increases by 8% a
///   second, capped at 1.5 times what the link is delivering.
/// - SCReAM (RFC 8298) trims by 5% when its own sender queue delays, and slows its ramp near the rate
///   where congestion last happened. Its delay targets, like OBS's, assume a receiver with a deeper
///   buffer than Director's; `Tuning` says what they are here and why.
/// - BBR's point that a delivery rate measured while the sender had nothing waiting says what the
///   encoder produced, not what the link can carry. So the measured rate only sets a cut, which
///   happens with the queue long, and otherwise only caps a climb.
/// - Hoßfeld et al. (QoMEX 2014) found that viewers mind large quality swings, and time spent below
///   the best quality, far more than how often the quality moves. So changes are small and spaced,
///   and recovery is not slow for its own sake.
public struct AdaptiveBitrateController: Sendable {
  public enum Decision: String, Sendable, Codable, Equatable {
    case hold
    /// Frames were dropped, or the queue passed the point where they are about to be.
    case emergency
    /// The queue has stayed long for two ticks in a row.
    case congested
    /// The queue has grown for three ticks, still short.
    case growing
    case increase
  }

  public struct Tuning: Sendable, Equatable {
    /// Queue delay below which the link counts as clean. SCReAM's lower target is 100 ms; half that
    /// leaves room for the ordinary keyframe burst, which on a 1 s GOP arrives every second.
    public var clearDelay = 0.05
    /// A queue longer than this and still growing gets a small trim.
    public var growingDelay = 0.08
    /// A queue longer than this for two ticks is congestion.
    public var congestedDelay = 0.15
    /// Past this the picture is about to be late, so the cut is the large one.
    ///
    /// The three delays are set against Director, not the literature. SCReAM's 100 / 400 ms and
    /// OBS's 200 ms assume a receiver that buffers; Director shows nothing more than 500 ms late,
    /// and the network adds its own delay on top of what is measured here. Measured on the Pixel 10
    /// on 2026-09-12: with the queue's thresholds at 100 / 200 / 400 ms, a probe past a bandwidth
    /// cap froze Director's picture for 3 s before the queue here had reached 350 ms.
    public var emergencyDelay = 0.3
    /// GCC's decrease, applied to the measured delivery rate.
    public var deliveryFactor = 0.85
    public var emergencyFactor = 0.7
    public var congestedFactor = 0.9
    /// SCReAM's trim when its own sender queue delays.
    public var growingFactor = 0.95
    /// Time for the encoder to act on a cut before the next one: one GOP. A second cut before the
    /// first has reached the stream would be a reaction to the same backlog twice.
    public var decreaseHold = 1.0
    /// Drops arrive in runs until the next keyframe; one emergency per half second keeps a run of
    /// them from being counted as several events.
    public var emergencyHold = 0.5
    /// OBS's `DBR_INC_TIMER`: how long the link must stay clean before the rate climbs.
    public var increaseHold = 4.0
    /// GCC's multiplicative increase, per second.
    public var increasePerSecond = 1.08
    /// GCC's cap on an increase, relative to what the link is delivering now. On a clean link that
    /// is the current rate, so it never holds a climb back; it stops a climb outrunning a link that
    /// has stopped keeping up.
    public var probeCeilingFactor = 1.5
    /// How much delivery history the rate is measured over. OBS will not use an estimate covering
    /// less than a second.
    public var deliveryWindow = 1.0
    /// Changes smaller than this, relative to the current rate, are not worth a trip to the encoder.
    public var minimumChange = 0.05
    /// Increases are pushed at most this often, so a climb reaches the encoder in steps it can
    /// follow. Decreases go at once.
    public var increasePushInterval = 1.0
    /// OBS and belacoder both round to 100 kbps.
    public var quantum = 100_000
    /// Below this share of what the encoder offered, the link is not keeping up, and the transport's
    /// backlog is queue rather than bytes in flight.
    public var shortfall = 0.9
    /// After this long with nobody playing, the next client starts from the ceiling.
    public var idleReset = 10.0
    /// How far back the transport's base delay is remembered: LEDBAT's base delay (RFC 6817) and
    /// BBR's minimum round trip both use a window of about ten seconds.
    public var baseDelayWindow = 10.0
    /// A link that carried less than this share of the current rate over the delivery window was
    /// stalled rather than slow, and what it carried says nothing about what it can: a cut then takes
    /// its fixed step instead of going to the measured rate. Zero, the default, always takes the
    /// measurement at its word.
    public var stallShare = 0.0
    /// Whether a queue the link is already emptying is left alone. The queue's age goes on rising
    /// after a cut until the backlog from before it has gone, so a sender that cuts on age alone keeps
    /// cutting a link that now carries more than it is given. Off by default, where a quarter-second
    /// of queue is itself the problem.
    public var holdWhileDraining = false

    public init() {}

    /// TS Director's RTMP stream, which has seconds of room where a camera has a fraction of one.
    ///
    /// Nobody watches the stream against the field: a platform's player sits 5–20 s behind, so the
    /// RTMP client holds `RTMPClient.sendBufferSeconds` (8 s) of stream before it sheds anything, and
    /// a dip in the link is better sent late than dropped or coded softer. The thresholds follow that
    /// room rather than the camera's half-second display: a queue has to reach a second before it is
    /// trimmed, a second and a half before the rate goes to what the link carries, and five seconds
    /// before the large cut, which leaves three for the backlog to drain before anything is shed. A
    /// queue that is merely late costs the viewer nothing; a cut costs them picture for the 10–15 s
    /// the climb back takes.
    ///
    /// A stall, the link carrying almost nothing as Wi-Fi does for a second or three, is not a rate:
    /// cutting to what it carried would put the stream on the floor for a dip it could have ridden
    /// out, so below a tenth of the rate the cut takes its fixed step. And once the link carries more
    /// than the encoder makes, the queue is left to drain.
    public static let rtmpStream: Tuning = {
      var tuning = Tuning()
      tuning.clearDelay = 0.25
      tuning.growingDelay = 1.0
      tuning.congestedDelay = 1.5
      tuning.emergencyDelay = 5.0
      tuning.stallShare = 0.1
      tuning.holdWhileDraining = true
      return tuning
    }()
  }

  /// What the controller last did and why, for the state dump.
  public struct Status: Sendable, Equatable, Codable {
    public var ceiling: Int
    public var floor: Int
    /// What the encoder has been told.
    public var bitrate: Int
    public var lastDecision: Decision
    public var decreases: Int
    public var increases: Int
    /// The queue delay the last decision was made on, in milliseconds.
    public var queueDelayMilliseconds: Int
    /// Delivery rate over the last second, or nil until a second has been measured.
    public var deliveryBitsPerSecond: Int?
    /// What the transport holds on a clean link, in milliseconds, which is subtracted before its
    /// backlog counts as queue.
    public var transportBaseMilliseconds: Int
  }

  public let tuning: Tuning
  public private(set) var ceiling: Int
  /// The lowest rate a cut may reach: the operator's own low bitrate where there is one, and half
  /// the ceiling otherwise. Below the floor a softer picture stops being worth the dropped frames it
  /// would save.
  public private(set) var floor: Int
  /// Unrounded, so a slow climb is not lost to the quantum.
  private var target: Double
  /// What the encoder was last told.
  public private(set) var bitrate: Int

  private var deliveries: [(time: Double, interval: Double, bytes: Int, offered: Int)] = []
  /// The transport's delay, tick by tick, over the base-delay window.
  private var transportDelays: [(time: Double, delay: Double)] = []
  private var congestedTicks = 0
  private var recentDelays: [Double] = []
  private var lastDecreaseAt = -Double.infinity
  private var lastEmergencyAt = -Double.infinity
  private var lastLossAt = -Double.infinity
  private var lastPushAt = -Double.infinity
  private var lastSampleAt: Double?
  /// The rate the link broke at, which a climb approaches slowly from below as SCReAM does: the
  /// rate in force when congestion struck, or what the link was actually delivering if that was
  /// less. A cut from 4 Mbps on a link carrying 2.4 must not remember 4, or the climb races past
  /// 2.4 and finds the same congestion again.
  private var lastCongestedRate: Double?

  public private(set) var status: Status

  /// `floor` defaults to half the ceiling, and is kept between zero and the ceiling. `start` is the
  /// rate the encoder opens at, kept between the floor and the ceiling; nil starts at the ceiling.
  public init(ceiling: Int, floor: Int? = nil, tuning: Tuning = Tuning(), start: Int? = nil) {
    self.tuning = tuning
    self.ceiling = ceiling
    let floor = min(max(0, floor ?? ceiling / 2), ceiling)
    self.floor = floor
    let first = min(max(floor, start ?? ceiling), ceiling)
    target = Double(first)
    bitrate = first
    status = Status(
      ceiling: ceiling,
      floor: floor,
      bitrate: first,
      lastDecision: .hold,
      decreases: 0,
      increases: 0,
      queueDelayMilliseconds: 0,
      deliveryBitsPerSecond: nil,
      transportBaseMilliseconds: 0
    )
  }

  /// Starts again at `start` (the ceiling when nil), forgetting everything measured. For a new
  /// operator rate, and for an encoder that has been rebuilt at that rate. The counts carry over:
  /// they describe the session.
  public mutating func reset(ceiling: Int, floor: Int? = nil, start: Int? = nil) {
    let counts = (status.decreases, status.increases)
    self = AdaptiveBitrateController(ceiling: ceiling, floor: floor, tuning: tuning, start: start)
    (status.decreases, status.increases) = counts
  }

  /// One tick. Returns the rate to give the encoder, or nil when it should keep what it has.
  ///
  /// `sample` is the worst playing client's link since the previous tick, or nil when nobody is
  /// playing. `now` is a monotonic clock in seconds.
  public mutating func update(_ sample: CongestionSample?, now: Double) -> Int? {
    guard let sample else {
      // Nobody watching. Held rather than climbed, since there is no link to judge, but not held
      // for ever: a client arriving much later is on a link nothing has been measured about.
      if let last = lastSampleAt, now - last > tuning.idleReset, bitrate != ceiling {
        let (ceiling, floor) = (ceiling, floor)
        // The operator's floor, not the default: going idle is not a new setting.
        reset(ceiling: ceiling, floor: floor)
        return ceiling
      }
      return nil
    }
    lastSampleAt = now

    recordDelivery(sample, now: now)
    let delivery = deliveryRate()
    let delay = effectiveDelay(sample, delivery: delivery, now: now, isFallingShort: isFallingShort(sample))
    recentDelays.append(delay)
    if recentDelays.count > 3 { recentDelays.removeFirst(recentDelays.count - 3) }
    congestedTicks = delay > tuning.congestedDelay ? congestedTicks + 1 : 0

    let lost = sample.droppedFrames + sample.flushes > 0
    if lost { lastLossAt = now }

    let decision = decide(delay: delay, appDelay: sample.queueDelay, lost: lost, draining: isDraining(), now: now)
    let cutDelivery = self.cutDelivery()
    switch decision {
    case .emergency:
      cut(to: min(target * tuning.emergencyFactor, cutDelivery.map { $0 * tuning.deliveryFactor } ?? .infinity), now: now)
      lastEmergencyAt = now
    case .congested:
      cut(to: min(target * tuning.congestedFactor, cutDelivery.map { $0 * tuning.deliveryFactor } ?? .infinity), now: now)
    case .growing:
      cut(to: target * tuning.growingFactor, now: now)
    case .increase:
      climb(elapsed: sample.interval, delivery: delivery)
    case .hold:
      break
    }

    let pushed = push(decision: decision, now: now)
    status.lastDecision = decision
    status.queueDelayMilliseconds = Int((delay * 1000).rounded())
    status.deliveryBitsPerSecond = delivery.map { Int($0.rounded()) }
    status.bitrate = bitrate
    return pushed
  }

  // MARK: - Measuring

  private mutating func recordDelivery(_ sample: CongestionSample, now: Double) {
    guard sample.interval > 0 else { return }
    deliveries.append((now, sample.interval, sample.drainedBytes, sample.offeredBytes))
    // Kept a little past the window, so the window is always fully covered once it can be.
    while let first = deliveries.first, now - first.time > tuning.deliveryWindow + 0.5 {
      deliveries.removeFirst()
    }
  }

  /// Whether the link carried less than the encoder offered over the last second, or frames are
  /// already waiting in this app: the two ways a backlog in the transport can be told apart from
  /// bytes that are merely in flight for longer.
  private func isFallingShort(_ sample: CongestionSample) -> Bool {
    if sample.queueDelay > 0.02 { return true }
    guard let window = windowTotals(), window.offered > 0 else { return false }
    return Double(window.drained) < Double(window.offered) * tuning.shortfall
  }

  /// Whether the link carried at least what the encoder offered over the delivery window, so a
  /// backlog is shrinking on its own.
  private func isDraining() -> Bool {
    guard let window = windowTotals(), window.offered > 0 else { return false }
    return window.drained >= window.offered
  }

  /// Bytes drained and offered over the delivery window, or nil until the window is covered.
  private func windowTotals() -> (drained: Int, offered: Int)? {
    var covered = 0.0
    var drained = 0
    var offered = 0
    for entry in deliveries.reversed() {
      covered += entry.interval
      drained += entry.bytes
      offered += entry.offered
      if covered >= tuning.deliveryWindow * 0.95 { break }
    }
    guard covered >= tuning.deliveryWindow * 0.95 else { return nil }
    return (drained, offered)
  }

  /// The delivery rate a cut may go to: the measured one, unless the link was stalled rather than
  /// slow.
  private func cutDelivery() -> Double? {
    guard let delivery = deliveryRate() else { return nil }
    return delivery < Double(bitrate) * tuning.stallShare ? nil : delivery
  }

  /// Bits per second the link carried over the last second, or nil until a full second is measured.
  private func deliveryRate() -> Double? {
    var covered = 0.0
    var bytes = 0
    for entry in deliveries.reversed() {
      covered += entry.interval
      bytes += entry.bytes
      if covered >= tuning.deliveryWindow * 0.95 { break }
    }
    guard covered >= tuning.deliveryWindow * 0.95 else { return nil }
    return Double(bytes) * 8 / covered
  }

  /// How long a frame sent now would wait: its time in this app's queue, plus however much longer
  /// than usual the transport's own backlog takes to drain at the rate the link is carrying.
  ///
  /// The transport's count includes bytes in flight, so on a clean link it reads about one round
  /// trip, and a keyframe lands in it as a burst that is gone a tick later. Measured on the Pixel 10
  /// on 2026-09-12: counted raw, a clean link read 13–207 ms and the rate sat on the floor. So only
  /// a standing queue counts — the smaller of this tick and the last, which is CoDel's rule (Nichols
  /// and Jacobson, 2012) — and only above the smallest delay of the last ten seconds, which is flight
  /// time rather than queue. The app's own queue holds nothing in flight and counts in full.
  ///
  /// Even a standing backlog is only queue while the link is falling short. A longer round trip
  /// puts more bytes in flight while the link still carries everything the encoder makes; measured
  /// on the Pixel 10 on 2026-09-12, 150 ms of added latency read as 313 ms of queue and cut the rate
  /// to the floor for 25 s while the link kept up the whole time.
  private mutating func effectiveDelay(
    _ sample: CongestionSample,
    delivery: Double?,
    now: Double,
    isFallingShort: Bool
  ) -> Double {
    guard let backlog = sample.transportBacklogBytes else { return sample.queueDelay }
    let rate = max(delivery ?? 0, Double(floor))
    let transport = min(Double(max(0, backlog)) * 8 / rate, 10)
    let standing = min(transport, transportDelays.last?.delay ?? transport)
    transportDelays.append((now, transport))
    while let first = transportDelays.first, now - first.time > tuning.baseDelayWindow {
      transportDelays.removeFirst()
    }
    let base = transportDelays.map(\.delay).min() ?? 0
    status.transportBaseMilliseconds = Int((base * 1000).rounded())
    guard isFallingShort else { return sample.queueDelay }
    return sample.queueDelay + max(0, standing - base)
  }

  // MARK: - Deciding

  private func decide(delay: Double, appDelay: Double, lost: Bool, draining: Bool, now: Double) -> Decision {
    let sinceDecrease = now - lastDecreaseAt

    // Each cut is judged against the rate it would leave; one already at the floor has nowhere to go.
    let canCut = target > Double(floor)
    // The large cut is for frames lost or about to be: a queue in this app, which only builds once
    // the transport is full. The transport's own backlog is an estimate, and earns the smaller steps.
    if canCut, lost || appDelay > tuning.emergencyDelay, now - lastEmergencyAt >= tuning.emergencyHold {
      return .emergency
    }
    // The smaller steps are for a queue that is still building.
    let mayTrim = !(tuning.holdWhileDraining && draining)
    if canCut, mayTrim, congestedTicks >= 2, sinceDecrease >= tuning.decreaseHold {
      return .congested
    }
    if canCut, mayTrim, delay > tuning.growingDelay, isGrowing, sinceDecrease >= tuning.decreaseHold {
      return .growing
    }
    if target < Double(ceiling),
       delay < tuning.clearDelay,
       now - lastLossAt >= tuning.increaseHold,
       sinceDecrease >= tuning.increaseHold {
      return .increase
    }
    return .hold
  }

  /// Three ticks each longer than the one before: a queue building, as opposed to one burst.
  private var isGrowing: Bool {
    guard recentDelays.count >= 3 else { return false }
    return zip(recentDelays, recentDelays.dropFirst()).allSatisfy { $0 < $1 }
  }

  private mutating func cut(to rate: Double, now: Double) {
    let next = max(Double(floor), rate)
    guard next < target else { return }
    lastCongestedRate = min(target, cutDelivery() ?? target)
    target = next
    lastDecreaseAt = now
    congestedTicks = 0
    status.decreases += 1
  }

  private mutating func climb(elapsed: Double, delivery: Double?) {
    var factor = pow(tuning.increasePerSecond, max(0, elapsed)) - 1
    // SCReAM's approach to the last congested rate: full speed from well below it, a fifth of that
    // within 10% either side, so the climb lingers where it last went wrong instead of overshooting.
    if let last = lastCongestedRate, last > 0 {
      let distance = (target - last) / last
      factor *= max(0.2, min(1, pow(4 * distance, 2)))
    }
    var next = target * (1 + factor)
    if let delivery { next = min(next, delivery * tuning.probeCeilingFactor) }
    next = min(next, Double(ceiling))
    guard next > target else { return }
    target = next
    if target >= Double(ceiling) { lastCongestedRate = nil }
  }

  // MARK: - Pushing

  private mutating func push(decision: Decision, now: Double) -> Int? {
    let rounded = (Int(target) / tuning.quantum) * tuning.quantum
    // The floor and ceiling themselves are always reachable, whatever the quantum makes of them.
    let next = target >= Double(ceiling) ? ceiling : max(floor, rounded)
    guard next != bitrate else { return nil }

    let isDecrease = next < bitrate
    let atBound = next == ceiling || next == floor
    let change = abs(Double(next - bitrate)) / Double(bitrate)
    guard change >= tuning.minimumChange || atBound else { return nil }
    if !isDecrease, now - lastPushAt < tuning.increasePushInterval { return nil }

    if !isDecrease { status.increases += 1 }
    bitrate = next
    lastPushAt = now
    return next
  }
}
