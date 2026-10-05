import Foundation

// A test tool: makes a camera deliver fewer frames than it captures, the way a phone throttling from
// heat does, while everything else about the stream stays as it is.
//
// Changing `videoEncoder.rateControl.frameRateLimit` switches the capture format and restarts the
// session, which a receiver sees as a reconnect. This instead drops captured frames before they
// reach the encoder. The capture format, the declared rate, the SDP, the session and the sound are
// untouched, and every kept frame keeps its own capture time, so the receiver sees a connected
// camera sending fewer, unevenly spaced frames. It is off at every launch and is never saved.

/// A delivered rate that moves from `low` up to `high` and back down to `low` over each `period`
/// seconds, linearly, starting at `low`. On the wire it is `low:high:period`.
public struct FrameRateSwing: Sendable, Equatable {
  public var low: Double
  public var high: Double
  public var periodSeconds: Double

  public init(low: Double, high: Double, periodSeconds: Double) {
    self.low = low
    self.high = high
    self.periodSeconds = periodSeconds
  }

  /// Parses `low:high:period`. Nil for anything else, including a `low` above `high` or a rate
  /// outside what `FrameDelivery` accepts.
  public init?(text: String) {
    let parts = text.split(separator: ":", omittingEmptySubsequences: false)
      .map { Double($0.trimmingCharacters(in: .whitespaces)) }
    guard parts.count == 3, let low = parts[0], let high = parts[1], let period = parts[2],
          FrameDelivery.accepts(rate: low), FrameDelivery.accepts(rate: high), low <= high,
          period.isFinite, period > 0
    else { return nil }
    self.init(low: low, high: high, periodSeconds: period)
  }

  public var text: String {
    [ low, high, periodSeconds ].map(CameraParameters.number).joined(separator: ":")
  }

  /// The rate `elapsed` seconds into the swing: a triangle from `low` to `high` and back.
  public func rate(atElapsed elapsed: Double) -> Double {
    let phase = (elapsed / periodSeconds).truncatingRemainder(dividingBy: 1)
    let rising = phase < 0 ? phase + 1 : phase
    let fraction = rising < 0.5 ? rising * 2 : (1 - rising) * 2
    return low + (high - low) * fraction
  }
}

/// SplitMix64: a small generator whose sequence is the same on every platform, so a wander's seed
/// replays the same schedule on the iPhone and the Pixel.
public struct SeededRandom: Sendable, Equatable {
  private var state: UInt64

  public init(seed: UInt64) {
    state = seed
  }

  public mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }

  /// Uniform in `0 ..< 1`.
  public mutating func unit() -> Double {
    Double(next() >> 11) / Double(UInt64(1) << 53)
  }
}

/// A delivered rate that wanders at random, the way a phone's does as it heats on a solid network:
/// it holds a rate for `minHold`–`maxHold` seconds, then moves to a target picked uniformly in
/// `low`–`high`, as a step or a 1–5 s ramp (even odds); about one move in eight is a deep dip to
/// 8–15 fps for 1–4 s, recovering by a 1–5 s ramp. It starts at `high`. The schedule is a function
/// of the seed alone, so a run can be replayed exactly. On the wire it is
/// `low:high:minHold:maxHold:seed`; without a seed one is picked and reported.
public struct FrameRateWander: Sendable, Equatable {
  public var low: Double
  public var high: Double
  public var minHoldSeconds: Double
  public var maxHoldSeconds: Double
  public var seed: UInt64

  public static let dipProbability = 1.0 / 8
  public static let dipRates = 8.0 ... 15.0
  public static let dipSeconds = 1.0 ... 4.0
  public static let rampSeconds = 1.0 ... 5.0

  public init(low: Double, high: Double, minHoldSeconds: Double, maxHoldSeconds: Double, seed: UInt64) {
    self.low = low
    self.high = high
    self.minHoldSeconds = minHoldSeconds
    self.maxHoldSeconds = maxHoldSeconds
    self.seed = seed
  }

