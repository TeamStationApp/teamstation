import CNDI
import XCTest
@testable import DirectorNDI

/// The filter, exercised on hand-built frame headers.
///
/// No network and no SDK instance: `NDIFrameValidator` is a pure function over the header
/// precisely so that "what does this app refuse, and why" can be asserted without a camera. Every
/// case checks *which* rule fired, not merely that something did — a frame refused for the wrong
/// reason still looks like a pass, and hides the rule that should have caught it.
final class NDIFrameValidatorTests: XCTestCase {
  /// A frame this app is happy with: 1080p30 UYVY, progressive, packed.
  private func makeVideo(
    width: Int32 = 1920,
    height: Int32 = 1080,
    fourCC: NDIlib_FourCC_video_type_e = NDIlib_FourCC_video_type_UYVY,
    stride: Int32? = nil,
    rateN: Int32 = 30_000,
    rateD: Int32 = 1_000,
    format: NDIlib_frame_format_type_e = NDIlib_frame_format_type_progressive,
    hasData: Bool = true
  ) -> NDIlib_video_frame_v2_t {
    var frame = NDIlib_video_frame_v2_t()
    frame.xres = width
    frame.yres = height
    frame.FourCC = fourCC
    frame.frame_rate_N = rateN
    frame.frame_rate_D = rateD
    frame.frame_format_type = format
    frame.line_stride_in_bytes = stride ?? Int32(
      NDIFrameValidator.minimumStride(for: fourCC, width: Int(width))
    )
    frame.p_data = hasData ? Self.scratch : nil
    return frame
  }

  /// One allocation, large enough for any frame these tests describe. Never read — the validator
  /// only ever looks at the header — but it must be non-nil to get past the compressed-frame rule.
  private nonisolated(unsafe) static let scratch =
    UnsafeMutablePointer<UInt8>.allocate(capacity: 1920 * 1080 * 4)

  // MARK: - Accepted

  func testAcceptsOrdinaryFrame() {
    XCTAssertNil(NDIFrameValidator.accept(makeVideo()))
  }

  func testAcceptsEveryLayoutTheConverterHandles() {
    let layouts: [NDIlib_FourCC_video_type_e] = [
      NDIlib_FourCC_video_type_UYVY,
      NDIlib_FourCC_video_type_UYVA,
      NDIlib_FourCC_video_type_NV12,
      NDIlib_FourCC_video_type_I420,
      NDIlib_FourCC_video_type_YV12,
      NDIlib_FourCC_video_type_BGRA,
      NDIlib_FourCC_video_type_BGRX,
      NDIlib_FourCC_video_type_RGBA,
      NDIlib_FourCC_video_type_RGBX
    ]
    for layout in layouts {
      XCTAssertNil(
        NDIFrameValidator.accept(makeVideo(fourCC: layout)),
        "refused a layout the converter handles"
      )
      XCTAssertNotNil(
        NDIVideoFrameConverter.pixelFormat(for: layout),
        "accepted a layout the converter cannot copy, which would show a black tile"
      )
    }
  }

  /// A stride larger than the row is normal — senders pad — and refusing it would reject most
  /// real cameras.
  func testAcceptsPaddedStride() {
    XCTAssertNil(NDIFrameValidator.accept(makeVideo(stride: 1920 * 2 + 64)))
  }

  func testAccepts720pAnd60fps() {
    XCTAssertNil(NDIFrameValidator.accept(makeVideo(width: 1280, height: 720)))
    XCTAssertNil(NDIFrameValidator.accept(makeVideo(rateN: 60_000, rateD: 1_000)))
    // 59.94, which is what a camera on an NTSC timebase actually sends.
    XCTAssertNil(NDIFrameValidator.accept(makeVideo(rateN: 60_000, rateD: 1_001)))
  }

  // MARK: - Refused

