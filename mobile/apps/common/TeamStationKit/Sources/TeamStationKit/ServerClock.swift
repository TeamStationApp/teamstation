import Foundation

/// How far this device's clock is from TeamStation's, so the instants it reports (when a stream's
/// first picture was captured, when an upload's first frame was) are on the server's clock.
///
/// A phone's clock can be a second out: a Pixel on the bench read 1.04 s ahead of true time, which
/// put its angle a second behind an iPhone's of the same play. The offset is Cristian's: ask for the
/// server's time, note when the question left and the answer came back, and take the server's
/// reading as the midpoint. The shortest of a few round trips wins, because its midpoint can be
/// furthest from the truth by the least: half that round trip, less however lopsided it was.
public enum ServerClock {
  public struct Sample: Sendable, Equatable {
    /// This device's clock as the request left, and as the answer arrived, in seconds.
    public var sent: Double
    public var received: Double
    /// The server's clock in its answer, in seconds.
    public var server: Double

    public init(sent: Double, server: Double, received: Double) {
      self.sent = sent
      self.server = server
      self.received = received
    }

    public var roundTrip: Double { received - sent }
  }

  /// What to add to this device's clock to read the server's, from the sample with the shortest
  /// round trip. Nil with no sample whose answer came after its question.
  public static func offset(from samples: [Sample]) -> Double? {
    guard let best = samples.filter({ $0.roundTrip >= 0 }).min(by: { $0.roundTrip < $1.roundTrip })
    else { return nil }
    return best.server - (best.sent + best.received) / 2
  }

  /// How many round trips an estimate takes: enough that one of them is likely quick.
  public static let samples = 4
}
