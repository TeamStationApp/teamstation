import Foundation
import DirectorCore
import DirectorSources
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

  /// The reporting half. `shouldReconnect` answers whether to act; this answers what to show, and
  /// a tile needs the second because every other counter on it describes frames that arrived.
  @Test("Reports zero while delivering and the silence once past the timeout")
  func reportsSilence() {
    let last = Date(timeIntervalSince1970: 2_000)
    #expect(StallWatchdog.stalledForSeconds(
      now: last.addingTimeInterval(1),
      lastAccessUnitAt: last,
      sessionStartedAt: last.addingTimeInterval(-30),
      timeout: 5
    ) == 0)
    #expect(StallWatchdog.stalledForSeconds(
      now: last.addingTimeInterval(12),
      lastAccessUnitAt: last,
      sessionStartedAt: last.addingTimeInterval(-30),
      timeout: 5
    ) == 12)
  }

  @Test("A source that never delivered anything is silent from its start, not healthy")
  func neverDeliveredIsSilentFromStart() {
    let started = Date(timeIntervalSince1970: 3_000)
    #expect(StallWatchdog.stalledForSeconds(
      now: started.addingTimeInterval(9),
      lastAccessUnitAt: nil,
      sessionStartedAt: started,
      timeout: 5
    ) == 9)
  }

  @Test("Nothing to judge before a source has started")
  func noOriginIsNotAStall() {
    #expect(StallWatchdog.stalledForSeconds(
      now: Date(),
      lastAccessUnitAt: nil,
      sessionStartedAt: nil,
      timeout: 5
    ) == 0)
  }

  @Test("While the sound keeps arriving a missing picture is given a minute, doubling per reconnect; without sound, 5 s")
  func soundKeepsAPictureStallConnected() {
    let now = Date(timeIntervalSince1970: 2_000)
    func timeout(soundAgo: Double?, reconnects: Int) -> TimeInterval {
      StallWatchdog.pictureTimeout(
        now: now,
        lastSoundAt: soundAgo.map { now.addingTimeInterval(-$0) },
        timeout: 5,
        pictureOnlyTimeout: 60,
        stallReconnects: reconnects
      )
    }
    #expect(timeout(soundAgo: nil, reconnects: 0) == 5)
    #expect(timeout(soundAgo: 6, reconnects: 0) == 5)
    #expect(timeout(soundAgo: 0.2, reconnects: 0) == 60)
    #expect(timeout(soundAgo: 0.2, reconnects: 1) == 120)
    #expect(timeout(soundAgo: 0.2, reconnects: 3) == 480)
    #expect(timeout(soundAgo: 0.2, reconnects: 40) == 3_840)
    #expect(timeout(soundAgo: 0.2, reconnects: -1) == 60)
    // Twenty seconds of picture lost with the sound still coming is no reason to reconnect.
    #expect(!StallWatchdog.shouldReconnect(
      now: now,
      lastAccessUnitAt: now.addingTimeInterval(-20),
      sessionStartedAt: nil,
      timeout: timeout(soundAgo: 0.1, reconnects: 0)
    ))
  }
}
