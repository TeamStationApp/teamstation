import Foundation

/// Decides what an NDI camera's archive encodes on each tick of its own clock.
///
/// The archive used to encode each picture as it arrived, stamped by `NDIReceiveClock`: a counter
/// stepping at the camera's *measured* frame rate. That tied the recording's timeline to an
/// estimate, and an estimate can be wrong for a minute at a time. rec-411's Cosmo C2 came back from
/// a half-hour outage read as 1.9 fps, and its archive stamped every 16 ms picture 0.54 s after the
/// last. The archive now runs on a clock of its own at the raw camera frame rate from Settings:
/// tick n is n / rate after the first picture, whatever the camera sends.
///
/// **Which picture a tick encodes.** Every picture carries the moment it is `due` in the archive,
/// and each tick takes the next picture in order once it is due.
///
/// - A picture placed by the sender's clock is due at its capture time on our clock plus the
///   archive delay, so the recording follows the camera's own even capture grid however the
///   pictures arrived. Taking the newest picture to have *arrived* instead was the stutter in every
///   Cosmo recording: the Cosmo delivers 100 ms of pictures at once, so a tick-by-arrival archive
///   held one picture for several ticks and then jumped over the rest of the burst, repeating
///   21-35% of its frames while the live tile, paced by the delay line, was smooth. The delay is
///   what lets the burst arrive before its first picture is due.
/// - A picture with no usable sender clock is due at its arrival plus the same delay. Both kinds
///   share one timeline, so a sender whose pictures switch between stamped and unstamped costs at
///   most the difference between capture and arrival, its transit: going to stamped, the first
///   stamped pictures are due up to a transit before the last unstamped one and are dropped as late
///   until they catch up; going back, the next unstamped one is due a transit later and the last
///   stamped one is repeated meanwhile. Nothing is held for the whole delay, and nothing queued is
///   thrown away at once.
///
/// Pictures are taken one per tick while the next one's moment lies within half a tick ahead of the
/// tick and a tick and a half behind it. That band is two ticks wide, not one, so the few
/// milliseconds of scatter left in smoothed capture times cannot flip a picture between two ticks
/// and make a repeat and a skip out of a camera that is perfectly on time. A camera fractionally
/// faster than the archive drifts to the back of the band and loses one picture there; one
/// fractionally slower drifts to the front and has one repeated. A camera faster than the archive
/// stays toward the back of the band, its pictures taken up to a tick and a half after their
/// moment, so each frame is labelled by its picture's own capture rather than by the tick; see
/// `sinceTaken`.
///
/// A picture the camera has not replaced since the previous tick is encoded again, so a camera
/// that stutters, or sends a slower rate than the setting, still makes an evenly timed recording.
/// That is for short stalls only: once the newest picture is older than `repeatWindow` the camera
/// has gone, and ticks encode nothing. The count keeps running meanwhile, so when pictures come back
/// the recording shows a gap exactly as long as the outage, which the archive writer holds and the
/// export fills. The outage stays on the record, instead of half an hour of one picture being
/// written as if it were footage.
///
/// The ticker is the only store of the pictures it may still take: each carries its caller's
/// `payload` (the decoded pixels, for an NDI source), so what the ticker lets go is let go, and the
/// picture a tick repeats is always the one it holds.
///
/// When the archive stops, `drain(through:)` runs the ticks the pictures still queued are due on,
/// so the recording reaches the moment it was stopped instead of ending a delay early.
public struct ArchiveTicker<Payload> {
  public struct Picture {
    /// Monotonic seconds when the picture arrived.
    public var arrived: Double
    /// Monotonic seconds when it belongs in the archive: its capture time on our clock, or its
    /// arrival when the sender's clock does not place it, plus the archive delay.
    public var due: Double
    /// Counts up with every picture the camera delivers, so a repeat can be told from a new one.
    public var sequence: UInt64
    /// The caller's, carried with the picture and never looked at here.
    public var payload: Payload

    /// A picture due as it arrives.
    public init(arrived: Double, sequence: UInt64, payload: Payload) {
      self.init(arrived: arrived, due: arrived, sequence: sequence, payload: payload)
    }

    /// A picture due in the archive at `due`.
    public init(arrived: Double, due: Double, sequence: UInt64, payload: Payload) {
      self.arrived = arrived
      self.due = due
      self.sequence = sequence
      self.payload = payload
    }
  }

