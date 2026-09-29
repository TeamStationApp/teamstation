import CameramanCore
import Testing

@Suite("Broadcast policy")
struct BroadcastPolicyTests {
  @Test
  func ordinaryLaunchStaysQuietUntilTheOperatorHasBroadcast() {
    #expect(BroadcastPolicy.shouldListen(saved: false, isUITest: false, selfTest: false, recordSeconds: 0) == false)
    #expect(BroadcastPolicy.shouldListen(saved: true, isUITest: false, selfTest: false, recordSeconds: 0))
  }

  @Test
  func harnessThatNeedsAListenerDoesNotReplaceTheSavedChoice() {
    #expect(BroadcastPolicy.shouldListen(saved: false, isUITest: true, selfTest: false, recordSeconds: 0))
    #expect(BroadcastPolicy.shouldListen(saved: false, isUITest: false, selfTest: true, recordSeconds: 0))
    #expect(BroadcastPolicy.shouldPersist(persistSettings: true, isUITest: true, selfTest: false) == false)
    #expect(BroadcastPolicy.shouldPersist(persistSettings: true, isUITest: false, selfTest: true) == false)
    #expect(BroadcastPolicy.shouldPersist(persistSettings: true, isUITest: false, selfTest: false))
    #expect(BroadcastPolicy.shouldPersist(persistSettings: false, isUITest: false, selfTest: false) == false)
  }

  @Test
  func recordingRunLeavesThePortFree() {
    #expect(BroadcastPolicy.shouldListen(saved: true, isUITest: true, selfTest: true, recordSeconds: 5) == false)
  }

  @Test
  func stopSliderCommitsAtEightyPercent() {
    #expect(BroadcastPolicy.slideCommits(progress: 0.79) == false)
    #expect(BroadcastPolicy.slideCommits(progress: 0.8))
    #expect(BroadcastPolicy.slideCommits(progress: 1))
  }

  @Test
  func savedChoiceRoundTripsAndDefaultsToQuiet() {
    let store = InMemorySettingsStore()
    let preference = BroadcastPreference(store: store)
    #expect(preference.load() == false)
    preference.save(true)
    #expect(store.string(forKey: BroadcastPolicy.preferenceKey) == "true")
    #expect(BroadcastPreference(store: store).load())
    preference.save(false)
    #expect(preference.load() == false)
  }
}
