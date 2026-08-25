import Foundation
import DirectorPipeline
import Testing

@Suite("Stream stall policy")
struct StreamStallPolicyTests {
  private let policy = StreamStallPolicy(gopSeconds: 2, resetCooldown: 10)

  @Test("Pending pinned with stale callbacks resets the session")
  func pendingPinnedStaleCallbacksResets() {
    let action = policy.action(
      now: 100,
      lastKeyframeWall: 90,
      lastCallbackWall: 95,
      pendingEncodes: 3,
      hasLastFrame: true,
      lastResetWall: 0
    )
    #expect(action == .resetSession)
  }

  @Test("Pending pinned but callbacks fresh forces an idle IDR")
  func pendingPinnedFreshCallbacksIdleIDR() {
    let action = policy.action(
      now: 100,
      lastKeyframeWall: 97,
      lastCallbackWall: 99.9,
      pendingEncodes: 3,
      hasLastFrame: true,
      lastResetWall: 0
    )
    #expect(action == .encodeIdleIDR)
  }

  @Test("GOP due with no last frame does nothing")
  func gopDueWithoutLastFrameIsNone() {
    let action = policy.action(
      now: 100,
      lastKeyframeWall: 90,
      lastCallbackWall: 99.9,
      pendingEncodes: 0,
      hasLastFrame: false,
      lastResetWall: 0
    )
    #expect(action == .none)
  }

  @Test("A recent IDR does nothing")
  func recentIDRIsNone() {
    let action = policy.action(
      now: 100,
      lastKeyframeWall: 99,
      lastCallbackWall: 99.5,
      pendingEncodes: 1,
      hasLastFrame: true,
      lastResetWall: 0
    )
    #expect(action == .none)
  }

  @Test("Reset inside cooldown falls back to idle IDR")
  func resetCooldownFallsBackToIdleIDR() {
    let action = policy.action(
      now: 100,
      lastKeyframeWall: 90,
      lastCallbackWall: 95,
      pendingEncodes: 3,
      hasLastFrame: true,
      lastResetWall: 92
    )
    #expect(action == .encodeIdleIDR)
  }

  @Test("Never reset before the first callback")
  func noCallbackYetDoesNotReset() {
    let action = policy.action(
      now: 100,
      lastKeyframeWall: 90,
      lastCallbackWall: 0,
      pendingEncodes: 3,
      hasLastFrame: true,
      lastResetWall: 0
    )
    #expect(action == .encodeIdleIDR)
  }
}
