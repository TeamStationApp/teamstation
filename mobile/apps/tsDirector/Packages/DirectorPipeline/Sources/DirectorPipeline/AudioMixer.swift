import CoreMedia
import Foundation
import DirectorCore
import DirectorSources

/// Sums the sound of every source the operator has selected into one continuous programme bus.
///
/// The mix keeps its own clock: a 48 kHz sample counter on host uptime (`mach_continuous_time`),
/// started by `start`. Sample N is due at the start's uptime plus N / 48,000 s, and a timer emits
/// fixed 20 ms chunks a little behind the counter's live edge whether or not any source has spoken.
/// Consequences worth stating:
///
/// - Output is continuous by construction and begins at `start`. A silent stretch is emitted as
///   silence rather than as a gap, which matters because the muxer stalls the video track when the
///   audio track falls behind it. That includes the stretch before any source has spoken: a
///   game's live stream went out with no sound track for its first 1,110 s because the mix
///   used to wait for the first buffer.
/// - The counter runs on uptime, so a wall-clock change neither stretches nor squeezes the sound.
///
/// Each source's sound waits in its own `SourceSoundTimeline`, laid down by capture time as soon as
/// it is decoded and shared by both mixes. Each chunk pulls from every contributing timeline at the
/// counter position less `readLag`: the live mix hears a camera `readLag` (the display latency cap,
/// 1 s by default) after it captured the sound, and the recording's mix hears it at its capture
/// time but emits five seconds behind the live edge, so sound held up on the way still lands in its
/// place. A source that underruns fades out and contributes silence; a source that returns fades in.
///
/// Mixing is plain summation with a clamp. There is no limiter or automatic gain: with four or five
/// cameras in one room the sum is dominated by whichever is closest to the action, and quiet
/// programme audio is easier to fix afterwards than pumping is.
public final class AudioMixer: @unchecked Sendable {
  public static let sampleRate: Double = 48_000
  public static let channelCount = 2

  /// How far behind the live edge the live mix emits: one mixer chunk, so the chunk is complete.
  public static let mixDelaySeconds = 0.02
  /// Kept for callers that size a window; the timelines hold `SourceSoundTimeline.capacitySeconds`.
  public static let defaultWindowSeconds = 3.0
  /// The live mix's read lag when nothing has set one, and D with the display latency cap off: the
  /// cap's default, so D is the same either way.
  public static let defaultLiveReadLagSeconds = 1.0
  /// The most sound a quiet source must have waiting before it is heard again.
  public static let maximumReserveSeconds = 0.1
  private static let chunkSeconds = 0.02

  public struct Statistics: Sendable, Equatable {
    public var contributors = 0
    public var emittedSeconds: Double = 0
    /// Buffers that arrived after this mix had already read past where they belong: silence.
    public var lateBuffers: UInt64 = 0
    /// Buffers placed further ahead than a timeline accepts.
    public var futureBuffers: UInt64 = 0
    /// Buffers offered while the mix was stopped; there is no counter to place them on.
    public var unstartedBuffers: UInt64 = 0
    /// Samples emitted since `start`: the counter's read position.
    public var emittedSamples: Int64 = 0
    /// Sources faded out into silence, and the silence emitted for sources that had been heard.
    public var fades: UInt64 = 0
    public var concealedSeconds: Double = 0
    /// How far behind the counter this mix reads each source, in seconds.
    public var readLagSeconds: Double = 0

    public init() {}
  }

  private let clock: DirectorClock
  /// Host uptime in seconds. The counter's time base; injected so a test can move it by hand.
  private let uptime: @Sendable () -> Double
  /// Whether `start` runs the 20 ms timer. A test drives `emitReadyChunks` itself instead.
  private let runsTimer: Bool
  private let onMixed: @Sendable (AudioFrame) -> Void
  /// How far behind the live edge this mix emits.
  private let delaySeconds: Double
  /// Where each source's sound waits. Shared with the other mix when the router made it.
  public let timelines: SourceSoundTimelines
  private let readerID: Int

  private let lock = NSLock()
  private let chunkFrames: Int
  /// Where the counter started, nil while stopped. Everything below is counted from here.
  private var origin: Origin?
  /// Counter position of the next chunk to emit.
  private var emitCursor: Int64 = 0
  private var contributors: Set<SourceID> = []
  private var readers: [SourceID: SourceSoundTimeline.Reader] = [:]
  private var readLag: Double
  /// A new read lag, taken on the next chunk after every source has faded out at the old one.
  private var pendingReadLag: Double?
  /// Operator input gain per source, 0...1. Fifty percent is unity; 100 percent is +6 dB.
  private var inputGains: [SourceID: Double] = [:]
  private var statistics = Statistics()
  private var timer: DispatchSourceTimer?
  private let queue = DispatchQueue(label: "app.teamstation.director.audiomix")
  private let formatDescription: CMAudioFormatDescription?

  /// Hands each mix its own reader identity, so a timeline can tell the mixes reading it apart.
  private final class ReaderIDs: @unchecked Sendable {
    private let lock = NSLock()
    private var last = 0

