import CameramanEncode
import Foundation
import ProducerRTSP
import Testing

/// Checked two ways: against the byte values every AAC implementation produces for these formats,
/// and by round-tripping through GS Producer's own parser. The first catches a wrong config, the
/// second catches a config Producer would read differently to how it was written.
@Suite("Audio specific config")
struct AudioSpecificConfigTests {
  @Test("48 kHz stereo AAC-LC is 0x11 0x90")
  func stereo48() throws {
    let config = try #require(AudioSpecificConfigBuilder.aacLC(sampleRate: 48_000, channelCount: 2))
    #expect(Array(config) == [ 0x11, 0x90 ])
    #expect(AudioSpecificConfigBuilder.hex(config) == "1190")
  }

  @Test("48 kHz mono AAC-LC is 0x11 0x88")
  func mono48() throws {
    let config = try #require(AudioSpecificConfigBuilder.aacLC(sampleRate: 48_000, channelCount: 1))
    #expect(Array(config) == [ 0x11, 0x88 ])
  }

  @Test("44.1 kHz stereo AAC-LC is 0x12 0x10")
  func stereo44() throws {
    let config = try #require(AudioSpecificConfigBuilder.aacLC(sampleRate: 44_100, channelCount: 2))
    #expect(Array(config) == [ 0x12, 0x10 ])
  }

  @Test("Producer reads back every rate this app will send", arguments: [
    48_000, 44_100, 32_000, 24_000, 16_000, 8_000
  ])
  func producerRoundTrip(sampleRate: Int) throws {
    for channels in 1 ... 2 {
      let config = try #require(
        AudioSpecificConfigBuilder.aacLC(sampleRate: sampleRate, channelCount: channels)
      )
      let parsed = try #require(AudioSpecificConfig(config))

      #expect(parsed.objectType == AudioSpecificConfigBuilder.aacLCObjectType)
      #expect(parsed.sampleRate == sampleRate)
      #expect(parsed.channelCount == channels)
    }
  }

  @Test("Producer reads the hex spelling the SDP will carry")
  func producerReadsHexForm() throws {
    let config = try #require(AudioSpecificConfigBuilder.aacLC(sampleRate: 48_000, channelCount: 2))
    let hex = AudioSpecificConfigBuilder.hex(config)

    // The whole path Producer takes: `config=` off the fmtp line, hex-decoded, parsed. Driven through
    // the SDP rather than by calling the hex decoder, which is internal to that package — so this
    // also proves the app's spelling survives Producer's parser rather than only its decoder.
    let sdp = """
      v=0
      m=audio 0 RTP/AVP 97
      a=rtpmap:97 mpeg4-generic/48000/2
      a=fmtp:97 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=\(hex)
      """
    let audio = try #require(SDPDescription.parse(sdp).audio)
    let parsed = try #require(audio.audioSpecificConfig.flatMap(AudioSpecificConfig.init))

    #expect(parsed.sampleRate == 48_000)
    #expect(parsed.channelCount == 2)
    // The framing defaults have to survive too, or the depacketizer misreads every AU size.
    #expect(audio.aacFraming?.sizeLength == 13)
    #expect(audio.aacFraming?.indexLength == 3)
  }

  @Test("A rate AAC cannot express is refused rather than misencoded")
  func unsupportedRate() {
    // 47 kHz has no index in Table 1.16. Emitting the nearest one would make the client decode at
    // the wrong speed, which sounds like a slow drift rather than an error.
    #expect(AudioSpecificConfigBuilder.aacLC(sampleRate: 47_000, channelCount: 2) == nil)
  }

  @Test("An impossible channel count is refused")
  func unsupportedChannels() {
    #expect(AudioSpecificConfigBuilder.aacLC(sampleRate: 48_000, channelCount: 0) == nil)
    #expect(AudioSpecificConfigBuilder.aacLC(sampleRate: 48_000, channelCount: 8) == nil)
  }

  @Test("Every advertised rate index round-trips")
  func allIndices() throws {
    for rate in AudioSpecificConfigBuilder.sampleRateIndices {
      let config = try #require(AudioSpecificConfigBuilder.aacLC(sampleRate: rate, channelCount: 2))
      #expect(AudioSpecificConfig(config)?.sampleRate == rate)
    }
  }
}
