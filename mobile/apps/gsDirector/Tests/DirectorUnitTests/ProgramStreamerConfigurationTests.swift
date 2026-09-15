import CoreVideo
import DirectorCore
import DirectorRTMP
import DirectorSources
import Foundation
import Testing
@testable import DirectorPipeline

@Suite("Program streamer configuration")
struct ProgramStreamerConfigurationTests {
  @Test("The stream takes the stream group of Settings, not the programme's")
  func configuresFromTheStreamGroup() {
    var config = AppConfig.default
    config.programResolution = .hd1080
    config.programFrameRate = 30
    config.programBitrate = 12_000_000
    config.programCodec = .h264
    config.streamResolution = .hd720
    config.streamFrameRate = 60
    config.streamCodec = .hevc
    config.streamBitrateLow = 1_500_000
    config.streamBitrateHigh = 4_500_000
    config.gopSeconds = 1

    let streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter())
    let configured = streamer.configurationForTesting(config)
    #expect(configured == .init(
      width: 1280,
      height: 720,
      codec: .hevc,
      frameRate: 60,
      // It starts at the top of its range.
      bitrate: 4_500_000,
      bitrateLow: 1_500_000,
      bitrateHigh: 4_500_000,
      gopSeconds: 1
    ))
  }

  @Test("H.264 in Settings is H.264 on the wire")
  func h264() {
    var config = AppConfig.default
    config.streamCodec = .h264
    let streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter())
    #expect(streamer.configurationForTesting(config).codec == .h264)
  }

  @Test("The send buffer holds eight seconds of the high bitrate, with room for its spikes")
  func budgetFromHigh() {
    #expect(RTMPClient.sendBufferSeconds == 8)
    // 6 Mbps is 750 000 bytes a second: eight seconds of it at half again the rate.
    #expect(RTMPClient.sendBudget(forBitrate: 6_000_000) == 9_000_000)
    #expect(RTMPClient.sendBudget(forBitrate: 10_000_000) == 15_000_000)
    #expect(RTMPClient.sendBudget(forBitrate: 100_000) == 512 * 1024)
  }

  @Test("A second may reach half again the rate, and the next pays it back")
  func spikeLimits() {
    // 6 Mbps is 750 000 bytes a second: up to 1 125 000 in any one second, 1 875 000 in any two.
    #expect(ProgramStreamer.dataRateLimits(forBitrate: 6_000_000) == [ 1_125_000, 1, 1_875_000, 2 ])
  }

  @Test("H.265 keyframes are any IRAP picture; H.264's are type 5")
  func hevcKeyframes() {
    // NAL header byte 0 carries the type in bits 1-6: IDR_W_RADL (19) is 0x26, CRA (21) is 0x2A,
    // TRAIL_R (1) is 0x02.
    #expect(ProgramStreamer.payloadContainsIDR(Data([ 0, 0, 0, 2, 0x26, 0x01 ]), codec: .hevc))
    #expect(ProgramStreamer.payloadContainsIDR(Data([ 0, 0, 0, 2, 0x2A, 0x01 ]), codec: .hevc))
    #expect(!ProgramStreamer.payloadContainsIDR(Data([ 0, 0, 0, 2, 0x02, 0x01 ]), codec: .hevc))
    // A prefix SEI (39, 0x4E) ahead of the IDR slice.
    #expect(ProgramStreamer.payloadContainsIDR(Data([ 0, 0, 0, 2, 0x4E, 0x01, 0, 0, 0, 2, 0x26, 0x01 ]), codec: .hevc))
    // 0x26 read as H.264 is type 6, an SEI, not an IDR.
    #expect(!ProgramStreamer.payloadContainsIDR(Data([ 0, 0, 0, 1, 0x26 ]), codec: .h264))
  }

  @Test("A composite of another shape is letterboxed into the stream's size, bars black")
  func letterboxes() throws {
    let factory = try #require(PixelBufferFactory(width: 1000, height: 1000, pixelFormat: kCVPixelFormatType_32BGRA))
    let square = try #require(factory.makeBuffer())
    CVPixelBufferLockBaseAddress(square, [])
    memset(CVPixelBufferGetBaseAddress(square), 0xFF, CVPixelBufferGetDataSize(square))
    CVPixelBufferUnlockBaseAddress(square, [])

    let converted = try #require(ProgramStreamer.streamPicture(square, width: 1280, height: 720, converter: PixelConverter()))
    #expect(CVPixelBufferGetWidth(converted) == 1280)
    #expect(CVPixelBufferGetHeight(converted) == 720)
    #expect(CVPixelBufferGetPixelFormatType(converted) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    CVPixelBufferLockBaseAddress(converted, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(converted, .readOnly) }
    let luma = try #require(CVPixelBufferGetBaseAddressOfPlane(converted, 0)).assumingMemoryBound(to: UInt8.self)
    let row = CVPixelBufferGetBytesPerRowOfPlane(converted, 0)
    // White square in the middle, video-range black in the side bars.
    #expect(luma[360 * row + 640] > 200)
    #expect(luma[360 * row + 10] == 16)
    #expect(luma[360 * row + 1270] == 16)
  }

  @Test("A picture already at the stream's size and format is passed straight through")
  func passesThrough() throws {
    let factory = try #require(
      PixelBufferFactory(width: 1280, height: 720, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    )
    let buffer = try #require(factory.makeBuffer())
    let result = ProgramStreamer.streamPicture(buffer, width: 1280, height: 720, converter: PixelConverter())
    #expect(result === buffer)
  }
}
