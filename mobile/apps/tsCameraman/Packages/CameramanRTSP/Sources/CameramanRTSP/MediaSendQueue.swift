import Foundation

/// What waits to go out to one client, and what is given up when the link falls behind.
///
/// A camera encodes at a fixed rate whatever the network is doing. When the link carries less than
/// that, something has to wait, and whatever waits grows older. A receiver plays each picture and
/// each sound a fixed delay after capture (TS Director's live delay D, a second by default), so
/// anything that waits longer than that on the phone is too late to be heard or shown live, and holds
/// up everything behind it: on a link with jitter and loss the phone once fell 480 s behind, and at a
/// 3 Mbit/s cap it ran 0.5–1.4 s behind, so the live mix went silent for long stretches and replayed
/// a backlog when the link cleared.
///
/// So nothing is allowed to wait longer than `maximumAgeSeconds` from capture:
///
/// - A picture older than that starts a drop: it and every picture after it up to the next keyframe
///   are discarded (nothing between can be decoded without the dropped one), and the encoder is asked
///   for a keyframe. The stream skips ahead instead of falling behind.
/// - Sound older than that is discarded. Its stamps follow capture position, so the receiver sees a
///   gap in the sample count and fades over it on the same timeline.
///
/// The wait has to happen here, where it can still be dropped. Bytes handed to the transport cannot
/// be taken back, so the caller hands over only while `TransportGate` says the transport holds less
/// than about a quarter second at the rate the link is draining it. Sound and control go in an
/// urgent lane ahead of pictures, and pictures go one RTP packet at a time, so sound never waits
/// behind a whole keyframe.
///
/// RTP sequence numbers are written as packets are handed over, so a drop leaves no hole in them: a
/// receiver reads a hole as loss and marks the next access unit, the keyframe that ends the drop, as
/// corrupt.
public struct MediaSendQueue: Sendable {
  /// The oldest capture anything may have when it is handed to the transport: TS Director's default
  /// live delay D. Anything older cannot be heard or shown live, and sending it only delays what is
  /// behind it.
  public static let maximumAgeSeconds = 1.0
  /// How often a drop may ask the encoder again for a keyframe that has not come.
  public static let keyframeRequestIntervalSeconds = 0.5

  private struct Urgent: Sendable {
    let data: Data
    /// Capture time on the host clock; nil for control.
    let capture: Double?
    let duration: Double
    let enqueuedAt: Double
  }

  private struct Picture: Sendable {
    var packets: [Data]
    var sent = 0
    let capture: Double
    let isKeyframe: Bool
    let enqueuedAt: Double
    var bytes: Int { packets[sent...].reduce(0) { $0 + $1.count } }
  }

  private var urgent: [Urgent] = []
  private var pictures: [Picture] = []
  private var sequences: [UInt8: UInt16] = [:]
  private var lastKeyframeRequest: Double?

  /// True from a dropped picture until the keyframe that ends the drop.
  public private(set) var isDropping = false
  /// Pictures dropped for being too old, or for following one that was.
  public private(set) var droppedFrames = 0
  /// Drops started: each is one jump ahead in the picture.
  public private(set) var flushes = 0
  /// Sound packets dropped for being too old, and the sound they carried.
  public private(set) var droppedSoundPackets = 0
  public private(set) var droppedSoundSeconds: Double = 0
  /// Keyframes asked of the encoder by drops.
  public private(set) var keyframeRequests = 0

  public let maximumAge: Double

  public init(maximumAge: Double = MediaSendQueue.maximumAgeSeconds) {
    self.maximumAge = maximumAge
  }

  /// A new session: what waits belongs to the old one. The counts and sequence numbers carry on.
  public mutating func reset() {
    urgent.removeAll()
    pictures.removeAll()
    isDropping = false
  }

  /// Bytes waiting here, not yet handed to the transport.
  public var pendingBytes: Int {
    urgent.reduce(0) { $0 + $1.data.count } + pictures.reduce(0) { $0 + $1.bytes }
  }

  public var isEmpty: Bool { urgent.isEmpty && pictures.isEmpty }

  /// How long the oldest thing waiting has waited here.
  public func oldestWait(at now: Double) -> Double {
    let first = [urgent.first?.enqueuedAt, pictures.first?.enqueuedAt].compactMap { $0 }.min()
    return first.map { max(0, now - $0) } ?? 0
  }

  /// The sequence number the next media packet on `channel` will carry, for `RTP-Info`.
  public func nextSequence(channel: UInt8) -> UInt16 {
    sequences[channel] ?? 0
  }

  /// One picture, as interleaved RTP packets. Returns true when the encoder should be asked for a
  /// keyframe.
  public mutating func enqueuePicture(_ packets: [Data], capture: Double, isKeyframe: Bool, now: Double) -> Bool {
    guard !packets.isEmpty else { return false }
    if isDropping, !isKeyframe {
      droppedFrames += 1
      return requestKeyframe(at: now)
    }
    // A drop leaves nothing unsent behind it but a picture already part-sent, so a keyframe simply
    // ends it.
    if isKeyframe { isDropping = false }
    pictures.append(Picture(packets: packets, capture: capture, isKeyframe: isKeyframe, enqueuedAt: now))
    return prune(at: now)
  }

  /// One sound packet, as an interleaved RTP packet carrying `duration` seconds.
  public mutating func enqueueSound(_ packet: Data, capture: Double, duration: Double, now: Double) {
    urgent.append(Urgent(data: packet, capture: capture, duration: duration, enqueuedAt: now))
  }

