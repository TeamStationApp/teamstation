import CameramanCore
import Darwin
import Foundation
import Network
import os

/// The RTSP server: one `NWListener`, one `RTSPClientConnection` per client.
///
/// Media is pushed from `send(video:)` and `send(audio:)` rather than pulled, because the encoder runs
/// whether or not anyone is watching and its callbacks must never block on a socket.
public final class RTSPServer: @unchecked Sendable {
  public struct Status: Sendable, Equatable, Codable {
    public var isListening = false
    public var port: UInt16?
    /// The port actually bound, which may be the fallback rather than the one asked for.
    public var requestedPort: UInt16?
    /// Sessions currently playing. A connection that only polls parameters is not a viewer and is
    /// not counted here; `acceptedClients` still counts it.
    public var clientCount = 0
    public var lastError: String?
    /// Frames the send queue dropped across clients because a receiver could not keep up.
    public var droppedFrames = 0
    /// Lifetime accepts, including clients that closed immediately.
    public var acceptedClients = 0
    /// Lifetime closes. `acceptedClients - closedClients` should match `clientCount`.
    public var closedClients = 0
    /// Why the most recent client left: TEARDOWN, eof, nw failed, recv, server stop, cancelled.
    public var lastDisconnectReason: String?
    /// Bytes still sitting in client send queues. A climb with `clientCount > 0` is backpressure.
    public var sendQueuePendingBytes = 0
    public var sendQueueFlushes = 0
    /// `ready` / `failed` / `cancelled` / other `NWListener` states, for a soak that lost the bind.
    public var listenerState: String?

    public init() {}

    public var usedFallbackPort: Bool {
      guard let port, let requestedPort else { return false }
      return port != requestedPort
    }
  }

  /// Must also appear under `NSBonjourServices` in `Info.plist`, or advertising fails with -65555.
  public static let bonjourServiceType = "_rtsp._tcp"
  /// Same type NearStream uses. Director's AWX browse is what actually finds cameras on a split
  /// 2.4/5 GHz LAN; `_rtsp._tcp` from an iPhone often never appears there.
  public static let awxServiceType = "_awx_service._tcp."

  private let queue = DispatchQueue(label: "co.gamestation.cameraman.rtsp")
  private let state = OSAllocatedUnfairLock(initialState: MutableState())
  /// Takes the SSRCs the connection will actually send on, so the SDP's `a=ssrc` attributes name the
  /// same streams the RTP does.
  private let describe: @Sendable (UInt32, UInt32) -> String
  private let hasAudio: @Sendable () -> Bool
  private let identity: @Sendable () -> DeviceIdentity
  /// Called when a client starts playing, so it gets a picture immediately instead of waiting out
  /// the keyframe interval on frames whose references it never received.
  private let requestKeyframe: @Sendable () -> Void
  /// Answers `GET_PARAMETER` / `SET_PARAMETER` bodies. Nil offers no parameters.
  private let parameters: RTSPResponder.ParameterHandler?

  /// What `start` was last called with, so the listener can be rebuilt without the caller having to
  /// remember. `stop` clears it, so a deliberate shutdown is never undone by a retry.
  private struct StartRequest {
    var port: UInt16
    var fallbackPort: UInt16
    var path: String
    var advertise: Bool
  }

  private struct MutableState {
    var listener: NWListener?
    var connections: [ObjectIdentifier: RTSPClientConnection] = [:]
    var status = Status()
    var advertise = false
    var path = "/live/mainstream"
    var startRequest: StartRequest?
  }

  /// Second Bonjour type, published beside the NWListener's `_rtsp._tcp` service. One listener can
  /// only advertise one type; Director finds NearStream on this one.
  private var awxAdvertisement: NetService?
  private var pathMonitor: NWPathMonitor?
  /// Pending rebind, and how many have been tried since the last `.ready`. Both are touched only on
  /// `queue`, like the monitors above.
  private var rebindWork: DispatchWorkItem?
  private var rebindAttempt = 0
  /// Browsing is how iOS keeps AWDL and Local Network permission warm. Advertising alone is not.
  private var localNetworkBrowser: NWBrowser?

  public var onStatusChange: (@Sendable (Status) -> Void)?

  public var status: Status { state.withLock { $0.status } }