  public enum Decision: Sendable, Equatable {
    /// Encode `current` as frame `index` of the archive. `isRepeat` when that picture was already
    /// encoded on an earlier tick.
    case encode(index: Int64, isRepeat: Bool)
    /// The camera has sent nothing for longer than `repeatWindow`: this tick encodes nothing.
    case outage
    /// No new tick is due, or no picture has ever arrived.
    case idle
  }

  /// Half a second: longer than any stutter a working camera has, short enough that a camera that
  /// has gone is not recorded as a frozen picture.
  public static var defaultRepeatWindow: Double { 0.5 }

  /// How long after its capture a picture is due in the archive. It has to cover the spread of
  /// arrivals: the Cosmo C2's bursts put up to about 100 ms between a picture's capture and its
  /// arrival on top of the least transit, and a hitch can double that. A picture that still arrives
  /// after its moment is not lost; it is taken late, on the next tick.
  public static var defaultArchiveDelay: Double { 0.25 }

  /// The most pictures held for their moment: a second at 60 fps, well past the delay. A camera
  /// whose pixel pool cannot lend that many lowers `queueLimit`; see `NDIFrameSource`.
  public static var maximumQueued: Int { 60 }

  /// One tick `drain(through:)` ran: the archive frame number, the tick's own time, and the
  /// picture it encodes.
  public struct DrainedTick {
    public var index: Int64
    public var tickTime: Double
    public var picture: Picture
    /// `sinceTaken` for this tick.
    public var sinceTaken: Double
  }

  public private(set) var frameRate: Int
  public let repeatWindow: Double
  /// The most pictures queued for their moment, `maximumQueued` at most. Together with `current`
  /// this is every picture the ticker holds. Lowering it lets go of the oldest queued pictures at
  /// once, counted as skipped.
  public var queueLimit: Int = Self.maximumQueued {
    didSet {
      queueLimit = Swift.min(Self.maximumQueued, Swift.max(1, queueLimit))
      trimQueue()
    }
  }
  private var origin: Double?
  private var lastIndex: Int64 = -1
  private var lastSequence: UInt64?
  private var queued: [Picture] = []
  /// The picture the last encoding tick took, repeated until a newer one is taken.
  public private(set) var current: Picture?
  /// The last tick's own time, on the same monotonic clock as `now`: when the frame it encoded
  /// belongs, whenever the timer actually fired.
  public private(set) var lastTickTime: Double?
  /// The time of the tick that took `current`.
  private var currentTakenAt: Double?
  /// How long before the last tick `current` was taken: zero for a new picture, a tick more for
  /// each repeat.
  ///
  /// What a frame's capture label adds to its picture's own capture time. A new picture is labelled
  /// by its own capture, not by the tick: a camera faster than the archive settles at the back of
  /// the band, up to a tick and a half behind, and labelling by the tick put its content that much
  /// later than it was taken (50 ms for a 60 fps camera in a 30 fps archive). A repeat moves on with
  /// the ticks, as the camera's own clock would have while it stalled.
  public var sinceTaken: Double {
    guard let lastTickTime, let currentTakenAt else { return 0 }
    return lastTickTime - currentTakenAt
  }
  /// Ticks that encoded a picture again, pictures passed over for a newer one, and pictures dropped
  /// for being due no later than one already taken or waiting. Cumulative: `restart` keeps them.
  public private(set) var repeatedTicks: UInt64 = 0
  public private(set) var skippedPictures: UInt64 = 0
  public private(set) var latePictures: UInt64 = 0

  public init(frameRate: Int, repeatWindow: Double = defaultRepeatWindow) {
    self.frameRate = max(1, frameRate)
    self.repeatWindow = repeatWindow
  }

  /// Starts again with nothing held and no clock, as a new archive does, keeping the counts so they
  /// describe the camera across takes like its other archive counters.
  public mutating func restart(frameRate: Int) {
    self.frameRate = max(1, frameRate)
    origin = nil
    lastIndex = -1
    lastSequence = nil
    queued.removeAll()
    current = nil
    currentTakenAt = nil
    lastTickTime = nil
  }

  /// Moves every held picture's moment by `seconds`, for an archive delay that changed: shortened,
  /// the queue is re-based onto the new delay instead of every new picture being due before it and
  /// refused as late while the old queue drains.
  public mutating func shiftDue(by seconds: Double) {
    for index in queued.indices { queued[index].due += seconds }
    current?.due += seconds
  }

