import Foundation
import Testing

@testable import CameramanCore
@testable import CameramanRTSP

import ProducerRTSP

/// What Cameraman writes has to be what Producer reads. Both sides are ours, so agreement between
/// them proves only self-consistency — the byte-level assertions against RFC 3550 live in
/// `RTCPWriterTests`, and these tests check the two implementations meet.
struct RTCPInteropTests {
  private let identity = DeviceIdentity(uuid: "3f2504e04f8911d39a0c", name: "Third Base")

  private func writer(ssrc: UInt32 = 0x1234_5678) -> RTCPWriter {
    RTCPWriter(ssrc: ssrc, identity: identity)
  }

  @Test func producerReadsTheIdentityOutOfACompoundPacket() throws {
    let packet = writer().compoundPacket(
      ntpTime: RTCPWriter.ntpTime(from: Date(timeIntervalSince1970: 1_700_000_000)),
      rtpTimestamp: 90_000,
      packetCount: 300,
      octetCount: 400_000
    )

    let report = try #require(RTCPReport.parse(packet))
    #expect(report.cname == identity.cname)
    #expect(report.name == "Third Base")
  }

  @Test func theSenderReportSurvivesWithItsClocksIntact() throws {
    let sent = Date(timeIntervalSince1970: 1_700_000_000.5)
    let packet = writer().compoundPacket(
      ntpTime: RTCPWriter.ntpTime(from: sent),
      rtpTimestamp: 4_500_000,
      packetCount: 1_500,
      octetCount: 2_000_000
    )

    let report = try #require(RTCPReport.parse(packet))
    let sr = try #require(report.senderReports.first)
    #expect(sr.ssrc == 0x1234_5678)
    #expect(sr.rtpTimestamp == 4_500_000)
    #expect(sr.packetCount == 1_500)
    #expect(sr.octetCount == 2_000_000)
    // The NTP fraction is 32 bits, so a round trip is exact to far better than a millisecond.
    #expect(abs(sr.ntpDate.timeIntervalSince(sent)) < 0.001)
  }

  @Test func theCNAMEBindsTheStreamToTheSSRCTheSDPNamed() throws {
    let ssrc: UInt32 = 0xDEAD_BEEF
    let sdp = SDPBuilder(
      identity: identity,
      video: .init(codec: .h264, parameterSets: [ Self.sps, Self.pps ], width: 1920, height: 1080),
      audio: nil,
      videoSSRC: ssrc,
      audioSSRC: 0
    ).build()

    let described = SDPDescription.parse(sdp)
    let report = try #require(RTCPReport.parse(writer(ssrc: ssrc).sourceDescription()))

    // A receiver correlating the two must find the same identifier on both, or it cannot tell
    // which of several cameras the report it just received belongs to.
    #expect(described.video?.cname == identity.cname)
    #expect(report.sourceDescriptions.first?.ssrc == ssrc)
    #expect(report.cname == described.video?.cname)
  }

  @Test func aRenameTravelsWithoutChangingWhoTheCameraIs() throws {
    let renamed = DeviceIdentity(uuid: identity.uuid, name: "First Base")
    let report = try #require(RTCPReport.parse(RTCPWriter(ssrc: 1, identity: renamed).sourceDescription()))

    #expect(report.name == "First Base")
    // The point of a UUID-derived CNAME: the label changes, the identity does not.
    #expect(report.cname == identity.cname)
  }

  @Test func producerToleratesAPacketItDoesNotFullyUnderstand() throws {
    // A receiver report (PT 201) ahead of the SDES, which our writer never emits but a camera may.
    var packet = Data([ 0x81, 201, 0x00, 0x01, 0, 0, 0, 9 ])
    packet.append(writer().sourceDescription())

    let report = try #require(RTCPReport.parse(packet))
    #expect(report.cname == identity.cname)
  }

  @Test func garbageIsRejectedRatherThanGuessedAt() {
    #expect(RTCPReport.parse(Data()) == nil)
    // Version 1, which no RTCP sender emits.
    #expect(RTCPReport.parse(Data([ 0x41, 202, 0x00, 0x01, 0, 0, 0, 1 ])) == nil)
    // A length field that runs off the end of the packet.
    #expect(RTCPReport.parse(Data([ 0x81, 200, 0xFF, 0xFF, 0, 0, 0, 1 ])) == nil)
  }

  private static let sps = Data([ 0x67, 0x64, 0x00, 0x1F, 0xAC, 0xD9, 0x40, 0x50, 0x05, 0xBB ])
  private static let pps = Data([ 0x68, 0xEB, 0xE3, 0xCB, 0x22, 0xC0 ])
}
