import Foundation
import Testing
import DirectorPipeline

@Suite("Replay wedge watchdog")
struct ReplayWedgePolicyTests {
  @Test("A replay presenting frames is never treated as wedged")
  func healthyReplayIsLeftAlone() {
    let policy = ReplayWedgePolicy()
    // A quarter-speed replay still pops frames several times a second.
    #expect(!policy.shouldReturnToLive(now: 1_000, lastPresentedAt: 999.8))
    #expect(!policy.shouldReturnToLive(now: 1_000, lastPresentedAt: 998))
  }

  @Test("A replay that has shown nothing for the timeout is wedged")
  func stalledReplayIsRecovered() {
    let policy = ReplayWedgePolicy()
    #expect(policy.shouldReturnToLive(now: 1_000, lastPresentedAt: 995))
    // The case that was actually found: a tile wedged for four and a half hours. Uptime has to
    // be longer than that for the stamp to be positive — zero and below mean "never presented".
    #expect(policy.shouldReturnToLive(now: 20_000, lastPresentedAt: 20_000 - 15_471))
  }

  @Test("A tile that has never shown a picture is not the watchdog's business")
  func neverPresentedIsIgnored() {
    // Zero is "no picture yet". Starting a replay is the decoder's start path to get wrong, and
    // firing here would fight it.
    #expect(!ReplayWedgePolicy().shouldReturnToLive(now: 1_000, lastPresentedAt: 0))
  }

  @Test("The timeout sits clear of the decoder's own two-second give-up")
  func timeoutIsClearOfTheDecoder() {
    let policy = ReplayWedgePolicy()
    #expect(policy.timeout >= 3)
    // A decoder that gives up at two seconds should always finish first, so the watchdog only ever
    // sees the case where that did not happen.
    #expect(!policy.shouldReturnToLive(now: 1_000, lastPresentedAt: 997.5))
  }

  @Test("A silly timeout cannot be configured down into the decoder's range")
  func timeoutHasAFloor() {
    #expect(ReplayWedgePolicy(timeout: 0).timeout >= 1)
  }
}
