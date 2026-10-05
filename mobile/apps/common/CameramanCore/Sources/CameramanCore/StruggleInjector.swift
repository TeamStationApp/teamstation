import Foundation

// A test tool: makes a healthy phone behave like a hot one. A phone that has throttled itself starves
// its whole pipeline, not only its picture: in one game a hot camera delivered about
// 25 fps all game, its 60- and 120-picture GOPs spread over 3.1-6.7 s, and its sound reached the iPad
// at 53% of real time. T2's wander drops pictures from an otherwise healthy phone; this starves the
// rest. Three parts, each with its own level, all from one seed so a run can be replayed:
//
// - `mic`: microphone sound lost before it is encoded, in irregular bursts, at about this fraction
//   of the time (at most 0.5). The samples are gone as an overrun loses them: never counted, never
//   sent, so a sender that stamps sound by count stamps everything after early.
// - `hold`: the outgoing packets of both streams held for 0.3-2 s at a time, then released in one
//   burst, about this fraction of the time. Arrival rate drops on the receiver; capture times stay
//   true.
// - `slow`: windows of 1-5 s, about this fraction of the time, in which only one picture in every
//   50-250 ms reaches the encoder: the picture rate out falls irregularly, as a starved encoder's.
//
// Off at every launch and never saved. It combines with the frame-rate throttle.

/// What the injector is told to do. On the wire `mic:hold:slow:seed`.
public struct Struggle: Sendable, Equatable {
  public var mic: Double
  public var hold: Double
  public var slow: Double
  public var seed: UInt64

  public static let maximumMic = 0.5
  public static let maximumHold = 0.9
  public static let maximumSlow = 0.95

  public init(mic: Double, hold: Double, slow: Double, seed: UInt64) {
    self.mic = mic
    self.hold = hold
    self.slow = slow
    self.seed = seed
  }

  /// Parses `mic:hold:slow[:seed]`, each level a fraction within its maximum. Without a seed one is
  /// picked, and read back.
  public init?(text: String, randomSeed: () -> UInt64 = { UInt64.random(in: 1 ... UInt64.max) }) {
    let parts = text.split(separator: ":", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespaces) }
    guard parts.count == 3 || parts.count == 4 else { return nil }
    let levels = parts.prefix(3).map(Double.init)
    guard let mic = levels[0], let hold = levels[1], let slow = levels[2],
          (0 ... Self.maximumMic).contains(mic), (0 ... Self.maximumHold).contains(hold),
          (0 ... Self.maximumSlow).contains(slow)
    else { return nil }
    let seed: UInt64
    if parts.count == 4 {
      guard let parsed = UInt64(parts[3]) else { return nil }
      seed = parsed
    } else {
      seed = randomSeed()
    }
    self.init(mic: mic, hold: hold, slow: slow, seed: seed)
  }

  public var text: String {
    ([ mic, hold, slow ].map(CameraParameters.number) + [ String(seed) ]).joined(separator: ":")
  }

  public var isOff: Bool { mic <= 0 && hold <= 0 && slow <= 0 }
}

/// Alternating quiet gaps and windows on one seeded stream: each window lasts uniformly within
/// `window`, each gap is uniform in `0 ... 2 x mean gap`, with the mean gap set so windows take
/// about `level` of the time. It starts with a gap.
public struct WindowSchedule: Sendable, Equatable {
  public let level: Double
  public let window: ClosedRange<Double>
  public private(set) var windows: [ClosedRange<Double>] = []
  private var random: SeededRandom
  private var time = 0.0

  public init(seed: UInt64, level: Double, window: ClosedRange<Double>) {
    self.level = level
    self.window = window
    random = SeededRandom(seed: seed)
  }

  /// The window `elapsed` falls in, if any.
  public mutating func window(at elapsed: Double) -> ClosedRange<Double>? {
    guard level > 0 else { return nil }
    extend(through: elapsed)
    return windows.last { $0.lowerBound <= elapsed && elapsed < $0.upperBound }
  }

