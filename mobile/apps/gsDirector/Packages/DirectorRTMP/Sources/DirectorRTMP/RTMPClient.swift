import Darwin
import Foundation
import Network

public enum RTMPClientError: Error, CustomStringConvertible, Equatable {
  case cancelled
  case timeout
  case connectFailed(String)
  case rejected(String)
  case disconnected(String)

  public var description: String {
    switch self {
    case .cancelled: "streaming stopped"
    case .timeout: "stream server did not answer in time"
    case let .connectFailed(reason): "could not connect to stream server: \(reason)"
    case let .rejected(reason): reason
    case let .disconnected(reason): "stream disconnected: \(reason)"
    }
  }
}

/// Publishes H.264 + AAC FLV tags over RTMP. Metrics count bytes that left the socket and tags
/// that did not, which is the OBS "dropped frames (network)" number rather than TCP retransmits.
public final class RTMPClient: @unchecked Sendable {
  public struct Metrics: Sendable, Equatable {
    public var megabitsPerSecond: Double = 0
    public var droppedPackets: UInt64 = 0

    public init(megabitsPerSecond: Double = 0, droppedPackets: UInt64 = 0) {
      self.megabitsPerSecond = megabitsPerSecond
      self.droppedPackets = droppedPackets
    }
  }

  public typealias FailureHandler = @Sendable (RTMPClientError) -> Void

  private let queue = DispatchQueue(label: "co.gamestation.director.rtmp")
  private static let queueKey = DispatchSpecificKey<UInt8>()
  private let lock = NSLock()
  private var connection: NWConnection?
  private var reader = RTMPChunkReader()
  private var handshakeBuffer = Data()
  private var phase = Phase.idle
  private var outChunkSize = RTMPChunk.defaultSize
  private var streamID: UInt32 = 0
  private var bytesSent: UInt64 = 0
  private var bytesThisWindow: UInt64 = 0
  private var windowStarted = CFAbsoluteTimeGetCurrent()
  private var megabitsPerSecond: Double = 0
  private var droppedPackets: UInt64 = 0
  private var sendQueue: [Data] = []
  private var isSending = false
  private var connectWait: CheckedContinuation<Void, Error>?
  private var onFailure: FailureHandler?
  private var url: RTMPURL?
  private var socketReady = false

  private enum Phase {
    case idle, handshaking, connected, creatingStream, publishing, live, failed
  }

  private static let maxQueuedBytes = 256 * 1024
  private static let commandChunk: UInt32 = 3
  private static let dataChunk: UInt32 = 4
  private static let audioChunk: UInt32 = 8
  private static let videoChunk: UInt32 = 9
  private static let controlChunk: UInt32 = 2

  public init() {
    queue.setSpecific(key: Self.queueKey, value: 1)
  }

  public var metrics: Metrics {
    lock.lock()
    defer { lock.unlock() }
    refreshMegabitsLocked()
    return Metrics(megabitsPerSecond: megabitsPerSecond, droppedPackets: droppedPackets)
  }

