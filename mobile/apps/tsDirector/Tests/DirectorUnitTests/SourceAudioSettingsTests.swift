import Foundation
import DirectorCore
import DirectorSources
import DirectorUI
import Testing

@Suite("Source audio settings")
struct SourceAudioSettingsTests {
  private static func record(
    id: UUID = UUID(),
    name: String = "1st",
    hardwareID: String? = nil,
    cname: String? = nil
  ) -> CameraRecord {
    CameraRecord(
      id: id,
      name: name,
      advertisedName: "Pixel10",
      lastKnownCNAME: cname,
      lastKnownHost: "192.168.7.148",
      lastSeenAt: Date(timeIntervalSince1970: 0),
      hardwareID: hardwareID
    )
  }

  @Test("A camera is filed under its hardware identifier, not under either of its names")
  func hardwareIdentifierIsTheKey() {
    let id = UUID()
    let selection = SourceSelection(
      id: .init(id.uuidString),
      kind: .rtsp,
      advertisedName: "Pixel10",
      customName: "1st"
    )
    let key = SourceAudioRules.key(
      for: selection,
      record: Self.record(id: id, hardwareID: "uuid:258bf622-da23-4f23-bbba-1b42440dddf1")
    )
    #expect(key == "hw:uuid:258bf622-da23-4f23-bbba-1b42440dddf1")

    // Both names change; the camera has not.
    var renamed = selection
    renamed.customName = "first base"
    renamed.advertisedName = "Pixel 10 Pro"
    #expect(SourceAudioRules.key(
      for: renamed,
      record: Self.record(id: id, name: "first base", hardwareID: "uuid:258bf622-da23-4f23-bbba-1b42440dddf1")
    ) == key)
  }

  @Test("A camera with no NearStream identity is filed under the CNAME it presents")
  func cnameIsTheFallbackKey() {
    let id = UUID()
    let selection = SourceSelection(id: .init(id.uuidString), kind: .rtsp, advertisedName: "00002 Mound")
    let key = SourceAudioRules.key(
      for: selection,
      record: Self.record(id: id, cname: "Hamedal Server/1.0(Jan 16 2026)")
    )
    #expect(key == "cname:Hamedal Server/1.0(Jan 16 2026)")
  }

  @Test("A session-keyed socket has nothing durable to be filed under")
  func sessionKeyedRowsAreNotFiled() {
    let selection = SourceSelection(
      id: .init("session-2b1f0d5e-2b8e-4a6b-8a0c-7e6d5c4b3a21"),
      kind: .rtsp,
      advertisedName: "Unnamed"
    )
    #expect(SourceAudioRules.key(for: selection, record: nil) == nil)
  }

  @Test("An NDI source with no camera record falls back to its own durable id")
  func ndiRowsFallBackToTheirID() {
    let selection = SourceSelection(
      id: .init("NDI-ART-SIRIUS--NDI-HX3-A-99552F"),
      kind: .ndi,
      advertisedName: "NDI HX3_A_99552f"
    )
    #expect(SourceAudioRules.key(for: selection, record: nil) == "id:NDI-ART-SIRIUS--NDI-HX3-A-99552F")
  }

  @Test("A camera that comes back as a brand new row comes back out of the mix")
  func rediscoveredCameraKeepsItsAudioDecision() {
    let hardwareID = "uuid:c94df9ca-d7c2-468f-8529-97d01fba14e7"
    let first = UUID()
    let second = UUID()
    var settings: [String: SourceAudioSetting] = [:]
    let keying: (UUID) -> (SourceSelection) -> String? = { recordID in
      { selection in
        SourceAudioRules.key(for: selection, record: Self.record(id: recordID, hardwareID: hardwareID))
      }
    }

    // The operator puts this camera in the mix and turns it down.
    var decided = SourceSelection(id: .init(first.uuidString), kind: .rtsp, advertisedName: "3rd")
    decided.usesAudio = true
    decided.inputGain = 0.2
    SourceAudioRules.remembering(decided, in: &settings, key: keying(first))

    // It is forgotten and found again, so discovery mints it a new record and a new row, which
    // arrives with the defaults: out of the mix at fifty percent.
    let fresh = SourceSelection(id: .init(second.uuidString), kind: .rtsp, advertisedName: "3rd")
    #expect(fresh.usesAudio == false)

    let applied = SourceAudioRules.applying(settings, to: [ fresh ], key: keying(second))
    #expect(applied[0].usesAudio)
    #expect(applied[0].inputGain == 0.2)
  }

  @Test("A camera nobody has ever asked for is not in the programme mix")
  func newCamerasStartOutOfTheMix() {
    let discovered = SourceSelection(id: .init("NDI-NEW"), kind: .ndi, advertisedName: "NDI HX3_B_99552f")
    #expect(discovered.usesAudio == false)
    #expect(SourceSelectionRules.audioContributors(in: [ discovered ]).isEmpty)
  }

  @Test("An iPad that was already mixing a camera before the switch existed keeps mixing it")
  func selectionsSavedBeforeTheFieldExistedKeepTheirAudio() throws {
    let legacy = Data(
      #"[{"id":{"rawValue":"CAM1"},"kind":"synthetic","advertisedName":"CAM1","isEnabled":true,"isPresent":true}]"#
        .utf8
    )
    let decoded = try JSONDecoder().decode([SourceSelection].self, from: legacy)
    #expect(decoded[0].usesAudio)
  }

  @Test("An NDI camera that renames itself is a camera nobody has decided on, and keeps its default")
  func unknownCamerasKeepTheirDefaults() {
    var settings: [String: SourceAudioSetting] = [:]
    var decided = SourceSelection(
      id: .init("NDI-ART-SIRIUS--NDI-HX3-A-994079"),
      kind: .ndi,
      advertisedName: "NDI HX3_A_000001"
    )
    decided.usesAudio = true
    SourceAudioRules.remembering(decided, in: &settings, key: { SourceAudioRules.key(for: $0, record: nil) })

    let renamed = SourceSelection(
      id: .init("NDI-ART-SIRIUS--NDI-HX3-A-99552F"),
      kind: .ndi,
      advertisedName: "NDI HX3_A_99552f"
    )
    let applied = SourceAudioRules.applying(
      settings,
      to: [ renamed ],
      key: { SourceAudioRules.key(for: $0, record: nil) }
    )
    #expect(applied[0].usesAudio == false)
  }

  @Test("A phone linked for control stays out of the mix whatever was remembered about it")
  func linkedControlsAreNotPutBackInTheMix() {
    var settings: [String: SourceAudioSetting] = [:]
    var phone = SourceSelection(id: .init("NDI-PHONE"), kind: .ndi, advertisedName: "Phone")
    phone.usesAudio = true
    SourceAudioRules.remembering(phone, in: &settings, key: { SourceAudioRules.key(for: $0, record: nil) })
    #expect(settings["id:NDI-PHONE"]?.usesAudio == true)

    var camera = SourceSelection(id: .init("NDI-CAM"), kind: .ndi, advertisedName: "Cam")
    camera.linkedControlID = phone.id
    var linkedPhone = phone
    linkedPhone.usesAudio = false

    let applied = SourceAudioRules.applying(
      settings,
      to: [ camera, linkedPhone ],
      key: { SourceAudioRules.key(for: $0, record: nil) }
    )
    #expect(applied[1].usesAudio == false)
  }

  @Test("An iPad already in use keeps the decisions that only its source list holds")
  func seedingTakesTheRowsAsTheTruthOnce() {
    var settings: [String: SourceAudioSetting] = [:]
    var mixed = SourceSelection(id: .init("NDI-HOME"), kind: .ndi, advertisedName: "home")
    mixed.usesAudio = true
    mixed.inputGain = 0.75
    let quiet = SourceSelection(id: .init("NDI-THIRD"), kind: .ndi, advertisedName: "3rd")

    SourceAudioRules.seeding(
      from: [ mixed, quiet ],
      into: &settings,
      key: { SourceAudioRules.key(for: $0, record: nil) }
    )
    #expect(settings["id:NDI-HOME"] == SourceAudioSetting(usesAudio: true, inputGain: 0.75))
    #expect(settings["id:NDI-THIRD"]?.usesAudio == false)

    // A second launch must not let a row that arrived with the defaults overwrite the decision.
    var reappeared = mixed
    reappeared.usesAudio = false
    reappeared.inputGain = SourceSelectionRules.defaultInputGain
    SourceAudioRules.seeding(
      from: [ reappeared ],
      into: &settings,
      key: { SourceAudioRules.key(for: $0, record: nil) }
    )
    #expect(settings["id:NDI-HOME"] == SourceAudioSetting(usesAudio: true, inputGain: 0.75))
  }

  @Test("Both decisions survive a round trip through the store, as a file on disk")
  func storeRoundTrip() throws {
    let root = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("SourceAudioSettingsTests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("audio.json")

    let store = SourceAudioStore(url: url)
    #expect(store.load().isEmpty)

    // The directory does not exist yet: a first launch writes this before anything has made it.
    store.save([ "hw:uuid:abc": SourceAudioSetting(usesAudio: false, inputGain: 0.9) ])
    #expect(FileManager.default.fileExists(atPath: url.path))
    #expect(store.load()["hw:uuid:abc"] == SourceAudioSetting(usesAudio: false, inputGain: 0.9))

    store.clear()
    #expect(store.load().isEmpty)
  }

  @Test("A gain outside 0...1 is clamped rather than stored as given")
  func gainIsClamped() {
    #expect(SourceAudioSetting(usesAudio: true, inputGain: 1.8).inputGain == 1)
    #expect(SourceAudioSetting(usesAudio: true, inputGain: -0.4).inputGain == 0)
  }
}
