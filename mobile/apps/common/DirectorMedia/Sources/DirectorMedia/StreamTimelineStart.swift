import CoreMedia
import Foundation

/// When the first picture a publish sent was captured, on the wall clock: where the server's copy of
/// the stream begins.
///
/// TeamStation places a live video by when the publish reached it, which is up to a second and more
/// after the picture was taken, and by a different amount on every publisher: a phone holds each
/// picture a second before the programme shows it, the dial takes what it takes, and pictures stamped
/// before the publish was live are never sent. Two phones filming one clock played out of step by
/// the difference. The publisher is the one that knows, so it works the moment out and says it.
///
/// A picture is stamped on the stream's own clock when it is submitted (`StreamEncodeClock`), so
/// each submission records how long before then its picture was captured. A repeat, or a picture
/// with no capture time, borrows the last age measured. When the first picture goes out, its capture
/// is its stamp on the wall clock less that age. Once settled it holds for the publish; each
/// publish starts a new one, and its host says which publish began the server's video.
public struct StreamTimelineStart: Sendable {
  /// Submissions not yet sent: each picture's stamp in milliseconds and its age when submitted.
  private var ages: [(stamp: Int64, age: Double)] = []
  private var lastAge: Double = 0
  /// The settled moment, in the seconds the submissions were given in.
  public private(set) var captured: Double?

  /// Pictures waiting for the publish to go live, at most: half a minute at 30 fps.
  static let maximumHeld = 900

  public init() {}

  /// A picture was stamped `time` at `now`; `captureWall` is when it was captured, nil for a repeat.
  /// Both on the clock `now` is read from.
  public mutating func submitted(time: CMTime, now: Double, captureWall: Double?) {
    guard captured == nil, time.isNumeric else { return }
    // An age that is negative or absurd is a clock that stepped, not a picture's.
    if let captureWall, now - captureWall >= 0, now - captureWall < 10 {
      lastAge = now - captureWall
    }
    ages.append((Self.key(time), lastAge))
    if ages.count > Self.maximumHeld { ages.removeFirst(ages.count - Self.maximumHeld) }
  }

  /// The first picture went out, stamped `time` on a stream clock that read zero at `startWall`.
  public mutating func sent(time: CMTime, startWall: Double) {
    guard captured == nil, time.isNumeric else { return }
    let key = Self.key(time)
    let age = ages.last(where: { $0.stamp == key })?.age ?? lastAge
    captured = startWall + time.seconds - age
    ages = []
  }

  private static func key(_ time: CMTime) -> Int64 {
    Int64((time.seconds * 1_000).rounded())
  }
}
