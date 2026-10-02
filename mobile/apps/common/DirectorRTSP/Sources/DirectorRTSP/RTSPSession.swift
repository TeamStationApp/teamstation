import Foundation
import Network

/// Drives one camera from `OPTIONS` to `PLAY` and then pumps interleaved RTP off the socket.
///
/// Transport is RTP over the RTSP TCP connection. That needs one socket and no port allocation, it
/// avoids iOS's local-network and NAT complications, and loss shows up as a stall rather than as
/// silent corruption. The cost is head-of-line blocking, which on a LAN is not a practical concern.
public final class RTSPSession: @unchecked Sendable {
  public enum Transport: String, Sendable, CaseIterable {
    case tcp
    case udp
  }

  public struct Configuration: Sendable {
    public var host: String
    public var port: Int
    public var path: String
    public var username: String?
    public var password: String?
    public var transport: Transport
    public var userAgent: String

    public init(
      host: String,
      port: Int = 554,
      path: String = "/live/mainstream",
      username: String? = nil,
      password: String? = nil,
      transport: Transport = .tcp,
      userAgent: String = "TS Director/1.0"
    ) {
      self.host = host
      self.port = port
      self.path = path
      self.username = username
      self.password = password
      self.transport = transport
      self.userAgent = userAgent
    }

    public var url: String { "rtsp://\(host):\(port)\(path)" }
  }

  /// Which interleaved channel carries what, once the camera has confirmed it.
  public struct Channels: Sendable, Equatable {
    public var video: UInt8
    public var audio: UInt8?
  }

  public enum Event: Sendable {
    case playing(description: SDPDescription, channels: Channels)
    case packet(channel: UInt8, packet: RTPPacket)
    case rtcp(RTCPReport)
    /// Every way a session can end arrives here, including the camera closing the socket cleanly:
    /// from the receiver's point of view an orderly shutdown mid-game is still a failure.
    case failed(reason: String)
  }

  public typealias EventHandler = @Sendable (Event) -> Void

  private enum Keepalive {
    case getParameter
    case options
  }

  public let configuration: Configuration

  private let onEvent: EventHandler
  private let queue: DispatchQueue
  private let lock = NSLock()
  private var receivedBytes: UInt64 = 0

  private var connection: NWConnection?
  private var parser = RTSPStreamParser()
  private var builder: RTSPRequestBuilder
  private var pending: [Int: @Sendable (RTSPResponse) -> Void] = [:]
  private var challenge: RTSPAuthChallenge?
  private var contentBase: String
  private var channels = Channels(video: 0, audio: nil)
  private var keepaliveTimer: DispatchSourceTimer?
  private var keepaliveMethod = Keepalive.getParameter
  private var isStopped = false
  private var isPlaying = false

  public init(configuration: Configuration, onEvent: @escaping EventHandler) {
    self.configuration = configuration
    self.onEvent = onEvent
    contentBase = configuration.url
    builder = RTSPRequestBuilder(userAgent: configuration.userAgent)
    queue = DispatchQueue(label: "app.teamstation.director.rtsp.\(configuration.host)")
  }

  public func start() {
    guard configuration.transport == .tcp else {
      // The launch argument exists so UDP can be tried later. Quietly using TCP instead would make
      // a flow that asked for UDP look like it had tested UDP.
      onEvent(.failed(reason: "transport \(configuration.transport.rawValue) is not implemented"))
      return
    }

    guard let port = NWEndpoint.Port(rawValue: UInt16(configuration.port)) else {
      onEvent(.failed(reason: "invalid port \(configuration.port)"))
      return
    }

    let parameters = NWParameters.tcp
    parameters.includePeerToPeer = true
    // A control connection that Nagles delays every request by up to 40 ms, and the setup handshake
    // is five round trips before a single frame arrives.
    if let options = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
      options.noDelay = true
      options.connectionTimeout = 8
    }

    let connection = NWConnection(
      host: NWEndpoint.Host(configuration.host),
      port: port,
      using: parameters
    )

