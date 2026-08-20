import ProducerCore
import ProducerSources
import ProducerUI
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
}