    func next() -> Int {
      lock.lock()
      defer { lock.unlock() }
      last += 1
      return last
    }
  }

  private static let readerIDs = ReaderIDs()

  /// The counter's starting point: the uptime it counts from, as a whole sample, the wall-clock
  /// instant that was at the time, and the wall-minus-uptime offset used for emitted wall clocks.
  private struct Origin {
    let uptime: Double
    let uptimeSample: Int64
    /// `start`'s wall clock in samples since 1970, so emitted presentation times keep counting on
    /// the epoch they always have.
    let wallSample: Int64
    var wallOffset: Double
  }

  /// A wall-minus-uptime offset that moves by more than this has been adjusted (a slew or a step)
  /// and is adopted. Below it, the difference is the jitter of reading two clocks one after the
  /// other, and following it would shift contiguous buffers by a sample and click.
  static let wallOffsetToleranceSeconds = 0.001

  /// `delaySeconds` is how far behind the live edge chunks are emitted, and `readLagSeconds` how far
  /// behind each chunk's own position its sources are read. `timelines` is shared between mixes
  /// reading the same sources; a mix given none keeps its own, fed by `append`.
  public init(
    clock: DirectorClock,
    delaySeconds: Double = AudioMixer.mixDelaySeconds,
    readLagSeconds: Double = 0,
    windowSeconds: Double = AudioMixer.defaultWindowSeconds,
    uptime: @escaping @Sendable () -> Double = HostUptime.seconds,
    runsTimer: Bool = true,
    timelines: SourceSoundTimelines? = nil,
    onMixed: @escaping @Sendable (AudioFrame) -> Void
  ) {
    self.clock = clock
    self.uptime = uptime
    self.runsTimer = runsTimer
    self.onMixed = onMixed
    self.delaySeconds = delaySeconds
    self.timelines = timelines ?? SourceSoundTimelines(clock: clock, uptime: uptime)
    readLag = max(0, readLagSeconds)
    chunkFrames = Int(Self.sampleRate * Self.chunkSeconds)
    readerID = Self.readerIDs.next()
    formatDescription = AudioSampleBuilder.makeFormatDescription(
      AudioSampleBuilder.interleavedInt16Description(
        sampleRate: Self.sampleRate,
        channels: UInt32(Self.channelCount)
      )
    )
  }

  public var currentStatistics: Statistics {
    lock.lock()
    var copy = statistics
    copy.contributors = contributors.count
    copy.readLagSeconds = pendingReadLag ?? readLag
    let ids = contributors
    let states = readers
    lock.unlock()
    for id in ids {
      guard let timeline = timelines.existing(id) else { continue }
      copy.lateBuffers &+= timeline.lateBuffers(for: readerID)
      copy.futureBuffers &+= timeline.currentStatistics.futureBuffers
    }
    for state in states.values {
      copy.fades &+= state.fades
      copy.concealedSeconds += state.concealedSeconds
    }
    return copy
  }

  /// What this mix is doing with one source, nil before it has read it.
  public func reader(for id: SourceID) -> SourceSoundTimeline.Reader? {
    lock.lock()
    defer { lock.unlock() }
    return readers[id]
  }

  /// The sources this mix sums. A source left out stops contributing at once.
  public func setContributors(_ ids: Set<SourceID>) {
    lock.lock()
    contributors = ids
    readers = readers.filter { ids.contains($0.key) }
    lock.unlock()
  }

  /// Replaces the per-source input gains used from the next chunk. Missing sources stay at 50%.
  public func setInputGains(_ gains: [SourceID: Double]) {
    lock.lock()
    inputGains = gains
    lock.unlock()
  }

  /// Moves where sources are read. While running, every source fades out at the old place first
  /// and is heard again at the new one.
  public func setReadLag(seconds: Double) {
    let lag = max(0, seconds)
    lock.lock()
    if origin != nil, lag != readLag {
      pendingReadLag = lag
    } else {
      readLag = lag
      pendingReadLag = nil
    }
    lock.unlock()
  }

