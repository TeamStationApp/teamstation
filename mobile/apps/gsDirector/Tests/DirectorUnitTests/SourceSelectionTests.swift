import Foundation
import DirectorCore
import DirectorSources
import DirectorUI
import Testing

@Suite("Source selection")
struct SourceSelectionTests {
  @Test("An empty discovery marks leftover rows absent rather than deleting them")
  func emptyDiscoveryMarksAbsent() {
    let existing = [
      SourceSelection(id: .init("CAM1"), kind: .synthetic, advertisedName: "CAM1", isEnabled: true)
    ]
    let merged = SourceSelectionRules.merge(existing: existing, discovered: [])
    #expect(merged.count == 1)
    #expect(merged[0].isPresent == false)
  }

  @Test("An unidentified IP that identity later bound does not stay as a grey duplicate")
  func unidentifiedAbsentRowsAreDropped() {
    let existing = [
      SourceSelection(
        id: .init("camera-10.10.7.118"),
        kind: .rtsp,
        advertisedName: "10.10.7.118",
        isPresent: true
      ),
      SourceSelection(
        id: .init("C94DF9CA-D7C2-468F-8529-97D01FBA14E7"),
        kind: .rtsp,
        advertisedName: "Left Field",
        isEnabled: true,
        isPresent: true
      )
    ]
    let merged = SourceSelectionRules.merge(
      existing: existing,
      discovered: [
        DiscoveredSource(
          id: .init("C94DF9CA-D7C2-468F-8529-97D01FBA14E7"),
          kind: .rtsp,
          advertisedName: "handheld",
          address: "rtsp://10.10.7.118:554/live/mainstream"
        )
      ]
    )
    #expect(merged.map(\.id.rawValue) == [ "C94DF9CA-D7C2-468F-8529-97D01FBA14E7" ])
    #expect(merged[0].advertisedName == "handheld")
    #expect(merged[0].isPresent)
  }

  @Test("An enabled address-keyed row is dropped so an IP cannot remain as a camera")
  func enabledAddressKeyedRowsAreDropped() {
    let existing = [
      SourceSelection(
        id: .init("camera-10.10.7.40-18554"),
        kind: .rtsp,
        advertisedName: "10.10.7.40",
        isEnabled: true,
        isPresent: true
      )
    ]
    let merged = SourceSelectionRules.merge(existing: existing, discovered: [])
    #expect(merged.isEmpty)
  }

  @Test("The selection store keeps CameraRecord UUIDs and drops IP keys")
  func selectionStoreDropsAddressKeyedRTSP() {
    let suite = "co.gamestation.director.tests.sources.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let store = SourceSelectionStore(store: ConfigStore(defaults: defaults))
    let cameraID = UUID()
    store.save([
      SourceSelection(
        id: .init(cameraID.uuidString),
        kind: .rtsp,
        advertisedName: "Third Base",
        isEnabled: true
      ),
      SourceSelection(
        id: .init("camera-10.10.7.40-18554"),
        kind: .rtsp,
        advertisedName: "10.10.7.40",
        isEnabled: true
      ),
      SourceSelection(
        id: .init("session-\(UUID().uuidString)"),
        kind: .rtsp,
        advertisedName: "Unnamed",
        isEnabled: true
      ),
      SourceSelection(
        id: .init("CAM1"),
        kind: .synthetic,
        advertisedName: "CAM1",
        isEnabled: true
      )
    ])
    let loaded = store.load()
    #expect(Set(loaded.map(\.id.rawValue)) == [ cameraID.uuidString, "CAM1" ])
    store.clear()
  }

  @Test("Switching profile drops rows of the other kind so they cannot look like live cameras")
  func retainingKindDropsTheOther() {
    let mixed = [
      SourceSelection(id: .init("CAM1"), kind: .synthetic, advertisedName: "CAM1", isPresent: true),
      SourceSelection(
        id: .init("fixture-left-field"),
        kind: .file,
        advertisedName: "Left Field",
        isPresent: true
      )
    ]
    let fileOnly = SourceSelectionRules.retaining(mixed, kind: .file)
    #expect(fileOnly.map(\.id.rawValue) == ["fixture-left-field"])
  }

