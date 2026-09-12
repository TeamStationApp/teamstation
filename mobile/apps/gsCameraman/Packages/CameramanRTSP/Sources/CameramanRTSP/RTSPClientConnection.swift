import CameramanCore
import CoreMedia
import Foundation
import Network

/// One connected client: the RTSP exchange, then interleaved media.
///
/// All work happens on the server's queue, so the mutable state needs no locking. The encoder's
/// callbacks hop onto that queue rather than touching this directly.
final class RTSPClientConnection: @unchecked Sendable {
  private let connection: NWConnection
  private let queue: DispatchQueue
  private let sdp: @Sendable (UInt32, UInt32) -> String
  private let identity: @Sendable () -> DeviceIdentity
  private let requestKeyframe: @Sendable () -> Void
  private let parameters: RTSPResponder.ParameterHandler?
  private var responder: RTSPResponder

  private var buffer = Data()
  /// True between PLAY and PAUSE/TEARDOWN. The server counts only these as clients, so a
  /// control-only connection polling parameters is not shown to the operator as a viewer.
  private(set) var isStreaming = false {
    didSet { if isStreaming != oldValue { onStreamingChange?() } }
  }
  private var isAwaitingKeyframe = false
  private var videoSetup: RTSPResponder.Setup?
  private var audioSetup: RTSPResponder.Setup?

  private let videoSSRC: UInt32
  private let audioSSRC: UInt32
  private var videoSequence: UInt16 = 0
  private var audioSequence: UInt16 = 0
  private var videoPacketCount: UInt32 = 0
  private var videoOctetCount: UInt32 = 0
  private var audioFrameIndex = 0
  private var audioPacketCount: UInt32 = 0
  private var audioOctetCount: UInt32 = 0
  private var lastAudioReportTime = Date.distantPast
  private var firstVideoPresentationTime: Double?
  private var videoTimestamps = RTPTimestampSequencer()
  private var lastReportTime = Date.distantPast

  private(set) var sendQueue = StreamSendQueue()
  private var congestion = CongestionMeter()
  /// The most free space the TCP send buffer has reported, which is its size as far as this side can
  /// tell. Network.framework reports only the free space, and the backlog is what is missing from it.
  private var largestAvailableSendBuffer = 0
  private var closeReason = "cancelled"

  var onClose: (@Sendable (String) -> Void)?
  /// Fired on the server queue whenever `isStreaming` flips, so the client count can be recounted.
  var onStreamingChange: (@Sendable () -> Void)?

