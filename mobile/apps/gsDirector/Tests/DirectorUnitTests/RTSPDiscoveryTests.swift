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
      confirmHost: { endpoint in confirmed.contains(endpoint.host) ? StreamAdvertisement() : nil }
    )
  }

  private let pixelUUID = "258bf622-da23-4f23-bbba-1b42440dddf1"
  private let iPhoneUUID = "b11d5d5f-07e6-4802-a880-9a3a5ffd0e29"

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

  @Test("A manual host:port uses that port instead of 554")
  func manualHostPort() async {
    let discovery = discovery(
      hosts: [ "127.0.0.1:18554" ],
      confirmed: [ "127.0.0.1" ]
    )
    await discovery.sweepNow()
    #expect(discovery.currentEndpoints.map(\.port) == [ 18554 ])
    #expect(discovery.currentSources.first?.address == "rtsp://127.0.0.1:18554/live/mainstream")
    #expect(CameraIdentityRules.isSessionIdentity(discovery.currentSources.first!.id))
    #expect(!discovery.currentSources.first!.id.rawValue.contains("127.0.0.1"))
  }

  @Test("Four farm ports on one IP stay four sources")
  func fourHostPortsOnOneIP() async {
    let discovery = discovery(
      hosts: [
        "10.10.7.40:18554",
        "10.10.7.40:18555",
        "10.10.7.40:18556",
        "10.10.7.40:18557"
      ],
      confirmed: [ "10.10.7.40" ]
    )
    await discovery.sweepNow()
    #expect(discovery.currentSources.count == 4)
    #expect(Set(discovery.currentEndpoints.map(\.port)) == [ 18554, 18555, 18556, 18557 ])
    let ids = discovery.currentSources.map(\.id)
    #expect(Set(ids).count == 4)
    #expect(ids.allSatisfy { CameraIdentityRules.isSessionIdentity($0) })
    #expect(ids.allSatisfy { !$0.rawValue.contains("10.10.7.40") })
  }

  @Test("Without an identity layer a source is session-keyed, not address-keyed")
  func sessionKeyedFallback() async {
    let discovery = discovery(hosts: [ "10.10.7.148" ], confirmed: [ "10.10.7.148" ])

    await discovery.sweepNow()

    let source = discovery.currentSources.first
    #expect(source.map { CameraIdentityRules.isSessionIdentity($0.id) } == true)
    #expect(source?.id.rawValue.contains("10.10.7.148") != true)
    #expect(source?.advertisedName == CameraIdentityRules.unnamedFallback)

    await discovery.sweepNow()
    #expect(discovery.currentSources.first?.id == source?.id)
  }

  @Test("The identity layer supplies the SourceID and the name")
  func identityWins() async {
    let cameraID = UUID()
    let discovery = discovery(
      hosts: [ "10.10.7.148" ],
      confirmed: [ "10.10.7.148" ],
      resolveIdentity: { endpoints, _, _ in
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
    let resolve: RTSPDiscovery.IdentityResolver = { endpoints, _, _ in
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
    #expect(diagnostic.contains("cname=0"))
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
      confirmHost: { _ in StreamAdvertisement() }
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
        return StreamAdvertisement()
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
      confirmHost: { $0.host == "10.10.7.148" ? StreamAdvertisement() : nil }
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
        return endpoint.port == 8554 ? StreamAdvertisement() : nil
      }
    )

    await discovery.sweepNow()

    #expect(probed.endpoints == [ CameraEndpoint(host: "10.10.7.50", port: 8554, path: "/live/mainstream") ])
    #expect(discovery.currentEndpoints == probed.endpoints)
    #expect(discovery.currentSources.first?.address == "rtsp://10.10.7.50:8554/live/mainstream")
    #expect(discovery.diagnostic.contains("rtsp=1"))
    #expect(discovery.diagnostic.contains("awx=0"))
  }

  @Test("A Cameraman TXT uuid is listed even when DESCRIBE never becomes ready")
  func cameramanAdvertisementIsListedWithoutDescribe() async {
    let advertisement = CameraAdvertisement(
      host: "10.10.7.50",
      advertisedName: "handheld",
      port: 554,
      path: "/live/mainstream",
      uuid: "c94df9ca-d7c2-468f-8529-97d01fba14e7"
    )
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(isScanEnabled: false),
      advertisementBrowser: StaticAdvertisementBrowser([ advertisement ]),
      confirmHost: { _ in nil }
    )

    await discovery.sweepNow()

    #expect(discovery.currentEndpoints == [ CameraEndpoint(host: "10.10.7.50", port: 554) ])
    #expect(discovery.currentSources.first?.advertisedName == "handheld")
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
      confirmHost: { _ in StreamAdvertisement() }
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
      confirmHost: { _ in StreamAdvertisement() }
    )

    await discovery.sweepNow()

    #expect(discovery.currentEndpoints.map(\.host) == [ "10.10.7.118" ])
    #expect(discovery.currentSources.count == 1)
  }

  // MARK: - GS Cameraman on its own port

  @Test("The sweep asks every address about GS Cameraman's port as well as NearStream's")
  func sweepCoversTheCameramanPort() {
    #expect(RTSPDiscovery.Configuration.cameramanPort == 8554)
    #expect(RTSPDiscovery(configuration: RTSPDiscovery.Configuration()).sweepPorts == [ 554, 8554 ])
    #expect(RTSPDiscovery(configuration: RTSPDiscovery.Configuration(isScanEnabled: false)).sweepPorts.isEmpty)
  }

  @Test("A Cameraman the sweep found on 8554 is probed there and identified by its CNAME")
  func sweptCameramanIsIdentifiedByCNAME() async {
    let captured = Captured()
    let pixel = CameraEndpoint(host: "10.10.6.123", port: 8554)
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(),
      resolveIdentity: { _, _, claims in
        captured.record(claims)
        return [:]
      },
      confirmHost: { [pixelUUID] endpoint in
        endpoint == pixel ? StreamAdvertisement(cname: pixelUUID, name: "Pixel10") : nil
      }
    )
    discovery.setSweepIsShared(true)
    discovery.acceptSweep(SubnetScanner.Result(
      openHosts: [ "10.10.6.123", "10.10.6.200" ],
      probedCount: 254,
      subnet: "10.10.6.0/24",
      diagnostic: nil,
      // 5353 is some other service's port on the same sweep; it is not this transport's to probe.
      portsByHost: [ "10.10.6.123": [ 8554 ], "10.10.6.200": [ 5353 ] ]
    ))

    await discovery.sweepNow()

    #expect(discovery.currentEndpoints == [ pixel ])
    #expect(captured.claims[pixel]?.cname == pixelUUID)
    #expect(discovery.diagnostic.contains("cname=1"))
  }

  @Test("A phone that took another's address is not named by the other's advertisement")
  func staleAdvertisementDoesNotNameTheNewPhone() async {
    // The Pixel advertised this socket, left, and the iPhone was given the same lease and port.
    let stale = CameraAdvertisement(
      host: "10.10.6.123",
      advertisedName: "Pixel10",
      port: 8554,
      uuid: pixelUUID
    )
    let discovery = RTSPDiscovery(
      configuration: RTSPDiscovery.Configuration(isScanEnabled: false),
      advertisementBrowser: StaticAdvertisementBrowser([ stale ]),
      confirmHost: { [iPhoneUUID] _ in StreamAdvertisement(cname: iPhoneUUID, name: "iPhone15") }
    )

    await discovery.sweepNow()

    #expect(discovery.currentEndpoints == [ CameraEndpoint(host: "10.10.6.123", port: 8554) ])
    #expect(discovery.currentSources.first?.advertisedName != "Pixel10")
  }

  @Test("Only a Cameraman UUID CNAME is taken from the sweep's DESCRIBE")
  func sweepClaimKeepsOnlyCameramanUUIDs() {
    let cameraman = SDPDescription.parse([
      "v=0",
      "s=Pixel10",
      "m=video 0 RTP/AVP 96",
      "a=rtpmap:96 H265/90000",
      "a=ssrc:2740792677 cname:\(pixelUUID)",
      "a=ssrc:2740792677 name:Pixel10",
      ""
    ].joined(separator: "\r\n"))
    #expect(RTSPDiscovery.sweepClaim(from: cameraman) == StreamAdvertisement(cname: pixelUUID, name: "Pixel10"))

    // Every VM33 sends the same firmware string, so it cannot tell one from another.
    let vm33 = SDPDescription.parse([
      "v=0",
      "m=video 0 RTP/AVP 96",
      "a=rtpmap:96 H264/90000",
      "a=ssrc:1 cname:Hamedal Server/1.0(Jan 16 2026)",
      ""
    ].joined(separator: "\r\n"))
    #expect(RTSPDiscovery.sweepClaim(from: vm33).isEmpty)
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

  /// What the identity layer was told each socket said about itself.
  final class Captured: @unchecked Sendable {
    private let lock = NSLock()
    private var latest: [CameraEndpoint: StreamAdvertisement] = [:]

    var claims: [CameraEndpoint: StreamAdvertisement] {
      lock.lock()
      defer { lock.unlock() }
      return latest
    }

    func record(_ claims: [CameraEndpoint: StreamAdvertisement]) {
      lock.lock()
      latest = claims
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
