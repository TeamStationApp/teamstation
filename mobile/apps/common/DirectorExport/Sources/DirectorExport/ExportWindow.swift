import Foundation
import DirectorCore

/// The stretch of wall clock every file of one export is cut from.
///
/// Every output of an export is the same length, and a moment N seconds into one is the same moment
/// N seconds into all of them. That only holds when they are all cut from one window, so when the
/// work of one export is split between machines the window is computed once and handed to each.
public struct ExportWindow: Sendable, Equatable, Codable {
  public var start: WallClock
  /// Nil only for a take that recorded no end and whose cameras wrote nothing.
  public var end: WallClock?

  public init(start: WallClock, end: WallClock?) {
    self.start = start
    self.end = end
  }
}
