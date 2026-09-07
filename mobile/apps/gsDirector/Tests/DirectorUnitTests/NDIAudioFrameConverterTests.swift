import CNDI
import XCTest
import DirectorSources
@testable import DirectorNDI

/// NDI audio into the mono 48 kHz the programme bus and the archive encoder both take.
///
/// The rate conversion is the part that matters. A camera at 44.1 kHz left unresampled drifts from
/// its own video by about 8% — a second of skew every twelve seconds — and the muxer stalls on the
/// divergence long before anyone hears it.
final class NDIAudioFrameConverterTests: XCTestCase {
  /// Builds a planar float frame. `value(channel:sample:)` fills it, so a downmix or a swapped
  /// plane is visible in the result rather than merely plausible.
  private func makeFrame(
    rate: Int32 = 48_000,
    channels: Int32 = 1,
    samples: Int32 = 1_024,
    padding: Int32 = 0,
    storage: inout [Float],
    value: (Int, Int) -> Float
  ) -> NDIlib_audio_frame_v3_t {
    let strideSamples = Int(samples + padding)
    storage = [Float](repeating: 0, count: strideSamples * Int(channels))
    for channel in 0 ..< Int(channels) {
      for sample in 0 ..< Int(samples) {
        storage[channel * strideSamples + sample] = value(channel, sample)
      }
    }

    var frame = NDIlib_audio_frame_v3_t()
    frame.sample_rate = rate
    frame.no_channels = channels
    frame.no_samples = samples
    frame.FourCC = NDIlib_FourCC_audio_type_FLTP
    frame.channel_stride_in_bytes = Int32(strideSamples * MemoryLayout<Float>.size)
    frame.p_data = storage.withUnsafeMutableBytes { $0.baseAddress?.assumingMemoryBound(to: UInt8.self) }
    return frame
  }

  func testMonoAtTheOutputRatePassesThroughUnchanged() {
    let converter = NDIAudioFrameConverter()
    var storage: [Float] = []
    var frame = makeFrame(storage: &storage) { _, sample in
      sample == 0 ? 1.0 : 0.0
    }
    let samples = storage.withUnsafeMutableBytes { raw -> [Int16]? in
      frame.p_data = raw.baseAddress?.assumingMemoryBound(to: UInt8.self)
      return converter.convert(frame)
    }
    guard let samples else { return XCTFail("conversion failed") }
    XCTAssertEqual(samples.count, 1_024)
    XCTAssertEqual(samples[0], Int16.max)
    XCTAssertEqual(samples[1], 0)
  }

  /// Channels are averaged, not picked. Taking only the left would silently drop half of a
  /// correctly configured camera's audio.
  func testChannelsAreAveraged() {
    let converter = NDIAudioFrameConverter()
    var storage: [Float] = []
    var frame = makeFrame(channels: 2, storage: &storage) { channel, _ in
      channel == 0 ? 1.0 : 0.0
    }
    let samples = storage.withUnsafeMutableBytes { raw -> [Int16]? in
      frame.p_data = raw.baseAddress?.assumingMemoryBound(to: UInt8.self)
      return converter.convert(frame)
    }
    guard let samples, let first = samples.first else { return XCTFail("conversion failed") }
    XCTAssertEqual(Double(first), Double(Int16.max) * 0.5, accuracy: Double(Int16.max) * 0.02)
  }

  func testSixChannelsAreDownmixed() {
    let converter = NDIAudioFrameConverter()
    var storage: [Float] = []
    var frame = makeFrame(channels: 6, storage: &storage) { _, _ in 0.5 }
    let samples = storage.withUnsafeMutableBytes { raw -> [Int16]? in
      frame.p_data = raw.baseAddress?.assumingMemoryBound(to: UInt8.self)
      return converter.convert(frame)
    }
    guard let samples, let first = samples.first else { return XCTFail("conversion failed") }
    XCTAssertEqual(samples.count, 1_024)
    XCTAssertEqual(Double(first), Double(Int16.max) * 0.5, accuracy: Double(Int16.max) * 0.02)
  }

  /// A channel stride larger than the samples it carries is legal and common; reading it as packed
  /// would mix one channel with the tail of another.
  func testPaddedChannelStrideIsHonoured() {
    let converter = NDIAudioFrameConverter()
    var storage: [Float] = []
    var frame = makeFrame(channels: 2, padding: 128, storage: &storage) { channel, _ in
      channel == 0 ? 1.0 : 1.0
    }
    let samples = storage.withUnsafeMutableBytes { raw -> [Int16]? in
      frame.p_data = raw.baseAddress?.assumingMemoryBound(to: UInt8.self)
      return converter.convert(frame)
    }
    guard let samples, let first = samples.first else { return XCTFail("conversion failed") }
    XCTAssertEqual(first, Int16.max)
  }

  /// 44.1 kHz in, 48 kHz out: about 9% more samples than went in.
  func testResamplesToTheProgrammeRate() {
    let converter = NDIAudioFrameConverter()
    var storage: [Float] = []
    var frame = makeFrame(rate: 44_100, samples: 4_410, storage: &storage) { _, _ in 0.25 }
    let samples = storage.withUnsafeMutableBytes { raw -> [Int16]? in
      frame.p_data = raw.baseAddress?.assumingMemoryBound(to: UInt8.self)
      return converter.convert(frame)
    }
    guard let samples else { return XCTFail("conversion failed") }
    XCTAssertEqual(Double(samples.count), 4_800, accuracy: 20)
  }

  /// Levels beyond ±1.0 are legal in NDI — the SDK documents 1.0 as +4 dBu with headroom above —
  /// so they clamp rather than wrapping into the opposite sign.
  func testHotSignalClampsRatherThanWrapping() {
    let converter = NDIAudioFrameConverter()
    var storage: [Float] = []
    var frame = makeFrame(storage: &storage) { _, sample in sample % 2 == 0 ? 4.0 : -4.0 }
    let samples = storage.withUnsafeMutableBytes { raw -> [Int16]? in
      frame.p_data = raw.baseAddress?.assumingMemoryBound(to: UInt8.self)
      return converter.convert(frame)
    }
    guard let samples else { return XCTFail("conversion failed") }
    XCTAssertEqual(samples[0], Int16.max)
    XCTAssertEqual(samples[1], -Int16.max)
  }

  /// The resampler carries its fractional read position between buffers, so a non-integer ratio
  /// does not lose or repeat a sample at every boundary — which at 44.1 kHz would be a click 47
  /// times a second.
  func testConsecutiveBuffersDoNotClickAtTheSeam() {
    let converter = NDIAudioFrameConverter()
    var total = 0
    for _ in 0 ..< 10 {
      var storage: [Float] = []
      var frame = makeFrame(rate: 44_100, samples: 1_024, storage: &storage) { _, _ in 0.1 }
      let samples = storage.withUnsafeMutableBytes { raw -> [Int16]? in
        frame.p_data = raw.baseAddress?.assumingMemoryBound(to: UInt8.self)
        return converter.convert(frame)
      }
      guard let samples else { return XCTFail("conversion failed") }
      total += samples.count
    }
    // Ten buffers of 1024 at 44.1 kHz is 10240/44100 s, which at 48 kHz is about 11 147 samples.
    XCTAssertEqual(Double(total), 11_147, accuracy: 40)
  }
}