  func testRefusesEmptyDimensions() {
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(width: 0)), .emptyDimensions)
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(height: 0)), .emptyDimensions)
  }

  /// 4:2:2 pairs pixels, so an odd width puts every chroma calculation a column out.
  func testRefusesOddWidth() {
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(width: 1921)), .oddWidth)
  }

  /// The requirement is 1080p and below. A 4K frame accepted here becomes a thermal problem in the
  /// middle of a game instead of a refusal in the source list.
  func testRefuses4K() {
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(width: 3840, height: 2160)), .tooLarge)
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(width: 1920, height: 1200)), .tooLarge)
  }

  /// Dimensions but no pixels is an Advanced-SDK sender's compressed frame. Saying so beats a
  /// black tile.
  func testRefusesCompressedFrame() {
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(hasData: false)), .nullData)
  }

  func testRefusesUnhandledLayout() {
    XCTAssertEqual(
      NDIFrameValidator.accept(makeVideo(fourCC: NDIlib_FourCC_video_type_P216)),
      .unsupportedFourCC
    )
    XCTAssertEqual(
      NDIFrameValidator.accept(makeVideo(fourCC: NDIlib_FourCC_video_type_PA16)),
      .unsupportedFourCC
    )
  }

  /// A stride shorter than the row makes a copy walk off the end of every line. It has to be
  /// caught on the header, before anything reads the buffer.
  func testRefusesShortStride() {
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(stride: 1920)), .shortStride)
    XCTAssertEqual(
      NDIFrameValidator.accept(makeVideo(fourCC: NDIlib_FourCC_video_type_BGRA, stride: 1920 * 2)),
      .shortStride
    )
  }

  func testRefusesImpossibleFrameRate() {
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(rateD: 0)), .invalidFrameRate)
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(rateN: 0)), .invalidFrameRate)
    XCTAssertEqual(NDIFrameValidator.accept(makeVideo(rateN: 1_000_000)), .invalidFrameRate)
  }

  /// The receiver asks the SDK to de-interlace. A sender ignoring that sends half a picture, which
  /// is worse in a progressive archive than no picture.
  func testRefusesFields() {
    XCTAssertEqual(
      NDIFrameValidator.accept(makeVideo(format: NDIlib_frame_format_type_field_0)),
      .fielded
    )
    XCTAssertEqual(
      NDIFrameValidator.accept(makeVideo(format: NDIlib_frame_format_type_interleaved)),
      .fielded
    )
  }

  // MARK: - Audio

  private func makeAudio(
    rate: Int32 = 48_000,
    channels: Int32 = 1,
    samples: Int32 = 1_024,
    stride: Int32? = nil,
    fourCC: NDIlib_FourCC_audio_type_e = NDIlib_FourCC_audio_type_FLTP,
    hasData: Bool = true
  ) -> NDIlib_audio_frame_v3_t {
    var frame = NDIlib_audio_frame_v3_t()
    frame.sample_rate = rate
    frame.no_channels = channels
    frame.no_samples = samples
    frame.FourCC = fourCC
    frame.channel_stride_in_bytes = stride ?? samples * 4
    frame.p_data = hasData ? Self.scratch : nil
    return frame
  }

  func testAcceptsOrdinaryAudio() {
    XCTAssertNil(NDIFrameValidator.accept(makeAudio()))
    XCTAssertNil(NDIFrameValidator.accept(makeAudio(rate: 44_100)))
    XCTAssertNil(NDIFrameValidator.accept(makeAudio(channels: 6)))
  }

  func testRefusesBrokenAudio() {
    XCTAssertEqual(NDIFrameValidator.accept(makeAudio(rate: 0)), .invalidSampleRate)
    XCTAssertEqual(NDIFrameValidator.accept(makeAudio(channels: 0)), .invalidChannelCount)
    XCTAssertEqual(NDIFrameValidator.accept(makeAudio(samples: 0)), .emptyBuffer)
    XCTAssertEqual(NDIFrameValidator.accept(makeAudio(hasData: false)), .nullData)
    XCTAssertEqual(NDIFrameValidator.accept(makeAudio(stride: 1_024)), .shortChannelStride)
  }

  // MARK: - Metadata

  /// The SDK documentation tells receivers to expect badly formed XML from real senders, so this
  /// must never throw and must never cost a frame.
  func testMetadataTolerance() {
    XCTAssertTrue(NDIFrameValidator.isWellFormedXML("<ndi_product long_name=\"Camera\" />"))
    XCTAssertFalse(NDIFrameValidator.isWellFormedXML("<ndi_product long_name=\"Broken & Unclosed"))
    XCTAssertFalse(NDIFrameValidator.isWellFormedXML(""))
  }

  // MARK: - Counters

  /// `/dump-state` has to say which rule fired. A count with no reason cannot tell a 4K camera
  /// from a corrupt one.
  func testCountersNameTheRule() {
    var counters = NDIRejectionCounters()
    counters.record(NDIFrameValidator.VideoRejection.tooLarge)
    counters.record(NDIFrameValidator.VideoRejection.tooLarge)
    counters.record(NDIFrameValidator.VideoRejection.shortStride)
    counters.record(NDIFrameValidator.AudioRejection.emptyBuffer)

    XCTAssertEqual(counters.totalVideo, 3)
    XCTAssertEqual(counters.totalAudio, 1)
    XCTAssertEqual(counters.summary, "emptyBuffer=1 shortStride=1 tooLarge=2")
  }

  /// Every rejection carries an explanation an operator can act on, because each one is a camera
  /// that will otherwise never appear with nothing said about why.
  func testEveryRejectionExplainsItself() {
    let video: [NDIFrameValidator.VideoRejection] = [
      .emptyDimensions, .oddWidth, .tooLarge, .nullData,
      .unsupportedFourCC, .shortStride, .invalidFrameRate, .fielded
    ]
    for rejection in video {
      XCTAssertFalse(rejection.reason.isEmpty, "\(rejection) has no explanation")
    }
    let audio: [NDIFrameValidator.AudioRejection] = [
      .invalidSampleRate, .invalidChannelCount, .emptyBuffer,
      .nullData, .unsupportedFourCC, .shortChannelStride
    ]
    for rejection in audio {
      XCTAssertFalse(rejection.reason.isEmpty, "\(rejection) has no explanation")
    }
  }
}