  /// The two live transports run together, so pruning between them is what made a mixed rig
  /// impossible: starting RTSP discovery discarded every NDI selection the operator had made.
  @Test("A live profile keeps cameras of both live transports")
  func retainingKeepsBothLiveKinds() {
    let mixed = [
      SourceSelection(id: .init("ndi-c2"), kind: .ndi, advertisedName: "C2", isPresent: true),
      SourceSelection(id: .init("rtsp-pixel"), kind: .rtsp, advertisedName: "Pixel", isPresent: true),
      SourceSelection(id: .init("CAM1"), kind: .synthetic, advertisedName: "CAM1", isPresent: true)
    ]
    #expect(
      SourceSelectionRules.retaining(mixed, kind: .rtsp).map(\.id.rawValue) == ["ndi-c2", "rtsp-pixel"]
    )
    #expect(
      SourceSelectionRules.retaining(mixed, kind: .ndi).map(\.id.rawValue) == ["ndi-c2", "rtsp-pixel"]
    )
  }

  @Test("A generated profile still drops every live camera")
  func retainingStillPrunesLiveForGenerated() {
    let mixed = [
      SourceSelection(id: .init("ndi-c2"), kind: .ndi, advertisedName: "C2", isPresent: true),
      SourceSelection(id: .init("rtsp-pixel"), kind: .rtsp, advertisedName: "Pixel", isPresent: true),
      SourceSelection(id: .init("CAM1"), kind: .synthetic, advertisedName: "CAM1", isPresent: true)
    ]
    #expect(SourceSelectionRules.retaining(mixed, kind: .synthetic).map(\.id.rawValue) == ["CAM1"])
  }

  /// Endpoint rebinding is an RTSP concern — NDI cameras are keyed by name and have no endpoint —
  /// so a refresh that only RTSP can answer must not speak for NDI. Sent through the full merge it
  /// marked the enabled C2 missing and deleted the NDI cameras nobody had enabled yet.
  @Test("Refreshing one transport leaves the other transport's cameras alone")
  func refreshLimitedToAnsweringKinds() {
    let existing = [
      SourceSelection(id: .init("ndi-c2"), kind: .ndi, advertisedName: "C2", isEnabled: true, isPresent: true),
      SourceSelection(id: .init("ndi-spare"), kind: .ndi, advertisedName: "Spare", isPresent: true),
      SourceSelection(id: .init("rtsp-pixel"), kind: .rtsp, advertisedName: "Pixel", isPresent: true)
    ]
    let refreshed = SourceSelectionRules.merging(
      existing: existing,
      discovered: [
        DiscoveredSource(id: .init("rtsp-pixel"), kind: .rtsp, advertisedName: "Pixel", address: "10.10.7.208")
      ],
      limitedTo: [.rtsp]
    )
    #expect(refreshed.map { $0.id.rawValue } == ["ndi-c2", "ndi-spare", "rtsp-pixel"])
    #expect(refreshed.allSatisfy { $0.isPresent })
  }

  @Test("A refresh keeps existing rows on the tiles they were already on")
  func refreshPreservesOrder() {
    let existing = [
      SourceSelection(id: .init("rtsp-a"), kind: .rtsp, advertisedName: "A", isPresent: true),
      SourceSelection(id: .init("ndi-c2"), kind: .ndi, advertisedName: "C2", isPresent: true),
      SourceSelection(id: .init("rtsp-b"), kind: .rtsp, advertisedName: "B", isPresent: true)
    ]
    let refreshed = SourceSelectionRules.merging(
      existing: existing,
      discovered: [
        DiscoveredSource(id: .init("rtsp-b"), kind: .rtsp, advertisedName: "B", address: "10.10.7.2"),
        DiscoveredSource(id: .init("rtsp-a"), kind: .rtsp, advertisedName: "A", address: "10.10.7.1"),
        DiscoveredSource(id: .init("rtsp-new"), kind: .rtsp, advertisedName: "New", address: "10.10.7.3")
      ],
      limitedTo: [.rtsp]
    )
    #expect(refreshed.map { $0.id.rawValue } == ["rtsp-a", "ndi-c2", "rtsp-b", "rtsp-new"])
  }

  /// Off has to reach the cameras. Sending it to `file4` gave a device with no fixtures a source
  /// list that could never fill, and the operator no way back to real cameras from the UI.
  @Test("Turning simulated cameras off selects real cameras")
  func simulatedOffMeansRTSP() {
    #expect(SourceProfile.forSimulatedCameras(true) == .synthetic4)
    #expect(SourceProfile.forSimulatedCameras(false) == .rtsp)
  }

  @Test("A camera the scanner has not published is not started")
  func unpublishedCameraIsNotStartable() {
    let discovered = [
      DiscoveredSource(
        id: .init("CAM1"),
        kind: .rtsp,
        advertisedName: "Cam 1",
        address: "rtsp://192.168.1.10/live"
      )
    ]
    #expect(SourceSelectionRules.startableSource(id: .init("CAM1"), among: discovered)?.address != nil)
    #expect(SourceSelectionRules.startableSource(id: .init("CAM2"), among: discovered) == nil)
  }

  @Test("Camera failures stay quiet until a recording is open")
  func cameraFailureIsSilentUnlessRecording() {
    #expect(
      OperatorAlert.cameraFailure(
        displayName: "Cam 1",
        detail: "connection failed",
        isRecording: false
      ) == nil
    )
    #expect(
      OperatorAlert.cameraFailure(
        displayName: "Cam 1",
        detail: "connection failed",
        isRecording: true
      ) == "Cam 1 went offline: connection failed"
    )
    #expect(
      OperatorAlert.cameraFailure(displayName: "Cam 1", detail: "", isRecording: true) == nil
    )
  }

  @Test("Missing inputGain decodes as 50 percent")
  func missingInputGainDefaultsToHalf() throws {
    let json = Data("""
    [{"id":{"rawValue":"CAM1"},"kind":"synthetic","advertisedName":"CAM1","isEnabled":true,"usesAudio":true,"isPresent":true}]
    """.utf8)
    let decoded = try JSONDecoder().decode([SourceSelection].self, from: json)
    #expect(decoded[0].inputGain == 0.5)
  }

  @Test("Input gain clamps to 0...1 and 50 percent is unity")
  func inputGainClampsAndHalfIsUnity() {
    #expect(SourceSelectionRules.clampedInputGain(-1) == 0)
    #expect(SourceSelectionRules.clampedInputGain(2) == 1)
    #expect(SourceSelectionRules.mixMultiplier(forGain: 0) == 0)
    #expect(SourceSelectionRules.mixMultiplier(forGain: 0.5) == 1)
    #expect(SourceSelectionRules.mixMultiplier(forGain: 1) == 2)
    var selections = [
      SourceSelection(id: .init("CAM1"), kind: .synthetic, advertisedName: "CAM1")
    ]
    #expect(selections[0].inputGain == 0.5)
    SourceSelectionRules.setInputGain(1.5, for: .init("CAM1"), in: &selections)
    #expect(selections[0].inputGain == 1)
    SourceSelectionRules.setInputGain(-0.2, for: .init("CAM1"), in: &selections)
    #expect(selections[0].inputGain == 0)
  }

  @Test("Persisted inputGain survives a round trip")
  func inputGainRoundTrip() throws {
    let original = SourceSelection(
      id: .init("CAM1"),
      kind: .synthetic,
      advertisedName: "CAM1",
      inputGain: 0.75
    )
    let data = try JSONEncoder().encode([original])
    let decoded = try JSONDecoder().decode([SourceSelection].self, from: data)
    #expect(decoded[0].inputGain == 0.75)
  }

  @Test("Output prefers the persisted camera, then the last enabled row")
  func programSourcePrefersPersistedThenLastEnabled() {
    let cam1 = SourceSelection(
      id: .init("CAM1"),
      kind: .synthetic,
      advertisedName: "CAM1",
      isEnabled: true,
      sourceIndex: 0
    )
    let cam2 = SourceSelection(
      id: .init("CAM2"),
      kind: .synthetic,
      advertisedName: "CAM2",
      isEnabled: true,
      sourceIndex: 1
    )
    let cam3 = SourceSelection(
      id: .init("CAM3"),
      kind: .synthetic,
      advertisedName: "CAM3",
      isEnabled: true,
      sourceIndex: 2
    )
    let selections = [cam1, cam2, cam3]
    #expect(
      SourceSelectionRules.programSourceIndex(preferring: .init("CAM2"), among: selections) == 1
    )
    #expect(
      SourceSelectionRules.programSourceIndex(preferring: nil, among: selections) == 2
    )
    #expect(
      SourceSelectionRules.programSourceIndex(preferring: .init("CAM9"), among: selections) == 2
    )
  }

  @Test("Program source store remembers a camera id")
  func programSourceStoreRoundTrip() {
    let suite = "co.gamestation.director.tests.programSource"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let store = ProgramSourceStore(store: ConfigStore(defaults: defaults))
    #expect(store.load() == nil)
    store.save(SourceID("CAM3"))
    #expect(store.load() == SourceID("CAM3"))
    store.clear()
    #expect(store.load() == nil)
  }
}

