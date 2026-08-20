import Foundation
import ProducerCore
import ProducerRTSP
import Testing

@Suite("Stall watchdog")
struct StallWatchdogTests {
  @Test("A session that never delivered a frame still reconnects after the timeout")
  func neverReceivedFrameIsAStall() {
    let started = Date(timeIntervalSince1970: 1_000)
    let now = started.addingTimeInterval(6)
    #expect(
      StallWatchdog.shouldReconnect(
        now: now,
        lastAccessUnitAt: nil,
        sessionStartedAt: started,
        timeout: 5
      )
    )
  }

  @Test("A quiet session after pictures still reconnects")
  func quietAfterPicturesIsAStall() {
    let last = Date(timeIntervalSince1970: 1_000)
    let now = last.addingTimeInterval(6)
    #expect(
      StallWatchdog.shouldReconnect(
        now: now,
        lastAccessUnitAt: last,
        sessionStartedAt: last.addingTimeInterval(-2),
        timeout: 5
      )
    )
  }

  @Test("A fresh session is not yet a stall")
  func freshSessionIsNotAStall() {
    let started = Date(timeIntervalSince1970: 1_000)
    #expect(
      !StallWatchdog.shouldReconnect(
        now: started.addingTimeInterval(1),
        lastAccessUnitAt: nil,
        sessionStartedAt: started,
        timeout: 5
      )
    )
  }

  @Test("With neither a start nor a picture, there is nothing to time")
  func missingOriginDoesNotReconnect() {
    #expect(
      !StallWatchdog.shouldReconnect(
        now: Date(),
        lastAccessUnitAt: nil,
        sessionStartedAt: nil,
        timeout: 5
      )
    )
  }
}