  init(
    connection: NWConnection,
    queue: DispatchQueue,
    sdp: @escaping @Sendable (UInt32, UInt32) -> String,
    hasAudio: Bool,
    identity: @escaping @Sendable () -> DeviceIdentity,
    requestKeyframe: @escaping @Sendable () -> Void,
    parameters: RTSPResponder.ParameterHandler? = nil
  ) {
    self.connection = connection
    self.queue = queue
    self.sdp = sdp
    self.identity = identity
    self.requestKeyframe = requestKeyframe
    self.parameters = parameters

    // Distinct per connection, so two clients watching at once are separable in a capture. Held as
    // locals first because no property can be read until all of them are initialized.
    let video = UInt32.random(in: 1 ... .max)
    let audio = UInt32.random(in: 1 ... .max)
    videoSSRC = video
    audioSSRC = audio

    responder = RTSPResponder(
      sessionIdentifier: RTSPResponder.generateSessionIdentifier(),
      sdp: sdp(video, audio),
      hasAudio: hasAudio,
      parameters: parameters
    )
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed(let error):
        self?.closeReason = "nw failed: \(error.localizedDescription)"
        self?.finish()
      case .cancelled:
        self?.finish()
      default:
        break
      }
    }
    // The connection must be started before anything else is done with it. Cancelling an unstarted
    // incoming connection leaves the client's TCP handshake unanswered, which looks like a hang rather
    // than a refusal.
    connection.start(queue: queue)
    receive()
  }

  func close(reason: String = "server stop") {
    closeReason = reason
    connection.cancel()
  }

  private func finish() {
    guard let onClose else { return }
    self.onClose = nil
    onClose(closeReason)
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 8 * 1024) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      if let data, !data.isEmpty {
        buffer.append(data)
        drainRequests()
      }
      if let error {
        closeReason = "recv: \(error.localizedDescription)"
        connection.cancel()
        return
      }
      if isComplete {
        closeReason = "eof"
        connection.cancel()
        return
      }
      receive()
    }
  }

  private func drainRequests() {
    // A client may pipeline several requests into one segment, and the buffer may hold a partial one
    // at the end, so this loops until nothing more can be parsed rather than assuming one per read.
    while let (request, consumed) = RTSPServerRequest.parse(buffer) {
      buffer.removeFirst(consumed)

      // The SDP is regenerated per DESCRIBE, since the parameter sets are unknown until the encoder
      // has produced a frame and a client may connect before then.
      if request.method == "DESCRIBE" {
        responder = RTSPResponder(
          sessionIdentifier: responder.sessionIdentifier,
          sdp: sdp(videoSSRC, audioSSRC),
          hasAudio: responder.hasAudio,
          parameters: parameters
        )
      }

      let outcome = responder.respond(to: request)

      switch outcome.effect {
      case .startStreaming(let video, let audio):
        videoSetup = video
        audioSetup = audio
        // Each client gets its own SSRC and its own timeline, so a client that joins an hour in still
        // starts at zero and RTP-Info can promise that.
        firstVideoPresentationTime = nil
        videoTimestamps.reset()
        audioFrameIndex = 0

        var response = outcome.response
        response.headers.append((
          name: "RTP-Info",
          value: rtpInfo(for: request.uri, hasAudio: audio != nil)
        ))
        write(response.wireFormat)

        isStreaming = true
        // Nothing before the next keyframe is decodable by a client that just joined, and sending it
        // makes a decoder report broken references rather than simply waiting.
        isAwaitingKeyframe = true
        requestKeyframe()
      case .stopStreaming:
        write(outcome.response.wireFormat)
        isStreaming = false
      case .close:
        isStreaming = false
        closeReason = "TEARDOWN"
        // Cancelling before the send completes discards the response, and the client then waits out
        // its TEARDOWN timeout on a connection the server has already forgotten.
        connection.send(content: outcome.response.wireFormat, completion: .contentProcessed {
          [weak self] _ in
          self?.connection.cancel()
        })
        return
      case .none:
        write(outcome.response.wireFormat)
      }
    }
  }

  /// RFC 2326 §12.33. Tells the client which sequence number and RTP timestamp each track will start
  /// at, which is what it uses to line the two up before the first RTCP sender report arrives.
  ///
  /// Only honest because the timelines are reset immediately above; promising a start the sender does
  /// not honour is worse than sending no header at all.
  private func rtpInfo(for uri: String, hasAudio: Bool) -> String {
    let base = uri.hasSuffix("/") ? String(uri.dropLast()) : uri
    var tracks = [
      "url=\(base)/\(SDPBuilder.videoTrackControl);seq=\(videoSequence);rtptime=0"
    ]
    if hasAudio {
      tracks.append("url=\(base)/\(SDPBuilder.audioTrackControl);seq=\(audioSequence);rtptime=0")
    }
    return tracks.joined(separator: ",")
  }

  private func write(_ data: Data) {
    connection.send(content: data, completion: .contentProcessed { _ in })
  }

  // MARK: - Media

  func send(video frame: EncodedVideoFrame, codec: StreamCodec) {
    queue.async { [self] in
      guard isStreaming, let setup = videoSetup else { return }
      if isAwaitingKeyframe {
        guard frame.isKeyframe else { return }
        isAwaitingKeyframe = false
      }

      let payloads: [Data] = switch codec {
      case .h264: H264Packetizer().payloads(for: frame)
      case .hevc: HEVCPacketizer().payloads(for: frame)
      }
      guard !payloads.isEmpty else { return }

      let bytes = payloads.reduce(0) { $0 + $1.count }
      congestion.offered(bytes: bytes)
      let wasDropping = sendQueue.isDropping
      switch sendQueue.decide(frameBytes: bytes, isKeyframe: frame.isKeyframe) {
      case .drop:
        // Nothing more goes out until a keyframe, so ask for one now rather than leaving the client
        // without pictures for the rest of the GOP.
        if !wasDropping { requestKeyframe() }
        return
      case .flushThenSend:
        // NWConnection cannot cancel the stale send buffers; `decide` bumped `generation` so their
        // completions will not debit this keyframe.
        break
      case .send:
        break
      }

      if firstVideoPresentationTime == nil { firstVideoPresentationTime = frame.presentationTime }
      let elapsed = frame.presentationTime - (firstVideoPresentationTime ?? frame.presentationTime)
      let natural = UInt32(truncatingIfNeeded: Int64(elapsed * Double(H264Packetizer.clockRate)))

      // A receiver treats a timestamp change as the end of a picture, so two frames sharing one are
      // merged into a single malformed access unit. The capture clock does occasionally repeat a
      // presentation time, so the sent timestamp is forced to advance — measured on the 32-bit
      // circle, because the field's own rollover is a forward step and not a repeat.
      let timestamp = videoTimestamps.next(natural: natural)

      let writer = RTPPacketWriter(payloadType: SDPBuilder.videoPayloadType, ssrc: videoSSRC)
      var batch = Data()
      for (index, payload) in payloads.enumerated() {
        // The marker bit goes on the last packet of the picture, which is how the receiver knows the
        // frame is complete without waiting for the next timestamp.
        let packet = writer.packet(
          sequenceNumber: videoSequence,
          timestamp: timestamp,
          marker: index == payloads.count - 1,
          payload: payload
        )
        videoSequence &+= 1
        videoPacketCount &+= 1
        videoOctetCount &+= UInt32(truncatingIfNeeded: payload.count)
        if let framed = InterleavedFramer.frame(channel: setup.dataChannel, payload: packet) {
          batch.append(framed)
        }
      }

      sendMedia(batch)
      sendReportIfDue(setup: setup, rtpTimestamp: timestamp, captureTime: frame.presentationTime)
    }
  }

  func send(audio frame: EncodedAudioFrame) {
    queue.async { [self] in
      guard isStreaming, let setup = audioSetup else { return }
      guard let payload = AACPacketizer().payload(for: frame) else { return }

      let writer = RTPPacketWriter(payloadType: SDPBuilder.audioPayloadType, ssrc: audioSSRC)
      let timestamp = AACPacketizer.timestamp(forFrameIndex: audioFrameIndex)
      let packet = writer.packet(
        sequenceNumber: audioSequence,
        timestamp: timestamp,
        marker: true,
        payload: payload
      )
      audioSequence &+= 1
      audioFrameIndex += 1
      audioPacketCount &+= 1
      audioOctetCount &+= UInt32(truncatingIfNeeded: payload.count)

      guard let framed = InterleavedFramer.frame(channel: setup.dataChannel, payload: packet) else {
        return
      }
      congestion.offered(bytes: framed.count)
      sendQueue.enqueueAudio(bytes: framed.count)
      sendMedia(framed)
      sendAudioReportIfDue(
        setup: setup,
        rtpTimestamp: timestamp,
        captureTime: frame.captureTime ?? frame.presentationTime
      )
    }
  }

  private func sendMedia(_ data: Data) {
    guard !data.isEmpty else { return }
    let count = data.count
    let generation = sendQueue.generation
    congestion.sent(bytes: count, at: ProcessInfo.processInfo.systemUptime)
    connection.send(content: data, completion: .contentProcessed { [weak self] _ in
      // Credited on completion rather than enqueue, so the queue depth reflects what the client has
      // actually taken. Completions from a flushed generation are ignored by the send queue, but the
      // meter still counts them: flushed or not, those bytes went down the link.
      guard let self else { return }
      self.queue.async {
        self.sendQueue.complete(bytes: count, generation: generation)
        self.congestion.delivered()
      }
    })
  }

  /// This client's link since the last call, or nil when it is not playing. Runs on the server's
  /// queue like everything else here.
  func congestionSample(at now: Double) -> CongestionSample? {
    let sample = congestion.sample(
      at: now,
      droppedFrames: sendQueue.droppedFrames,
      flushes: sendQueue.flushes,
      transportBacklogBytes: transportBacklogBytes()
    )
    return isStreaming ? sample : nil
  }

  /// Bytes the TCP send buffer is holding, estimated as its largest free space seen less its free
  /// space now.
  ///
  /// `.contentProcessed` fires when Network.framework has handed bytes to TCP, not when they left,
  /// so a send buffer that autotunes to megabytes can hold seconds of video with nothing waiting on
  /// this side at all. This is the part of the queue the ledger cannot see.
  private func transportBacklogBytes() -> Int? {
    guard let metadata = connection.metadata(definition: NWProtocolTCP.definition) as? NWProtocolTCP.Metadata
    else { return nil }
    let available = Int(metadata.availableSendBuffer)
    largestAvailableSendBuffer = max(largestAvailableSendBuffer, available)
    return largestAvailableSendBuffer - available
  }

  /// A sender report about once a second, which is what RFC 3550 §6.2 recommends and what clients use
  /// to derive a wall clock and to learn the CNAME.
  /// Wall clock minus the capture clock, sampled once per connection.
  ///
  /// `EncodedVideoFrame.presentationTime` is on the host time clock; NTP is wall clock. Sampling the
  /// difference once and reusing it keeps successive reports on a single mapping, so a receiver
  /// regressing RTP against NTP sees the camera's own rate rather than this app's clock reads.
  private lazy var captureToWallOffset: Double = {
    Date().timeIntervalSince1970 - CMClockGetTime(CMClockGetHostTimeClock()).seconds
  }()

  /// The audio stream's own sender report, about once a second, on the audio control channel.
  ///
  /// Only the picture used to have one, so a receiver could tie the audio's RTP timeline to a wall
  /// clock only through when its first packet arrived. Paired from the frame's capture time and put
  /// on wall time through the same offset as the video's, so both streams share one mapping.
  private func sendAudioReportIfDue(setup: RTSPResponder.Setup, rtpTimestamp: UInt32, captureTime: Double) {
    let now = Date()
    guard now.timeIntervalSince(lastAudioReportTime) >= 1 else { return }
    lastAudioReportTime = now

    let captureWall = Date(timeIntervalSince1970: captureTime + captureToWallOffset)
    let writer = RTCPWriter(ssrc: audioSSRC, identity: identity())
    let report = writer.compoundPacket(
      ntpTime: RTCPWriter.ntpTime(from: captureWall),
      rtpTimestamp: rtpTimestamp,
      packetCount: audioPacketCount,
      octetCount: audioOctetCount
    )
    if let framed = InterleavedFramer.frame(channel: setup.controlChannel, payload: report) {
      write(framed)
    }
  }

  private func sendReportIfDue(setup: RTSPResponder.Setup, rtpTimestamp: UInt32, captureTime: Double) {
    let now = Date()
    guard now.timeIntervalSince(lastReportTime) >= 1 else { return }
    lastReportTime = now

    // Stamped from the frame's capture time, not from `Date()` here.
    //
    // The RTP timestamp in this report is derived from capture; pairing it with the wall clock at
    // *send* makes the pair wrong by however long encode and the send queue took, and that is
    // variable — the queue backs up under contention — so it lands in the receiver's offset
    // estimate as noise it cannot filter out. It also makes any send-side test delay invisible:
    // hold the frames and the report slides with them, so the receiver's correction absorbs the
    // fault and the injection silently passes.
    let captureWall = Date(timeIntervalSince1970: captureTime + captureToWallOffset)

    let writer = RTCPWriter(ssrc: videoSSRC, identity: identity())
    let report = writer.compoundPacket(
      ntpTime: RTCPWriter.ntpTime(from: captureWall),
      rtpTimestamp: rtpTimestamp,
      packetCount: videoPacketCount,
      octetCount: videoOctetCount
    )
    if let framed = InterleavedFramer.frame(channel: setup.controlChannel, payload: report) {
      write(framed)
    }
  }
}
