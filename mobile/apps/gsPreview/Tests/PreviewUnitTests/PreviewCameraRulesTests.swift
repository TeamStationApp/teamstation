import DirectorSources
import Foundation
import PreviewCore
import PreviewTestHarness
import Testing

@Suite("Preview stream path")
struct PreviewStreamTests {
  @Test("NearStream preview path is substream2, never mainstream")
  func forcedPath() {
    #expect(PreviewStream.nearStreamPath == "/live/substream2")
    let endpoint = PreviewStream.endpoint(host: "192.168.7.244")
    #expect(endpoint.path == "/live/substream2")
    #expect(endpoint.port == 554)
  }

  @Test("Advertised TXT path is ignored")
  func ignoresAdvertisedMainstream() {
    let advertisement = CameraAdvertisement(
      host: "192.168.7.244",
      advertisedName: "00001 3rd",
      modelName: "VM33_00001",
      port: 554,
      path: "/live/mainstream"
    )
    #expect(advertisement.path == "/live/mainstream")
    #expect(PreviewStream.endpoint(from: advertisement).path == "/live/substream2")
  }
}

@Suite("NearStream filter")
struct NearStreamFilterTests {
  @Test("VM33 advertisements are kept")
  func keepsVM33() {
    let near = CameraAdvertisement(
      host: "192.168.7.244",
      advertisedName: "00001 3rd",
      modelName: "VM33_00001"
    )
    #expect(PreviewCameraRules.isNearStream(near))
  }

  @Test("Cameraman advertisements are dropped")
  func dropsCameraman() {
    let phone = CameraAdvertisement(
      host: "192.168.7.50",
      advertisedName: "Handheld",
      uuid: "3278e89a-60d9-411d-a93e-5960cb08de79"
    )
    #expect(PreviewCameraRules.isNearStream(phone) == false)
  }
}

@Suite("Tile identity")
struct TileIdentityTests {
  @Test("Tiles follow Director identity: sticker serial, not advertised name")
  func uniqueIDNotAdvertisedName() {
    let first = CameraAdvertisement(
      host: "192.168.7.225",
      advertisedName: "00003 1st",
      modelName: "VM33_00003"
    )
    let mound = CameraAdvertisement(
      host: "192.168.7.244",
      advertisedName: "00002 Mound",
      modelName: "VM33_00002"
    )
    let third = CameraAdvertisement(
      host: "192.168.7.148",
      advertisedName: "00001 3rd",
      modelName: "VM33_00001"
    )
    #expect(PreviewCameraRules.tileID(for: first) == first.uniqueID)
    #expect(PreviewCameraRules.tileID(for: mound) == mound.uniqueID)
    #expect(PreviewCameraRules.tileID(for: third) == third.uniqueID)
    #expect(PreviewCameraRules.arrivingIDs([first, mound, third]).count == 3)
    #expect(
      Set(PreviewCameraRules.arrivingIDs([first, mound, third]))
        == Set([first.uniqueID, mound.uniqueID, third.uniqueID].compactMap { $0 })
    )
  }

  @Test("A camera without a unique id still gets a tile when it has a LAN host")
  func hostWithoutUniqueID() {
    let advertisement = CameraAdvertisement(
      host: "192.168.7.200",
      advertisedName: "00001 3rd"
    )
    #expect(advertisement.uniqueID == nil)
    #expect(PreviewCameraRules.tileID(for: advertisement) == "192.168.7.200")
  }
}

@Suite("Remembered advertisements")
struct RememberedAdvertisementTests {
  @Test("A Bonjour browse that omits one camera keeps the one already seen")
  func partialBrowseKeepsMissingCamera() {
    let first = CameraAdvertisement(
      host: "192.168.7.225",
      advertisedName: "00003 1st",
      modelName: "VM33_00003"
    )
    let mound = CameraAdvertisement(
      host: "192.168.7.244",
      advertisedName: "00002 Mound",
      modelName: "VM33_00002"
    )
    let third = CameraAdvertisement(
      host: "192.168.7.148",
      advertisedName: "00001 3rd",
      modelName: "VM33_00001"
    )
    let remembered = PreviewCameraRules.remembering(
      previous: [first, mound, third],
      incoming: [first, third]
    )
    let ids = Set(remembered.compactMap(\.uniqueID))
    #expect(ids == Set([first.uniqueID, mound.uniqueID, third.uniqueID].compactMap { $0 }))
  }