  /// Parses `low:high:minHold:maxHold[:seed]`. Nil for anything else, including `low` above `high`,
  /// a rate `FrameDelivery` refuses, or holds that are not `0 < minHold ≤ maxHold`.
  public init?(text: String, randomSeed: () -> UInt64 = { UInt64.random(in: 1 ... UInt64.max) }) {
    let parts = text.split(separator: ":", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }
    guard parts.count == 4 || parts.count == 5 else { return nil }
    let numbers = parts.prefix(4).map(Double.init)
    guard let low = numbers[0], let high = numbers[1], let minHold = numbers[2], let maxHold = numbers[3],
          FrameDelivery.accepts(rate: low), FrameDelivery.accepts(rate: high), low <= high,
          minHold.isFinite, maxHold.isFinite, minHold > 0, minHold <= maxHold
    else { return nil }
    let seed: UInt64
    if parts.count == 5 {
      guard let parsed = UInt64(parts[4]) else { return nil }
      seed = parsed
    } else {
      seed = randomSeed()
    }
    self.init(low: low, high: high, minHoldSeconds: minHold, maxHoldSeconds: maxHold, seed: seed)
  }

  public var text: String {
    ([ low, high, minHoldSeconds, maxHoldSeconds ].map(CameraParameters.number) + [ String(seed) ])
      .joined(separator: ":")
  }
}

/// A wander's schedule, generated from its seed as far as it has been asked about: segments over
/// which the rate is constant or a straight ramp.
public struct WanderSchedule: Sendable, Equatable {
  public struct Segment: Sendable, Equatable {
    public var start: Double
    public var end: Double
    public var from: Double
    public var to: Double
    /// True for a deep dip's floor.
    public var isDip: Bool
  }

  public let wander: FrameRateWander
  public private(set) var segments: [Segment] = []
  private var random: SeededRandom
  private var time = 0.0
  private var rate: Double
  /// Moves made, and how many of them were deep dips.
  public private(set) var moves = 0
  public private(set) var dips = 0

  public init(_ wander: FrameRateWander) {
    self.wander = wander
    random = SeededRandom(seed: wander.seed)
    rate = wander.high
  }

  /// The rate `elapsed` seconds in.
  public mutating func rate(atElapsed elapsed: Double) -> Double {
    extend(through: elapsed)
    guard let segment = segments.last(where: { $0.start <= elapsed }) else { return wander.high }
    guard segment.end > segment.start, segment.from != segment.to else { return segment.from }
    let fraction = min(1, max(0, (elapsed - segment.start) / (segment.end - segment.start)))
    return segment.from + (segment.to - segment.from) * fraction
  }

  /// Generates segments until they cover `elapsed`.
  public mutating func extend(through elapsed: Double) {
    while time <= elapsed {
      let w = wander
      let hold = w.minHoldSeconds + (w.maxHoldSeconds - w.minHoldSeconds) * random.unit()
      append(hold, from: rate, to: rate, isDip: false)
      moves += 1
      if random.unit() < FrameRateWander.dipProbability {
        dips += 1
        let dip = draw(FrameRateWander.dipRates)
        append(draw(FrameRateWander.dipSeconds), from: dip, to: dip, isDip: true)
        let target = w.low + (w.high - w.low) * random.unit()
        append(draw(FrameRateWander.rampSeconds), from: dip, to: target, isDip: false)
        rate = target
      } else {
        let target = w.low + (w.high - w.low) * random.unit()
        if random.unit() < 0.5 {
          rate = target
        } else {
          append(draw(FrameRateWander.rampSeconds), from: rate, to: target, isDip: false)
          rate = target
        }
      }
    }
  }

  private mutating func draw(_ range: ClosedRange<Double>) -> Double {
    range.lowerBound + (range.upperBound - range.lowerBound) * random.unit()
  }

  private mutating func append(_ duration: Double, from: Double, to: Double, isDip: Bool) {
    segments.append(Segment(start: time, end: time + duration, from: from, to: to, isDip: isDip))
    time += duration
  }
}

/// What the throttle is told to do: a steady rate, a swing, a wander, or nothing. A wander wins over
/// a swing, and a swing over a steady rate, when more than one is set.
public struct FrameDelivery: Sendable, Equatable {
  /// Frames per second, 0 for off.
  public var frameRate: Double
  public var swing: FrameRateSwing?
  public var wander: FrameRateWander?

  public static let off = FrameDelivery()

  /// The slowest and fastest rates accepted. One frame a second is already a camera in trouble;
  /// above 240 nothing a phone captures is throttled.
  public static let minimumRate = 1.0
  public static let maximumRate = 240.0

  public init(frameRate: Double = 0, swing: FrameRateSwing? = nil, wander: FrameRateWander? = nil) {
    self.frameRate = frameRate
    self.swing = swing
    self.wander = wander
  }

  public var isOff: Bool { wander == nil && swing == nil && frameRate <= 0 }