  /// The SDP is produced on demand rather than held, because the parameter sets are not known until
  /// the encoder has produced its first frame, and a client may DESCRIBE before then.
  public init(
    describe: @escaping @Sendable (UInt32, UInt32) -> String,
    hasAudio: @escaping @Sendable () -> Bool,
    identity: @escaping @Sendable () -> DeviceIdentity,
    requestKeyframe: @escaping @Sendable () -> Void,
    parameters: RTSPResponder.ParameterHandler? = nil
  ) {
    self.describe = describe
    self.hasAudio = hasAudio
    self.identity = identity
    self.requestKeyframe = requestKeyframe
    self.parameters = parameters
  }

  /// Binds `port`, falling back to `fallbackPort` if it is taken. A bind failure is a visible status
  /// rather than a thrown error, because the app has to keep running and show the operator why.
  public func start(port: UInt16, fallbackPort: UInt16, path: String, advertise: Bool = true) {
    queue.async { [self] in
      state.withLock {
        $0.startRequest = StartRequest(
          port: port,
          fallbackPort: fallbackPort,
          path: path,
          advertise: advertise
        )
      }
      cancelRebind()
      bindStartRequest()
    }
  }

  public func stop() {
    queue.async { [self] in
      cancelRebind()
      stopLocked()
    }
  }

  /// Puts the listener back if it is down but was never deliberately stopped, and does nothing if it
  /// is already up.
  ///
  /// iOS cancels the `NWListener` and its Bonjour record when the app leaves the foreground and does
  /// not restore either on the way back. Nothing else in the app notices: capture and encode are
  /// independent of the listener, so the app returns to the foreground rendering a live preview
  /// while serving nobody — which over the network is indistinguishable from a camera that was never
  /// started. Call this whenever the app becomes active.
  public func ensureListening() {
    queue.async { [self] in
      let down = state.withLock { $0.startRequest != nil && $0.listener == nil }
      guard down else { return }
      cancelRebind()
      bindStartRequest()
    }
  }

  /// Cancels the listener the way iOS does when the scene leaves the foreground: the start request
  /// is left in place, so this produces exactly the state `ensureListening` and the automatic rebind
  /// exist to get out of. Verification only — nothing in the app calls it.
  public func simulateListenerLoss() {
    queue.async { [self] in
      state.withLock { $0.listener }?.cancel()
    }
  }

  /// Binds the stored request, preferring its port and falling back to the second. Runs on `queue`.
  private func bindStartRequest() {
    guard let request = state.withLock({ $0.startRequest }) else { return }
    stopLocked(clearingRequest: false)
    let bound = bind(
      port: request.port,
      requested: request.port,
      path: request.path,
      advertise: request.advertise
    ) || bind(
      port: request.fallbackPort,
      requested: request.port,
      path: request.path,
      advertise: request.advertise
    )
    // Neither port produced a listener, so no state handler will fire to ask for a retry. Without
    // this the server would sit down forever on a transient bind failure.
    if !bound { scheduleRebind() }
  }

  /// Re-publishes `_rtsp._tcp` under the current name. A rename that only updated the in-memory
  /// identity would otherwise keep advertising the old instance until the listener was restarted.
  public func refreshAdvertisement() {
    queue.async { [self] in
      let snapshot: (NWListener, String)? = state.withLock { current in
        guard current.advertise, let listener = current.listener else { return nil }
        return (listener, current.path)
      }
      guard let (listener, path) = snapshot else { return }
      let ip = Self.lanIPv4()
      let port = listener.port.map { Int($0.rawValue) }
      listener.service = Self.bonjourService(
        identity: identity(),
        path: path,
        ip: ip,
        port: port
      )
      if let port {
        publishAWX(identity: identity(), path: path, ip: ip, port: port)
      }
    }
  }

  /// Advertised so a client knows this build answers `GET_PARAMETER` / `SET_PARAMETER` before it
  /// offers a control screen. An older build without it shows no controls instead of a screen
  /// that cannot connect.
  public static let controlVersion = CameraParameters.controlVersion

  /// TXT keys Director reads for Cameraman identity. `uuid` is the CNAME; `name` is the label.
  /// `ip` / `port` let GS Director bind without resolving the Bonjour UUID hostname, which
  /// often has no usable A-record from another iOS device. `control` says the parameter verbs
  /// are answered.
  public static func bonjourTXT(
    identity: DeviceIdentity,
    path: String,
    ip: String? = nil,
    port: Int? = nil
  ) -> [String: String] {
    var fields = [
      "uuid": identity.cname,
      "name": identity.name,
      "path": path,
      "control": controlVersion
    ]
    if let ip, !ip.isEmpty { fields["ip"] = ip }
    if let port, port > 0 { fields["port"] = String(port) }
    return fields
  }

