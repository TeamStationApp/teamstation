import Foundation
import Testing
@testable import DirectorRTSP

@Suite("RTP clock skew guard")
struct RTPClockSkewTests {
  /// NTP epoch is 1900; the wire format is seconds in the high word, fraction in the low.
  private func ntpTimestamp(unixSeconds: Double) -> UInt64 {
    let ntpSeconds = unixSeconds + 2_208_988_800
    let whole = UInt64(ntpSeconds)
    let fraction = UInt64((ntpSeconds - Double(whole)) * 4_294_967_296)
    return (whole << 32) | fraction
  }

  private func audit(cameraUnixSeconds: Double, ourUnixSeconds: Double) -> RTPClockAudit {
    var audit = RTPClockAudit()
    let sender = RTCPReport.SenderReport(
      ssrc: 7,
      ntpTimestamp: ntpTimestamp(unixSeconds: cameraUnixSeconds),
      rtpTimestamp: 90_000,
      packetCount: 100,
      octetCount: 100_000
    )
    audit.note(
      report: RTCPReport(senderReports: [ sender ]),
      arrivalUptime: 10,
      wallClockNow: Date(timeIntervalSince1970: ourUnixSeconds)
    )
    return audit
  }

  @Test("A camera whose clock agrees with ours is corrected onto it")
  func correctsSmallOffset() {
    // Camera runs 2.15 s ahead — the spread actually measured on the bench.
    let now = 1_800_000_000.0
    let audit = audit(cameraUnixSeconds: now + 2.15, ourUnixSeconds: now)
    let capture = audit.captureTimeOnLocalClock(rtpTimestamp: 90_000, ssrc: 7)
    #expect(capture != nil)
    // The anchor's own instant, moved onto our clock: back to `now`.
    #expect(abs((capture ?? 0) - now) < 0.01)
  }

  @Test("A camera whose clock was never set is declined rather than believed")
  func declinesUnsetClock() {
    // The NearStream case: ships with no NTP client and powers up believing it is 1970.
    let now = 1_800_000_000.0
    let audit = audit(cameraUnixSeconds: 0, ourUnixSeconds: now)
    // Correcting by this would put every segment of that camera decades from the rest of the take.
    #expect(audit.captureTimeOnLocalClock(rtpTimestamp: 90_000, ssrc: 7) == nil)
  }

  @Test("The guard sits at an hour, so a real time-zone-sized error is still declined")
  func declinesHourScaleSkew() {
    let now = 1_800_000_000.0
    let audit = audit(cameraUnixSeconds: now + 7_200, ourUnixSeconds: now)
    #expect(audit.captureTimeOnLocalClock(rtpTimestamp: 90_000, ssrc: 7) == nil)
    #expect(RTPClockAudit.maximumClockSkewSeconds == 3_600)
  }

  @Test("Without a sender report there is nothing to correct from")
  func noAnchorNoAnswer() {
    let audit = RTPClockAudit()
    #expect(audit.captureTimeOnLocalClock(rtpTimestamp: 90_000, ssrc: 7) == nil)
  }
}