/// One source carries a take's sound. See `SourceSelectionRules.setUsesAudio` and the
/// `programmeSoundLock` plan: the programme master places its sound by one offset settled at the
/// part's start, which is only correct while the sound comes from one place.
@Suite("One audio source")
struct SingleAudioSourceTests {
  /// `sourceIndex` matters: `audioContributors` counts only sources that are on a tile, since a
  /// source with no tile is not being received at all and contributes nothing.
  private func rows(_ audio: [Bool]) -> [SourceSelection] {
    audio.enumerated().map { index, usesAudio in
      SourceSelection(
        id: .init("CAM\(index + 1)"),
        kind: .synthetic,
        advertisedName: "CAM\(index + 1)",
        isEnabled: true,
        usesAudio: usesAudio,
        sourceIndex: index
      )
    }
  }

  @Test("Turning one camera's audio on turns every other camera's off")
  func turningOneOnTurnsTheRestOff() {
    var selections = rows([true, true, true])
    SourceSelectionRules.setUsesAudio(true, for: .init("CAM2"), in: &selections)
    #expect(selections.map(\.usesAudio) == [false, true, false])
    #expect(SourceSelectionRules.audioSource(in: selections)?.id == .init("CAM2"))
  }

  @Test("Turning the only source off leaves the take with no sound rather than picking another")
  func turningTheOnlyOneOffLeavesSilence() {
    var selections = rows([false, true, false])
    SourceSelectionRules.setUsesAudio(false, for: .init("CAM2"), in: &selections)
    #expect(selections.allSatisfy { !$0.usesAudio })
    #expect(SourceSelectionRules.audioSource(in: selections) == nil)
  }

