import CoreMedia
import Foundation
import DirectorCore
import DirectorSources

/// Sums the audio of every source the operator has selected into one continuous programme bus.
///
/// The hard part is not the arithmetic, it is agreeing on a timeline. Each camera stamps its audio
/// with its own clock, delivers it on its own thread, and drifts at its own rate, so buffers cannot
/// simply be concatenated in arrival order. The mix keeps its own clock instead: a 48 kHz sample
/// counter on host uptime (`mach_continuous_time`), started by `start`. Sample N is due at the
/// start's uptime plus N / 48,000 s. Every buffer is written into a ring at the counter position of
/// its wall clock, and a timer emits fixed chunks from a point far enough behind the counter's live
/// edge that late arrivals have already landed. Consequences worth stating:
///
/// - Output is continuous by construction and begins at `start`. A silent stretch is emitted as
///   silence rather than as a gap, which matters because the muxer stalls the video track when the
///   audio track falls behind it — the failure this pipeline has already been bitten by twice. That
///   includes the stretch before any source has spoken: a game's live stream went out
///   with no sound track for its first 1,110 s because the mix used to wait for the first buffer.
/// - The counter runs on uptime, so a wall-clock change neither stretches nor squeezes the sound.
///   Wall clocks are only translated onto it, through an offset that is re-read and adopted when it
///   moves by more than a millisecond.
/// - A source that stops contributing costs nothing. It simply stops adding to the sum.
///
/// How far behind the live edge is the one difference between the two mixes Director runs. The
/// live mix is fed sound the delay line has already timed, so it runs a single chunk behind. The
/// recording's mix is fed sound at its capture time as it arrives, and runs seconds behind so sound
/// held up on the way still lands in its place.
///
/// Mixing is plain summation with a clamp. There is no limiter or automatic gain: with four or five
/// cameras in one room the sum is dominated by whichever is closest to the action, and quiet
/// programme audio is easier to fix afterwards than pumping is.
public final class AudioMixer: @unchecked Sendable {
  public static let sampleRate: Double = 48_000
  public static let channelCount = 2

  /// How far behind the live edge the live mix emits. One mixer chunk, so the ring's live edge is
  /// complete. Camera jitter is absorbed by the RTP delay line before audio is mixed; a
  /// quarter-second here would play the programme behind the picture.
  public static let mixDelaySeconds = 0.02
  /// The live mix's ring depth. Comfortably longer than the delay so a burst cannot wrap onto
  /// unread samples.
  public static let defaultWindowSeconds = 3.0
  private static let chunkSeconds = 0.02

  public struct Statistics: Sendable, Equatable {
    public var contributors = 0
    public var emittedSeconds: Double = 0
    public var lateBuffers: UInt64 = 0
    public var futureBuffers: UInt64 = 0
    /// Buffers offered while the mix was stopped; there is no counter to place them on.
    public var unstartedBuffers: UInt64 = 0
    /// Samples emitted since `start`: the counter's read position.
    public var emittedSamples: Int64 = 0

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

  private let lock = NSLock()
  /// Accumulator in 32-bit so several sources can be summed before clamping once, on the way out.
  private var ring: [Int32]
  private let capacityFrames: Int
  private let chunkFrames: Int
  /// Where the counter started, nil while stopped. Everything below is counted from here.
  private var origin: Origin?
  /// Counter position of the next chunk to emit.
  private var emitCursor: Int64 = 0
  private var contributors: Set<SourceID> = []
  /// Operator input gain per source, 0...1. Fifty percent is unity; 100 percent is +6 dB.
  private var inputGains: [SourceID: Double] = [:]
  private var statistics = Statistics()
  private var timer: DispatchSourceTimer?
  private let queue = DispatchQueue(label: "app.teamstation.director.audiomix")
  private let formatDescription: CMAudioFormatDescription?

  /// The counter's starting point: the uptime it counts from, the wall-clock instant that was at
  /// the time, and the wall-minus-uptime offset used to translate buffers onto it.
  private struct Origin {
    let uptime: Double
    /// `start`'s wall clock in samples since 1970, so emitted presentation times keep counting on
    /// the epoch they always have.
    let wallSample: Int64
    var wallOffset: Double
  }

  /// A wall-minus-uptime offset that moves by more than this has been adjusted (a slew or a step)
  /// and is adopted. Below it, the difference is the jitter of reading two clocks one after the
  /// other, and following it would shift contiguous buffers by a sample and click.
  static let wallOffsetToleranceSeconds = 0.001

  /// `delaySeconds` is how far behind the live edge chunks are emitted, and `windowSeconds` how much
  /// the ring holds, which must be longer.
  public init(
    clock: DirectorClock,
    delaySeconds: Double = AudioMixer.mixDelaySeconds,
    windowSeconds: Double = AudioMixer.defaultWindowSeconds,
    uptime: @escaping @Sendable () -> Double = HostUptime.seconds,
    runsTimer: Bool = true,
    onMixed: @escaping @Sendable (AudioFrame) -> Void
  ) {
    self.clock = clock
    self.uptime = uptime
    self.runsTimer = runsTimer
    self.onMixed = onMixed
    self.delaySeconds = delaySeconds
    capacityFrames = Int(Self.sampleRate * max(windowSeconds, delaySeconds + 1))
    chunkFrames = Int(Self.sampleRate * Self.chunkSeconds)
    ring = [Int32](repeating: 0, count: capacityFrames * Self.channelCount)
    formatDescription = AudioSampleBuilder.makeFormatDescription(
      AudioSampleBuilder.interleavedInt16Description(
        sampleRate: Self.sampleRate,
        channels: UInt32(Self.channelCount)
      )
    )
  }

