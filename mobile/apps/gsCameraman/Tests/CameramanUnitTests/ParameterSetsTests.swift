import CameramanCore
import CameramanEncode
import CoreMedia
import Foundation
import ProducerRTSP
import Testing

/// Parameter-set handling is checked against a real `CMFormatDescription`, built the same way
/// GS Producer builds its decoder, so the two sides are provably using the same bytes in the same
/// order.
@Suite("Parameter sets")
struct ParameterSetsTests {
  /// Captured from VideoToolbox encoding 1080p H.264 High profile on an iPhone 13 Pro.
  private let sps = Data([
    0x27, 0x64, 0x00, 0x28, 0xAC, 0xD9, 0x40, 0x78,
    0x02, 0x27, 0xE5, 0x84, 0x00, 0x00, 0x03, 0x00,
    0x04, 0x00, 0x00, 0x03, 0x00, 0xCA, 0x40
  ])
  private let pps = Data([ 0x28, 0xEE, 0x3C, 0xB0 ])

  private func h264FormatDescription() throws -> CMFormatDescription {
    var description: CMFormatDescription?
    let status = sps.withUnsafeBytes { spsBytes in
      pps.withUnsafeBytes { ppsBytes in
        let pointers = [
          spsBytes.baseAddress!.assumingMemoryBound(to: UInt8.self),
          ppsBytes.baseAddress!.assumingMemoryBound(to: UInt8.self)
        ]
        let sizes = [ sps.count, pps.count ]
        return pointers.withUnsafeBufferPointer { pointerBuffer in
          sizes.withUnsafeBufferPointer { sizeBuffer in
            CMVideoFormatDescriptionCreateFromH264ParameterSets(
              allocator: kCFAllocatorDefault,
              parameterSetCount: 2,
              parameterSetPointers: pointerBuffer.baseAddress!,
              parameterSetSizes: sizeBuffer.baseAddress!,
              nalUnitHeaderLength: 4,
              formatDescriptionOut: &description
            )
          }
        }
      }
    }
    #expect(status == noErr)
    return try #require(description)
  }

  @Test("SPS comes out before PPS, which is the order sprop-parameter-sets requires")
  func h264Order() throws {
    let sets = ParameterSets.h264(from: try h264FormatDescription())

    #expect(sets.count == 2)
    #expect(sets.first == sps)
    #expect(sets.last == pps)
  }

  @Test("Producer reads back what this app puts in the SDP")
  func producerReadsParameterSets() throws {
    let sets = ParameterSets.h264(from: try h264FormatDescription())
    let sprop = sets.map { $0.base64EncodedString() }.joined(separator: ",")

    // Exactly the fmtp line the SDP builder will emit, parsed by Producer's own SDP reader.
    let sdp = """
      v=0
      m=video 0 RTP/AVP 96
      a=rtpmap:96 H264/90000
      a=fmtp:96 packetization-mode=1; sprop-parameter-sets=\(sprop)
      """
    let parsed = SDPDescription.parse(sdp)

    #expect(parsed.video?.videoCodec == .h264)
    #expect(parsed.video?.parameterSets == [ sps, pps ])
  }

  @Test("A format description with no parameter sets yields none rather than crashing")
  func emptyDescription() throws {
    // An audio format description has no H.264 parameter sets, which is the shape of the mistake
    // this guards against.
    var description: CMFormatDescription?
    var asbd = AudioStreamBasicDescription(
      mSampleRate: 48_000,
      mFormatID: kAudioFormatMPEG4AAC,
      mFormatFlags: 0,
      mBytesPerPacket: 0,
      mFramesPerPacket: 1024,
      mBytesPerFrame: 0,
      mChannelsPerFrame: 2,
      mBitsPerChannel: 0,
      mReserved: 0
    )
    CMAudioFormatDescriptionCreate(
      allocator: kCFAllocatorDefault,
      asbd: &asbd,
      layoutSize: 0,
      layout: nil,
      magicCookieSize: 0,
      magicCookie: nil,
      extensions: nil,
      formatDescriptionOut: &description
    )

    #expect(ParameterSets.h264(from: try #require(description)).isEmpty)
    #expect(ParameterSets.hevc(from: try #require(description)).isEmpty)
  }

  @Test("profile-level-id is the three SPS bytes after the NAL header")
  func profileLevelID() {
    // 0x64 High profile, 0x00 constraints, 0x28 level 4.0.
    #expect(ParameterSets.h264ProfileLevelID(sps: sps) == "640028")
  }

  @Test("A truncated SPS produces no profile-level-id rather than a wrong one")
  func truncatedSPS() {
    #expect(ParameterSets.h264ProfileLevelID(sps: Data([ 0x27, 0x64 ])) == nil)
  }
}