  /// A sender report or an RTSP response: never dropped, never renumbered, and ahead of pictures.
  public mutating func enqueueControl(_ data: Data, now: Double) {
    urgent.append(Urgent(data: data, capture: nil, duration: 0, enqueuedAt: now))
  }

  /// Drops what has grown too old. Returns true when the encoder should be asked for a keyframe.
  public mutating func prune(at now: Double) -> Bool {
    urgent.removeAll { item in
      guard let capture = item.capture, now - capture > maximumAge else { return false }
      droppedSoundPackets += 1
      droppedSoundSeconds += item.duration
      return true
    }

    // A picture already part-sent finishes; the receiver has its first packets.
    let first = pictures.first.map { $0.sent > 0 ? 1 : 0 } ?? 0
    let stale = pictures[first...].prefix { now - $0.capture > maximumAge }.count
    guard stale > 0 || isDropping else { return false }
    if !isDropping { flushes += 1 }
    // Everything up to the first keyframe young enough to send.
    let resume = pictures[(first + stale)...].firstIndex(where: \.isKeyframe)
    let end = resume ?? pictures.endIndex
    droppedFrames += end - first
    pictures.removeSubrange(first ..< end)
    isDropping = resume == nil
    return isDropping && requestKeyframe(at: now)
  }

  /// The next bytes to hand to the transport, or nil when there is nothing or no room. `hasRoom`
  /// gates media; control always goes. Call `prune` first.
  public mutating func next(hasRoom: Bool) -> Data? {
    if let head = urgent.first {
      guard head.capture == nil || hasRoom else { return nil }
      urgent.removeFirst()
      return head.capture == nil ? head.data : renumbered(head.data)
    }
    guard hasRoom, var picture = pictures.first else { return nil }
    let packet = picture.packets[picture.sent]
    picture.sent += 1
    if picture.sent == picture.packets.count {
      pictures.removeFirst()
    } else {
      pictures[0] = picture
    }
    return renumbered(packet)
  }

  private mutating func requestKeyframe(at now: Double) -> Bool {
    if let last = lastKeyframeRequest, now - last < Self.keyframeRequestIntervalSeconds { return false }
    lastKeyframeRequest = now
    keyframeRequests += 1
    return true
  }

  /// Writes the channel's next sequence number into an interleaved RTP packet (`$`, channel, length,
  /// then the RTP header, whose sequence number is bytes 2–3).
  private mutating func renumbered(_ framed: Data) -> Data {
    guard framed.count >= 8 else { return framed }
    var data = framed
    let base = data.startIndex
    guard data[base] == 0x24 else { return framed }
    let channel = data[base + 1]
    let sequence = sequences[channel] ?? 0
    data[base + 6] = UInt8(sequence >> 8)
    data[base + 7] = UInt8(sequence & 0xFF)
    sequences[channel] = sequence &+ 1
    return data
  }
}

/// How much is in the transport — handed over, not yet gone from the phone — and whether more may
/// follow.
///
/// Bytes handed over can no longer be dropped for a fresher picture, so the transport is allowed
/// about `transportSeconds` of what the link is actually draining, never less than `minimumBytes` (a
/// round trip's worth on a healthy link) and `initialBytes` until a rate has been measured. What it
/// holds is what was handed over and not yet taken, plus the kernel's send queue where the platform
/// can say exactly (Android's `SIOCOUTQ`); the iPhone's reported free space is not exact enough to
/// count.
public struct TransportGate: Sendable {
  public static let transportSeconds = 0.25
  public static let minimumBytes = 32 * 1024
  public static let initialBytes = 64 * 1024
  public static let rateWindowSeconds = 1.0

  /// Bytes handed to the transport, and bytes it reported taking.
  public private(set) var handedBytes = 0
  public private(set) var processedBytes = 0
  private var departures: [(time: Double, left: Int)] = []
  private var rate: Double?

  public init() {}

  public mutating func handed(_ bytes: Int) { handedBytes += bytes }
  public mutating func processed(_ bytes: Int) { processedBytes += bytes }

  /// Bytes the transport holds: handed and not yet taken, plus what the kernel holds.
  public func inTransport(kernelBacklog: Int) -> Int {
    max(0, handedBytes - processedBytes) + max(0, kernelBacklog)
  }

  /// Notes how much has left the phone by `now`, for the drain rate.
  public mutating func observe(at now: Double, kernelBacklog: Int) {
    let left = max(0, processedBytes - max(0, kernelBacklog))
    if let last = departures.last, now <= last.time { return }
    departures.append((now, left))
    while departures.count > 2, now - departures[1].time >= Self.rateWindowSeconds {
      departures.removeFirst()
    }
    if let oldest = departures.first, now - oldest.time >= Self.rateWindowSeconds * 0.5 {
      rate = Double(max(0, left - oldest.left)) / (now - oldest.time)
    }
  }

  /// Bytes per second the link has been draining, nil until half a window is measured.
  public var drainRate: Double? { rate }

  public var budgetBytes: Int {
    guard let rate else { return Self.initialBytes }
    return max(Self.minimumBytes, Int(rate * Self.transportSeconds))
  }

  public func hasRoom(kernelBacklog: Int) -> Bool {
    inTransport(kernelBacklog: kernelBacklog) < budgetBytes
  }
}
