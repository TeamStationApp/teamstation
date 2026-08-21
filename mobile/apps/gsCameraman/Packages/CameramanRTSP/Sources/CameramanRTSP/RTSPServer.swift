import CameramanCore
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
      listener.service = Self.bonjourService(identity: identity(), path: path)
    }
  }

  /// TXT keys Director reads for Cameraman identity. `uuid` is the CNAME; `name` is the label.
  public static func bonjourTXT(identity: DeviceIdentity, path: String) -> [String: String] {
    [
      "uuid": identity.cname,
      "name": identity.name,
      "path": path
    ]
  }

  public static func bonjourService(identity: DeviceIdentity, path: String) -> NWListener.Service {
    NWListener.Service(
      name: identity.name,
      type: bonjourServiceType,
      txtRecord: NWTXTRecord(bonjourTXT(identity: identity, path: path))
    )
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
      listener.service = Self.bonjourService(identity: identity(), path: path)
    }

    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    listener.stateUpdateHandler = { [weak self] listenerState in
      guard let self else { return }
      switch listenerState {
      case .ready:
        update {
          $0.isListening = true
          $0.port = listener.port?.rawValue ?? port
          $0.requestedPort = requested
          $0.lastError = nil
        }
      case .failed(let error):
        update {
          $0.isListening = false
          $0.port = nil
          $0.lastError = "listener failed on \(port): \(error.localizedDescription)"
        }
      case .cancelled:
        update {
          $0.isListening = false
          $0.port = nil
        }
      default:
        break
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
    client.onClose = { [weak self] in
      self?.updateConnections { $0[key] = nil }
    }

    updateConnections { $0[key] = client }
    client.start()
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
    }
  }

  /// Edits the connection table and republishes the count in one lock acquisition.
  ///
  /// `OSAllocatedUnfairLock` is not recursive, so the count must be taken inside the same critical
  /// section that changed the table rather than by calling back in for it.
  private func updateConnections(
    _ change: @Sendable (inout [ObjectIdentifier: RTSPClientConnection]) -> Void
  ) {
    let updated = state.withLock { current -> Status in
      change(&current.connections)
      current.status.clientCount = current.connections.count
      return current.status
    }
    onStatusChange?(updated)
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
