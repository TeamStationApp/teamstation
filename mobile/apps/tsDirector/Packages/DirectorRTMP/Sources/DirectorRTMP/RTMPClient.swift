import AdaptiveBitrate
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

/// Publishes H.264 (classic FLV) or H.265 (Enhanced RTMP) video and AAC audio over RTMP. Metrics
/// count bytes that left the socket and tags that did not, which is the OBS "dropped frames
/// (network)" number rather than TCP retransmits.
public final class RTMPClient: @unchecked Sendable {
  public struct Metrics: Sendable, Equatable {
    public var megabitsPerSecond: Double = 0
    public var droppedPackets: UInt64 = 0
    /// Bytes handed to the sender that have not reached the socket. Pinned at the budget is the
    /// signature of an upstream stall.
    public var queuedBytes: Int = 0

    public init(
      megabitsPerSecond: Double = 0,
      droppedPackets: UInt64 = 0,
      queuedBytes: Int = 0
    ) {
      self.megabitsPerSecond = megabitsPerSecond
      self.droppedPackets = droppedPackets
      self.queuedBytes = queuedBytes
    }
  }

  /// What `sendVideo` / `sendAudio` did with a tag.
  public enum SendOutcome: Sendable, Equatable {
    case sent
    /// Shed because the socket is behind. The stream is still live.
    case droppedOverBudget
    /// Shed because video resumes on the next keyframe, so the decoder is not fed a hole.
    /// The encoder should force an IDR.
    case droppedAwaitingKeyframe
    /// Not publishing. Nothing was sent and nothing was queued.
    case notLive
  }

  public typealias FailureHandler = @Sendable (RTMPClientError) -> Void

  private let queue = DispatchQueue(label: "app.teamstation.director.rtmp")
  private let ioQueue = DispatchQueue(label: "app.teamstation.director.rtmp.io")
  private static let queueKey = DispatchSpecificKey<UInt8>()
  private let lock = NSLock()
  private var socketFD: Int32 = -1
  private var readSource: DispatchSourceRead?
  private var connectSource: DispatchSourceWrite?
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
  private var sendQueue: [Queued] = []
  private var isSending = false
  /// Bytes written but not yet on the wire, wherever they are parked.
  ///
  /// Summing `sendQueue` cannot measure this. `flush()` takes an item off the queue and then
  /// blocks inside `send` while holding the serial `queue`, so every later chunk waits as a
  /// pending `queue.async` block and `sendQueue` reads *empty* for the whole stall — which is
  /// how a 256 KB cap sat in front of a backlog that reached gigabytes. This counter is
  /// incremented where the work is submitted and decremented where it completes, so it sees the
  /// backlog in the dispatch queue as well as in the array.
  private var queuedBytes = 0

  /// One whole RTMP message waiting for the socket, with what the shed policy needs to judge it.
  ///
  /// `RTMPChunk.encode` writes a full header for every message and fmt 3 only to continue that same
  /// message, so nothing here is encoded against anything else and a message can be thrown away
  /// without the receiver losing its place.
  private struct Queued {
    var data: Data
    var submittedAt: Double
    var isVideo: Bool
    var isKeyframe: Bool
    var isSequenceHeader: Bool
  }
  /// Every write in order and how much of it the socket has taken, for the bitrate controller.
  private var ledger = RTMPSendLedger()
  private var sendBudgetBytes = RTMPClient.defaultSendBudgetBytes
  /// How long the oldest write may wait before media is shed.
  private var bufferSeconds = RTMPClient.sendBufferSeconds
  private var sendTimeoutSeconds: Double = 2
  private var stallDeadline: Double = RTMPClient.stallDeadlineSeconds
  /// What the video tags carry. Decides what `connect` and `onMetaData` announce, and whether an
  /// early refusal is explained as the server not taking the codec.
  private var videoCodec = RTMPVideoCodec.h264
  /// When the publish went live, so a hang-up soon after can be told from one much later.
  private var liveSince: CFAbsoluteTime = 0
  /// Set when video is shed, cleared by the first keyframe that fits under budget, so playback
  /// downstream resumes on an IDR instead of mid-GOP.
  private var awaitingKeyframe = false
  /// True from `stop()` onward. Tearing the socket down makes an in-flight `send` fail with
  /// EPIPE, and that error would otherwise win the race against the cancellation and reach the
  /// operator as a stream error on a deliberate stop.
  private var isStopping = false
  private var connectWait: CheckedContinuation<Void, Error>?
  private var onFailure: FailureHandler?
  private var url: RTMPURL?
  private var socketReady = false
  private var sentC2 = false
  private var handshakePeer = ""
  private var handshakeSent = 0
  private var handshakeRecv = 0
  private var handshakeTrace = ""

