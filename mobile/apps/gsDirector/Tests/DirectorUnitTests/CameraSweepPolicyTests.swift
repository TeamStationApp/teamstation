import Foundation
import Testing
import DirectorSources

@Suite("Camera sweep policy")
struct CameraSweepPolicyTests {
  @Test("Sweeps at the standing gap when nothing is being recorded or streamed")
  func idleSweepsAtTheStandingGap() {
    var policy = CameraSweepPolicy()
    #expect(policy.gapAfterNextSweep(isBusy: false, anyEnabledCameraMissing: false, now: 0) == 10)
    #expect(policy.gapAfterNextSweep(isBusy: false, anyEnabledCameraMissing: true, now: 300) == 10)
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
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: 10) == 10)
  }

  /// One gap, however long the camera has been gone. The broadcasts a shorter early gap costs are
  /// what made the Director's own Wi-Fi slow, and they land during the recording.
  @Test("Holds the same gap however long the dropout lasts")
  func gapDoesNotChangeWithTime() {
    var policy = CameraSweepPolicy()
    let start = 1_000.0
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: start)
    for (elapsed, expected) in [
      (0.0, 10.0), (30.0, 10.0), (59.9, 10.0),
      (60.0, 10.0), (90.0, 10.0), (119.9, 10.0),
      (120.0, 10.0), (600.0, 10.0), (7_200.0, 10.0)
    ] {
      let gap = policy.gapAfterNextSweep(
        isBusy: true,
        anyEnabledCameraMissing: true,
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
    _ = policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: start)
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: start + 300) == 10)
    // Found again.
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: false, now: start + 301) == nil)
    // And gone again: back to chasing hard.
    #expect(policy.gapAfterNextSweep(isBusy: true, anyEnabledCameraMissing: true, now: start + 302) == 10)
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
