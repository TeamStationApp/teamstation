import DirectorSources
import Foundation
import Testing

@Suite("Silence clock")
struct SilenceClockTests {
  private let t0 = Date(timeIntervalSince1970: 1_000)

  /// The Cosmo off the network: 565 reconnects over two hours, each one a fresh session.
  @Test("Reconnecting does not restart the silence")
  func reconnectsDoNotReset() {
    var clock = SilenceClock()
    clock.sessionStarted(at: t0)
    clock.notePicture(at: t0.addingTimeInterval(1))
    // Sessions keep opening and nothing arrives.
    for attempt in 1...20 { clock.sessionStarted(at: t0.addingTimeInterval(Double(attempt) * 8)) }
    let stalled = clock.stalledForSeconds(now: t0.addingTimeInterval(7_201), timeout: 5)
    #expect(stalled == 7_200)
  }

  @Test("A source that never delivered is silent from when it started, not from its last attempt")
  func neverDelivered() {
    var clock = SilenceClock()
    clock.sessionStarted(at: t0)
    clock.sessionStarted(at: t0.addingTimeInterval(30))
    #expect(clock.stalledForSeconds(now: t0.addingTimeInterval(40), timeout: 5) == 40)
  }

  @Test("A picture ends the silence, and a healthy source reads zero")
  func pictureResets() {
    var clock = SilenceClock()
    clock.sessionStarted(at: t0)
    clock.notePicture(at: t0.addingTimeInterval(100))
    #expect(clock.stalledForSeconds(now: t0.addingTimeInterval(103), timeout: 5) == 0)
    #expect(clock.stalledForSeconds(now: t0.addingTimeInterval(110), timeout: 5) == 10)
  }

  @Test("Stopping the source forgets its silence")
  func stopForgets() {
    var clock = SilenceClock()
    clock.sessionStarted(at: t0)
    clock.stop()
    #expect(clock.stalledForSeconds(now: t0.addingTimeInterval(600), timeout: 5) == 0)
    clock.sessionStarted(at: t0.addingTimeInterval(600))
    #expect(clock.stalledForSeconds(now: t0.addingTimeInterval(610), timeout: 5) == 10)
  }
}