    lock.lock()
    isStopped = false
    self.connection = connection
    lock.unlock()

    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        receiveNext()
        beginHandshake()
      case let .failed(error):
        finish(reason: "connection failed: \(error.localizedDescription)")
      case .cancelled:
        break
      case .waiting:
        // iOS-to-iOS RTSP (TS Cameraman) sits in `.waiting` for Local Network / peer-to-peer
        // before `.ready`. NearStream boxes skip this state; aborting it made the iPhone look dead.
        break
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  public func stop() {
    lock.lock()
    guard !isStopped else {
      lock.unlock()
      return
    }
    isStopped = true
    let connection = self.connection
    let wasPlaying = isPlaying
    var teardownBuilder = builder
    let session = builder.session
    let base = contentBase
    keepaliveTimer?.cancel()
    keepaliveTimer = nil
    pending.removeAll()
    isPlaying = false
    lock.unlock()

    // Best effort: a camera that never sees TEARDOWN keeps the session until its timeout expires,
    // and these cameras refuse a second session while the first is alive.
    if wasPlaying, session != nil, let connection {
      let request = teardownBuilder.make(.teardown, uri: base)
      connection.send(content: request.wireFormat, completion: .contentProcessed { _ in
        connection.cancel()
      })
    } else {
      connection?.cancel()
    }

    lock.lock()
    self.connection = nil
    lock.unlock()
  }

  // MARK: - Handshake

  private func beginHandshake() {
    send(.options, uri: configuration.url) { [weak self] response in
      guard let self else { return }
      guard response.isSuccess else {
        finish(reason: "OPTIONS failed: \(response.statusCode) \(response.reasonPhrase)")
        return
      }
      describe()
    }
  }

  private func describe() {
    send(.describe, uri: configuration.url, headers: [ (name: "Accept", value: "application/sdp") ]) {
      [weak self] response in
      guard let self else { return }
      guard response.isSuccess else {
        finish(reason: "DESCRIBE failed: \(response.statusCode) \(response.reasonPhrase)")
        return
      }

      let description = SDPDescription.parse(response.bodyText)
      guard let video = description.video, video.videoCodec != nil else {
        finish(reason: "no supported video track in the session description")
        return
      }

      // Content-Base is what track control URLs resolve against; without it a relative
      // `trackID=0` is joined to the request URL, which some cameras answer with 404.
      lock.lock()
      contentBase = response.header("content-base")
        ?? response.header("content-location")
        ?? configuration.url
      lock.unlock()

      setupVideo(description: description)
    }
  }

  private func setupVideo(description: SDPDescription) {
    let uri = SDPDescription.absoluteControlURL(control: description.video?.control, base: contentBase)
    send(.setup, uri: uri, headers: [
      (name: "Transport", value: "RTP/AVP/TCP;unicast;interleaved=0-1")
    ]) { [weak self] response in
      guard let self else { return }
      guard response.isSuccess else {
        finish(reason: "SETUP video failed: \(response.statusCode) \(response.reasonPhrase)")
        return
      }

      lock.lock()
      builder.session = response.session
      channels.video = Self.interleavedChannel(in: response.header("transport")) ?? 0
      lock.unlock()

      guard let audio = description.audio, audio.aacFraming != nil else {
        play(description: description)
        return
      }
      setupAudio(description: description)
    }
  }

  private func setupAudio(description: SDPDescription) {
    let uri = SDPDescription.absoluteControlURL(control: description.audio?.control, base: contentBase)
    send(.setup, uri: uri, headers: [
      (name: "Transport", value: "RTP/AVP/TCP;unicast;interleaved=2-3")
    ]) { [weak self] response in
      guard let self else { return }
      // Audio is worth having but not worth failing the camera for: a video-only tile is still a
      // usable tile.
      if response.isSuccess {
        lock.lock()
        channels.audio = Self.interleavedChannel(in: response.header("transport")) ?? 2
        lock.unlock()
      }
      play(description: description)
    }
  }

  private func play(description: SDPDescription) {
    send(.play, uri: contentBase, headers: [ (name: "Range", value: "npt=0.000-") ]) {
      [weak self] response in
      guard let self else { return }
      guard response.isSuccess else {
        finish(reason: "PLAY failed: \(response.statusCode) \(response.reasonPhrase)")
        return
      }

      lock.lock()
      isPlaying = true
      let channels = self.channels
      let timeout = response.sessionTimeout
      lock.unlock()

      startKeepalive(timeout: timeout)
      onEvent(.playing(description: description, channels: channels))
    }
  }

  /// `interleaved=2-3` — the camera may not echo the channels that were asked for.
  static func interleavedChannel(in transport: String?) -> UInt8? {
    guard let transport else { return nil }
    for parameter in transport.split(separator: ";") {
      let parts = parameter.split(separator: "=", maxSplits: 1)
      guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "interleaved" else {
        continue
      }
      let channels = parts[1].split(separator: "-")
      return channels.first.flatMap { UInt8($0.trimmingCharacters(in: .whitespaces)) }
    }
    return nil
  }