  public static func bonjourService(
    identity: DeviceIdentity,
    path: String,
    ip: String? = nil,
    port: Int? = nil
  ) -> NWListener.Service {
    NWListener.Service(
      name: identity.name,
      type: bonjourServiceType,
      txtRecord: NWTXTRecord(bonjourTXT(identity: identity, path: path, ip: ip, port: port))
    )
  }

  /// Wi-Fi IPv4, then any other infrastructure address. USB link-local and loopback are skipped so
  /// Director on another device is not handed an address it cannot reach.
  public static func lanIPv4() -> String? {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return nil }
    defer { freeifaddrs(head) }
    var addresses: [(interface: String, ip: String)] = []
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let interface = pointer.pointee
      guard interface.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
      let name = String(cString: interface.ifa_name)
      var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let result = getnameinfo(
        interface.ifa_addr,
        socklen_t(interface.ifa_addr.pointee.sa_len),
        &buffer,
        socklen_t(buffer.count),
        nil,
        0,
        NI_NUMERICHOST
      )
      guard result == 0 else { continue }
      addresses.append((name, String(cString: buffer)))
    }
    return preferredLANIPv4(addresses: addresses)
  }

  /// Picks the IPv4 Director should dial. `en0` (Wi-Fi) wins; 169.254 and loopback never do.
  public static func preferredLANIPv4(addresses: [(interface: String, ip: String)]) -> String? {
    func rank(_ interface: String) -> Int {
      if interface == "en0" { return 0 }
      if interface.hasPrefix("en") { return 1 }
      if interface.hasPrefix("bridge") { return 2 }
      if interface.hasPrefix("awdl") || interface.hasPrefix("llw") { return 5 }
      if interface.hasPrefix("utun") || interface.hasPrefix("ipsec") { return 6 }
      return 4
    }

    // Cellular never: it is not the field's network, and for the moments Wi-Fi drops it was the
    // only address left, so Director moved a live tile to 203.0.113.16 and lost the camera for 20 s.
    // Some carriers hand out 10.x on cellular, so the interface is excluded as well as the range.
    return addresses
      .filter { interface, ip in !interface.hasPrefix("pdp_ip") && isPrivateIPv4(ip) }
      .min { rank($0.interface) < rank($1.interface) }?
      .ip
  }

  /// 10/8, 172.16/12 or 192.168/16: the addresses a Director on the same network can dial.
  public static func isPrivateIPv4(_ ip: String) -> Bool {
    let octets = ip.split(separator: ".", omittingEmptySubsequences: false).compactMap { UInt8($0) }
    guard octets.count == 4 else { return false }
    switch (octets[0], octets[1]) {
    case (10, _): return true
    case (172, 16...31): return true
    case (192, 168): return true
    default: return false
    }
  }

  private func bind(port: UInt16, requested: UInt16, path: String, advertise: Bool) -> Bool {
    guard let endpointPort = NWEndpoint.Port(rawValue: port) else { return false }

    let parameters = NWParameters.tcp
    // Without this a listener that was not cleanly torn down leaves the port unusable for a minute,
    // which on a relaunch looks exactly like another app holding it.
    parameters.allowLocalEndpointReuse = true
    parameters.includePeerToPeer = true

    let listener: NWListener
    do {
      listener = try NWListener(using: parameters, on: endpointPort)
    } catch {
      update { $0.lastError = "could not bind \(port): \(error.localizedDescription)" }
      return false
    }

    // Bonjour, so GS Producer finds the camera without anyone typing an address. `_rtsp._tcp` must
    // also be declared under `NSBonjourServices` in Info.plist: without it the advertisement fails
    // with -65555 (kDNSServiceErr_NoAuth) and takes the listener down with it, and
    // NSLocalNetworkUsageDescription alone gives no hint that anything is missing.
    //
    // The TXT record carries the identity so a browsing client can label the camera before connecting.
    state.withLock {
      $0.advertise = advertise
      $0.path = path
    }
    if advertise {
      let ip = Self.lanIPv4()
      listener.service = Self.bonjourService(
        identity: identity(),
        path: path,
        ip: ip,
        port: Int(port)
      )
      startLocalNetworkKeepAlive()
      startPathMonitor()
    }

    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    listener.stateUpdateHandler = { [weak self] listenerState in
      guard let self else { return }
      switch listenerState {
      case .ready:
        let bound = listener.port?.rawValue ?? port
        cancelRebind()
        update {
          $0.isListening = true
          $0.port = bound
          $0.requestedPort = requested
          $0.lastError = nil
          $0.listenerState = "ready"
        }
        if advertise {
          let ip = Self.lanIPv4()
          listener.service = Self.bonjourService(
            identity: self.identity(),
            path: path,
            ip: ip,
            port: Int(bound)
          )
          self.publishAWX(identity: self.identity(), path: path, ip: ip, port: Int(bound))
        }
      case .failed(let error):
        // Only the current listener may report. A rebind leaves the previous one to finish dying,
        // and its late callback would otherwise overwrite the new listener's `ready` with a fault
        // that is already history.
        guard clearIfCurrent(listener) else { return }
        update {
          $0.isListening = false
          $0.port = nil
          $0.lastError = "listener failed on \(port): \(error.localizedDescription)"
          $0.listenerState = "failed"
        }
        scheduleRebind()
      case .cancelled:
        // A cancel this server asked for goes through `stopLocked`, which drops its reference
        // first, so still being the current listener here means something else took it — a
        // backgrounded scene, or a network path that went away. Those are the cases worth
        // recovering from; a deliberate stop keeps the `stopped` state `stopLocked` already set.
        guard clearIfCurrent(listener) else { return }
        update {
          $0.isListening = false
          $0.port = nil
          $0.listenerState = "cancelled"
        }
        scheduleRebind()
      default:
        guard isCurrent(listener) else { return }
        update { $0.listenerState = String(describing: listenerState) }
      }
    }

    state.withLock { $0.listener = listener }
    listener.start(queue: queue)
    return true
  }

  private func accept(_ connection: NWConnection) {
    let client = RTSPClientConnection(
      connection: connection,
      queue: queue,
      sdp: describe,
      hasAudio: hasAudio(),
      identity: identity,
      requestKeyframe: requestKeyframe,
      parameters: parameters
    )
    let key = ObjectIdentifier(client)
    client.onClose = { [weak self] reason in
      self?.noteDisconnect(key: key, reason: reason)
    }
    client.onStreamingChange = { [weak self] in
      self?.recountClients()
    }

    let updated = state.withLock { current -> Status in
      current.connections[key] = client
      current.status.clientCount = Self.playingCount(current.connections)
      current.status.acceptedClients += 1
      return current.status
    }
    onStatusChange?(updated)
    client.start()
  }

  private func noteDisconnect(key: ObjectIdentifier, reason: String) {
    let updated = state.withLock { current -> Status in
      current.connections[key] = nil
      current.status.clientCount = Self.playingCount(current.connections)
      current.status.closedClients += 1
      current.status.lastDisconnectReason = reason
      return current.status
    }
    onStatusChange?(updated)
  }

  private func recountClients() {
    let updated: Status? = state.withLock { current -> Status? in
      let playing = Self.playingCount(current.connections)
      guard playing != current.status.clientCount else { return nil }
      current.status.clientCount = playing
      return current.status
    }
    if let updated { onStatusChange?(updated) }
  }

  private static func playingCount(_ connections: [ObjectIdentifier: RTSPClientConnection]) -> Int {
    connections.values.filter(\.isStreaming).count
  }

  private func stopLocked(clearingRequest: Bool = true) {
    let (listener, connections) = state.withLock { current -> (NWListener?, [RTSPClientConnection]) in
      let result = (current.listener, Array(current.connections.values))
      current.listener = nil
      current.connections = [:]
      if clearingRequest { current.startRequest = nil }
      return result
    }
    listener?.cancel()
    for connection in connections { connection.close() }
    pathMonitor?.cancel()
    pathMonitor = nil
    localNetworkBrowser?.cancel()
    localNetworkBrowser = nil
    let awx = awxAdvertisement
    awxAdvertisement = nil
    DispatchQueue.main.async { awx?.stop() }
    update {
      $0.isListening = false
      $0.port = nil
      $0.clientCount = 0
      $0.listenerState = "stopped"
    }
  }

  private func isCurrent(_ listener: NWListener) -> Bool {
    state.withLock { $0.listener === listener }
  }

  /// Drops the server's reference to `listener` if it is still the current one, reporting whether
  /// it was. Lets a state handler tell a listener that died under it from one this server replaced.
  private func clearIfCurrent(_ listener: NWListener) -> Bool {
    state.withLock { current in
      guard current.listener === listener else { return false }
      current.listener = nil
      return true
    }
  }

  /// Backoff between rebind attempts, so a port that is genuinely held by something else does not
  /// spin. Reset once a listener reaches `.ready`.
  private static let rebindDelays: [Double] = [0.5, 1, 2, 5, 10]

  private func scheduleRebind() {
    guard state.withLock({ $0.startRequest != nil }), rebindWork == nil else { return }
    let delay = Self.rebindDelays[min(rebindAttempt, Self.rebindDelays.count - 1)]
    rebindAttempt += 1
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      rebindWork = nil
      // `stop` or a successful `ensureListening` may have overtaken this while it waited.
      guard state.withLock({ $0.startRequest != nil && $0.listener == nil }) else { return }
      bindStartRequest()
    }
    rebindWork = work
    queue.asyncAfter(deadline: .now() + delay, execute: work)
  }

  private func cancelRebind() {
    rebindWork?.cancel()
    rebindWork = nil
    rebindAttempt = 0
  }

  private func startPathMonitor() {
    guard pathMonitor == nil else { return }
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] _ in
      self?.refreshAdvertisement()
    }
    monitor.start(queue: queue)
    pathMonitor = monitor
  }

  private func startLocalNetworkKeepAlive() {
    guard localNetworkBrowser == nil else { return }
    let parameters = NWParameters()
    parameters.includePeerToPeer = true
    let browser = NWBrowser(
      for: .bonjourWithTXTRecord(type: "_awx_service._tcp", domain: "local."),
      using: parameters
    )
    localNetworkBrowser = browser
    browser.start(queue: queue)
  }

  private func publishAWX(identity: DeviceIdentity, path: String, ip: String?, port: Int) {
    let data = Self.txtRecordData(
      Self.bonjourTXT(identity: identity, path: path, ip: ip, port: port)
    )
    if let existing = awxAdvertisement {
      if existing.port == port, existing.name == identity.name {
        existing.setTXTRecord(data)
        return
      }
      awxAdvertisement = nil
      DispatchQueue.main.async { existing.stop() }
    }

    let service = NetService(
      domain: "local.",
      type: Self.awxServiceType,
      name: identity.name,
      port: Int32(port)
    )
    service.includesPeerToPeer = true
    service.setTXTRecord(data)
    awxAdvertisement = service
    DispatchQueue.main.async { service.publish() }
  }

  private static func txtRecordData(_ fields: [String: String]) -> Data {
    let record = Dictionary(uniqueKeysWithValues: fields.map { ($0.key, Data($0.value.utf8)) })
    return NetService.data(fromTXTRecord: record)
  }

  private func update(_ change: @Sendable (inout Status) -> Void) {
    let updated = state.withLock { current -> Status in
      change(&current.status)
      return current.status
    }
    onStatusChange?(updated)
  }

  // MARK: - Media

  /// Test-only late-delivery injection. Idle by default and a straight pass-through when idle.
  public let sendDelay = SendDelayLine()

  public func send(video frame: EncodedVideoFrame, codec: StreamCodec) {
    sendDelay.submit { [weak self] in
      guard let self else { return }
      let clients = self.state.withLock { Array($0.connections.values) }
      for client in clients { client.send(video: frame, codec: codec) }
    }
  }

  public func send(audio frame: EncodedAudioFrame) {
    sendDelay.submit { [weak self] in
      guard let self else { return }
      let clients = self.state.withLock { Array($0.connections.values) }
      for client in clients { client.send(audio: frame) }
    }
  }

  /// Aggregate backpressure across clients, for the HUD. A single slow client is worth seeing before
  /// it is diagnosed as an encoder problem.
  public func sendQueueSummaries() -> [StreamSendQueue] {
    state.withLock { Array($0.connections.values) }.map(\.sendQueue)
  }

  /// The worst playing client's link since the previous call, or nil when nobody is playing.
  ///
  /// Every connection is sampled, playing or not, so each one's interval starts from this call
  /// rather than from whenever it last happened to be the worst.
  public func sampleCongestion(_ completion: @escaping @Sendable (CongestionSample?) -> Void) {
    queue.async { [self] in
      let now = ProcessInfo.processInfo.systemUptime
      let clients = state.withLock { Array($0.connections.values) }
      completion(CongestionSample.worst(of: clients.compactMap { $0.congestionSample(at: now) }))
    }
  }
}
