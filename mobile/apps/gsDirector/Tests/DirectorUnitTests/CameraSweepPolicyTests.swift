import Foundation
import Testing
import DirectorSources

@Suite("Camera sweep policy")
struct CameraSweepPolicyTests {
  /// Sweeping simply because time passed is what made the segment noisy. Idle and healthy is now
  /// silence, whether or not anything is recording.
  @Test("Does not sweep when nothing is missing and nobody is looking")
  func idleAndHealthyIsSilent() {
    var policy = CameraSweepPolicy()
    #expect(policy.gapAfterNextSweep(isBusy: false, anyEnabledCameraMissing: false, isBrowsing: false, now: 0) == nil)
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, isBrowsing: false, now: 10) == nil)
  }

  @Test("Sweeps while the operator is on the camera list, which is what that screen is for")
  func browsingSweeps() {
    var policy = CameraSweepPolicy()
    #expect(policy.gapAfterNextSweep(isBusy: false, anyEnabledCameraMissing: false, isBrowsing: true, now: 0) == 10)
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, isBrowsing: true, now: 5) == 10)
  }

  @Test("A missing camera is chased whether or not anyone is looking")
  func missingSweepsRegardless() {
    var policy = CameraSweepPolicy()
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, isBrowsing: false, now: 300) == 10)
  }

  @Test("Does not sweep at all while recording with every camera accounted for")
  func busyAndHealthyDoesNotSweep() {
    var policy = CameraSweepPolicy()
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, isBrowsing: false, now: 0) == nil)
  }

  /// The whole point of the design: a recording pays nothing for discovery until something breaks.
  @Test("Starts sweeping the moment an enabled camera goes missing mid-recording")
  func dropoutStartsRecoverySweeping() {
    var policy = CameraSweepPolicy()
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, isBrowsing: false, now: 0) == nil)
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, isBrowsing: false, now: 10) == 10)
  }

  /// One gap, however long the camera has been gone. The broadcasts a shorter early gap costs are
  /// what made the Director's own Wi-Fi slow, and they land during the recording.
  @Test("Holds the same gap however long the dropout lasts")
  func gapDoesNotChangeWithTime() {
    var policy = CameraSweepPolicy()
    let start = 1_000.0
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, isBrowsing: false, now: start)
    for (elapsed, expected) in [
      (0.0, 10.0), (30.0, 10.0), (59.9, 10.0),
      (60.0, 10.0), (90.0, 10.0), (119.9, 10.0),
      (120.0, 10.0), (600.0, 10.0), (7_200.0, 10.0)
    ] {
      let gap = policy.gapAfterNextSweep(
        isBusy: true,
        anyEnabledCameraMissing: true,
        isBrowsing: false,
        now: start + elapsed
      )
      #expect(gap == expected, "at \(elapsed)s missing, expected \(expected)s gap, got \(gap as Any)")
    }
  }

  /// The dropout clock still resets, because `missingForSeconds` drives telemetry and an
  /// offline-for-hours tile is judged on it.
  @Test("Recovery resets the dropout clock")
  func recoveryResetsTheDropoutClock() {
    var policy = CameraSweepPolicy()
    let start = 500.0
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, isBrowsing: false, now: start)
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, isBrowsing: false, now: start + 300) == 10)
    // Found again.
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, isBrowsing: false, now: start + 301) == nil)
    // And gone again: back to chasing hard.
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, isBrowsing: false, now: start + 302) == 10)
  }

  /// Every enabled camera is "not present" for the first seconds after launch, before discovery
  /// has heard from it. That is not a dropout, and treating it as one swept the segment on every
  /// launch.
  @Test("Does not sweep for cameras that simply have not appeared yet at launch")
  func launchIsNotADropout() {
    var policy = CameraSweepPolicy(startedAt: 1_000)
    #expect(policy.gapAfterNextSweep(isBusy: false, anyEnabledCameraMissing: true, isBrowsing: false, now: 1_000) == nil)
    #expect(policy.gapAfterNextSweep(isBusy: false, anyEnabledCameraMissing: true, isBrowsing: false, now: 1_019.9) == nil)
    #expect(policy.missingForSeconds(now: 1_019.9) == nil)
  }

  @Test("A camera still missing once startup is over is chased")
  func missingAfterGraceSweeps() {
    var policy = CameraSweepPolicy(startedAt: 1_000)
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, isBrowsing: false, now: 1_020) == 10)
  }

  @Test("The camera list sweeps even during startup, because the operator asked")
  func browsingDuringGraceSweeps() {
    var policy = CameraSweepPolicy(startedAt: 1_000)
    #expect(policy.gapAfterNextSweep(isBusy: false, anyEnabledCameraMissing: true, isBrowsing: true, now: 1_001) == 10)
  }

  @Test("Reports how long the dropout has lasted, and nothing when healthy")
  func missingDuration() {
    var policy = CameraSweepPolicy()
    #expect(policy.missingForSeconds(now: 0) == nil)
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, isBrowsing: false, now: 100)
    #expect(policy.missingForSeconds(now: 175) == 75)
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, isBrowsing: false, now: 200)
    #expect(policy.missingForSeconds(now: 200) == nil)
  }
}
