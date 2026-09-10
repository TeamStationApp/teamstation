import Foundation
import Testing
import DirectorCore
import DirectorSources

@Suite("Composite discovery")
struct CompositeDiscoveryTests {
  @Test("Publishes both transports' cameras as one list")
  func mergesBothTransports() {
    let ndi = StubDiscovery(kind: .ndi)
    let rtsp = StubDiscovery(kind: .rtsp)
    let composite = CompositeSourceDiscovery([ndi, rtsp])

    let published = PublishedLists()
    composite.start { published.append($0) }

    ndi.publish([source("c2", .ndi)])
    #expect(published.last?.map(\.id.rawValue) == ["c2"])

    rtsp.publish([source("pixel", .rtsp)])
    #expect(published.last?.map(\.id.rawValue) == ["c2", "pixel"])
    #expect(composite.currentSources.count == 2)
  }

  /// One transport finding nothing must not delay or remove the other's cameras — with both always
  /// on, an NDI-only rig would otherwise sit empty waiting for an RTSP scan.
  @Test("A transport that has found nothing removes nothing")
  func silentTransportDoesNotBlock() {
    let ndi = StubDiscovery(kind: .ndi)
    let rtsp = StubDiscovery(kind: .rtsp)
    let composite = CompositeSourceDiscovery([ndi, rtsp])
    composite.start { _ in }

    ndi.publish([source("c2", .ndi)])
    #expect(composite.currentSources.map(\.id.rawValue) == ["c2"])

    rtsp.publish([])
    #expect(composite.currentSources.map(\.id.rawValue) == ["c2"])
  }

  @Test("A camera is built by the transport that speaks its protocol")
  func routesMakeSourceByKind() throws {
    let ndi = StubDiscovery(kind: .ndi)
    let rtsp = StubDiscovery(kind: .rtsp)
    let composite = CompositeSourceDiscovery([ndi, rtsp])

    _ = try composite.makeSource(for: source("c2", .ndi))
    #expect(ndi.built == ["c2"])
    #expect(rtsp.built.isEmpty)

    _ = try composite.makeSource(for: source("pixel", .rtsp))
    #expect(rtsp.built == ["pixel"])
  }

  @Test("Asking a camera of an absent transport is an error, not the wrong transport")
  func refusesUnknownKind() {
    let composite = CompositeSourceDiscovery([StubDiscovery(kind: .ndi)])
    #expect(throws: CompositeDiscoveryError.self) {
      _ = try composite.makeSource(for: source("pixel", .rtsp))
    }
  }

  @Test("Control reaches every transport")
  func fansOutControl() {
    let ndi = StubDiscovery(kind: .ndi)
    let rtsp = StubDiscovery(kind: .rtsp)
    let composite = CompositeSourceDiscovery([ndi, rtsp])

    composite.setPeriodicSearch(false)
    composite.searchNow()
    composite.setSweepDemand(isBusy: true, anyEnabledCameraMissing: true, isBrowsing: false)

    for child in [ndi, rtsp] {
      #expect(child.periodicSearch == false)
      #expect(child.searches == 1)
      #expect(child.demand?.isBusy == true)
      #expect(child.demand?.missing == true)
    }
    #expect(composite.kinds == [.ndi, .rtsp])
  }

  /// With both transports live, "found nothing" has to say which one found nothing.
  @Test("Each transport's status is labelled with its own name")
  func diagnosticNamesEachTransport() {
    let ndi = StubDiscovery(kind: .ndi, diagnostic: "found=2")
    let rtsp = StubDiscovery(kind: .rtsp, diagnostic: "scan=off")
    #expect(CompositeSourceDiscovery([ndi, rtsp]).diagnostic == "ndi[found=2] rtsp[scan=off]")
  }

  private func source(_ id: String, _ kind: SourceKind) -> DiscoveredSource {
    DiscoveredSource(id: SourceID(id), kind: kind, advertisedName: id, address: "192.168.7.1")
  }
}

private final class PublishedLists: @unchecked Sendable {
  private let lock = NSLock()
  private var lists: [[DiscoveredSource]] = []

  func append(_ sources: [DiscoveredSource]) {
    lock.lock()
    lists.append(sources)
    lock.unlock()
  }

  var last: [DiscoveredSource]? {
    lock.lock()
    defer { lock.unlock() }
    return lists.last
  }
}

private final class StubDiscovery: SourceDiscovery, @unchecked Sendable {
  let kind: SourceKind
  let diagnostic: String
  private(set) var isRunning = false
  private(set) var built: [String] = []
  private(set) var searches = 0
  private(set) var periodicSearch = true
  private(set) var demand: (isBusy: Bool, missing: Bool)?
  private(set) var currentSources: [DiscoveredSource] = []
  private var handler: DiscoveryChangeHandler?

  init(kind: SourceKind, diagnostic: String = "") {
    self.kind = kind
    self.diagnostic = diagnostic
  }

  func start(onChange: @escaping DiscoveryChangeHandler) {
    handler = onChange
    isRunning = true
  }

  func stop() {
    handler = nil
    isRunning = false
  }

  func publish(_ sources: [DiscoveredSource]) {
    currentSources = sources
    handler?(sources)
  }

  func makeSource(for discovered: DiscoveredSource) throws -> FrameSource {
    built.append(discovered.id.rawValue)
    return StubFrameSource(sourceID: discovered.id)
  }

  func setPeriodicSearch(_ enabled: Bool) { periodicSearch = enabled }
  func searchNow() { searches += 1 }

  func setSweepDemand(isBusy: Bool, anyEnabledCameraMissing: Bool, isBrowsing: Bool) {
    demand = (isBusy, anyEnabledCameraMissing)
  }
}

private final class StubFrameSource: FrameSource, @unchecked Sendable {
  let sourceID: SourceID
  let displayName = "stub"
  private(set) var isRunning = false
  var format: SourceFormat? { nil }

  init(sourceID: SourceID) { self.sourceID = sourceID }
  func start(sinks: FrameSinks) throws { isRunning = true }
  func stop() { isRunning = false }
}
