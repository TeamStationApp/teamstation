import Foundation

/// Request feedback has its own lifetime; its expiry never changes camera focus.
public struct FocusFeedback: Equatable, Sendable {
  public static let duration: TimeInterval = 2
  public let token: UUID
  public let x: Double
  public let y: Double
  public let started: Date

  public init(x: Double, y: Double, started: Date = Date()) {
    token = UUID()
    self.x = x
    self.y = y
    self.started = started
  }

  public func opacity(at date: Date) -> Double {
    let elapsed = date.timeIntervalSince(started)
    guard elapsed >= 0, elapsed < Self.duration else { return 0 }
    return 0.35 + 0.65 * (1 + cos(elapsed * .pi * 4)) / 2
  }
}
