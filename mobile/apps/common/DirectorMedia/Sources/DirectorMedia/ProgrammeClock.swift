import Foundation

/// The programme's own frame clock.
///
/// The programme used to be encoded as each picture of the camera on air arrived. Its timeline was
/// steered to real time, but a frame existed only when that camera delivered one: a camera that
/// stalled wrote nothing, and the next picture landed a whole stall later, so the last picture before
/// it became a single sample seconds long. Players hang on those. The programme now makes its frames
/// on a clock of its own, from the newest picture it has: a stalled or frozen camera on air is the
/// same picture repeated at the programme's rate, and nothing a camera does can move the timeline.
///
/// One clock serves the recording and the stream, which may run at different rates. It ticks at
/// the faster of the two, and each of them takes the ticks that fall on its own grid.
public struct ProgrammeClock: Sendable, Equatable {
  public struct Tick: Sendable, Equatable {
    /// This tick's number at `rate`.
    public var index: Int64
    /// The recording's frame number, when a recording frame falls on this tick.
    public var recordingFrame: Int64?
    /// The stream's frame number, when a stream frame falls on this tick.
    public var streamFrame: Int64?
    /// Recording frames before `recordingFrame` that a late timer skipped. Each was due a picture,
    /// and the recording is written on an exact grid, so they are filled rather than left as one
    /// frame lasting several.
    public var recordingFramesMissed: Int64
    /// How far after its own moment this tick ran, in seconds (negative when the timer was early),
    /// and how many ticks before it never ran at all: the iPad falling behind, seen from the clock.
    public var lateness: Double
    public var ticksMissed: Int64

    public init(
      index: Int64,
      recordingFrame: Int64?,
      streamFrame: Int64? = nil,
      recordingFramesMissed: Int64 = 0,
      lateness: Double = 0,
      ticksMissed: Int64 = 0
    ) {
      self.index = index
      self.recordingFrame = recordingFrame
      self.streamFrame = streamFrame
      self.recordingFramesMissed = recordingFramesMissed
      self.lateness = lateness
      self.ticksMissed = ticksMissed
    }
  }

  /// Ticks per second: the faster of the recording's and the stream's rates.
  public let rate: Int
  public let recordingRate: Int
  public let streamRate: Int
  private var origin: Double?
  private var lastTick: Int64 = -1
  private var lastRecordingFrame: Int64 = -1
  private var lastStreamFrame: Int64 = -1

  public init(recordingRate: Int, streamRate: Int) {
    self.recordingRate = max(1, recordingRate)
    self.streamRate = max(1, streamRate)
    self.rate = max(1, recordingRate, streamRate)
  }

  /// The tick at `now`, or nil when none is due. Tick numbers are the nearest to `now`, so a timer
  /// that fires a little early or late lands on its own tick and one that fires very late skips a
  /// number rather than stamping a frame at the wrong time; the recording frames it skipped are
  /// counted in `recordingFramesMissed`. A recording or stream frame falls on the first tick at or
  /// after its own time, allowing half a tick for the timer being early, so a picture is never taken
  /// for a frame before that frame's moment.
  public mutating func tick(at now: Double) -> Tick? {
    let origin = self.origin ?? now
    self.origin = origin
    let elapsed = now - origin
    let index = Int64((elapsed * Double(rate)).rounded())
    guard index > lastTick else { return nil }
    let ticksMissed = lastTick >= 0 ? max(0, index - lastTick - 1) : 0
    lastTick = index
    let previousRecordingFrame = lastRecordingFrame
    let recordingFrame = Self.frame(at: elapsed, rate: recordingRate, tickRate: rate, after: &lastRecordingFrame)
    return Tick(
      index: index,
      recordingFrame: recordingFrame,
      streamFrame: Self.frame(at: elapsed, rate: streamRate, tickRate: rate, after: &lastStreamFrame),
      recordingFramesMissed: recordingFrame.map { max(0, $0 - previousRecordingFrame - 1) } ?? 0,
      lateness: elapsed - Double(index) / Double(rate),
      ticksMissed: ticksMissed
    )
  }

  /// The frame of an output at `rate` due by `elapsed`, if it is newer than the last one given.
  private static func frame(at elapsed: Double, rate: Int, tickRate: Int, after last: inout Int64) -> Int64? {
    let halfTick = 0.5 * Double(rate) / Double(tickRate)
    let frame = Int64((elapsed * Double(rate) + halfTick).rounded(.down))
    guard frame > last else { return nil }
    last = frame
    return frame
  }
}
