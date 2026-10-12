import Foundation

/// Where the programme clock takes its pictures from.
///
/// TS Director's is its compositor's output, held in a `ProgrammePictureQueue` until each picture's
/// moment comes due; the phone's is its one camera. Either way the clock asks on each tick it is
/// due a picture, and the source answers with the newest picture due by then — the last one again
/// when nothing new is due — or nothing before its first.
public protocol ProgrammePictureSource {
  associatedtype Picture

  /// The picture due on a tick at `wallNow`, a tick being `period` seconds long. `sequence` tells a
  /// new picture from the last one repeated.
  mutating func programmePicture(at wallNow: Double, period: Double) -> (picture: Picture, sequence: UInt64)?
}

extension ProgrammePictureQueue: ProgrammePictureSource {
  public mutating func programmePicture(
    at wallNow: Double,
    period: Double
  ) -> (picture: Picture, sequence: UInt64)? {
    pick(at: wallNow, period: period).map { ($0.picture, $0.sequence) }
  }
}

extension ProgrammeClock {
  /// The tick at `now` and, when one is due, the picture `source` has for it at `wallNow`. Nil when
  /// no tick is due; a tick with no picture is one before the source's first.
  public mutating func tick<Source: ProgrammePictureSource>(
    at now: Double,
    wallNow: Double,
    from source: inout Source
  ) -> (tick: Tick, picture: (picture: Source.Picture, sequence: UInt64)?)? {
    guard let tick = tick(at: now) else { return nil }
    return (tick, source.programmePicture(at: wallNow, period: 1 / Double(rate)))
  }
}