  // MARK: - Keepalive

  private func startKeepalive(timeout: Int) {
    // Half the session timeout: one lost keepalive then still has a chance before the camera drops
    // the session out from under a running game.
    let interval = max(10, timeout / 2)

    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + .seconds(interval), repeating: .seconds(interval))
    timer.setEventHandler { [weak self] in self?.sendKeepalive() }

    lock.lock()
    keepaliveTimer?.cancel()
    keepaliveTimer = timer
    lock.unlock()
    timer.resume()
  }

  private func sendKeepalive() {
    lock.lock()
    let method = keepaliveMethod
    lock.unlock()

    send(method == .getParameter ? .getParameter : .options, uri: contentBase) { [weak self] response in
      guard let self else { return }
      // Not every camera implements GET_PARAMETER even when it advertises it; OPTIONS keeps a
      // session alive just as well.
      if response.statusCode == 501, method == .getParameter {
        lock.lock()
        keepaliveMethod = .options
        lock.unlock()
      }
    }
  }

  // MARK: - Socket

  private func send(
    _ method: RTSPMethod,
    uri: String,
    headers: [(name: String, value: String)] = [],
    completion: @escaping @Sendable (RTSPResponse) -> Void
  ) {
    lock.lock()
    guard !isStopped, let connection else {
      lock.unlock()
      return
    }
    let request = builder.make(method, uri: uri, headers: headers)
    pending[request.cseq] = { [weak self] response in
      guard let self else { return }
      // A 401 is answered once, with the challenge applied, and the retry gets a new CSeq.
      if response.statusCode == 401,
         let header = response.header("www-authenticate"),
         let parsed = RTSPAuthChallenge.parse(header),
         let username = configuration.username {
        lock.lock()
        let alreadyTried = challenge != nil
        challenge = parsed
        if !alreadyTried {
          builder.authorization = RTSPAuthorization.header(
            for: parsed,
            method: method,
            uri: uri,
            username: username,
            password: configuration.password ?? ""
          )
        }
        lock.unlock()

        if !alreadyTried {
          send(method, uri: uri, headers: headers, completion: completion)
          return
        }
      }
      completion(response)
    }
    lock.unlock()

    connection.send(content: request.wireFormat, completion: .contentProcessed { [weak self] error in
      guard let error else { return }
      self?.finish(reason: "send failed: \(error.localizedDescription)")
    })
  }

  private func receiveNext() {
    lock.lock()
    let connection = self.connection
    lock.unlock()
    guard let connection else { return }

    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }

      if let data, !data.isEmpty {
        handle(received: data)
      }
      if let error {
        finish(reason: "receive failed: \(error.localizedDescription)")
        return
      }
      if isComplete {
        finish(reason: "camera closed the connection")
        return
      }
      receiveNext()
    }
  }

  /// Every byte this session has read off the socket, media and responses alike. The tile's rate
  /// readout is built on it, so it counts what the link carried rather than what decoded.
  public var bytesReceived: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return receivedBytes
  }

  private func handle(received data: Data) {
    lock.lock()
    receivedBytes &+= UInt64(data.count)
    parser.append(data)
    var items: [RTSPStreamItem] = []
    while let item = parser.next() { items.append(item) }
    lock.unlock()

    for item in items {
      switch item {
      case let .interleaved(channel, payload):
        if channel.isMultiple(of: 2) {
          // Even channels are RTP. Odd channels are RTCP for the preceding even channel.
          guard let packet = RTPPacket.parse(payload) else { continue }
          onEvent(.packet(channel: channel, packet: packet))
        } else if let report = RTCPReport.parse(payload), !report.isEmpty {
          onEvent(.rtcp(report))
        }

      case let .response(response):
        lock.lock()
        let handler = response.cseq.flatMap { pending.removeValue(forKey: $0) }
        lock.unlock()
        handler?(response)
      }
    }
  }

  private func finish(reason: String) {
    lock.lock()
    guard !isStopped else {
      lock.unlock()
      return
    }
    isStopped = true
    let connection = self.connection
    self.connection = nil
    keepaliveTimer?.cancel()
    keepaliveTimer = nil
    pending.removeAll()
    isPlaying = false
    lock.unlock()

    connection?.cancel()
    onEvent(.failed(reason: reason))
  }
}