  @Test("An empty browse does not wipe the snapshot")
  func emptyBrowseKeepsSnapshot() {
    let third = CameraAdvertisement(
      host: "192.168.7.148",
      advertisedName: "00001 3rd",
      modelName: "VM33_00001"
    )
    let remembered = PreviewCameraRules.remembering(previous: [third], incoming: [])
    #expect(remembered.count == 1)
    #expect(remembered.first?.uniqueID == third.uniqueID)
  }
}

@Suite("Tile order")
struct TileOrderTests {
  @Test("New cameras append; existing order is kept")
  func appendsWithoutReshuffle() {
    #expect(
      PreviewCameraRules.appending(existing: ["a"], arriving: ["b", "a"]) == ["a", "b"]
    )
    #expect(
      PreviewCameraRules.appending(existing: ["a", "b"], arriving: ["a", "b", "c"])
        == ["a", "b", "c"]
    )
  }

  @Test("Gone cameras drop from the list")
  func dropsMissing() {
    #expect(
      PreviewCameraRules.appending(existing: ["a", "b", "c"], arriving: ["c", "a"])
        == ["a", "c"]
    )
  }

  @Test("A camera still streaming is kept when this browse omitted it")
  func retainingKeepsStreamingCamera() {
    #expect(
      PreviewCameraRules.merging(
        existing: ["a", "b", "c"],
        arriving: ["a", "c"],
        retaining: Set(["b"])
      ) == ["a", "b", "c"]
    )
  }
}

@Suite("Advertised name")
struct AdvertisedNameTests {
  @Test("Header uses the camera's advertised name")
  func usesAdvertisedName() {
    let advertisement = CameraAdvertisement(
      host: "192.168.7.148",
      advertisedName: "00001 3rd",
      modelName: "VM33_00001"
    )
    #expect(advertisement.advertisedName == "00001 3rd")
  }
}

@Suite("Landscape snap")
struct LandscapeSnapTests {
  @Test("Picks the tile with the greatest visible height")
  func mostVisibleWins() {
    #expect(PreviewCameraRules.snapIndex(visibleHeights: [40, 200, 80]) == 1)
    #expect(PreviewCameraRules.snapIndex(visibleHeights: [300, 20]) == 0)
    #expect(PreviewCameraRules.snapIndex(visibleHeights: []) == 0)
  }

  @Test("Scroll offset maps to a fractional focus covering two cameras")
  func fractionalFocusProgress() {
    let stride: CGFloat = 390
    let progress = PreviewCameraRules.focusProgress(offset: 0.3 * stride, pageStride: stride, count: 3)
    #expect(abs(progress - 0.3) < 0.0001)
    #expect(PreviewCameraRules.nearestIndex(progress: progress, count: 3) == 0)
    #expect(PreviewCameraRules.nearestIndex(progress: 0.6, count: 3) == 1)
    #expect(abs(PreviewCameraRules.overlayOffset(progress: 0.3, thumbStride: 80) - 24) < 0.0001)
  }

  @Test("Landscape top inset uses the notch-side inset when top is 0")
  func landscapeTopClearsSystemGestures() {
    #expect(
      PreviewCameraRules.landscapeThumbTopInset(top: 0, leading: 47, trailing: 21) == 47
    )
    #expect(
      PreviewCameraRules.landscapeThumbTopInset(top: 0, leading: 21, trailing: 47) == 47
    )
    #expect(
      PreviewCameraRules.landscapeThumbTopInset(top: 59, leading: 0, trailing: 0) == 59
    )
    #expect(
      PreviewCameraRules.landscapeThumbTopInset(top: 0, leading: 0, trailing: 0) == 24
    )
  }
}

@Suite("Launch configuration")
struct LaunchConfigurationTests {
  @Test("Parses synthetic camera names")
  func syntheticNames() {
    let launch = LaunchConfiguration(
      arguments: ["-uiTest", "true", "-syntheticCameras", "00001 3rd,00001 1st"]
    )
    #expect(launch.isUITest)
    #expect(launch.syntheticCameras == ["00001 3rd", "00001 1st"])
  }
}