  public mutating func extend(through elapsed: Double) {
    guard level > 0 else { return }
    let meanWindow = (window.lowerBound + window.upperBound) / 2
    let meanGap = meanWindow * (1 - level) / level
    while time <= elapsed {
      time += 2 * meanGap * random.unit()
      let length = window.lowerBound + (window.upperBound - window.lowerBound) * random.unit()
      windows.append(time ... time + length)
      time += length
    }
  }
}

/// Applies a `Struggle` to one camera. Each part keeps its own clock, anchored at the first time it
/// is asked: capture time for sound and pictures, uptime for the send hold.
public final class StruggleInjector: @unchecked Sendable {
  public static let micBurst = 0.02 ... 0.4
  public static let holdLength = 0.3 ... 2.0
  public static let slowWindow = 1.0 ... 5.0
  public static let slowSpacing = 0.05 ... 0.25

  private let lock = NSLock()
  private var configured: Struggle?
  private var mic: WindowSchedule?
  private var hold: WindowSchedule?
  private var slow: WindowSchedule?
  private var spacing: SeededRandom?
  private var micAnchor: Double?
  private var holdAnchor: Double?
  private var slowAnchor: Double?
  private var nextSlowFrame: Double?
  private var droppedSoundSeconds = 0.0
  private var holds = 0
  private var droppedFrames: UInt64 = 0
  private var lastHold: ClosedRange<Double>?

  public init() {}

  public var struggle: Struggle? {
    lock.withLock { configured }
  }

  /// What it has done since configured: seconds of sound dropped, holds begun, pictures dropped.
  public var summary: (droppedSoundSeconds: Double, holds: Int, droppedFrames: UInt64) {
    lock.withLock { (droppedSoundSeconds, holds, droppedFrames) }
  }

  public func configure(_ struggle: Struggle?) {
    lock.withLock {
      let active = struggle.flatMap { $0.isOff ? nil : $0 }
      configured = active
      mic = active.map { WindowSchedule(seed: $0.seed ^ 0x6D69_6300, level: $0.mic, window: Self.micBurst) }
      hold = active.map { WindowSchedule(seed: $0.seed ^ 0x686F_6C64, level: $0.hold, window: Self.holdLength) }
      slow = active.map { WindowSchedule(seed: $0.seed ^ 0x736C_6F77, level: $0.slow, window: Self.slowWindow) }
      spacing = active.map { SeededRandom(seed: $0.seed ^ 0x7370_6163) }
      micAnchor = nil
      holdAnchor = nil
      slowAnchor = nil
      nextSlowFrame = nil
      lastHold = nil
      droppedSoundSeconds = 0
      holds = 0
      droppedFrames = 0
    }
  }

  /// Whether a stretch of microphone sound captured at `captureTime` for `duration` seconds reaches
  /// the encoder. Judged at its start.
  public func keepsSound(captureTime: Double, duration: Double) -> Bool {
    lock.withLock {
      guard mic != nil else { return true }
      let anchor = micAnchor ?? captureTime
      micAnchor = anchor
      guard mic!.window(at: captureTime - anchor) != nil else { return true }
      droppedSoundSeconds += max(0, duration)
      return false
    }
  }

  /// Whether the picture captured at `captureTime` reaches the encoder.
  public func keepsFrame(captureTime: Double) -> Bool {
    lock.withLock {
      guard slow != nil else { return true }
      let anchor = slowAnchor ?? captureTime
      slowAnchor = anchor
      guard slow!.window(at: captureTime - anchor) != nil else {
        nextSlowFrame = nil
        return true
      }
      if let next = nextSlowFrame, captureTime < next {
        droppedFrames &+= 1
        return false
      }
      let range = Self.slowSpacing
      nextSlowFrame = captureTime + range.lowerBound + (range.upperBound - range.lowerBound) * spacing!.unit()
      return true
    }
  }

  /// When a packet handed over at uptime `now` may leave: the end of the hold it falls in, or nil to
  /// send it at once.
  public func holdRelease(now: Double) -> Double? {
    lock.withLock {
      guard hold != nil else { return nil }
      let anchor = holdAnchor ?? now
      holdAnchor = anchor
      guard let window = hold!.window(at: now - anchor) else { return nil }
      if lastHold != window {
        lastHold = window
        holds += 1
      }
      return anchor + window.upperBound
    }
  }
}
