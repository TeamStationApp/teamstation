import Foundation
import DirectorCore
import DirectorSources
import DirectorUI
import Testing

/// A video row (an NDI camera, say the Cosmo C2 relaying a phone's HDMI) linked to a Cameraman
/// whose only job is the parameter channel: telemetry and control, never a media session.
@Suite("Source linking")
struct SourceLinkingRulesTests {
  private static let phoneID = SourceID("C94DF9CA-D7C2-468F-8529-97D01FBA14E7")
  private static let otherPhoneID = SourceID("1B7F0E5A-2C3D-4E5F-8A9B-0C1D2E3F4A5B")
  private static let ndiID = SourceID("NDI-COSMO-C2--CAM-1-")

  private func fixture() -> [SourceSelection] {
    [
      SourceSelection(id: Self.ndiID, kind: .ndi, advertisedName: "Cam 1", isEnabled: true, sourceIndex: 0),
      SourceSelection(
        id: Self.phoneID, kind: .rtsp, advertisedName: "Phone", isEnabled: true, usesAudio: true, sourceIndex: 1
      ),
      SourceSelection(id: Self.otherPhoneID, kind: .rtsp, advertisedName: "Phone 2"),
    ]
  }

  @Test("Linking records the partner on the video row and takes the phone off the grid")
  func linkRecordsPartnerAndDisablesControl() {
    var rows = fixture()
    let result = SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &rows)
    #expect(result == .linked)
    #expect(rows[0].linkedControlID == Self.phoneID)
    #expect(rows[1].isEnabled == false)
    #expect(rows[1].sourceIndex == nil)
    #expect(rows[1].usesAudio == false)
    #expect(SourceSelectionRules.isLinkedControl(Self.phoneID, in: rows))
    #expect(SourceSelectionRules.linkedVideoID(forControl: Self.phoneID, in: rows) == Self.ndiID)
    #expect(SourceSelectionRules.enabled(in: rows).map(\.id) == [Self.ndiID])
  }

  @Test("A row cannot be linked to itself, to a missing row, or to a phone another row already uses")
  func linkRefusals() {
    var rows = fixture()
    #expect(SourceSelectionRules.link(video: Self.ndiID, control: Self.ndiID, in: &rows) == .sameSource)
    #expect(SourceSelectionRules.link(video: Self.ndiID, control: .init("nope"), in: &rows) == .unknownSource)
    #expect(SourceSelectionRules.link(video: .init("nope"), control: Self.phoneID, in: &rows) == .unknownSource)

    #expect(SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &rows) == .linked)
    #expect(
      SourceSelectionRules.link(video: Self.otherPhoneID, control: Self.phoneID, in: &rows) == .controlAlreadyLinked
    )
    // A phone that is somebody's control cannot be a video row with a link of its own.
    #expect(SourceSelectionRules.link(video: Self.phoneID, control: Self.otherPhoneID, in: &rows) == .videoIsControl)
    // A video row that has its own link cannot serve as another row's control.
    #expect(SourceSelectionRules.link(video: Self.otherPhoneID, control: Self.ndiID, in: &rows) == .controlAlreadyLinked)
  }

  @Test("Re-linking a video row to another phone releases the first one")
  func relinkReleasesPrevious() {
    var rows = fixture()
    SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &rows)
    #expect(SourceSelectionRules.link(video: Self.ndiID, control: Self.otherPhoneID, in: &rows) == .linked)
    #expect(rows[0].linkedControlID == Self.otherPhoneID)
    #expect(SourceSelectionRules.isLinkedControl(Self.phoneID, in: rows) == false)
    #expect(SourceSelectionRules.isLinkedControl(Self.otherPhoneID, in: rows))
  }

  @Test("Unlinking from either side clears the link and leaves the phone as an ordinary disabled row")
  func unlinkEitherSide() {
    var rows = fixture()
    SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &rows)
    SourceSelectionRules.unlink(control: Self.phoneID, in: &rows)
    #expect(rows[0].linkedControlID == nil)
    #expect(rows[1].isEnabled == false)
    #expect(SourceSelectionRules.setEnabled(true, for: Self.phoneID, in: &rows) == .enabled(sourceIndex: 1))

    var again = fixture()
    SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &again)
    SourceSelectionRules.unlink(video: Self.ndiID, in: &again)
    #expect(again[0].linkedControlID == nil)
    #expect(SourceSelectionRules.isLinkedControl(Self.phoneID, in: again) == false)
  }

  @Test("A linked phone cannot be enabled, slotted or mixed while it is somebody's control")
  func linkedControlIsInert() {
    var rows = fixture()
    SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &rows)
    #expect(SourceSelectionRules.setEnabled(true, for: Self.phoneID, in: &rows) == .linkedForControl)
    #expect(rows[1].isEnabled == false)
    #expect(SourceSelectionRules.assign(slot: 2, to: Self.phoneID, in: &rows) == .unchanged)
    #expect(rows[1].sourceIndex == nil)
    SourceSelectionRules.setUsesAudio(true, for: Self.phoneID, in: &rows)
    #expect(rows[1].usesAudio == false)
  }

  @Test("Candidates are controllable rows that are not the video row and not already in a link")
  func candidates() {
    var rows = fixture()
    let controllable: (SourceSelection) -> Bool = { $0.kind == .rtsp }
    #expect(
      SourceSelectionRules.linkCandidates(for: Self.ndiID, in: rows, controllable: controllable).map(\.id)
        == [Self.phoneID, Self.otherPhoneID]
    )
    SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &rows)
    // The row's current partner stays offered so the picker can show it as chosen; the video row
    // itself and NDI rows (not controllable) never appear.
    #expect(
      SourceSelectionRules.linkCandidates(for: Self.ndiID, in: rows, controllable: controllable).map(\.id)
        == [Self.phoneID, Self.otherPhoneID]
    )
    #expect(
      SourceSelectionRules.linkCandidates(for: Self.otherPhoneID, in: rows, controllable: controllable).isEmpty
    )
  }

  @Test("Display order puts a linked phone directly under its video row without touching stored order")
  func displayOrder() {
    var rows = [
      SourceSelection(id: Self.phoneID, kind: .rtsp, advertisedName: "Phone"),
      SourceSelection(id: Self.otherPhoneID, kind: .rtsp, advertisedName: "Phone 2", isEnabled: true, sourceIndex: 0),
      SourceSelection(id: Self.ndiID, kind: .ndi, advertisedName: "Cam 1", isEnabled: true, sourceIndex: 1),
    ]
    SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &rows)
    #expect(rows.map(\.id) == [Self.phoneID, Self.otherPhoneID, Self.ndiID])
    #expect(SourceSelectionRules.displayOrder(rows).map(\.id) == [Self.otherPhoneID, Self.ndiID, Self.phoneID])
  }

  @Test("A linked phone that goes off the network stays in the list")
  func mergeRetainsAbsentLinkedPhone() {
    var rows = fixture()
    SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &rows)
    let merged = SourceSelectionRules.merge(
      existing: rows,
      discovered: [DiscoveredSource(id: Self.ndiID, kind: .ndi, advertisedName: "Cam 1", address: "COSMO (Cam 1)")]
    )
    #expect(merged.map(\.id) == [Self.ndiID, Self.phoneID])
    #expect(merged[1].isPresent == false)
    #expect(merged[0].linkedControlID == Self.phoneID)
  }

  @Test("A link survives a store round trip, and a blob without the key decodes unlinked")
  func persistence() throws {
    var rows = fixture()
    SourceSelectionRules.link(video: Self.ndiID, control: Self.phoneID, in: &rows)
    let data = try JSONEncoder().encode(rows)
    let decoded = try JSONDecoder().decode([SourceSelection].self, from: data)
    #expect(decoded[0].linkedControlID == Self.phoneID)
    #expect(SourceSelectionRules.isLinkedControl(Self.phoneID, in: decoded))

    let legacy = Data("""
    [{"id":{"rawValue":"NDI-X"},"kind":"ndi","advertisedName":"X","isEnabled":true,"isPresent":true}]
    """.utf8)
    let old = try JSONDecoder().decode([SourceSelection].self, from: legacy)
    #expect(old[0].linkedControlID == nil)

    let suite = "app.teamstation.director.tests.linking.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let store = SourceSelectionStore(store: ConfigStore(defaults: defaults))
    store.save(rows)
    let loaded = store.load()
    #expect(loaded.first { $0.id == Self.ndiID }?.linkedControlID == Self.phoneID)
    #expect(loaded.contains { $0.id == Self.phoneID })
  }

  @Test("Loaded state is normalised: a linked phone is off the grid and a link to a vanished row is dropped")
  func normalisation() {
    var rows = fixture()
    rows[0].linkedControlID = Self.phoneID
    // Persisted before the rule existed, or edited by hand: the phone still claims a slot.
    let fixed = SourceSelectionRules.normalizingLinks(rows)
    #expect(fixed[1].isEnabled == false)
    #expect(fixed[1].sourceIndex == nil)

    var dangling = fixture()
    dangling[0].linkedControlID = .init("gone")
    #expect(SourceSelectionRules.normalizingLinks(dangling)[0].linkedControlID == nil)
  }
}
