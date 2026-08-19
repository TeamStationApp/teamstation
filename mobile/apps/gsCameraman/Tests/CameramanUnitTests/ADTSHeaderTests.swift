import CameramanEncode
import Foundation
import Testing

struct ADTSHeaderTests {
  @Test func describesAACLCAt48kStereo() throws {
    let header = try #require(ADTSHeader.make(
      payloadCount: 300,
      sampleRate: 48_000,
      channelCount: 2
    ))

    #expect(header.count == 7)
    // Syncword, MPEG-4, layer 0, protection absent.
    #expect(header[0] == 0xFF)
    #expect(header[1] == 0xF1)

    let profile = (header[2] >> 6) & 0x03
    #expect(profile == 1, "AAC-LC is object type 2, written as 1")

    let frequencyIndex = Int((header[2] >> 2) & 0x0F)
    #expect(AudioSpecificConfigBuilder.sampleRateIndices[frequencyIndex] == 48_000)

    let highChannelBit = Int(header[2] & 0x01) << 2
    let lowChannelBits = Int(header[3] >> 6)
    #expect(highChannelBit | lowChannelBits == 2)
  }

  @Test func lengthFieldCoversHeaderAndPayload() throws {
    let header = try #require(ADTSHeader.make(
      payloadCount: 300,
      sampleRate: 44_100,
      channelCount: 1
    ))

    #expect(frameLength(of: header) == 307)
  }

  @Test func lengthFieldSurvivesItsBoundaries() throws {
    // The field is split across three bytes, so an off-by-one in the shifts only shows up at values
    // that straddle a byte edge.
    for payloadCount in [ 1, 7, 8, 255, 256, 2_040, 2_048, 8_184 ] {
      let header = try #require(ADTSHeader.make(
        payloadCount: payloadCount,
        sampleRate: 48_000,
        channelCount: 2
      ))
      #expect(frameLength(of: header) == payloadCount + 7, "payload \(payloadCount)")
    }
  }

  /// The 13-bit field is split across bytes 3, 4 and 5.
  private func frameLength(of header: Data) -> Int {
    let high = Int(header[3] & 0x03) << 11
    let middle = Int(header[4]) << 3
    let low = Int(header[5] >> 5)
    return high | middle | low
  }

  @Test func wrapPrefixesThePayloadWithoutAlteringIt() throws {
    let accessUnit = Data([ 0x21, 0x1A, 0xBC, 0xDE ])
    let frame = try #require(ADTSHeader.wrap(accessUnit, sampleRate: 48_000, channelCount: 1))

    #expect(frame.count == accessUnit.count + 7)
    #expect(frame.suffix(accessUnit.count) == accessUnit)
  }

  @Test func rejectsWhatADTSCannotExpress() {
    #expect(ADTSHeader.make(payloadCount: 100, sampleRate: 47_000, channelCount: 2) == nil)
    #expect(ADTSHeader.make(payloadCount: 100, sampleRate: 48_000, channelCount: 0) == nil)
    #expect(ADTSHeader.make(payloadCount: 100, sampleRate: 48_000, channelCount: 8) == nil)
    #expect(ADTSHeader.make(payloadCount: 0, sampleRate: 48_000, channelCount: 2) == nil)
    // A frame that does not fit the 13-bit length field would otherwise wrap around silently.
    #expect(ADTSHeader.make(payloadCount: 8_192, sampleRate: 48_000, channelCount: 2) == nil)
  }
}
