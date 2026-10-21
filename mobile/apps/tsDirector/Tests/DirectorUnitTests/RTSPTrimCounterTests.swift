import CoreMedia
import CoreVideo
import DirectorCore
@testable import DirectorRTSP
import DirectorSources
import Foundation
import Testing

/// A delay line that is full trims from the front, and those pictures were received and never
/// shown. Uncounted, a tile that fell behind read "received 19 fps" with every loss counter at zero.
@Suite("RTSP delay-line trims")
struct RTSPTrimCounterTests {
  private func makeSource() -> RTSPFrameSource {
    let source = RTSPFrameSource(
      sourceID: SourceID("camera"),
      displayName: "camera",
      configuration: RTSPSession.Configuration(host: "127.0.0.1", port: 9)
    )
    source.setAnnouncedFrameRate(60)
    return source
  }

  /// One whole HEVC picture: a single NAL in one packet, marker set, 1/60 s after the last.
  private func picture(_ index: Int) throws -> RTPPacket {
    let sequence = UInt16(index + 1)
    let timestamp = UInt32(3_000 + index * 1_500)
    var bytes: [UInt8] = [ 0x80, 0xE0, UInt8(sequence >> 8), UInt8(sequence & 0xFF) ]
    bytes += [ UInt8(timestamp >> 24), UInt8((timestamp >> 16) & 0xFF), UInt8((timestamp >> 8) & 0xFF), UInt8(timestamp & 0xFF) ]
    bytes += [ 0, 0, 0, 7 ]
    bytes += [ 0x02, 0x01 ] + [UInt8](repeating: 0xAB, count: 32)
    return try #require(RTPPacket.parse(Data(bytes)))
  }

  @Test("Coded pictures past the delay line's capacity are counted as trimmed")
  func countsCodedTrims() throws {
    let source = makeSource()
    source.handle(.playing(description: SourceSoundTimelineTests.sdp(cname: "phone"), channels: .init(video: 0, audio: 2)))
    // Nothing drains: `start` was never called, so every picture stays in the line.
    let ceiling = PlayoutController.Limits().maximumMilliseconds
    let capacity = Int((60 * (ceiling / 1_000 + 0.25)).rounded(.up))
    let extra = 7
    for index in 0 ..< capacity + extra {
      source.handle(.packet(channel: 0, packet: try picture(index)))
    }
    #expect(source.receiveStats.captured == UInt64(capacity + extra))
    #expect(source.receiveStats.codedPicturesTrimmed == UInt64(extra))
    #expect(source.receiveStats.decodedPicturesTrimmed == 0)
  }

  @Test("Decoded pictures past the eight the line holds are counted as trimmed")
  func countsDecodedTrims() throws {
    let source = makeSource()
    let factory = try #require(PixelBufferFactory(width: 64, height: 64, pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))
    for index in 0 ..< 8 {
      source.publish(pixelBuffer: try #require(factory.makeBuffer()), presentationTime: CMTime(value: CMTimeValue(index), timescale: 60))
    }
    #expect(source.receiveStats.decodedPicturesTrimmed == 0, "eight fit")
    for index in 8 ..< 12 {
      source.publish(pixelBuffer: try #require(factory.makeBuffer()), presentationTime: CMTime(value: CMTimeValue(index), timescale: 60))
    }
    #expect(source.receiveStats.decodedPicturesTrimmed == 4)
    #expect(source.receiveStats.codedPicturesTrimmed == 0)
  }
}