  public var isLive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return phase == .live
  }

  public func publish(to url: RTMPURL, timeoutSeconds: Double = 12) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async {
        self.begin(url: url, continuation: continuation)
        self.queue.asyncAfter(deadline: .now() + timeoutSeconds) {
          self.lock.lock()
          let waiting = self.connectWait != nil && self.phase != .live
          let ready = self.socketReady
          self.lock.unlock()
          if waiting {
            self.fail(
              ready ? .timeout : .connectFailed("could not open a TCP connection to the stream server"),
              notifyWaiter: true
            )
          }
        }
      }
    }
  }

  public func stop() {
    queue.async { self.fail(.cancelled, notifyWaiter: true) }
  }

  public func onFailure(_ handler: @escaping FailureHandler) {
    lock.lock()
    onFailure = handler
    lock.unlock()
  }

  public func sendVideo(timestampMs: UInt32, tag: Data) {
    enqueueMedia(type: .video, chunkStreamID: Self.videoChunk, timestamp: timestampMs, payload: tag)
  }

  public func sendAudio(timestampMs: UInt32, tag: Data) {
    enqueueMedia(type: .audio, chunkStreamID: Self.audioChunk, timestamp: timestampMs, payload: tag)
  }

  public func sendMetadata(width: Int, height: Int, frameRate: Int, bitrate: Int) {
    queue.async {
      self.lock.lock()
      let streamID = self.streamID
      let live = self.phase == .live
      self.lock.unlock()
      guard live else { return }
      let payload = AMF0.encode([
        .string("@setDataFrame"),
        .string("onMetaData"),
        .ecmaArray([
          "duration": .number(0),
          "width": .number(Double(width)),
          "height": .number(Double(height)),
          "framerate": .number(Double(frameRate)),
          "videodatarate": .number(Double(bitrate) / 1000),
          "videocodecid": .number(7),
          "audiodatarate": .number(128),
          "audiocodecid": .number(10),
          "audiosamplerate": .number(48_000),
          "audiochannels": .number(2),
          "stereo": .boolean(true)
        ])
      ])
      self.write(
        RTMPChunk.encode(
          RTMPMessage(streamID: streamID, type: .amf0Data, timestamp: 0, payload: payload),
          chunkStreamID: Self.dataChunk,
          chunkSize: self.outChunkSize
        )
      )
    }
  }

  private func begin(url: RTMPURL, continuation: CheckedContinuation<Void, Error>) {
    lock.lock()
    if phase != .idle {
      lock.unlock()
      continuation.resume(throwing: RTMPClientError.connectFailed("already started"))
      return
    }
    connectWait = continuation
    self.url = url
    phase = .handshaking
    handshakeBuffer.removeAll()
    reader = RTMPChunkReader()
    socketReady = false
    lock.unlock()

    guard let port = NWEndpoint.Port(rawValue: UInt16(url.port)) else {
      fail(.connectFailed("invalid port \(url.port)"), notifyWaiter: true)
      return
    }
    let parameters = NWParameters.tcp
    if let options = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
      options.noDelay = true
      options.connectionTimeout = 8
    }
    // Prefer IPv6, then IPv4. Dual-stack hostname lookup in Network.framework can sit in
    // `.preparing` until the handshake timeout when one family is firewalled.
    let host = Self.ipLiteral(for: url.host, family: AF_INET6)
      ?? Self.ipLiteral(for: url.host, family: AF_INET)
      ?? url.host
    let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: parameters)
    self.connection = connection
    connection.stateUpdateHandler = { [weak self] state in
      self?.handle(state: state)
    }
    connection.start(queue: queue)
  }

  /// Literal address for `host` in `family` (`AF_INET` or `AF_INET6`), or nil if lookup fails.
  private static func ipLiteral(for host: String, family: Int32) -> String? {
    if family == AF_INET, IPv4Address(host) != nil { return host }
    if family == AF_INET6, IPv6Address(host) != nil { return host }
    var hints = addrinfo()
    hints.ai_family = family
    hints.ai_socktype = SOCK_STREAM
    var info: UnsafeMutablePointer<addrinfo>?
    let code = host.withCString { getaddrinfo($0, nil, &hints, &info) }
    guard code == 0, let first = info else { return nil }
    defer { freeaddrinfo(info) }
    guard let raw = first.pointee.ai_addr else { return nil }
    if family == AF_INET {
      let sin = raw.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
      var address = sin.sin_addr
      var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
      inet_ntop(AF_INET, &address, &buffer, socklen_t(INET_ADDRSTRLEN))
      let literal = String(cString: buffer)
      return literal.isEmpty ? nil : literal
    }
    let sin6 = raw.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee }
    var address = sin6.sin6_addr
    var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
    inet_ntop(AF_INET6, &address, &buffer, socklen_t(INET6_ADDRSTRLEN))
    let literal = String(cString: buffer)
    return literal.isEmpty ? nil : literal
  }

  private func handle(state: NWConnection.State) {
    switch state {
    case .ready:
      lock.lock()
      socketReady = true
      lock.unlock()
      receive()
      write(RTMPHandshake.c0c1())
    case let .failed(error):
      fail(.connectFailed(error.localizedDescription), notifyWaiter: true)
    case .cancelled:
      fail(.cancelled, notifyWaiter: true)
    default:
      break
    }
  }

  private func receive() {
    connection?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      self.queue.async {
        if let error {
          self.fail(.disconnected(error.localizedDescription), notifyWaiter: true)
          return
        }
        if let data, !data.isEmpty { self.handle(received: data) }
        if isComplete {
          self.fail(.disconnected("server closed the socket"), notifyWaiter: true)
          return
        }
        self.receive()
      }
    }
  }

  private func handle(received data: Data) {
    lock.lock()
    let phase = self.phase
    lock.unlock()
    if phase == .handshaking {
      handshakeBuffer.append(data)
      guard let hello = RTMPHandshake.splitServerHello(handshakeBuffer) else { return }
      let consumed = 1 + RTMPHandshake.packetSize * 2
      let leftover = handshakeBuffer.count > consumed ? Data(handshakeBuffer[consumed...]) : Data()
      handshakeBuffer.removeAll()
      write(RTMPHandshake.c2(fromS1: hello.s1))
      sendConnect()
      if !leftover.isEmpty {
        let messages = reader.push(leftover)
        for message in messages { handle(message: message) }
      }
      return
    }
    let messages = reader.push(data)
    for message in messages { handle(message: message) }
  }

  private func handle(message: RTMPMessage) {
    switch message.type {
    case .setChunkSize:
      if message.payload.count >= 4 {
        let size = Int(readUInt32BE(message.payload))
        if size > 0 { reader.setChunkSize(size) }
      }
    case .windowAckSize, .setPeerBandwidth, .userControl, .acknowledgement, .abort:
      break
    case .amf0Command, .amf3Command:
      handleCommand(message.payload)
    default:
      break
    }
  }

  private func handleCommand(_ payload: Data) {
    let values = AMF0.decodeList(payload)
    guard let name = values.first?.stringValue else { return }
    let tx = values.dropFirst().first?.numberValue.map { Int($0) } ?? 0
    switch name {
    case "_result":
      lock.lock()
      let phase = self.phase
      lock.unlock()
      if phase == .connected, tx == 1 {
        sendCreateStream()
      } else if phase == .creatingStream {
        let stream = values.dropFirst(3).first?.numberValue.map { UInt32($0) } ?? 1
        sendPublish(streamID: stream)
      }
    case "_error":
      let detail = values.compactMap(\.objectValue).first?["description"]?.stringValue
        ?? "stream server rejected the publish"
      fail(.rejected(detail), notifyWaiter: true)
    case "onStatus":
      let code = values.compactMap(\.objectValue).first?["code"]?.stringValue ?? ""
      if code.contains("Publish.Start") {
        markLive()
      } else if code.contains("Publish.BadName") || code.contains("Failed") || code.contains("Rejected") {
        fail(.rejected(code), notifyWaiter: true)
      }
    default:
      break
    }
  }

  private func sendConnect() {
    guard let url else { return }
    outChunkSize = 4096
    write(
      RTMPChunk.encode(
        RTMPMessage(
          streamID: 0,
          type: .setChunkSize,
          timestamp: 0,
          payload: uint32BE(UInt32(outChunkSize))
        ),
        chunkStreamID: Self.controlChunk,
        chunkSize: RTMPChunk.defaultSize
      )
    )
    write(
      RTMPChunk.encode(
        RTMPMessage(
          streamID: 0,
          type: .windowAckSize,
          timestamp: 0,
          payload: uint32BE(2_500_000)
        ),
        chunkStreamID: Self.controlChunk,
        chunkSize: outChunkSize
      )
    )
    let payload = AMF0.encode([
      .string("connect"),
      .number(1),
      .object([
        "app": .string(url.app),
        "flashVer": .string("FMLE/3.0 (compatible; FMSc/1.0)"),
        "tcUrl": .string(url.tcURL),
        "type": .string("nonprivate"),
        "audioCodecs": .number(1024),
        "videoCodecs": .number(128),
        "videoFunction": .number(1)
      ])
    ])
    write(
      RTMPChunk.encode(
        RTMPMessage(streamID: 0, type: .amf0Command, timestamp: 0, payload: payload),
        chunkStreamID: Self.commandChunk,
        chunkSize: outChunkSize
      )
    )
    lock.lock()
    phase = .connected
    lock.unlock()
  }

  private func sendCreateStream() {
    lock.lock()
    phase = .creatingStream
    lock.unlock()
    let payload = AMF0.encode([ .string("createStream"), .number(2), .null ])
    write(
      RTMPChunk.encode(
        RTMPMessage(streamID: 0, type: .amf0Command, timestamp: 0, payload: payload),
        chunkStreamID: Self.commandChunk,
        chunkSize: outChunkSize
      )
    )
  }

  private func sendPublish(streamID: UInt32) {
    guard let url else { return }
    lock.lock()
    self.streamID = streamID
    phase = .publishing
    lock.unlock()
    let payload = AMF0.encode([
      .string("publish"),
      .number(3),
      .null,
      .string(url.stream),
      .string("live")
    ])
    write(
      RTMPChunk.encode(
        RTMPMessage(streamID: streamID, type: .amf0Command, timestamp: 0, payload: payload),
        chunkStreamID: Self.commandChunk,
        chunkSize: outChunkSize
      )
    )
    // nginx-rtmp and PeerTube start forwarding as soon as publish lands; waiting for onStatus
    // leaves the first GOP on the floor if the server never sends it.
    markLive()
  }

  private func markLive() {
    lock.lock()
    let already = phase == .live || phase == .failed
    if !already { phase = .live }
    let waiter = connectWait
    connectWait = nil
    lock.unlock()
    waiter?.resume()
  }

  private func enqueueMedia(
    type: RTMPMessageType,
    chunkStreamID: UInt32,
    timestamp: UInt32,
    payload: Data
  ) {
    lock.lock()
    let live = phase == .live
    let streamID = self.streamID
    let queued = sendQueue.reduce(0) { $0 + $1.count }
    lock.unlock()
    guard live else { return }
    if queued > Self.maxQueuedBytes {
      lock.lock()
      droppedPackets += 1
      lock.unlock()
      return
    }
    write(
      RTMPChunk.encode(
        RTMPMessage(streamID: streamID, type: type, timestamp: timestamp, payload: payload),
        chunkStreamID: chunkStreamID,
        chunkSize: outChunkSize
      )
    )
  }

  private func write(_ data: Data) {
    guard !data.isEmpty else { return }
    if DispatchQueue.getSpecific(key: Self.queueKey) != nil {
      enqueueAndFlush(data)
    } else {
      queue.async { self.enqueueAndFlush(data) }
    }
  }

  private func enqueueAndFlush(_ data: Data) {
    lock.lock()
    sendQueue.append(data)
    let sending = isSending
    if !sending { isSending = true }
    lock.unlock()
    if !sending { flush() }
  }

  private func flush() {
    lock.lock()
    guard !sendQueue.isEmpty else {
      isSending = false
      lock.unlock()
      return
    }
    let data = sendQueue.removeFirst()
    lock.unlock()
    connection?.send(content: data, completion: .contentProcessed { [weak self] error in
      guard let self else { return }
      self.queue.async {
        if let error {
          self.fail(.disconnected(error.localizedDescription), notifyWaiter: true)
          return
        }
        self.lock.lock()
        self.bytesSent += UInt64(data.count)
        self.bytesThisWindow += UInt64(data.count)
        self.refreshMegabitsLocked()
        self.lock.unlock()
        self.flush()
      }
    })
  }

  private func refreshMegabitsLocked() {
    let elapsed = CFAbsoluteTimeGetCurrent() - windowStarted
    if elapsed >= 1 {
      megabitsPerSecond = StreamMetrics.megabits(bytes: bytesThisWindow, windowSeconds: elapsed)
      bytesThisWindow = 0
      windowStarted = CFAbsoluteTimeGetCurrent()
    }
  }

  private func fail(_ error: RTMPClientError, notifyWaiter: Bool) {
    lock.lock()
    if phase == .failed {
      lock.unlock()
      return
    }
    let wasLive = phase == .live
    phase = .failed
    let waiter = notifyWaiter ? connectWait : nil
    connectWait = nil
    let handler = onFailure
    lock.unlock()
    connection?.cancel()
    connection = nil
    sendQueue.removeAll()
    isSending = false
    waiter?.resume(throwing: error)
    if wasLive, error != .cancelled { handler?(error) }
  }

  private func uint32BE(_ value: UInt32) -> Data {
    var stored = value.bigEndian
    return withUnsafeBytes(of: &stored) { Data($0) }
  }

  private func readUInt32BE(_ data: Data) -> UInt32 {
    guard data.count >= 4 else { return 0 }
    return (UInt32(data[0]) << 24) | (UInt32(data[1]) << 16) | (UInt32(data[2]) << 8) | UInt32(data[3])
  }
}
