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

  /// The stress run's publish that connected, then sent 3,406 bytes and no media: after a start, no
  /// keyframe ever came out, and both rules measured from events that had not happened.
  @Test("A stream with no keyframe since it started gets an idle IDR after a GOP and a half")
  func noKeyframeSinceStartForcesIDR() {
    let action = policy.action(
      now: 103,
      lastKeyframeWall: 0,
      lastCallbackWall: 0,
      pendingEncodes: 0,
      hasLastFrame: true,
      lastResetWall: 0,
      startedWall: 100
    )
    #expect(action == .encodeIdleIDR)
  }

  @Test("A stream whose encoder never called back is rebuilt after three GOPs")
  func noCallbackSinceStartResetsAfterThreeGOPs() {
    let action = policy.action(
      now: 107,
      lastKeyframeWall: 0,
      lastCallbackWall: 0,
      pendingEncodes: 3,
      hasLastFrame: true,
      lastResetWall: 0,
      startedWall: 100
    )
    #expect(action == .resetSession)
  }

  @Test("A slow first encode is not rebuilt inside three GOPs")
  func slowFirstEncodeIsLeftAlone() {
    let action = policy.action(
      now: 104,
      lastKeyframeWall: 0,
      lastCallbackWall: 0,
      pendingEncodes: 3,
      hasLastFrame: true,
      lastResetWall: 0,
      startedWall: 100
    )
    #expect(action == .encodeIdleIDR)
  }

  /// The soak's stall: -12912 at 64 callbacks a second, no picture out, keyframes frozen. The
  /// callbacks are fresh, so the silence rule never fired.
  @Test("Callbacks that only carry errors rebuild the session after two GOPs")
  func failingCallbacksReset() {
    let action = policy.action(
      now: 200,
      lastKeyframeWall: 150,
      lastCallbackWall: 199.98,
      pendingEncodes: 0,
      hasLastFrame: true,
      lastResetWall: 0,
      startedWall: 100,
      lastOutputWall: 150
    )
    #expect(action == .resetSession)
  }

  @Test("A failing encoder is not rebuilt again inside the cooldown")
  func failingCallbacksRespectCooldown() {
    let action = policy.action(
      now: 200,
      lastKeyframeWall: 150,
      lastCallbackWall: 199.98,
      pendingEncodes: 0,
      hasLastFrame: true,
      lastResetWall: 195,
      startedWall: 100,
      lastOutputWall: 150
    )
    #expect(action == .encodeIdleIDR)
  }

  /// The stress run of 2026-09-15: frames flowing, the regular keyframe a moment late, and an idle
  /// IDR that went out beside it with an earlier timestamp.
  @Test("A keyframe just past one GOP, with frames flowing, is left to the encoder's own schedule")
  func keyframeJustDueIsLeftToTheEncoder() {
    let action = policy.action(
      now: 100,
      lastKeyframeWall: 97.9,
      lastCallbackWall: 99.98,
      pendingEncodes: 1,
      hasLastFrame: true,
      lastResetWall: 0,
      startedWall: 50,
      lastOutputWall: 99.98
    )
    #expect(action == .none)
  }

  @Test("A keyframe a GOP and a half old gets an idle IDR")
  func keyframeWellOverdueForcesIDR() {
    let action = policy.action(
      now: 100,
      lastKeyframeWall: 97,
      lastCallbackWall: 99.98,
      pendingEncodes: 1,
      hasLastFrame: true,
      lastResetWall: 0,
      startedWall: 50,
      lastOutputWall: 99.98
    )
    #expect(action == .encodeIdleIDR)
  }

  @Test("Healthy output with fresh callbacks does nothing")
  func healthyOutputIsLeftAlone() {
    let action = policy.action(
      now: 200,
      lastKeyframeWall: 199,
      lastCallbackWall: 199.98,
      pendingEncodes: 1,
      hasLastFrame: true,
      lastResetWall: 0,
      startedWall: 100,
      lastOutputWall: 199.98
    )
    #expect(action == .none)
  }
}