  /// Runs the ticks the queued pictures are due on, up to `deadline` and no further than the last
  /// of them, as the timer would have. Used when the archive stops: the pictures captured in its
  /// last delay would otherwise never be encoded, and the recording would end that long early.
  public mutating func drain(through deadline: Double) -> [DrainedTick] {
    guard let origin else { return [] }
    let period = 1 / Double(frameRate)
    var ticks: [DrainedTick] = []
    while !queued.isEmpty {
      let tickTime = origin + Double(lastIndex + 1) * period
      guard tickTime <= deadline + period / 2 else { break }
      let before = lastIndex
      if case let .encode(index, _) = tick(at: tickTime), let current {
        ticks.append(DrainedTick(index: index, tickTime: tickTime, picture: current, sinceTaken: sinceTaken))
      }
      if lastIndex == before { break }
    }
    return ticks
  }

  /// Every picture the ticker holds: the queue and `current`.
  public var heldCount: Int { queued.count + (current == nil ? 0 : 1) }

  /// Hands over a picture as it arrives. False when it is refused, as a repeat or out of order, in
  /// which case nothing of it is kept.
  @discardableResult
  public mutating func add(_ picture: Picture) -> Bool {
    if let last = queued.last ?? current, picture.sequence <= last.sequence { return false }
    // Due no later than a picture already taken or waiting: out of order, and taking it would step
    // the recording backwards.
    if let last = queued.last ?? current, picture.due <= last.due {
      latePictures &+= 1
      return false
    }
    queued.append(picture)
    trimQueue()
    return true
  }

  private mutating func trimQueue() {
    guard queued.count > queueLimit else { return }
    skippedPictures &+= UInt64(queued.count - queueLimit)
    queued.removeFirst(queued.count - queueLimit)
  }

  /// What the tick at `now` encodes.
  ///
  /// The tick number is the nearest one to `now`, so a timer that fires a little early or late
  /// still lands on its own tick, and one that fires very late skips a number rather than stamping
  /// a frame at the wrong time. Pictures are judged against the tick's own time, not `now`, so the
  /// timer's jitter does not move them between ticks either.
  public mutating func tick(at now: Double) -> Decision {
    let period = 1 / Double(frameRate)
    guard let origin = origin ?? startingOrigin(at: now, period: period) else { return .idle }
    self.origin = origin
    let index = Int64(((now - origin) * Double(frameRate)).rounded())
    guard index > lastIndex else { return .idle }
    lastIndex = index
    let tickTime = origin + Double(index) * period
    lastTickTime = tickTime

    takeNext(at: tickTime, period: period)

    guard let current else { return .idle }
    let age = tickTime - current.due
    let isRepeat = current.sequence == lastSequence
    guard !isRepeat || age <= repeatWindow else { return .outage }
    if isRepeat { repeatedTicks &+= 1 }
    lastSequence = current.sequence
    return .encode(index: index, isRepeat: isRepeat)
  }

  /// The archive's clock starts on the first tick at or after the first picture's moment, so every
  /// moment after it falls within a tick's band with half a tick to spare on either side. Starting
  /// up to half a tick *before* it left the moments on the band's front edge, where a millisecond of
  /// smoothing (one arrival-placed picture eased onto the grid) turned into a repeat.
  private func startingOrigin(at now: Double, period: Double) -> Double? {
    guard let first = queued.first else { return nil }
    return first.due <= now ? now : nil
  }

  /// Takes the next picture in order whose moment has come, passing over any that a later picture
  /// has already caught up with.
  private mutating func takeNext(at tickTime: Double, period: Double) {
    let early = tickTime + period / 2
    let behind = tickTime - 1.5 * period
    while let next = queued.first, next.due <= early {
      if queued.count > 1, next.due < behind, queued[1].due <= early {
        queued.removeFirst()
        skippedPictures &+= 1
        continue
      }
      current = next
      currentTakenAt = tickTime
      queued.removeFirst()
      return
    }
  }
}

// Sendable whenever what it carries is. An NDI source's decoded pixels are not (`CVPixelBuffer`
// is not marked Sendable), and need not be: the ticker lives under its source's lock.
extension ArchiveTicker: Sendable where Payload: Sendable {}
extension ArchiveTicker.Picture: Sendable where Payload: Sendable {}
extension ArchiveTicker.DrainedTick: Sendable where Payload: Sendable {}

extension ArchiveTicker.Picture where Payload == Void {
  /// A picture with nothing carried, due as it arrives.
  public init(arrived: Double, sequence: UInt64) {
    self.init(arrived: arrived, sequence: sequence, payload: ())
  }

  /// A picture with nothing carried, due in the archive at `due`.
  public init(arrived: Double, due: Double, sequence: UInt64) {
    self.init(arrived: arrived, due: due, sequence: sequence, payload: ())
  }
}
