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

/// What the throttle is told to do: a steady rate, a swing, or nothing. A swing wins over a steady
/// rate when both are set.
public struct FrameDelivery: Sendable, Equatable {
  /// Frames per second, 0 for off.
  public var frameRate: Double
  public var swing: FrameRateSwing?

  public static let off = FrameDelivery()

  /// The slowest and fastest rates accepted. One frame a second is already a camera in trouble;
  /// above 240 nothing a phone captures is throttled.
  public static let minimumRate = 1.0
  public static let maximumRate = 240.0

  public init(frameRate: Double = 0, swing: FrameRateSwing? = nil) {
    self.frameRate = frameRate
    self.swing = swing
  }

  public var isOff: Bool { swing == nil && frameRate <= 0 }

  /// The rate to deliver `elapsed` seconds after the throttle was configured. Nil when off.
  public func targetRate(atElapsed elapsed: Double) -> Double? {
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
    guard let rate = configured.targetRate(atElapsed: time - start) else { return true }
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
