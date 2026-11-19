import Foundation

/// The two numbers on TS Speedy's screen. Each side holds its last reading above zero for five
/// seconds, then shows a dash; a side that never had a reading shows the dash too.
public struct SpeedBoard: Equatable, Sendable {
  public enum Side: Sendable {
    case pitch
    case exit
  }

  /// How long a reading stays on screen.
  public static let hold: TimeInterval = 5
  /// What an empty or expired side shows.
  public static let dash = "--"

  struct Slot: Equatable, Sendable {
    var mph: Int
    var at: Date
  }

  var pitch: Slot?
  var exit: Slot?

  public init() {}

  /// A reading from the radar. Zero means "no reading" for that side, as it does on the wire, and
  /// leaves that side alone.
  public mutating func receive(pitch: Int, exit: Int, at now: Date) {
    if pitch > 0 { self.pitch = Slot(mph: pitch, at: now) }
    if exit > 0 { self.exit = Slot(mph: exit, at: now) }
  }

  public mutating func clear() {
    pitch = nil
    exit = nil
  }

  public func text(_ side: Side, at now: Date) -> String {
    guard let slot = side == .pitch ? pitch : exit else { return Self.dash }
    return now.timeIntervalSince(slot.at) < Self.hold ? String(slot.mph) : Self.dash
  }
}
