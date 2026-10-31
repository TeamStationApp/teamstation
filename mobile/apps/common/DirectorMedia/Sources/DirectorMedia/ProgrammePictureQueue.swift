import Foundation

/// Chooses the programme's picture on each tick of the programme clock by when it was captured.
///
/// A picture captured at W belongs on the programme at W + D, the same moment its camera's sound
/// is played (`SourceSoundTimeline`). On each tick the newest picture whose moment has come (within
/// `toleranceSeconds`) is taken; when none has, the last one is shown again. So a camera's frame
/// rate only changes how often a picture repeats: a 30 fps camera on a 60 fps programme repeats
/// every other tick, and a camera that swings between 30 and 60 fps moves between that and none.
///
/// A picture that arrives more than a whole tick after its moment is dropped rather than shown late:
/// showing it would put it ticks behind its neighbours, which reads as a hitch, and nothing else
/// waits for it. One that misses its tick by less is shown on the next: the preview's delay line
/// releases pictures on a 4 ms drain, so a picture due right on a tick can land just after it, and
/// a camera locked in that phase would otherwise lose every picture. A replay's picture comes with
/// the moment it is due instead (`ReplayCadence`) and is taken by the same rule; a picture with
/// neither is due at once.
///
/// Each cut starts a run: the pictures one camera hands over from then on. Pictures are put in order
/// within a run, because a camera's clock can sit behind another's; across runs only their moments
/// are compared, in `pick`. A later run takes the air on the
/// tick its first picture is due, late or not, and everything left of the earlier runs goes, due or
/// not. Until then the earlier run plays on, so a cut holds no picture. Two runs overlap for that
/// long because a cut back must find the camera on air unbroken.
///
/// The queue holds `D` plus `spareSeconds` of each run's pictures and lets older ones go.
public struct ProgrammePictureQueue<Picture> {
  public static var toleranceSeconds: Double { 0.002 }
  public static var spareSeconds: Double { 0.25 }

  public struct Entry {
    public let picture: Picture
    /// When it was captured, on our wall clock; nil for a replay's picture or one due at once.
    public let capture: Double?
    /// When a replay's picture is due, on our wall clock.
    public let due: Double?
    public let sequence: UInt64
    /// The run it belongs to; see the type's notes. A programme that never cuts leaves it at 0.
    public let run: UInt64

    /// When it belongs on the programme with the delay `delay`.
    func moment(delay: Double) -> Double {
      capture.map { $0 + delay } ?? due ?? -Double.infinity
    }
  }

  public private(set) var delaySeconds: Double
  private var queued: [Entry] = []
  /// The picture on air, repeated until a newer one is due.
  public private(set) var current: Entry?
  private var lastTick: Double?
  private var nextSequence: UInt64 = 0
  /// Pictures dropped because they arrived after their moment.
  public private(set) var latePictures: UInt64 = 0
  /// Pictures never shown because a newer one was due on the same tick.
  public private(set) var skippedPictures: UInt64 = 0

  public init(delaySeconds: Double) {
    self.delaySeconds = max(0, delaySeconds)
  }

  public var count: Int { queued.count }

  /// The run of the picture on air.
  public var onAirRun: UInt64? { current?.run }

  /// A new delay applies from the next tick; what is queued is judged by it.
  public mutating func setDelay(seconds: Double) {
    delaySeconds = max(0, seconds)
  }

  /// Adds a picture as it arrives from a camera, in capture order, or a replay's picture, in tape
  /// order, with the moment it is `due`.
  public mutating func add(_ picture: Picture, capture: Double?, due: Double? = nil, run: UInt64 = 0) {
    // Of a run a later one has replaced on air: nothing can show it now.
    if let current, run < current.run { return }
    // Older than what is already on air: it arrived after its moment, and after a newer picture's.
    if let capture, let current, current.run == run, let shown = current.capture, capture < shown {
      latePictures &+= 1
      return
    }
    nextSequence &+= 1
    let entry = Entry(
      picture: picture,
      capture: capture,
      due: capture == nil ? due : nil,
      sequence: nextSequence,
      run: run
    )
    // Runs in order, and capture order within one; a picture with no capture time goes last in its run.
    var index = queued.count
    while index > 0 {
      let before = queued[index - 1]
      guard before.run >= run else { break }
      if before.run == run {
        guard let capture, (before.capture ?? -Double.infinity) > capture else { break }
      }
      index -= 1
    }
    queued.insert(entry, at: index)
    // Bounded by time: the newest capture of the run less the delay and the spare.
    if let newest = capture {
      let floor = newest - delaySeconds - Self.spareSeconds
      queued.removeAll { $0.run == run && ($0.capture ?? newest) < floor }
    }
    if queued.count > 1_000 { queued.removeFirst(queued.count - 1_000) }
  }

  /// A cut: everything queued goes but the pictures of `run`, the camera on air's when it plays on
  /// until the new camera's first picture is due. The picture on air stays.
  public mutating func dropRuns(keeping run: UInt64?) {
    queued.removeAll { $0.run != run }
  }

  /// The picture for the tick at wall-clock `now`, ticks being `period` apart: the newest that is
  /// due, or the last again.
  public mutating func pick(at now: Double, period: Double) -> Entry? {
    let tolerance = Self.toleranceSeconds
    let due = now + tolerance
    var chosen: Int?
    // A run waits at its first picture not yet due; a later run's may be due regardless.
    var waiting: UInt64?
    for (index, entry) in queued.enumerated() where entry.run != waiting {
      if entry.moment(delay: delaySeconds) <= due { chosen = index } else { waiting = entry.run }
    }
    if let chosen {
      var candidate = queued[chosen]
      // Its moment passed a whole tick ago and it was not here then: dropped, unless nothing has
      // ever been shown or it is its run's first on air, which ends what is on air whenever it lands.
      if let lastTick, let capture = candidate.capture, let current, current.run == candidate.run,
         capture + delaySeconds <= lastTick - period - tolerance {
        latePictures &+= 1
        candidate = current
      } else {
        skippedPictures &+= UInt64(queued[..<chosen].filter { $0.run == candidate.run }.count)
      }
      if candidate.sequence != current?.sequence { current = candidate }
      queued.removeFirst(chosen + 1)
    }
    lastTick = now
    return current
  }
}