  /// The rate to deliver `elapsed` seconds after the throttle was configured. Nil when off. A
  /// wander is answered by `FrameDeliveryThrottle`, which keeps its schedule; here it starts high.
  public func targetRate(atElapsed elapsed: Double) -> Double? {
    if let wander {
      var schedule = WanderSchedule(wander)
      return schedule.rate(atElapsed: elapsed)
    }
    if let swing { return swing.rate(atElapsed: elapsed) }
    return frameRate > 0 ? frameRate : nil
  }

  /// Whether `rate` is a rate a throttle can be told to deliver. 0, for off, is checked separately.
  public static func accepts(rate: Double) -> Bool {
    rate.isFinite && rate >= minimumRate && rate <= maximumRate
  }
}

/// Decides, frame by frame, which captured frames reach the encoder, and measures how many did.
///
/// Called from the capture queue for every captured frame, with that frame's capture time; read from
/// anywhere for the rate it is delivering. Kept frames are due at intervals of `1 / rate`, each
/// varied by up to ±30%, counted from the previous due time rather than the previous kept frame, so
/// the long-run rate is the one asked for even though only whole captured frames can be kept.
public final class FrameDeliveryThrottle: @unchecked Sendable {
  /// How far each interval is varied either way, as a fraction of `1 / rate`.
  public static let jitter = 0.3
  /// The window the delivered rate is measured over.
  public static let measurementWindow = 2.0
  /// A frame this close before its due time is kept: capture times wobble by a millisecond or so.
  static let earlyTolerance = 0.001
  /// A capture time this far behind the last one is a new clock (a session restart), not a frame.
  static let clockStepBack = 0.5

  private let lock = NSLock()
  private let random: @Sendable () -> Double
  private var configured = FrameDelivery.off
  private var anchor: Double?
  private var due: Double?
  private var lastSeen: Double?
  private var delivered: [Double] = []
  private var schedule: WanderSchedule?

  /// `random` returns values in `0 ..< 1`; tests pass a seeded generator.
  public init(random: @escaping @Sendable () -> Double = { Double.random(in: 0 ..< 1) }) {
    self.random = random
  }

  public var delivery: FrameDelivery {
    lock.withLock { configured }
  }

  /// Starts a new delivery pattern from the next frame. A swing starts at its `low`.
  public func configure(_ delivery: FrameDelivery) {
    lock.withLock {
      configured = delivery
      anchor = nil
      due = nil
      schedule = delivery.wander.map(WanderSchedule.init)
    }
  }

  /// Whether the frame captured at `captureTime` seconds should be encoded.
  public func shouldDeliver(captureTime: Double) -> Bool {
    lock.withLock {
      if let lastSeen, captureTime < lastSeen - Self.clockStepBack {
        anchor = nil
        due = nil
        delivered.removeAll()
      }
      lastSeen = captureTime
      guard keep(captureTime) else { return false }
      delivered.append(captureTime)
      while let first = delivered.first, captureTime - first > Self.measurementWindow {
        delivered.removeFirst()
      }
      return true
    }
  }

  /// The rate a wander is asking for now, nil without one.
  public var wanderTarget: Double? {
    lock.withLock {
      guard var current = schedule, let anchor, let lastSeen else { return nil }
      let rate = current.rate(atElapsed: lastSeen - anchor)
      schedule = current
      return rate
    }
  }

  /// Frames per second reaching the encoder over the last two seconds of capture time, whether or
  /// not a throttle is set. Nil until two frames have been delivered.
  public var deliveredFrameRate: Double? {
    lock.withLock {
      guard delivered.count >= 2, let first = delivered.first, let last = delivered.last, last > first
      else { return nil }
      return Double(delivered.count - 1) / (last - first)
    }
  }

  private func keep(_ time: Double) -> Bool {
    let start = anchor ?? time
    anchor = start
    let rate: Double
    if schedule != nil {
      rate = schedule!.rate(atElapsed: time - start)
    } else if let steady = configured.targetRate(atElapsed: time - start) {
      rate = steady
    } else {
      return true
    }
    let next = due ?? time
    guard time + Self.earlyTolerance >= next else { return false }
    let mean = 1 / rate
    let interval = mean * (1 + Self.jitter * (2 * random() - 1))
    // From the due time, so the rate is exact on average; but never from further back than one
    // mean interval, or a rate the camera cannot reach would build a backlog and then a burst.
    due = max(next, time - mean) + interval
    return true
  }
}