  public var currentStatistics: Statistics {
    lock.lock()
    defer { lock.unlock() }
    var copy = statistics
    copy.contributors = contributors.count
    return copy
  }

  /// Drops sources that are no longer ticked for audio. `append` only inserts, so without this
  /// `mix=` would keep climbing after the operator unticks a camera.
  public func retainContributors(_ ids: Set<SourceID>) {
    lock.lock()
    contributors.formIntersection(ids)
    lock.unlock()
  }

  /// Replaces the per-source input gains used on the next `append`. Missing sources stay at 50%.
  public func setInputGains(_ gains: [SourceID: Double]) {
    lock.lock()
    inputGains = gains
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
      wallSample: Int64((wall * Self.sampleRate).rounded()),
      wallOffset: wall - startUptime
    )
    emitCursor = 0
    statistics.emittedSamples = 0
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
    for index in ring.indices { ring[index] = 0 }
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
    let uptimeSeconds = wall - origin.wallOffset - origin.uptime
    return Int64((uptimeSeconds * Self.sampleRate).rounded())
  }

  /// Re-reads wall minus uptime and keeps it unless it has moved by more than the tolerance.
  private func adoptWallOffset(_ origin: inout Origin) {
    let offset = clock.now.seconds - uptime()
    if abs(offset - origin.wallOffset) > Self.wallOffsetToleranceSeconds {
      origin.wallOffset = offset
    }
  }

  /// Mixes one source buffer in at the position its wall clock claims.
  public func append(_ frame: AudioFrame) {
    guard var samples = AudioPCM.stereoSamples(
      from: frame.sampleBuffer,
      sampleRate: Self.sampleRate,
      channelCount: Self.channelCount
    ) else { return }
    let frameCount = samples.count / Self.channelCount
    guard frameCount > 0 else { return }

    lock.lock()
    let multiplier = (inputGains[frame.sourceID] ?? 0.5) * 2
    lock.unlock()
    AudioPCM.scale(&samples, multiplier: multiplier)

    lock.lock()
    defer { lock.unlock() }

    guard var origin = self.origin else {
      statistics.unstartedBuffers &+= 1
      return
    }
    let start = counterPosition(ofWall: frame.wallClock.seconds, origin: &origin)
    self.origin = origin
    contributors.insert(frame.sourceID)
    let cursor = emitCursor

    if start + Int64(frameCount) <= cursor {
      statistics.lateBuffers &+= 1
      return
    }
    if start > cursor + Int64(capacityFrames) {
      statistics.futureBuffers &+= 1
      return
    }

    // A buffer that straddles the cursor keeps only the part that has not been emitted.
    let skip = Int(max(0, cursor - start))
    for offset in skip ..< frameCount {
      let slot = Self.slot(start + Int64(offset), capacity: capacityFrames) * Self.channelCount
      ring[slot] += Int32(samples[offset * Self.channelCount])
      ring[slot + 1] += Int32(samples[offset * Self.channelCount + 1])
    }
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
      emitChunks(through: horizon)
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
    emitChunks(through: Int64((elapsed * Self.sampleRate).rounded(.down)))
  }

  private func emitChunks(through horizon: Int64) {
    while true {
      lock.lock()
      guard var origin = self.origin, emitCursor + Int64(chunkFrames) <= horizon else {
        lock.unlock()
        return
      }
      let cursor = emitCursor

      var interleaved = [Int16](repeating: 0, count: chunkFrames * Self.channelCount)
      for offset in 0 ..< chunkFrames {
        let slot = Self.slot(cursor + Int64(offset), capacity: capacityFrames) * Self.channelCount
        interleaved[offset * Self.channelCount] = Self.clamp(ring[slot])
        interleaved[offset * Self.channelCount + 1] = Self.clamp(ring[slot + 1])
        // Zeroing on the way out is what lets the ring be reused: a slot that kept its old sum
        // would add a copy of itself back into the mix one window later.
        ring[slot] = 0
        ring[slot + 1] = 0
      }
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

  /// The ring slot of a counter position. Positions before 0 are sound captured before `start`,
  /// which the late-buffer check discards, but the modulo still has to land inside the ring.
  private static func slot(_ position: Int64, capacity: Int) -> Int {
    let remainder = position % Int64(capacity)
    return Int(remainder < 0 ? remainder + Int64(capacity) : remainder)
  }

  private static func clamp(_ value: Int32) -> Int16 {
    Int16(max(Int32(Int16.min), min(Int32(Int16.max), value)))
  }
}

/// Host uptime that keeps counting while the device sleeps: `mach_continuous_time` in seconds.
public enum HostUptime {
  private static let secondsPerTick: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(info.numer) / Double(info.denom) / 1_000_000_000
  }()

  @Sendable
  public static func seconds() -> Double {
    Double(mach_continuous_time()) * secondsPerTick
  }
}
