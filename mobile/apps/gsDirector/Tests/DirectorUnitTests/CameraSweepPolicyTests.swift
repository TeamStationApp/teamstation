import Foundation
import Testing
import DirectorSources

@Suite("Camera sweep policy")
struct CameraSweepPolicyTests {
  @Test("Sweeps freely when nothing is being recorded or streamed")
  func idleSweepsAtTheShortGap() {
    var policy = CameraSweepPolicy()
    #expect(policy.gapAfterNextSweep(isBusy: false, anyEnabledCameraMissing: false, now: 0) == 3)
    #expect(policy.gapAfterNextSweep(isBusy: false, anyEnabledCameraMissing: true, now: 300) == 3)
  }

  @Test("Does not sweep at all while recording with every camera accounted for")
  func busyAndHealthyDoesNotSweep() {
    var policy = CameraSweepPolicy()
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, now: 0) == nil)
  }

  /// The whole point of the design: a recording pays nothing for discovery until something breaks.
  @Test("Starts sweeping the moment an enabled camera goes missing mid-recording")
  func dropoutStartsRecoverySweeping() {
    var policy = CameraSweepPolicy()
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, now: 0) == nil)
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: 10) == 3)
  }

  @Test("Backs off 3 to 6 to 15 a minute at a time, then holds")
  func backoffSchedule() {
    var policy = CameraSweepPolicy()
    let start = 1_000.0
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: start)
    for (elapsed, expected) in [
      (0.0, 3.0), (30.0, 3.0), (59.9, 3.0),
      (60.0, 6.0), (90.0, 6.0), (119.9, 6.0),
      (120.0, 15.0), (600.0, 15.0), (7_200.0, 15.0)
    ] {
      let gap = policy.gapAfterNextSweep(
        isBusy: true,
        anyEnabledCameraMissing: true,
        now: start + elapsed
      )
      #expect(gap == expected, "at \(elapsed)s missing, expected \(expected)s gap, got \(gap as Any)")
    }
  }

  /// A camera that comes back and drops again is a fresh emergency, not a continuation of the old
  /// one — otherwise the second dropout inherits a fifteen second gap and takes that long to notice.
  @Test("Recovery resets the backoff")
  func recoveryResetsTheBackoff() {
    var policy = CameraSweepPolicy()
    let start = 500.0
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: start)
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: start + 300) == 15)
    // Found again.
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, now: start + 301) == nil)
    // And gone again: back to chasing hard.
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: start + 302) == 3)
  }

  @Test("Reports how long the dropout has lasted, and nothing when healthy")
  func missingDuration() {
    var policy = CameraSweepPolicy()
    #expect(policy.missingForSeconds(now: 0) == nil)
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: 100)
    #expect(policy.missingForSeconds(now: 175) == 75)
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, now: 200)
    #expect(policy.missingForSeconds(now: 200) == nil)
  }
}
