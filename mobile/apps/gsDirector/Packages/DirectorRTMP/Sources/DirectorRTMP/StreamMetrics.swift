import Foundation

public enum StreamMetrics {
  /// Bytes on the wire over `windowSeconds`, as megabits/s rounded to 0.01.
  public static func megabits(bytes: UInt64, windowSeconds: Double) -> Double {
    guard windowSeconds > 0 else { return 0 }
    let megabits = Double(bytes) * 8 / 1_000_000 / windowSeconds
    return (megabits * 100).rounded() / 100
  }
}

/// Presents each distinct stream error once per session so a failing send loop cannot stack toasts.
public struct StreamErrorGate: Sendable, Equatable {
  private var shown: String?

  public init() {}

  public mutating func reset() {
    shown = nil
  }

  public mutating func shouldPresent(_ message: String) -> Bool {
    if shown == message { return false }
    shown = message
    return true
  }
}
