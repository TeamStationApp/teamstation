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
        id: .init("camera-192.168.7.118"),
        kind: .rtsp,
        advertisedName: "192.168.7.118",
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
          address: "rtsp://192.168.7.118:554/live/mainstream"
        )
      ]
    )
    #expect(merged.map(\.id.rawValue) == [ "C94DF9CA-D7C2-468F-8529-97D01FBA14E7" ])
    #expect(merged[0].advertisedName == "handheld")
    #expect(merged[0].isPresent)
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