  /// Starts the counter at sample 0, now, and emits from here on whether or not a source speaks.
  /// Starting a running mix changes nothing: the counter it already has is the programme's.
  public func start() {
    lock.lock()
    guard origin == nil else {
      lock.unlock()
      return
    }
    let startUptime = uptime()
    let wall = clock.now.seconds
    origin = Origin(
      uptime: startUptime,
      uptimeSample: Int64((startUptime * Self.sampleRate).rounded()),
      wallSample: Int64((wall * Self.sampleRate).rounded()),
      wallOffset: wall - startUptime
    )
    emitCursor = 0
    statistics.emittedSamples = 0
    if let pending = pendingReadLag {
      readLag = pending
      pendingReadLag = nil
    }
    lock.unlock()

    guard runsTimer else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + Self.chunkSeconds, repeating: Self.chunkSeconds)
    timer.setEventHandler { [weak self] in self?.emitReadyChunks() }
    self.timer = timer
    timer.resume()
  }

  /// Stops the counter. The next `start` begins again at sample 0.
  public func stop() {
    timer?.cancel()
    timer = nil
    lock.lock()
    origin = nil
    emitCursor = 0
    contributors.removeAll()
    readers.removeAll()
    lock.unlock()
  }

  /// Whether the counter is running.
  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return origin != nil
  }

  /// The counter position of a wall-clock instant. Called with `lock` held and the mix started.
  private func counterPosition(ofWall wall: Double, origin: inout Origin) -> Int64 {
    adoptWallOffset(&origin)
    return Int64(((wall - origin.wallOffset) * Self.sampleRate).rounded()) - origin.uptimeSample
  }

  /// Re-reads wall minus uptime and keeps it unless it has moved by more than the tolerance.
  private func adoptWallOffset(_ origin: inout Origin) {
    let offset = clock.now.seconds - uptime()
    if abs(offset - origin.wallOffset) > Self.wallOffsetToleranceSeconds {
      origin.wallOffset = offset
    }
  }

  /// Lays one source buffer down on its timeline, at its capture time, and counts the source in.
  /// The router feeds shared timelines directly; this is for a mix that keeps its own.
  public func append(_ frame: AudioFrame) {
    lock.lock()
    guard origin != nil else {
      statistics.unstartedBuffers &+= 1
      lock.unlock()
      return
    }
    contributors.insert(frame.sourceID)
    lock.unlock()
    timelines.append(frame)
  }

  /// Emits everything up to `wall` at once, without waiting out the delay. For the end of a take:
  /// sound that has not arrived by then is not coming in time to matter.
  public func flush(through wall: WallClock) {
    queue.sync {
      lock.lock()
      guard var origin = self.origin else {
        lock.unlock()
        return
      }
      let horizon = counterPosition(ofWall: wall.seconds, origin: &origin)
      self.origin = origin
      lock.unlock()
      emitChunks(through: horizon, flushing: true)
    }
  }

  /// Emits every whole chunk that is now far enough behind the counter's live edge to be complete.
  /// The timer calls this on `queue`; a test calls it directly with uptime where it wants it.
  func emitReadyChunks() {
    lock.lock()
    guard let origin else {
      lock.unlock()
      return
    }
    let elapsed = uptime() - origin.uptime - delaySeconds
    lock.unlock()
    emitChunks(through: Int64((elapsed * Self.sampleRate).rounded(.down)), flushing: false)
  }

  private func emitChunks(through horizon: Int64, flushing: Bool) {
    while true {
      lock.lock()
      guard var origin = self.origin, emitCursor + Int64(chunkFrames) <= horizon else {
        lock.unlock()
        return
      }
      let cursor = emitCursor
      let lagFrames = Int64((readLag * Self.sampleRate).rounded())
      let readAt = origin.uptimeSample + cursor - lagFrames
      let reserve = Int(min((delaySeconds + readLag) / 2, Self.maximumReserveSeconds) * Self.sampleRate)
      let stopAt = pendingReadLag.map { _ in readAt + Int64(SourceSoundTimeline.fadeFrames) }

      var sum = [Int32](repeating: 0, count: chunkFrames * Self.channelCount)
      for id in contributors {
        guard let timeline = timelines.existing(id) else { continue }
        var reader = readers[id] ?? SourceSoundTimeline.Reader(id: readerID)
        timeline.read(
          &reader,
          at: readAt,
          count: chunkFrames,
          gain: (inputGains[id] ?? 0.5) * 2,
          reserveFrames: reserve,
          flushing: flushing,
          stopAt: stopAt,
          into: &sum
        )
        readers[id] = reader
      }
      if let pending = pendingReadLag {
        readLag = pending
        pendingReadLag = nil
      }

      let interleaved = sum.map(Self.clamp)
      emitCursor = cursor + Int64(chunkFrames)
      statistics.emittedSeconds += Self.chunkSeconds
      statistics.emittedSamples = emitCursor
      adoptWallOffset(&origin)
      self.origin = origin
      let wall = origin.uptime + origin.wallOffset + Double(cursor) / Self.sampleRate
      let format = formatDescription
      lock.unlock()

      guard
        let format,
        let buffer = AudioSampleBuilder.makeSampleBuffer(
          samples: interleaved,
          formatDescription: format,
          presentationTime: CMTime(
            value: origin.wallSample + cursor,
            timescale: CMTimeScale(Self.sampleRate)
          )
        )
      else { continue }

      onMixed(AudioFrame(
        sourceID: SourceID("program-mix"),
        sampleBuffer: buffer,
        wallClock: WallClock(seconds: wall)
      ))
    }
  }

  private static func clamp(_ value: Int32) -> Int16 {
    Int16(max(Int32(Int16.min), min(Int32(Int16.max), value)))
  }
}

/// Host uptime that keeps counting while the device sleeps: `mach_continuous_time` in seconds.
public enum HostUptime {
  @Sendable
  public static func seconds() -> Double {
    ContinuousUptime.seconds()
  }
}
