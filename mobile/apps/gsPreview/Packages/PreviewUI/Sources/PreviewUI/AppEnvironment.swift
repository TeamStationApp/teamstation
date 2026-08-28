import Foundation
import DirectorCore
import DirectorRTSP
import DirectorSources
import PreviewCore
import PreviewTestHarness

@MainActor
@Observable
public final class AppEnvironment {
  public private(set) var cameras: [PreviewCamera] = []
  public private(set) var statusMessage = "Looking for cameras…"
  public private(set) var browseState = "idle"

  private let launch: LaunchConfiguration
  private let browser: any CameraAdvertisementBrowsing
  private let probe: RTSPEndpointProbe
  private var controlServer: ControlServer?
  private var pollTask: Task<Void, Never>?
  private var connecting = Set<String>()
  /// Last non-empty merge of `_awx_service._tcp`, matching Director's CameraRegistry.
  private var rememberedAds: [CameraAdvertisement] = []

  public init(
    launch: LaunchConfiguration = LaunchConfiguration(),
    browser: any CameraAdvertisementBrowsing = AWXServiceBrowser(),
    probe: RTSPEndpointProbe = RTSPEndpointProbe()
  ) {
    self.launch = launch
    self.browser = browser
    self.probe = probe
    if launch.isUITest {
      startControlServer()
    }
  }

  public func start() {
    if !launch.syntheticCameras.isEmpty {
      installSyntheticCameras(launch.syntheticCameras)
      return
    }
    browser.start()
    statusMessage = "Looking for cameras…"
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshAdvertisements()
        try? await Task.sleep(for: .seconds(2))
      }
    }
  }

  public func stop() {
    pollTask?.cancel()
    pollTask = nil
    browser.stop()
    rememberedAds = []
    for camera in cameras {
      camera.source?.stop()
      camera.source = nil
    }
    controlServer?.stop()
  }

  public func dumpState() -> Data {
    let rows: [[String: String]] = cameras.enumerated().map { index, camera in
      [
        "index": String(index + 1),
        "name": camera.advertisedName,
        "host": camera.endpoint.host,
        "path": camera.endpoint.path
      ]
    }
    let payload: [String: Any] = [
      "browseState": browseState,
      "status": statusMessage,
      "cameras": rows
    ]
    return (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
  }

  private func installSyntheticCameras(_ names: [String]) {
    var next: [PreviewCamera] = []
    for (offset, name) in names.enumerated() {
      let id = "synthetic-\(offset)"
      let camera = PreviewCamera(
        id: id,
        advertisedName: name,
        endpoint: PreviewStream.endpoint(host: "127.0.0.1")
      )
      let source = SyntheticFrameSource(
        sourceID: SourceID(id),
        displayName: name,
        width: 640,
        height: 360,
        paletteIndex: offset
      )
      try? source.start(onPixelFrame: { [renderer = camera.renderer] frame in
        _ = renderer.enqueue(frame)
      })
      camera.source = source
      next.append(camera)
    }
    cameras = next
    statusMessage = next.isEmpty ? "No NearStream cameras on this network" : ""
    browseState = "synthetic"
  }

  private func refreshAdvertisements() async {
    browseState = browser.browseState
    rememberedAds = PreviewCameraRules.remembering(
      previous: rememberedAds,
      incoming: browser.advertisements
    )
    let seen = rememberedAds.filter {
      $0.hasUsableMediaHost && PreviewCameraRules.isNearStream($0)
    }
    let arriving = PreviewCameraRules.arrivingIDs(seen)
    let retaining = Set(
      cameras.compactMap { camera in
        camera.source?.isRunning == true ? camera.id : nil
      }
    )
    let ordered = PreviewCameraRules.merging(
      existing: cameras.map(\.id),
      arriving: arriving,
      retaining: retaining
    )

    let now = Date()
    var byID: [String: CameraAdvertisement] = [:]
    for advertisement in seen {
      if let id = PreviewCameraRules.tileID(for: advertisement) {
        byID[id] = advertisement
      }
    }

    var next: [PreviewCamera] = []
    for id in ordered {
      if let existing = cameras.first(where: { $0.id == id }) {
        existing.lastSeen = now
        if let advertisement = byID[id] {
          existing.advertisedName = advertisement.advertisedName
          let endpoint = PreviewStream.endpoint(from: advertisement)
          if existing.endpoint != endpoint {
            existing.source?.stop()
            existing.source = nil
            existing.endpoint = endpoint
            connecting.remove(id)
          }
        }
        if existing.source?.isRunning != true {
          connect(existing)
        }
        next.append(existing)
        continue
      }
      guard let advertisement = byID[id] else { continue }
      let camera = PreviewCamera(
        id: id,
        advertisedName: advertisement.advertisedName,
        endpoint: PreviewStream.endpoint(from: advertisement)
      )
      next.append(camera)
      connect(camera)
    }

    for dropped in cameras where next.contains(where: { $0.id == dropped.id }) == false {
      dropped.source?.stop()
      dropped.source = nil
    }
    cameras = next

    if cameras.isEmpty {
      statusMessage = arriving.isEmpty
        ? (browseState == "ready" || browseState == "idle"
          ? "No NearStream cameras on this network"
          : "Looking for cameras…")
        : "Looking for cameras…"
    } else {
      statusMessage = ""
    }
  }

  private func connect(_ camera: PreviewCamera) {
    let id = camera.id
    guard connecting.insert(id).inserted else { return }
    let endpoint = camera.endpoint
    let name = camera.advertisedName
    Task { [weak self, weak camera] in
      let confirmed = await self?.probe.confirm(
        host: endpoint.host,
        port: endpoint.port,
        path: endpoint.path
      )
      guard let self, let camera else { return }
      connecting.remove(id)
      guard confirmed != nil else { return }
      guard endpoint.path == PreviewStream.nearStreamPath else { return }
      let source = RTSPFrameSource(
        sourceID: SourceID(id),
        displayName: name,
        configuration: RTSPSession.Configuration(
          host: endpoint.host,
          port: endpoint.port,
          path: endpoint.path,
          userAgent: PreviewStream.userAgent
        )
      )
      try? source.start(onPixelFrame: { [renderer = camera.renderer] frame in
        _ = renderer.enqueue(frame)
      })
      camera.source = source
    }
  }

  private func startControlServer() {
    let server = ControlServer { [weak self] url in
      guard let self else { return nil }
      if url.path.contains("dump-state") {
        let snapshot: () -> Data = {
          MainActor.assumeIsolated { self.dumpState() }
        }
        if Thread.isMainThread {
          return snapshot()
        }
        return DispatchQueue.main.sync(execute: snapshot)
      }
      return Data(#"{"ok":true}"#.utf8)
    }
    try? server.start()
    controlServer = server
  }
}
