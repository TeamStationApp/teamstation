import CoreMedia
import Foundation

/// Shared PCM unpacking for the programme mix and the per-camera oscilloscope.
public enum AudioPCM: Sendable {
  /// Reads a source buffer as interleaved 16-bit stereo at `sampleRate`.
  ///
  /// Mono is duplicated across both channels and anything wider is truncated to the first two, so a
  /// camera's channel count never changes the shape of the bus. Sample rates other than the mix
  /// rate are resampled by nearest neighbour, which is crude but only ever applies to a source that
  /// is already unusual.
  public static func stereoSamples(
    from sampleBuffer: CMSampleBuffer,
    sampleRate: Double,
    channelCount: Int
  ) -> [Int16]? {
    withInt16(sampleBuffer) { source, sourceChannels, available, nativeRate in
      let ratio = nativeRate > 0 ? sampleRate / nativeRate : 1
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

  /// Downsamples the left channel to `count` points in -1...1, without resampling the rate.
  ///
  /// The meter wants the camera's own waveform, not the mix-rate conversion. Gain is applied in
  /// the view so dragging the slider scales the last sweep immediately.
  public static func waveformPoints(from sampleBuffer: CMSampleBuffer, count: Int) -> [Float]? {
    guard count > 0 else { return nil }
    return withInt16(sampleBuffer) { source, sourceChannels, frames, _ in
      guard frames > 0 else { return nil }
      var points = [Float](repeating: 0, count: count)
      for index in 0 ..< count {
        let sourceFrame = min(frames - 1, index * frames / count)
        points[index] = Float(source[sourceFrame * sourceChannels]) / Float(Int16.max)
      }
      return points
    }
  }

  /// Applies `multiplier` in place and saturates, which is what the mix bus hears as clipping.
  public static func scale(_ samples: inout [Int16], multiplier: Double) {
    guard multiplier != 1 else { return }
    let maxValue = Double(Int16.max)
    let minValue = Double(Int16.min)
    for index in samples.indices {
      let scaled = Double(samples[index]) * multiplier
      if scaled > maxValue {
        samples[index] = Int16.max
      } else if scaled < minValue {
        samples[index] = Int16.min
      } else {
        samples[index] = Int16(scaled.rounded())
      }
    }
  }

  private static func withInt16<T>(
    _ sampleBuffer: CMSampleBuffer,
    _ body: (UnsafePointer<Int16>, Int, Int, Double) -> T?
  ) -> T? {
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

    let channels = max(1, Int(asbd.mChannelsPerFrame))
    let frames = length / (2 * channels)
    guard frames > 0 else { return nil }
    let source = UnsafeRawPointer(pointer).bindMemory(to: Int16.self, capacity: length / 2)
    return body(source, channels, frames, asbd.mSampleRate)
  }
}