  private enum Phase {
    case idle, handshaking, connected, creatingStream, publishing, live, failed
  }

  /// How long the stream may wait for the link before it sheds anything. Nobody watches the stream
  /// against the field — a platform's player sits 5–20 s behind — so a dip in the link is better
  /// sent late than dropped, and half a minute covers every squeeze this rig has produced.
  ///
  /// This is no longer tied to how long one send may block: a send that times out is backpressure,
  /// not a dead peer, so the buffer is free to be as deep as the memory allows. `stallDeadlineSeconds`
  /// is what decides the peer is gone, and it is longer than this so the buffer is spent first.
  public static let sendBufferSeconds: Double = 30

  /// How long one write may make no progress at all before the peer counts as gone. Longer than the
  /// send buffer, so a link that comes back is always given its backlog first.
  public static let stallDeadlineSeconds: Double = 45
  /// What a client holds before `configure` gives it a budget of its own.
  static let defaultSendBudgetBytes = 1_500_000
  static let minimumSendBudgetBytes = 512 * 1024
  static let maximumSendBudgetBytes = 64 * 1024 * 1024

  /// The send buffer's size in bytes, a memory ceiling beside its age limit: `sendBufferSeconds` of
  /// the high bitrate, with room for the encoder's one-second spikes to half again the rate. 22 MB
  /// at 4 Mbps, 34 MB at 6 Mbps, 56 MB at the 10 Mbps top of Settings. `ProgramStreamer` passes its
  /// configured high bitrate so the budget tracks whatever the operator chose.
  public static func sendBudget(forBitrate bitrate: Int) -> Int {
    let bytes = Int(Double(bitrate) / 8 * sendBufferSeconds * 1.5)
    return min(max(bytes, minimumSendBudgetBytes), maximumSendBudgetBytes)
  }

  /// The bitrate controller's tuning for an RTMP stream: `Tuning.rtmpStream`, which lets the queue
  /// run to seconds before it cuts, because the send buffer holds `sendBufferSeconds` of stream. The
  /// buffer stays the last resort, for a link that stays down longer than it can cover.
  public static let adaptiveBitrateTuning = AdaptiveBitrateController.Tuning.rtmpStream

  /// What the link did since the previous call, in video's terms, for the bitrate controller: the
  /// age of the oldest write the socket has not taken, the bytes it took and the media bytes
  /// offered, the kernel's unsent bytes, and the packets the budget shed.
  public func congestionSample(at now: Double = RTMPClient.monotonicNow()) -> CongestionSample {
    lock.lock()
    let fd = socketFD
    lock.unlock()
    let backlog = fd >= 0 ? Self.unsentBytes(fd: fd) : nil
    lock.lock()
    defer { lock.unlock() }
    return ledger.sample(at: now, droppedPackets: droppedPackets, transportBacklogBytes: backlog)
  }

  /// The bytes the kernel holds for the socket that the peer has not acknowledged, from
  /// `SO_NWRITE`: on TCP, what is queued plus what is in flight. Nil when it cannot be read.
  static func unsentBytes(fd: Int32) -> Int? {
    var value: Int32 = 0
    var length = socklen_t(MemoryLayout<Int32>.size)
    guard getsockopt(fd, SOL_SOCKET, SO_NWRITE, &value, &length) == 0 else { return nil }
    return Int(max(0, value))
  }

