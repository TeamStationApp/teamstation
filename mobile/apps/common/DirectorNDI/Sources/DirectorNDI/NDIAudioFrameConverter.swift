import Accelerate
import CNDI
import Foundation
import DirectorSources

/// Turns NDI's planar float audio into the interleaved 16-bit mono the programme bus and the
/// archive encoder both take.
///
/// Three conversions happen here and each has a reason worth stating:
///
/// - **Planar float → interleaved.** NDI audio is always `FLTP`, one plane per channel with its
///   own stride. Nothing downstream reads planes.
/// - **Any channel count → mono.** `AudioSampleBuilder` describes a one-channel track and
///   `AudioMixer` sums cameras into a single bus, so a stereo or 5.1 camera is averaged rather
///   than refused. Taking only the left channel instead would silently drop half of a correctly
///   configured camera's audio.
/// - **Any rate → 48 kHz.** The programme bus is 48 kHz. A camera at 44.1 kHz left unresampled
///   drifts from its own video by about 8 % — a second of skew every twelve seconds — and the
///   muxer stalls on the divergence long before anyone hears it.
///
/// Float is clamped, not scaled: the SDK documents NDI 1.0 as +4 dBu with headroom above it, so
/// values beyond ±1.0 are legal and normal. Clamping is what the SDK's own 16-bit utility does.
public final class NDIAudioFrameConverter: @unchecked Sendable {
  public static let outputSampleRate = AudioSampleBuilder.sampleRate

  private let lock = NSLock()
  private var mixdown: [Float] = []
  /// Carried between frames so a non-integer resampling ratio does not lose or repeat a sample at
  /// every buffer boundary — which at 44.1 kHz would be a click 47 times a second.
  private var resamplePosition: Double = 0

  public init() {}

  /// Nil when the frame could not be read. Validation has already run, so this is a layout the
  /// converter genuinely could not handle rather than a malformed frame.
  public func convert(_ frame: NDIlib_audio_frame_v3_t) -> [Int16]? {
    guard let data = frame.p_data else { return nil }

    let channels = Int(frame.no_channels)
    let samples = Int(frame.no_samples)
    let channelStride = Int(frame.channel_stride_in_bytes)

    lock.lock()
    defer { lock.unlock() }

    if mixdown.count < samples { mixdown = [Float](repeating: 0, count: samples) }

    // Average the channels in place. vDSP over one plane at a time beats a per-sample loop over
    // channels, and at 5.1 the difference is a measurable slice of a 60 fps frame budget.
    mixdown.withUnsafeMutableBufferPointer { destination in
      guard let base = destination.baseAddress else { return }
      vDSP_vclr(base, 1, vDSP_Length(samples))
      for channel in 0 ..< channels {
        let plane = data.advanced(by: channel * channelStride)
          .withMemoryRebound(to: Float.self, capacity: samples) { $0 }
        vDSP_vadd(base, 1, plane, 1, base, 1, vDSP_Length(samples))
      }
      var scale = Float(1) / Float(max(channels, 1))
      vDSP_vsmul(base, 1, &scale, base, 1, vDSP_Length(samples))
    }

    let ratio = Double(frame.sample_rate) / Self.outputSampleRate
    let source = Array(mixdown[0 ..< samples])
    let resampled = ratio == 1 ? source : resample(source, ratio: ratio)

    var output = [Int16](repeating: 0, count: resampled.count)
    for index in 0 ..< resampled.count {
      let clamped = max(-1, min(1, resampled[index]))
      output[index] = Int16(clamped * Float(Int16.max))
    }
    return output
  }

  /// Linear interpolation, with the fractional read position carried across calls.
  ///
  /// Linear is enough here and a windowed-sinc is not: this is a monitoring and archive path for
  /// speech and crowd noise, the material is about to go through a lossy encoder, and the input
  /// rate is 44.1 or 48 kHz rather than something needing decimation.
  private func resample(_ input: [Float], ratio: Double) -> [Float] {
    guard input.count > 1 else {
      resamplePosition = 0
      return input
    }
    var output: [Float] = []
    output.reserveCapacity(Int(Double(input.count) / ratio) + 2)

    var position = resamplePosition
    while position < Double(input.count - 1) {
      let index = Int(position)
      let fraction = Float(position - Double(index))
      output.append(input[index] + (input[index + 1] - input[index]) * fraction)
      position += ratio
    }
    // What is left over is where the next buffer starts reading, expressed against its own
    // beginning.
    resamplePosition = position - Double(input.count)
    if resamplePosition < 0 { resamplePosition = 0 }
    return output
  }

  /// Called when a source stops, so a camera that comes back does not resume mid-sample.
  public func reset() {
    lock.lock()
    resamplePosition = 0
    lock.unlock()
  }
}
