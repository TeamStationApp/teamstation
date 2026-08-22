import CoreMedia
import Foundation
import DirectorCore
import DirectorSources

/// Sums the audio of every source the operator has selected into one continuous programme bus.
///
/// The hard part is not the arithmetic, it is agreeing on a timeline. Each camera stamps its audio
/// with its own clock, delivers it on its own thread, and drifts at its own rate, so buffers cannot
/// simply be concatenated in arrival order. Instead every buffer is written into a ring indexed by
/// **wall clock**, and a timer emits fixed chunks from a point far enough behind the live edge that
/// late arrivals have already landed. Two consequences worth stating:
///
/// - Output is continuous by construction. A silent stretch is emitted as silence rather than as a
///   gap, which matters because the muxer stalls the video track when the audio track falls behind
///   it — the failure this pipeline has already been bitten by twice.
/// - A source that stops contributing costs nothing. It simply stops adding to the sum.
///
/// Mixing is plain summation with a clamp. There is no limiter or automatic gain: with four or five
/// cameras in one room the sum is dominated by whichever is closest to the action, and quiet
/// programme audio is easier to fix afterwards than pumping is.
public final class AudioMixer: @unchecked Sendable {
  public static let sampleRate: Double = 48_000
  public static let channelCount = 2

  /// How far behind the live edge the emitter runs. One mixer chunk, so the ring's live edge is
  /// complete. Camera jitter is absorbed by the RTP delay line before audio is mixed; a
  /// quarter-second here would play the programme behind the picture.
  public static let mixDelaySeconds = 0.02
  /// Ring depth. Comfortably longer than the delay so a burst cannot wrap onto unread samples.
  private static let windowSeconds = 3.0
  private static let chunkSeconds = 0.02

  public struct Statistics: Sendable, Equatable {
    public var contributors = 0
    public var emittedSeconds: Double = 0
    public var lateBuffers: UInt64 = 0
    public var futureBuffers: UInt64 = 0

    public init() {}
  }

  private let clock: DirectorClock
  private let onMixed: @Sendable (AudioFrame) -> Void

  private let lock = NSLock()
  /// Accumulator in 32-bit so several sources can be summed before clamping once, on the way out.
  private var ring: [Int32]
  private let capacityFrames: Int
  private let chunkFrames: Int
  /// Absolute frame index, counted from the epoch, of the next chunk to emit. Nil until the first
  /// buffer arrives, since there is nothing to anchor to before that.
  private var emitCursor: Int64?
  private var contributors: Set<SourceID> = []
  /// Operator input gain per source, 0...1. Fifty percent is unity; 100 percent is +6 dB.
  private var inputGains: [SourceID: Double] = [:]
  private var statistics = Statistics()
  private var timer: DispatchSourceTimer?
  private let queue = DispatchQueue(label: "co.gamestation.director.audiomix")
  private let formatDescription: CMAudioFormatDescription?

  public init(clock: DirectorClock, onMixed: @escaping @Sendable (AudioFrame) -> Void) {
    self.clock = clock
    self.onMixed = onMixed
    capacityFrames = Int(Self.sampleRate * Self.windowSeconds)
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

  public func start() {
    guard timer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + Self.chunkSeconds, repeating: Self.chunkSeconds)
    timer.setEventHandler { [weak self] in self?.emitReadyChunks() }
    self.timer = timer
    timer.resume()
  }

  public func stop() {
    timer?.cancel()
    timer = nil
    lock.lock()
    emitCursor = nil
    contributors.removeAll()
    for index in ring.indices { ring[index] = 0 }
    lock.unlock()
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

    let start = Int64((frame.wallClock.seconds * Self.sampleRate).rounded())

    lock.lock()
    defer { lock.unlock() }

    contributors.insert(frame.sourceID)
    if emitCursor == nil {
      // Start the timeline at this buffer rather than at "now": the first source to speak defines
      // where the programme's audio begins, and anchoring to the clock instead would emit a
      // quarter-second of silence before it.
      emitCursor = start
    }
    guard let cursor = emitCursor else { return }

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
      let slot = Int((start + Int64(offset)) % Int64(capacityFrames)) * Self.channelCount
      ring[slot] += Int32(samples[offset * Self.channelCount])
      ring[slot + 1] += Int32(samples[offset * Self.channelCount + 1])
    }
  }

  /// Emits every whole chunk that is now far enough behind the live edge to be complete.
  private func emitReadyChunks() {
    let horizon = Int64(((clock.now.seconds - Self.mixDelaySeconds) * Self.sampleRate).rounded())

    while true {
      lock.lock()
      guard let cursor = emitCursor, cursor + Int64(chunkFrames) <= horizon else {
        lock.unlock()
        return
      }

      var interleaved = [Int16](repeating: 0, count: chunkFrames * Self.channelCount)
      for offset in 0 ..< chunkFrames {
        let slot = Int((cursor + Int64(offset)) % Int64(capacityFrames)) * Self.channelCount
        interleaved[offset * Self.channelCount] = Self.clamp(ring[slot])
        interleaved[offset * Self.channelCount + 1] = Self.clamp(ring[slot + 1])
        // Zeroing on the way out is what lets the ring be reused: a slot that kept its old sum
        // would add a copy of itself back into the mix one window later.
        ring[slot] = 0
        ring[slot + 1] = 0
      }
      emitCursor = cursor + Int64(chunkFrames)
      statistics.emittedSeconds += Self.chunkSeconds
      let format = formatDescription
      lock.unlock()

      guard
        let format,
        let buffer = AudioSampleBuilder.makeSampleBuffer(
          samples: interleaved,
          formatDescription: format,
          presentationTime: CMTime(value: cursor, timescale: CMTimeScale(Self.sampleRate))
        )
      else { continue }

      onMixed(AudioFrame(
        sourceID: SourceID("program-mix"),
        sampleBuffer: buffer,
        wallClock: WallClock(seconds: Double(cursor) / Self.sampleRate)
      ))
    }
  }

  private static func clamp(_ value: Int32) -> Int16 {
    Int16(max(Int32(Int16.min), min(Int32(Int16.max), value)))
  }
}
