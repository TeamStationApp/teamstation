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

  private struct MutableState {
    var listener: NWListener?
    var connections: [ObjectIdentifier: RTSPClientConnection] = [:]
    var status = Status()
    var advertise = false
    var path = "/live/mainstream"
  }

  public var onStatusChange: (@Sendable (Status) -> Void)?

  public var status: Status { state.withLock { $0.status } }

  /// The SDP is produced on demand rather than held, because the parameter sets are not known until
  /// the encoder has produced its first frame, and a client may DESCRIBE before then.
  public init(
    describe: @escaping @Sendable (UInt32, UInt32) -> String,
    hasAudio: @escaping @Sendable () -> Bool,
    identity: @escaping @Sendable () -> DeviceIdentity,
    requestKeyframe: @escaping @Sendable () -> Void
  ) {
    self.describe = describe
    self.hasAudio = hasAudio
    self.identity = identity
    self.requestKeyframe = requestKeyframe
  }

  /// Binds `port`, falling back to `fallbackPort` if it is taken. A bind failure is a visible status
  /// rather than a thrown error, because the app has to keep running and show the operator why.
  public func start(port: UInt16, fallbackPort: UInt16, path: String, advertise: Bool = true) {
    queue.async { [self] in
      stopLocked()
      if !bind(port: port, requested: port, path: path, advertise: advertise) {
        _ = bind(port: fallbackPort, requested: port, path: path, advertise: advertise)
      }
    }
  }

  public func stop() {
    queue.async { [self] in stopLocked() }
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
      listener.service = Self.bonjourService(
        identity: identity(),
        path: path,
        ip: Self.lanIPv4(),
        port: listener.port.map { Int($0.rawValue) }
      )
    }
  }

  /// TXT keys Director reads for Cameraman identity. `uuid` is the CNAME; `name` is the label.
  /// `ip` / `port` let GS Director bind without resolving the Bonjour UUID hostname, which
  /// often has no usable A-record from another iOS device.
  public static func bonjourTXT(
    identity: DeviceIdentity,
    path: String,
    ip: String? = nil,
    port: Int? = nil
  ) -> [String: String] {
    var fields = [
      "uuid": identity.cname,
      "name": identity.name,
      "path": path
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

  /// Wi-Fi IPv4 (`en0`). Director cannot use the Bonjour UUID hostname as an RTSP URL.
  public static func lanIPv4() -> String? {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return nil }
    defer { freeifaddrs(head) }
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let interface = pointer.pointee
      guard interface.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
      let name = String(cString: interface.ifa_name)
      guard name == "en0" || name.hasPrefix("bridge") else { continue }
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
      let address = String(cString: buffer)
      if address != "127.0.0.1", !address.hasPrefix("169.254.") { return address }
    }
    return nil
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
      listener.service = Self.bonjourService(
        identity: identity(),
        path: path,
        ip: Self.lanIPv4(),
        port: Int(port)
      )
    }

    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    listener.stateUpdateHandler = { [weak self] listenerState in
      guard let self else { return }
      switch listenerState {
      case .ready:
        let bound = listener.port?.rawValue ?? port
        update {
          $0.isListening = true
          $0.port = bound
          $0.requestedPort = requested
          $0.lastError = nil
          $0.listenerState = "ready"
        }
        if advertise {
          listener.service = Self.bonjourService(
            identity: self.identity(),
            path: path,
            ip: Self.lanIPv4(),
            port: Int(bound)
          )
        }
      case .failed(let error):
        update {
          $0.isListening = false
          $0.port = nil
          $0.lastError = "listener failed on \(port): \(error.localizedDescription)"
          $0.listenerState = "failed"
        }
      case .cancelled:
        update {
          $0.isListening = false
          $0.port = nil
          $0.listenerState = "cancelled"
        }
      default:
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
      requestKeyframe: requestKeyframe
    )
    let key = ObjectIdentifier(client)
    client.onClose = { [weak self] reason in
      self?.noteDisconnect(key: key, reason: reason)
    }

    let updated = state.withLock { current -> Status in
      current.connections[key] = client
      current.status.clientCount = current.connections.count
      current.status.acceptedClients += 1
      return current.status
    }
    onStatusChange?(updated)
    client.start()
  }

  private func noteDisconnect(key: ObjectIdentifier, reason: String) {
    let updated = state.withLock { current -> Status in
      current.connections[key] = nil
      current.status.clientCount = current.connections.count
      current.status.closedClients += 1
      current.status.lastDisconnectReason = reason
      return current.status
    }
    onStatusChange?(updated)
  }

  private func stopLocked() {
    let (listener, connections) = state.withLock { current -> (NWListener?, [RTSPClientConnection]) in
      let result = (current.listener, Array(current.connections.values))
      current.listener = nil
      current.connections = [:]
      return result
    }
    listener?.cancel()
    for connection in connections { connection.close() }
    update {
      $0.isListening = false
      $0.port = nil
      $0.clientCount = 0
      $0.listenerState = "stopped"
    }
  }

  private func update(_ change: @Sendable (inout Status) -> Void) {
    let updated = state.withLock { current -> Status in
      change(&current.status)
      return current.status
    }
    onStatusChange?(updated)
  }

  // MARK: - Media

  public func send(video frame: EncodedVideoFrame, codec: StreamCodec) {
    let clients = state.withLock { Array($0.connections.values) }
    for client in clients { client.send(video: frame, codec: codec) }
  }

  public func send(audio frame: EncodedAudioFrame) {
    let clients = state.withLock { Array($0.connections.values) }
    for client in clients { client.send(audio: frame) }
  }

  /// Aggregate backpressure across clients, for the HUD. A single slow client is worth seeing before
  /// it is diagnosed as an encoder problem.
  public func sendQueueSummaries() -> [StreamSendQueue] {
    state.withLock { Array($0.connections.values) }.map(\.sendQueue)
  }
}
