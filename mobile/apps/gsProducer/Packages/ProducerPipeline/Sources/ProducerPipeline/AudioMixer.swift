import CoreMedia
import Foundation
import ProducerCore
import ProducerSources

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

  /// How far behind the live edge the emitter runs. Covers network jitter and the spread between
  /// cameras: anything arriving later than this is already past and gets dropped.
  private static let mixDelaySeconds = 0.25
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

  private let clock: ProducerClock
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
  private var statistics = Statistics()
  private var timer: DispatchSourceTimer?
  private let queue = DispatchQueue(label: "co.gamestation.producer.audiomix")
  private let formatDescription: CMAudioFormatDescription?

  public init(clock: ProducerClock, onMixed: @escaping @Sendable (AudioFrame) -> Void) {
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
    guard let samples = Self.stereoSamples(from: frame.sampleBuffer) else { return }
    let frameCount = samples.count / Self.channelCount
    guard frameCount > 0 else { return }

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

  /// Reads a source buffer as interleaved 16-bit stereo at the mix rate.
  ///
  /// Mono is duplicated across both channels and anything wider is truncated to the first two, so a
  /// camera's channel count never changes the shape of the bus. Sample rates other than 48 kHz are
  /// resampled by nearest neighbour, which is crude but only ever applies to a source that is
  /// already unusual.
  private static func stereoSamples(from sampleBuffer: CMSampleBuffer) -> [Int16]? {
    guard
      let format = CMSampleBufferGetFormatDescription(sampleBuffer),
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
      asbd.mFormatID == kAudioFormatLinearPCM,
      asbd.mBitsPerChannel == 16,
      let block = CMSampleBufferGetDataBuffer(sampleBuffer)
    else { return nil }

    var length = 0
    var pointer: UnsafeMutablePointer<CChar>?
    guard CMBlockBufferGetDataPointer(
      block,
      atOffset: 0,
      lengthAtOffsetOut: nil,
      totalLengthOut: &length,
      dataPointerOut: &pointer
    ) == kCMBlockBufferNoErr, let pointer else { return nil }

    let sourceChannels = max(1, Int(asbd.mChannelsPerFrame))
    let available = length / (2 * sourceChannels)
    guard available > 0 else { return nil }

    let source = UnsafeRawPointer(pointer).bindMemory(to: Int16.self, capacity: length / 2)
    let ratio = asbd.mSampleRate > 0 ? sampleRate / asbd.mSampleRate : 1
    let outputFrames = ratio == 1 ? available : max(1, Int(Double(available) * ratio))

    var result = [Int16](repeating: 0, count: outputFrames * channelCount)
    for index in 0 ..< outputFrames {
      let sourceFrame = ratio == 1 ? index : min(available - 1, Int(Double(index) / ratio))
      let base = sourceFrame * sourceChannels
      let left = source[base]
      let right = sourceChannels > 1 ? source[base + 1] : left
      result[index * channelCount] = left
      result[index * channelCount + 1] = right
    }
    return result
  }
}
