import CoreMedia
import Foundation
import DirectorSources
import Testing

@Suite("AAC magic cookie")
struct AACMagicCookieTests {
  /// SDP `config=1290` from the VM33s: AAC-LC 32 kHz stereo. Written raw into `esds` this is
  /// the two bytes ffmpeg reports as an overread and AVPlayer as CoreMedia -12848.
  private let vm33Config = Data([0x12, 0x90])

  @Test("The SDP AudioSpecificConfig is wrapped in an ES_Descriptor before muxing")
  func wrapsAudioSpecificConfig() {
    let descriptor = CompressedSample.mpeg4ESDescriptor(audioSpecificConfig: vm33Config)
    #expect(descriptor.first == 0x03)
    #expect(descriptor.contains(vm33Config))
    #expect(descriptor != vm33Config)
    // DecoderSpecificInfo tag, length, then the two-byte config.
    #expect(descriptor.firstRange(of: Data([0x05, 0x02, 0x12, 0x90])) != nil)
  }

  @Test("An already-wrapped cookie is not wrapped again")
  func doesNotDoubleWrap() {
    let wrapped = CompressedSample.mpeg4ESDescriptor(audioSpecificConfig: vm33Config)
    #expect(CompressedSample.mpeg4ESDescriptor(audioSpecificConfig: wrapped) == wrapped)
  }

  @Test("The format description cookie is an ES_Descriptor, not the two SDP bytes")
  func formatDescriptionCookieIsESDS() throws {
    let description = try #require(
      CompressedSample.aacFormatDescription(
        magicCookie: vm33Config,
        sampleRate: 32_000,
        channelCount: 2
      )
    )
    var size = 0
    let pointer = CMAudioFormatDescriptionGetMagicCookie(description, sizeOut: &size)
    let cookie = Data(bytes: try #require(pointer), count: size)
    #expect(cookie.first == 0x03)
    #expect(cookie.contains(vm33Config))
  }
}