  /// Seconds on a clock that does not jump, which the ledger stamps writes with.
  public static func monotonicNow() -> Double {
    ProcessInfo.processInfo.systemUptime
  }

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
    return Metrics(
      megabitsPerSecond: megabitsPerSecond,
      droppedPackets: droppedPackets,
      queuedBytes: queuedBytes
    )
  }

  /// How many bytes may sit between `sendVideo`/`sendAudio` and the socket, and how long the oldest
  /// of them may wait, before media is shed; how long a single write may block before the peer
  /// counts as gone; and which codec the video tags carry. Call before `publish`.
  public func configure(
    sendBudgetBytes: Int,
    bufferSeconds: Double = RTMPClient.sendBufferSeconds,
    sendTimeoutSeconds: Double = 2,
    videoCodec: RTMPVideoCodec = .h264
  ) {
    lock.lock()
    self.sendBudgetBytes = max(sendBudgetBytes, Self.minimumSendBudgetBytes)
    self.bufferSeconds = max(bufferSeconds, 0.1)
    self.sendTimeoutSeconds = max(sendTimeoutSeconds, 0.1)
    self.videoCodec = videoCodec
    lock.unlock()
  }

  /// How long after going live a hang-up still reads as the server refusing the codec. A server
  /// that cannot take H.265 refuses the publish, or closes the socket once the first sequence
  /// header or picture arrives — within a second or two. Much later than that it is the network,
  /// and blaming the codec would send the operator to the wrong setting.
  static let codecRefusalWindowSeconds: Double = 10

  /// The operator's message for a failure, with the likely cause added when an Enhanced RTMP codec
  /// was refused or hung up on early: otherwise a server without H.265 support reads as a flaky
  /// connection, and the fix — choosing H.264 in Settings — is nowhere on screen.
  static func explainingCodecRefusal(
    _ error: RTMPClientError,
    codec: RTMPVideoCodec,
    secondsLive: Double?
  ) -> RTMPClientError {
    guard codec.isEnhanced else { return error }
    if let secondsLive, secondsLive > codecRefusalWindowSeconds { return error }
    let hint = "the server may not accept \(codec.displayName) over Enhanced RTMP; choose H.264 in Settings"
    switch error {
    case let .rejected(reason): return .rejected("\(reason) — \(hint)")
    case let .disconnected(reason): return .disconnected("\(reason) — \(hint)")
    default: return error
    }
  }

  public var isLive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return phase == .live
  }

  public func publish(to url: RTMPURL, timeoutSeconds: Double = 20) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queue.async {
        self.begin(url: url, continuation: continuation)
        self.queue.asyncAfter(deadline: .now() + timeoutSeconds) {
          self.lock.lock()
          let waiting = self.connectWait != nil && self.phase != .live
          let ready = self.socketReady
          self.lock.unlock()
          if waiting {
            let peer = self.handshakePeer
            let sent = self.handshakeSent
            let recv = self.handshakeRecv
            let trace = self.handshakeTrace
            self.fail(
              ready
                ? .connectFailed("handshake timeout peer=\(peer) sent=\(sent) recv=\(recv)\(trace)")
                : .connectFailed("could not open a TCP connection to the stream server"),
              notifyWaiter: true
            )
          }
        }
      }
    }
  }

  public func stop() {
    // Wake anything parked in `send` before the queued teardown runs. Without this, `stop` waits
    // out the full send timeout behind a blocked write on a stalled peer.
    lock.lock()
    isStopping = true
    let fd = socketFD
    lock.unlock()
    if fd >= 0 { shutdown(fd, SHUT_RDWR) }
    queue.async { self.fail(.cancelled, notifyWaiter: true) }
  }

  public func onFailure(_ handler: @escaping FailureHandler) {
    lock.lock()
    onFailure = handler
    lock.unlock()
  }

  @discardableResult
  public func sendVideo(timestampMs: UInt32, tag: Data) -> SendOutcome {
    enqueueMedia(
      type: .video,
      chunkStreamID: Self.videoChunk,
      timestamp: timestampMs,
      payload: tag,
      isVideo: true
    )
  }

  @discardableResult
  public func sendAudio(timestampMs: UInt32, tag: Data) -> SendOutcome {
    enqueueMedia(
      type: .audio,
      chunkStreamID: Self.audioChunk,
      timestamp: timestampMs,
      payload: tag,
      isVideo: false
    )
  }

  public func sendMetadata(width: Int, height: Int, frameRate: Int, bitrate: Int) {
    queue.async {
      self.lock.lock()
      let streamID = self.streamID
      let live = self.phase == .live
      let codec = self.videoCodec
      self.lock.unlock()
      guard live else { return }
      let payload = Self.metadataPayload(
        width: width,
        height: height,
        frameRate: frameRate,
        bitrate: bitrate,
        codec: codec
      )
      self.write(
        RTMPChunk.encode(
          RTMPMessage(streamID: streamID, type: .amf0Data, timestamp: 0, payload: payload),
          chunkStreamID: Self.dataChunk,
          chunkSize: self.outChunkSize
        )
      )
    }
  }

  /// `@setDataFrame onMetaData`. `videocodecid` is 7 for H.264 and, for an Enhanced RTMP codec, its
  /// FourCC as a number (0x68766331 for `hvc1`), as the Enhanced RTMP spec has publishers send it.
  static func metadataPayload(
    width: Int,
    height: Int,
    frameRate: Int,
    bitrate: Int,
    codec: RTMPVideoCodec
  ) -> Data {
    AMF0.encode([
      .string("@setDataFrame"),
      .string("onMetaData"),
      .ecmaArray([
        "duration": .number(0),
        "width": .number(Double(width)),
        "height": .number(Double(height)),
        "framerate": .number(Double(frameRate)),
        "videodatarate": .number(Double(bitrate) / 1000),
        "videocodecid": .number(codec.metadataCodecID),
        "audiodatarate": .number(128),
        "audiocodecid": .number(10),
        "audiosamplerate": .number(48_000),
        "audiochannels": .number(2),
        "stereo": .boolean(true)
      ])
    ])
  }

  /// The `connect` command. An Enhanced RTMP codec is also named in `fourCcList`, which is how the
  /// spec has a client say what it will send; classic H.264 leaves the object exactly as it was, so
  /// no server that took Director's stream before sees anything new.
  static func connectPayload(url: RTMPURL, codec: RTMPVideoCodec) -> Data {
    var object: [String: AMF0] = [
      "app": .string(url.app),
      "flashVer": .string("FMLE/3.0 (compatible; FMSc/1.0)"),
      "tcUrl": .string(url.tcURL),
      "type": .string("nonprivate"),
      "audioCodecs": .number(1024),
      "videoCodecs": .number(128),
      "videoFunction": .number(1)
    ]
    if codec.isEnhanced {
      object["fourCcList"] = .strictArray([ .string(codec.fourCCString) ])
    }
    return AMF0.encode([ .string("connect"), .number(1), .object(object) ])
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
    isStopping = false
    sentC2 = false
    handshakePeer = ""
    handshakeSent = 0
    handshakeRecv = 0
    handshakeTrace = ""
    lock.unlock()

    guard let port = UInt16(exactly: url.port) else {
      fail(.connectFailed("invalid port \(url.port)"), notifyWaiter: true)
      return
    }
    let host = url.host
    do {
      try openSocket(host: host, port: port)
    } catch {
      fail(.connectFailed(error.localizedDescription), notifyWaiter: true)
      return
    }
  }

  private func openSocket(host: String, port: UInt16) throws {
    var hints = addrinfo()
    hints.ai_family = AF_INET
    hints.ai_socktype = SOCK_STREAM
    hints.ai_protocol = IPPROTO_TCP
    var info: UnsafeMutablePointer<addrinfo>?
    let lookup = host.withCString { getaddrinfo($0, String(port), &hints, &info) }
    guard lookup == 0, let first = info else {
      throw RTMPClientError.connectFailed("could not resolve \(host)")
    }
    defer { freeaddrinfo(info) }

    let fd = Darwin.socket(first.pointee.ai_family, first.pointee.ai_socktype, first.pointee.ai_protocol)
    guard fd >= 0 else { throw RTMPClientError.connectFailed("could not open a TCP socket") }
    var noSig = Int32(1)
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSig, socklen_t(MemoryLayout<Int32>.size))
    var noDelay = Int32(1)
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &noDelay, socklen_t(MemoryLayout<Int32>.size))
    // Without this the socket blocks forever: a peer that vanishes without an RST leaves `send`
    // parked through TCP's retransmit timeouts while the encoder keeps queueing behind it.
    lock.lock()
    let timeoutSeconds = sendTimeoutSeconds
    lock.unlock()
    var timeout = Self.makeTimeval(seconds: timeoutSeconds)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    socketFD = fd
    var storage = sockaddr_storage()
    let addrLen = first.pointee.ai_addrlen
    _ = withUnsafeMutableBytes(of: &storage) { dest in
      memcpy(dest.baseAddress, first.pointee.ai_addr, Int(addrLen))
    }
    ioQueue.async { [weak self] in
      self?.blockingConnectAndRead(fd: fd, storage: storage, addrLen: addrLen)
    }
  }

  private func blockingConnectAndRead(fd: Int32, storage: sockaddr_storage, addrLen: socklen_t) {
    var storage = storage
    let rc = withUnsafePointer(to: &storage) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, addrLen) }
    }
    if rc != 0 {
      queue.async { self.fail(.connectFailed("could not open a TCP connection to the stream server"), notifyWaiter: true) }
      return
    }
    queue.async {
      self.lock.lock()
      self.socketReady = true
      self.lock.unlock()
    }
    let hello = RTMPHandshake.c0c1()
    let sent = hello.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, $0.count, 0) }
    if sent < hello.count {
      queue.async { self.fail(.connectFailed("could not send the stream handshake"), notifyWaiter: true) }
      return
    }
    let peer = Self.peerDescription(storage: storage, addrLen: addrLen)
    queue.async {
      self.lock.lock()
      self.handshakePeer = peer
      self.handshakeSent = sent
      self.lock.unlock()
    }
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      let count = buffer.withUnsafeMutableBytes { Darwin.recv(fd, $0.baseAddress, $0.count, 0) }
      if count > 0 {
        let chunk = Data(buffer.prefix(count))
        queue.async {
          self.lock.lock()
          self.handshakeRecv += count
          self.lock.unlock()
          self.handle(received: chunk)
        }
        continue
      }
      if count == 0 {
        queue.async {
          self.lock.lock()
          let reason = Self.serverClosedReason(live: self.phase == .live, handshakeTrace: self.handshakeTrace)
          self.lock.unlock()
          self.fail(.disconnected(reason), notifyWaiter: true)
        }
        return
      }
      if errno == EINTR { continue }
      queue.async { self.fail(.disconnected("socket read failed (\(errno))"), notifyWaiter: true) }
      return
    }
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

  private static func peerDescription(storage: sockaddr_storage, addrLen: socklen_t) -> String {
    var storage = storage
    return withUnsafePointer(to: &storage) { pointer in
      pointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { sin in
        var address = sin.pointee.sin_addr
        var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        inet_ntop(AF_INET, &address, &buffer, socklen_t(INET_ADDRSTRLEN))
        let host = String(cString: buffer)
        let port = Int(UInt16(bigEndian: sin.pointee.sin_port))
        return "\(host):\(port)"
      }
    }
  }

  private func handle(received data: Data) {
    lock.lock()
    let phase = self.phase
    lock.unlock()
    if phase == .handshaking {
      handshakeBuffer.append(data)
      // nginx-rtmp often withholds S2 until it has C2. Waiting for the full 3073-byte hello
      // before echoing S1 deadlocks the handshake until our timeout.
      let s0s1 = 1 + RTMPHandshake.packetSize
      if !sentC2, handshakeBuffer.count >= s0s1 {
        sentC2 = true
        write(RTMPHandshake.c2(fromS1: Data(handshakeBuffer[1 ..< s0s1])))
      }
      guard RTMPHandshake.splitServerHello(handshakeBuffer) != nil else { return }
      let consumed = 1 + RTMPHandshake.packetSize * 2
      let leftover = handshakeBuffer.count > consumed ? Data(handshakeBuffer[consumed...]) : Data()
      handshakeBuffer.removeAll()
      sendConnect()
      if !leftover.isEmpty {
        lock.lock()
        handshakeTrace += " leftover=\(leftover.count)"
        lock.unlock()
        let messages = reader.push(leftover)
        lock.lock()
        handshakeTrace += " parsed=\(messages.count)"
        lock.unlock()
        for message in messages { handle(message: message) }
      }
      return
    }
    let messages = reader.push(data)
    for message in messages { handle(message: message) }
  }

  private func handle(message: RTMPMessage) {
    lock.lock()
    handshakeTrace += " t\(message.type.rawValue)/\(message.payload.count)"
    lock.unlock()
    switch message.type {
    case .setChunkSize:
      if message.payload.count >= 4 {
        let size = Int(readUInt32BE(message.payload))
        if size > 0 { reader.setChunkSize(size) }
      }
    case .windowAckSize, .setPeerBandwidth, .acknowledgement, .abort:
      break
    case .userControl:
      if message.payload.count >= 6 {
        let event = (UInt16(message.payload[0]) << 8) | UInt16(message.payload[1])
        if event == 6 {
          var pong = Data([ 0x00, 0x07 ])
          pong.append(message.payload[2...])
          write(
            RTMPChunk.encode(
              RTMPMessage(streamID: 0, type: .userControl, timestamp: 0, payload: pong),
              chunkStreamID: Self.controlChunk,
              chunkSize: outChunkSize
            )
          )
        }
      }
    case .amf0Command, .amf3Command:
      handleCommand(message.payload)
    default:
      break
    }
  }

  private func handleCommand(_ payload: Data) {
    let values = AMF0.decodeList(payload)
    let tx = values.dropFirst().first?.numberValue.map { Int($0) } ?? 0
    guard let name = values.first?.stringValue else {
      lock.lock()
      handshakeTrace += " amf0empty"
      lock.unlock()
      return
    }
    lock.lock()
    handshakeTrace += " \(name)#\(tx)"
    lock.unlock()
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
      lock.lock()
      handshakeTrace += " \(code)"
      lock.unlock()
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
    lock.lock()
    let codec = videoCodec
    lock.unlock()
    let payload = Self.connectPayload(url: url, codec: codec)
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
    markLive()
  }

  private func markLive() {
    lock.lock()
    let already = phase == .live || phase == .failed
    if !already {
      phase = .live
      liveSince = CFAbsoluteTimeGetCurrent()
    }
    let waiter = connectWait
    connectWait = nil
    lock.unlock()
    waiter?.resume()
  }

  /// Frames a media tag and submits it, shedding load when the socket has fallen behind by more
  /// than the send buffer: its oldest write waiting longer than `bufferSeconds`, or more bytes
  /// waiting than the budget allows.
  ///
  /// Sequence headers are never shed: they are the decoder's only key to everything that follows.
  /// Video otherwise resumes on a keyframe, so a shed spell costs the ingest one GOP rather than
  /// a run of undecodable P-frames.
  @discardableResult
  private func enqueueMedia(
    type: RTMPMessageType,
    chunkStreamID: UInt32,
    timestamp: UInt32,
    payload: Data,
    isVideo: Bool
  ) -> SendOutcome {
    lock.lock()
    guard phase == .live else {
      lock.unlock()
      return .notLive
    }
    ledger.offered(bytes: payload.count, isAudio: !isVideo)
    let streamID = self.streamID
    let chunkSize = outChunkSize
    let isSequenceHeader = isVideo
      ? FLVTag.isVideoSequenceHeader(payload)
      : FLVTag.isAudioSequenceHeader(payload)
    let isKeyframe = isVideo && FLVTag.isVideoKeyframe(payload)
    lock.unlock()
    write(
      RTMPChunk.encode(
        RTMPMessage(streamID: streamID, type: type, timestamp: timestamp, payload: payload),
        chunkStreamID: chunkStreamID,
        chunkSize: chunkSize
      ),
      isVideo: isVideo,
      isKeyframe: isKeyframe,
      isSequenceHeader: isSequenceHeader
    )
    return .sent
  }

  /// Throws the oldest waiting messages away until the queue fits the budget again.
  ///
  /// The oldest, not the newest. A link that carries less than the programme cannot deliver
  /// everything, and holding the old frames to send the new ones late puts the stream further behind
  /// the game with every second — permanently, once the buffer fills. Dropping from the front costs
  /// the viewer a jump forward and leaves them near live, which is what a game wants; the take's
  /// own recording keeps what the stream skipped.
  ///
  /// Sequence headers are never thrown away: they are the decoder's only key to what follows. What
  /// is left has to start on a keyframe, so whole groups go rather than the front of one, and the
  /// ingest gets pictures it can decode instead of a run of references to frames it never saw.
  ///
  /// Called with the lock held.
  /// Whether the first picture still queued is one the ingest can decode on its own. For the tests
  /// that hold the shed policy to leaving a decodable queue behind.
  var firstQueuedVideoIsKeyframeForTesting: Bool {
    lock.lock()
    defer { lock.unlock() }
    guard let first = sendQueue.first(where: { $0.isVideo && !$0.isSequenceHeader }) else { return true }
    return first.isKeyframe
  }

  private func shedOldestLocked() {
    let now = Self.monotonicNow()
    func overBudget() -> Bool {
      queuedBytes > sendBudgetBytes || ledger.queueDelay(at: now) > bufferSeconds
    }
    guard overBudget() else { return }
    var shed = false
    while overBudget(), sendQueue.contains(where: { !$0.isSequenceHeader }) {
      guard let index = sendQueue.firstIndex(where: { !$0.isSequenceHeader }) else { break }
      queuedBytes = max(0, queuedBytes - sendQueue[index].data.count)
      sendQueue.remove(at: index)
      droppedPackets += 1
      shed = true
    }
    // Leave the queue starting on a picture the ingest can decode.
    if shed {
      while let first = sendQueue.firstIndex(where: { $0.isVideo && !$0.isSequenceHeader }),
            !sendQueue[first].isKeyframe {
        queuedBytes = max(0, queuedBytes - sendQueue[first].data.count)
        sendQueue.remove(at: first)
        droppedPackets += 1
      }
      ledger.resetWaiting(
        bytes: sendQueue.map { $0.data.count },
        since: sendQueue.map { $0.submittedAt }
      )
    }
  }

  /// Control writes — handshake, acknowledgements, the publish itself — are never shed.
  private func write(_ data: Data) {
    write(data, isVideo: false, isKeyframe: false, isSequenceHeader: true)
  }

  private func write(_ data: Data, isVideo: Bool, isKeyframe: Bool, isSequenceHeader: Bool) {
    guard !data.isEmpty else { return }
    // Counted here, at submission, rather than on the serial queue. A chunk submitted while the
    // sender is blocked never reaches `sendQueue` — it waits as a pending `queue.async` block —
    // so counting any later than this cannot see a backlog at all.
    let now = Self.monotonicNow()
    let item = Queued(
      data: data,
      submittedAt: now,
      isVideo: isVideo,
      isKeyframe: isKeyframe,
      isSequenceHeader: isSequenceHeader
    )
    // Queued here, under the lock, rather than from the sender's queue. While the socket is blocked
    // the serial queue is blocked with it, so anything handed to it waits as a pending block that
    // nothing can look at or throw away — the backlog would be invisible and unbounded. Holding it
    // here is what lets the oldest of it be shed.
    lock.lock()
    guard phase != .failed else {
      queuedBytes = 0
      ledger.clear()
      lock.unlock()
      return
    }
    queuedBytes += data.count
    ledger.submitted(bytes: data.count, at: now)
    sendQueue.append(item)
    shedOldestLocked()
    let sending = isSending
    if !sending { isSending = true }
    lock.unlock()
    guard !sending else { return }
    if DispatchQueue.getSpecific(key: Self.queueKey) != nil {
      flush()
    } else {
      queue.async { self.flush() }
    }
  }

  private func flush() {
    while true {
      lock.lock()
      guard !sendQueue.isEmpty else {
        isSending = false
        lock.unlock()
        return
      }
      let data = sendQueue.removeFirst().data
      let fd = socketFD
      lock.unlock()
      guard fd >= 0 else {
        release(queued: data.count)
        fail(.disconnected("socket closed"), notifyWaiter: true)
        return
      }
      let failure = send(data, over: fd)
      release(queued: data.count)
      if let failure {
        fail(failure, notifyWaiter: true)
        return
      }
    }
  }

  /// Writes every byte of one chunk, advancing an offset rather than reallocating the tail after
  /// each partial write. Returns the error to fail with, or nil once the chunk is gone.
  private func send(_ data: Data, over fd: Int32) -> RTMPClientError? {
    // Naming the ingest in the error is what makes the next incident attributable: the index
    // does not record which server a take was streaming to.
    lock.lock()
    let peerLabel = url.map { "\($0.host):\($0.port)" } ?? "stream server"
    let stallSeconds = stallDeadline
    lock.unlock()
    return data.withUnsafeBytes { raw -> RTMPClientError? in
      guard let base = raw.baseAddress else { return nil }
      var offset = 0
      var noProgressSince: Double?
      while offset < raw.count {
        let sent = Darwin.send(fd, base + offset, raw.count - offset, 0)
        if sent < 0 {
          if errno == EINTR { continue }
          // `SO_SNDTIMEO` expires as EAGAIN. That is a link carrying less than the programme, not a
          // peer that has gone: the queue behind this write is being shed to fit meanwhile, so
          // waiting costs bounded memory. Only a write that makes no progress at all for longer
          // than the buffer it is holding up counts the peer as gone. Treating the first timeout as
          // a disconnect is what ended two streams on the rig and left them off for the rest of the
          // session.
          if errno == EAGAIN || errno == EWOULDBLOCK {
            let now = Self.monotonicNow()
            let since = noProgressSince ?? now
            noProgressSince = since
            if now - since >= stallSeconds {
              return .disconnected("\(peerLabel) stopped accepting data")
            }
            continue
          }
          return .disconnected("socket write failed (\(errno))")
        }
        offset += sent
        noProgressSince = nil
        account(sent: sent)
      }
      return nil
    }
  }

  private func account(sent: Int) {
    lock.lock()
    bytesSent += UInt64(sent)
    bytesThisWindow += UInt64(sent)
    ledger.delivered(bytes: sent)
    refreshMegabitsLocked()
    lock.unlock()
  }

  private func release(queued count: Int) {
    lock.lock()
    queuedBytes = max(0, queuedBytes - count)
    lock.unlock()
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
    // Whichever path arrives first after `stop()`, a deliberate teardown reports as cancellation.
    // The socket error it provokes is our own doing and is not something to show the operator.
    let wasLive = phase == .live
    let reported: RTMPClientError = isStopping
      ? .cancelled
      : Self.explainingCodecRefusal(
        error,
        codec: videoCodec,
        secondsLive: wasLive ? CFAbsoluteTimeGetCurrent() - liveSince : nil
      )
    phase = .failed
    let waiter = notifyWaiter ? connectWait : nil
    connectWait = nil
    let handler = onFailure
    // Every field `flush()` and `enqueueAndFlush()` touch under the lock is now also written
    // under it. These used to be mutated bare, while a send was in flight on the other queue.
    let fd = socketFD
    socketFD = -1
    sendQueue.removeAll()
    isSending = false
    queuedBytes = 0
    ledger.clear()
    awaitingKeyframe = false
    lock.unlock()
    readSource?.cancel()
    readSource = nil
    connectSource?.cancel()
    connectSource = nil
    if fd >= 0 {
      // Unblock a parked send before closing, so the sender does not sit out its whole timeout.
      shutdown(fd, SHUT_RDWR)
      Darwin.close(fd)
    }
    waiter?.resume(throwing: reported)
    if wasLive, reported != .cancelled { handler?(reported) }
  }

  private static func makeTimeval(seconds: Double) -> timeval {
    let clamped = max(seconds, 0)
    let whole = clamped.rounded(.down)
    return timeval(
      tv_sec: Int(whole),
      tv_usec: Int32((clamped - whole) * 1_000_000)
    )
  }

  /// Why the stream ended when the server hung up. The handshake's message trace explains a server
  /// that hung up while connecting; once the stream is live it says nothing about why, and it lands
  /// in the operator's toast.
  static func serverClosedReason(live: Bool, handshakeTrace: String) -> String {
    "server closed the socket\(live ? "" : handshakeTrace)"
  }

  #if DEBUG
  /// Drives the send path over a caller-supplied socket, so a test can stall the peer without a
  /// real RTMP server. Goes straight to `.live`; no handshake is performed.
  func attachForTesting(
    fd: Int32,
    budgetBytes: Int,
    bufferSeconds: Double = RTMPClient.sendBufferSeconds,
    sendTimeoutSeconds: Double = 2,
    stallDeadlineSeconds: Double = RTMPClient.stallDeadlineSeconds
  ) {
    lock.lock()
    stallDeadline = max(stallDeadlineSeconds, 0)
    lock.unlock()
    // The same options `openSocket` sets. Without `SO_NOSIGPIPE` a test that closes the peer
    // takes the whole test process down with SIGPIPE instead of seeing EPIPE.
    var noSig = Int32(1)
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSig, socklen_t(MemoryLayout<Int32>.size))
    var timeout = Self.makeTimeval(seconds: sendTimeoutSeconds)
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    lock.lock()
    socketFD = fd
    phase = .live
    streamID = 1
    sendBudgetBytes = budgetBytes
    self.bufferSeconds = bufferSeconds
    self.sendTimeoutSeconds = sendTimeoutSeconds
    queuedBytes = 0
    ledger = RTMPSendLedger()
    droppedPackets = 0
    awaitingKeyframe = false
    lock.unlock()
  }

  var bytesSentForTesting: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return bytesSent
  }
  #endif

  private func uint32BE(_ value: UInt32) -> Data {
    var stored = value.bigEndian
    return withUnsafeBytes(of: &stored) { Data($0) }
  }

  private func readUInt32BE(_ data: Data) -> UInt32 {
    guard data.count >= 4 else { return 0 }
    return (UInt32(data[0]) << 24) | (UInt32(data[1]) << 16) | (UInt32(data[2]) << 8) | UInt32(data[3])
  }
}