  @Test("Turning one on twice is not a way to end up with two")
  func repeatedOnIsIdempotent() {
    var selections = rows([false, false, false])
    SourceSelectionRules.setUsesAudio(true, for: .init("CAM1"), in: &selections)
    SourceSelectionRules.setUsesAudio(true, for: .init("CAM1"), in: &selections)
    #expect(SourceSelectionRules.audioContributors(in: selections).count == 1)
  }

  /// Every take up to 409 remembered three cameras with audio on, and those settings are filed per
  /// camera with no ordering. Restoring them verbatim would put a sum back on a build whose master
  /// is only correct with one source.
  @Test("Restoring remembered settings that name three sources keeps the first and drops the rest")
  func normalisingKeepsTheFirstRow() {
    let normalised = SourceSelectionRules.normalisingAudioToOne(rows([true, true, true]))
    #expect(normalised.map(\.usesAudio) == [true, false, false])
  }

  @Test("Normalising leaves a list that already names one source alone")
  func normalisingIsAnIdentityOnOneSource() {
    let already = rows([false, true, false])
    #expect(SourceSelectionRules.normalisingAudioToOne(already).map(\.usesAudio) == [false, true, false])
  }

  @Test("Normalising a list with no audio source does not invent one")
  func normalisingDoesNotInventASource() {
    #expect(SourceSelectionRules.normalisingAudioToOne(rows([false, false])).allSatisfy { !$0.usesAudio })
  }

  /// The tie-break that matters. Keeping the first row instead took the bench rig's audio from
  /// `1st`, which hears the clapperboard, and gave it to `3rd`, which barely does — so a
  /// thirty-minute soak measured the wrong microphone and reported no claps.
  @Test("The most recently chosen camera keeps the audio, not the first row")
  func recencyBeatsRowOrder() {
    let three = rows([true, true, true])
    let chosen: [SourceID: Double] = [ .init("CAM3"): 200, .init("CAM1"): 100 ]
    let kept = SourceSelectionRules.normalisingAudioToOne(three, chosenAt: chosen)
    #expect(kept.map(\.usesAudio) == [false, false, true])
  }

  @Test("A stamped choice beats an unstamped one, however early its row")
  func stampedBeatsUnstamped() {
    let kept = SourceSelectionRules.normalisingAudioToOne(
      rows([true, true]),
      chosenAt: [ .init("CAM2"): 1 ]
    )
    #expect(kept.map(\.usesAudio) == [false, true])
  }

  @Test("With no stamps anywhere, row order still decides")
  func rowOrderIsTheLastResort() {
    #expect(SourceSelectionRules.normalisingAudioToOne(rows([true, true])).map(\.usesAudio) == [true, false])
  }

  @Test("Turning one on stamps it, and a gain change afterwards does not move the stamp")
  func gainDoesNotRestampTheChoice() {
    var settings: [String: SourceAudioSetting] = [:]
    var one = rows([true])[0]
    SourceAudioRules.remembering(one, in: &settings, key: { "k:\($0.id.rawValue)" }, now: 100)
    #expect(settings["k:CAM1"]?.chosenAt == 100)
    one.inputGain = 0.9
    SourceAudioRules.remembering(one, in: &settings, key: { "k:\($0.id.rawValue)" }, now: 500)
    #expect(settings["k:CAM1"]?.chosenAt == 100)
    #expect(settings["k:CAM1"]?.inputGain == 0.9)
  }

  @Test("Turning a camera's audio off clears its stamp so it stops competing")
  func turningOffClearsTheStamp() {
    var settings: [String: SourceAudioSetting] = [:]
    var one = rows([true])[0]
    SourceAudioRules.remembering(one, in: &settings, key: { "k:\($0.id.rawValue)" }, now: 100)
    one.usesAudio = false
    SourceAudioRules.remembering(one, in: &settings, key: { "k:\($0.id.rawValue)" }, now: 200)
    #expect(settings["k:CAM1"]?.chosenAt == nil)
  }
}
