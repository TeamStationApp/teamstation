import Foundation

/// Decides what an NDI camera's archive encodes on each tick of its own clock.
///
/// The archive used to encode each picture as it arrived, stamped by `NDIReceiveClock`: a counter
/// stepping at the camera's *measured* frame rate. That tied the recording's timeline to an
/// estimate, and an estimate can be wrong for a minute at a time. rec-361's Cosmo C2 came back from
/// a half-hour outage read as 1.9 fps, and its archive stamped every 16 ms picture 0.54 s after the
/// last. The archive now runs on a clock of its own at the raw camera frame rate from Settings:
/// tick n is n / rate after the first picture, whatever the camera sends.
///
/// Each tick encodes the newest picture. A picture the camera has not replaced since the previous
/// tick is encoded again, so a camera that stutters, or sends a slower rate than the setting, still
/// makes an evenly timed recording. That is for short stalls only: once the newest picture is older
/// than `repeatWindow` the camera has gone, and ticks encode nothing. The count keeps running
/// meanwhile, so when pictures come back the recording shows a gap exactly as long as the outage,
/// which the archive writer holds and the export fills. The outage stays on the record, instead of
/// half an hour of one picture being written as if it were footage.
public struct ArchiveTicker: Sendable, Equatable {
  public struct Picture: Sendable, Equatable {
    /// Monotonic seconds when the picture arrived.
    public var arrived: Double
    /// Counts up with every picture the camera delivers, so a repeat can be told from a new one.
    public var sequence: UInt64

    public init(arrived: Double, sequence: UInt64) {
      self.arrived = arrived
      self.sequence = sequence
    }
  }

  public enum Decision: Sendable, Equatable {
    /// Encode the newest picture as frame `index` of the archive. `isRepeat` when that picture was
    /// already encoded on an earlier tick.
    case encode(index: Int64, isRepeat: Bool)
    /// The camera has sent nothing for longer than `repeatWindow`: this tick encodes nothing.
    case outage
    /// No new tick is due, or no picture has ever arrived.
    case idle
  }

  /// Half a second: longer than any stutter a working camera has, short enough that a camera that
  /// has gone is not recorded as a frozen picture.
  public static let defaultRepeatWindow = 0.5

  public let frameRate: Int
  public let repeatWindow: Double
  private var origin: Double?
  private var lastIndex: Int64 = -1
  private var lastSequence: UInt64?

  public init(frameRate: Int, repeatWindow: Double = defaultRepeatWindow) {
    self.frameRate = max(1, frameRate)
    self.repeatWindow = repeatWindow
  }

  /// What the tick at `now` encodes, given the newest picture the camera has delivered.
  ///
  /// The tick number is the nearest one to `now`, so a timer that fires a little early or late
  /// still lands on its own tick, and one that fires very late skips a number rather than stamping
  /// a frame at the wrong time.
  public mutating func tick(at now: Double, newest: Picture?) -> Decision {
    guard let newest else { return .idle }
    let origin = self.origin ?? now
    self.origin = origin
    let index = Int64(((now - origin) * Double(frameRate)).rounded())
    guard index > lastIndex else { return .idle }
    lastIndex = index
    guard now - newest.arrived <= repeatWindow else { return .outage }
    let isRepeat = newest.sequence == lastSequence
    lastSequence = newest.sequence
    return .encode(index: index, isRepeat: isRepeat)
  }
}
