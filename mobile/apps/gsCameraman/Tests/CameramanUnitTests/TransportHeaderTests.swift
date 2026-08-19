import CameramanRTSP
import Testing

struct TransportHeaderTests {
  @Test func parsesTheInterleavedFormClientsSend() throws {
    let header = try #require(TransportHeader.parse("RTP/AVP/TCP;unicast;interleaved=0-1"))

    #expect(header.lower == .tcp)
    #expect(header.interleavedChannels?.data == 0)
    #expect(header.interleavedChannels?.control == 1)
    #expect(!header.isMulticast)
  }

  @Test func aBareChannelImpliesTheNextOneForControl() throws {
    let header = try #require(TransportHeader.parse("RTP/AVP/TCP;unicast;interleaved=4"))

    #expect(header.interleavedChannels?.data == 4)
    #expect(header.interleavedChannels?.control == 5)
  }

  @Test func picksTheFirstOfferItCanHonour() throws {
    // Clients list transports in descending preference. UDP first is the common case, and taking the
    // TCP offer behind it is what makes interleaving work without a round trip.
    let header = try #require(TransportHeader.parse(
      "RTP/AVP;unicast;client_port=8000-8001,RTP/AVP/TCP;unicast;interleaved=0-1"
    ))

    #expect(header.lower == .tcp)
    #expect(header.interleavedChannels?.data == 0)
  }

  @Test func refusesWhatItCannotDeliver() {
    #expect(TransportHeader.parse("RTP/AVP;unicast;client_port=8000-8001") == nil, "UDP")
    #expect(TransportHeader.parse("RTP/AVP/UDP;unicast;client_port=8000-8001") == nil, "explicit UDP")
    #expect(TransportHeader.parse("RTP/AVP/TCP;multicast") == nil, "multicast over TCP is meaningless")
    #expect(TransportHeader.parse("RAW/RAW/UDP") == nil, "not an RTP profile")
    #expect(TransportHeader.parse("") == nil)
  }

  @Test func parsesWithoutChannelsSoADefaultCanBeChosen() throws {
    // A client may leave the channels to the server. That is still a usable offer.
    let header = try #require(TransportHeader.parse("RTP/AVP/TCP;unicast"))

    #expect(header.lower == .tcp)
    #expect(header.interleavedChannels == nil)
  }

  @Test func isCaseAndSpaceTolerant() throws {
    let header = try #require(TransportHeader.parse("rtp/avp/tcp; unicast; INTERLEAVED=2-3"))

    #expect(header.interleavedChannels?.data == 2)
    #expect(header.interleavedChannels?.control == 3)
  }

  @Test func responseValueNamesTheChannelsTheServerWillUse() {
    let header = TransportHeader(lower: .tcp, interleavedChannels: (0, 1))
    #expect(header.responseValue(dataChannel: 6, controlChannel: 7)
      == "RTP/AVP/TCP;unicast;interleaved=6-7")
  }

  @Test func aChannelThatCannotHaveASuccessorIsRefused() {
    // 255 has no next channel, so implying one would wrap to 0 and collide with the video track.
    #expect(TransportHeader.parse("RTP/AVP/TCP;unicast;interleaved=255")?.interleavedChannels == nil)
  }
}
