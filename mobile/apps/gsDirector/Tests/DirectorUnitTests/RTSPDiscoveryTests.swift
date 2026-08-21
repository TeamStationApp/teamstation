import Foundation
import DirectorCore
import DirectorRTSP
import DirectorSources
import Testing

@Suite("RTSP discovery")
struct RTSPDiscoveryTests {
  /// Scanning is off in every test here: the sweep logic under test is what happens to hosts after
  /// they are found, and a real scan needs a network.
  private func discovery(
    hosts: [String],
    confirmed: Set<String>,
    resolveIdentity: RTSPDiscovery.IdentityResolver? = nil
  ) -> RTSPDiscovery {
    RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(
        path: "/live/mainstream",
        manualHosts: hosts,
        isScanEnabled: false
      ),
      resolveIdentity: resolveIdentity,
      confirmHost: { endpoint in confirmed.contains(endpoint.host) }
    )
  }

  @Test("A manual host that answers becomes a source; one that does not is dropped")
  func confirmationGatesPublication() async {
    let discovery = discovery(
      hosts: [ "10.10.7.148", "10.10.7.9" ],
      confirmed: [ "10.10.7.148" ]
    )

    await discovery.sweepNow()

    #expect(discovery.currentSources.count == 1)
    #expect(discovery.currentEndpoints.map(\.host) == [ "10.10.7.148" ])
    #expect(discovery.currentSources.first?.address == "rtsp://10.10.7.148:554/live/mainstream")
    #expect(discovery.currentSources.first?.kind == .rtsp)
  }

  @Test("Without an identity layer a source is keyed by address, so tiles still work unnamed")
  func addressKeyedFallback() async {
    let discovery = discovery(hosts: [ "10.10.7.148" ], confirmed: [ "10.10.7.148" ])

    await discovery.sweepNow()

    let source = discovery.currentSources.first
    #expect(source?.id == SourceID("camera-10.10.7.148"))
    #expect(source?.advertisedName == "10.10.7.148")
  }

  @Test("The identity layer supplies the SourceID and the name")
  func identityWins() async {
    let cameraID = UUID()
    let discovery = discovery(
      hosts: [ "10.10.7.148" ],
      confirmed: [ "10.10.7.148" ],
      resolveIdentity: { endpoints, _ in
        Dictionary(uniqueKeysWithValues: endpoints.map {
          ($0, (id: SourceID("camera-\(cameraID.uuidString)"), name: "Third Base"))
        })
      }
    )

    await discovery.sweepNow()

    let source = discovery.currentSources.first
    #expect(source?.id == SourceID("camera-\(cameraID.uuidString)"))
    #expect(source?.advertisedName == "Third Base")
    // The address still describes where to connect, which is the part that may change tomorrow.
    #expect(source?.address == "rtsp://10.10.7.148:554/live/mainstream")
  }

  @Test("A camera keeps its SourceID after moving to a new address")
  func identitySurvivesAnAddressChange() async {
    let stable = SourceID("camera-fixed")
    let resolve: RTSPDiscovery.IdentityResolver = { endpoints, _ in
      Dictionary(uniqueKeysWithValues: endpoints.map { ($0, (id: stable, name: "Third Base")) })
    }

    let before = discovery(hosts: [ "10.10.7.148" ], confirmed: [ "10.10.7.148" ], resolveIdentity: resolve)
    await before.sweepNow()

    let after = discovery(hosts: [ "10.10.7.201" ], confirmed: [ "10.10.7.201" ], resolveIdentity: resolve)
    await after.sweepNow()

    #expect(before.currentSources.first?.id == after.currentSources.first?.id)
    #expect(before.currentSources.first?.address != after.currentSources.first?.address)
  }

  @Test("The diagnostic says what was scanned, probed, confirmed and entered by hand")
  func diagnosticIsReadable() async {
    let discovery = discovery(
      hosts: [ "10.10.7.148", "10.10.7.9" ],
      confirmed: [ "10.10.7.148" ]
    )

    await discovery.sweepNow()

    let diagnostic = discovery.diagnostic
    #expect(diagnostic.contains("scan=off"))
    #expect(diagnostic.contains("confirmed=1"))
    #expect(diagnostic.contains("manual=2"))
    #expect(diagnostic.contains("awx=0"))
  }

  @Test("A sweep that finds nothing publishes an empty list rather than stale sources")
  func emptySweepClearsSources() async {
    let discovery = discovery(hosts: [ "10.10.7.148" ], confirmed: [ "10.10.7.148" ])
    await discovery.sweepNow()
    #expect(discovery.currentSources.count == 1)

    let gone = self.discovery(hosts: [ "10.10.7.148" ], confirmed: [])
    await gone.sweepNow()
    #expect(gone.currentSources.isEmpty)
    #expect(gone.diagnostic.contains("confirmed=0"))
  }

  @Test("The change handler fires with each published sweep")
  func handlerIsCalled() async {
    let discovery = discovery(hosts: [ "10.10.7.148" ], confirmed: [ "10.10.7.148" ])
    let received = Received()
    discovery.start { sources in received.record(sources) }

    await discovery.sweepNow()
    discovery.stop()

    #expect(received.latest?.count == 1)
    #expect(!discovery.isRunning)
  }

  @Test("Turning the periodic search off stops sweeps, and an explicit search still runs")
  func periodicSearchCanBePaused() async {
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(
        manualHosts: [ "10.10.7.148" ],
        isScanEnabled: false,
        rescanInterval: 0.05
      ),
      confirmHost: { _ in true }
    )

    discovery.setPeriodicSearch(false)
    discovery.start { _ in }
    // Long enough for several intervals to have elapsed had the search been running.
    try? await Task.sleep(for: .milliseconds(300))
    #expect(discovery.currentSources.isEmpty)

    // A camera that dropped mid-game is looked for on demand, which must work while paused.
    await discovery.sweepNow()
    #expect(discovery.currentSources.count == 1)

    discovery.stop()
  }

  @Test("A camera already being watched is not probed again")
  func streamingEndpointsAreNotReprobed() async {
    let probed = Probed()
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(
        manualHosts: [ "127.0.0.1" ],
        isScanEnabled: false
      ),
      confirmHost: { endpoint in
        probed.record(endpoint.host)
        return true
      }
    )

    await discovery.sweepNow()
    #expect(probed.hosts == [ "127.0.0.1" ])

    // Handing out a source and starting it is what makes the endpoint "in use". Nothing has to be
    // listening: the source is watching that address either way, which is the condition being
    // tested — a second DESCRIBE mid-session is work the camera may refuse.
    let source = try? discovery.makeSource(for: DiscoveredSource(
      id: SourceID("camera-127.0.0.1"),
      kind: .rtsp,
      advertisedName: "Third Base",
      address: "rtsp://127.0.0.1:554/live/mainstream"
    ))
    try? source?.start(sinks: FrameSinks(pixel: { _ in }))

    await discovery.sweepNow()
    source?.stop()

    #expect(probed.hosts == [ "127.0.0.1" ])
    #expect(discovery.currentEndpoints.map(\.host) == [ "127.0.0.1" ])
    #expect(discovery.diagnostic.contains("streaming=1"))
  }

  @Test("A Bonjour-advertised host is probed even when the subnet scan never saw it")
  func advertisementHostsBecomeCandidates() async {
    let advertisement = CameraAdvertisement(
      host: "10.10.7.148",
      advertisedName: "00D9D 3rd",
      modelName: "VM33_00D9D"
    )
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(isScanEnabled: false),
      advertisementBrowser: StaticAdvertisementBrowser([ advertisement ]),
      confirmHost: { $0.host == "10.10.7.148" }
    )

    await discovery.sweepNow()

    #expect(discovery.currentEndpoints.map(\.host) == [ "10.10.7.148" ])
    #expect(discovery.diagnostic.contains("awx=1"))
  }

  @Test("A _rtsp._tcp advertisement is probed on its SRV port, not the NearStream default")
  func rtspAdvertisementUsesAdvertisedPortAndPath() async {
    let advertisement = CameraAdvertisement(
      host: "10.10.7.50",
      advertisedName: "Camera 14E7",
      port: 8554,
      path: "/live/mainstream",
      uuid: "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    )
    let probed = Probed()
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(isScanEnabled: false),
      advertisementBrowser: StaticAdvertisementBrowser([ advertisement ]),
      confirmHost: { endpoint in
        probed.record(endpoint)
        return endpoint.port == 8554
      }
    )

    await discovery.sweepNow()

    #expect(probed.endpoints == [ CameraEndpoint(host: "10.10.7.50", port: 8554, path: "/live/mainstream") ])
    #expect(discovery.currentEndpoints == probed.endpoints)
    #expect(discovery.currentSources.first?.address == "rtsp://10.10.7.50:8554/live/mainstream")
    #expect(discovery.diagnostic.contains("rtsp=1"))
    #expect(discovery.diagnostic.contains("awx=0"))
  }

  @Test("Cameras that advertised a unique id are listed before unidentified RTSP hosts")
  func identifiedCamerasSortFirst() async {
    let advertisement = CameraAdvertisement(
      host: "10.10.7.244",
      advertisedName: "0107B Mound",
      modelName: "VM33_0107B"
    )
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(
        manualHosts: [ "10.10.7.118", "10.10.7.244" ],
        isScanEnabled: false
      ),
      advertisementBrowser: StaticAdvertisementBrowser([ advertisement ]),
      confirmHost: { _ in true }
    )

    await discovery.sweepNow()

    #expect(discovery.currentEndpoints.map(\.host) == [ "10.10.7.244", "10.10.7.118" ])
  }

  @Test("A Cameraman advertised on link-local and found on LAN is published once")
  func cameramanDuplicateAddressesCollapse() async {
    let advertisement = CameraAdvertisement(
      host: "169.254.113.105",
      advertisedName: "Left Field",
      uuid: "c94df9ca-d7c2-468f-8529-97d01fba14e7"
    )
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(
        manualHosts: [ "10.10.7.118" ],
        isScanEnabled: false
      ),
      advertisementBrowser: StaticAdvertisementBrowser([ advertisement ]),
      confirmHost: { _ in true }
    )

    await discovery.sweepNow()

    #expect(discovery.currentEndpoints.map(\.host) == [ "10.10.7.118" ])
    #expect(discovery.currentSources.count == 1)
  }

  @Test("An address without a host yields no endpoint, so a bad row cannot become a source")
  func endpointParsing() {
    #expect(CameraEndpoint(address: "rtsp://10.10.7.148:554/live/mainstream")
      == CameraEndpoint(host: "10.10.7.148", port: 554, path: "/live/mainstream"))
    // A missing port and path fall back to the RTSP defaults this app uses.
    #expect(CameraEndpoint(address: "rtsp://10.10.7.148")
      == CameraEndpoint(host: "10.10.7.148", port: 554, path: "/live/mainstream"))
    #expect(CameraEndpoint(address: nil) == nil)
    #expect(CameraEndpoint(address: "not a url") == nil)
  }

  /// Records which hosts the confirmation step was asked about.
  final class Probed: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []
    private var recordedEndpoints: [CameraEndpoint] = []

    var hosts: [String] {
      lock.lock()
      defer { lock.unlock() }
      return recorded
    }

    var endpoints: [CameraEndpoint] {
      lock.lock()
      defer { lock.unlock() }
      return recordedEndpoints
    }

    func record(_ host: String) {
      lock.lock()
      recorded.append(host)
      lock.unlock()
    }

    func record(_ endpoint: CameraEndpoint) {
      lock.lock()
      recorded.append(endpoint.host)
      recordedEndpoints.append(endpoint)
      lock.unlock()
    }
  }

  /// A box because the handler is `@Sendable` and fires off the test's own task.
  final class Received: @unchecked Sendable {
    private let lock = NSLock()
    private var sources: [DiscoveredSource]?

    var latest: [DiscoveredSource]? {
      lock.lock()
      defer { lock.unlock() }
      return sources
    }

    func record(_ sources: [DiscoveredSource]) {
      lock.lock()
      self.sources = sources
      lock.unlock()
    }
  }
}
