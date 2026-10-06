import AdaptiveBitrate
import CameramanRTSP
import Foundation
import Testing

/// Nothing waits on the phone longer than a receiver's live delay: a link that falls behind makes the
/// stream skip ahead, never fall behind. The cases use a half-second bound.
struct MediaSendQueueTests {
  static let video: UInt8 = 0
  static let audio: UInt8 = 2

  /// An interleaved RTP packet on `channel` whose sequence number reads 0 and whose payload is `tag`.
  static func packet(_ channel: UInt8, tag: UInt8, size: Int = 20) -> Data {
    var rtp = Data(repeating: 0, count: 12)
    rtp[0] = 0x80
    rtp.append(Data(repeating: tag, count: max(1, size - 16)))
    var framed = Data([0x24, channel, UInt8(rtp.count >> 8), UInt8(rtp.count & 0xFF)])
    framed.append(rtp)
    return framed
  }

  static func picture(_ tag: UInt8, packets: Int = 1) -> [Data] {
    (0 ..< packets).map { _ in packet(video, tag: tag) }
  }

  static func sequence(_ data: Data) -> UInt16 {
    UInt16(data[data.startIndex + 6]) << 8 | UInt16(data[data.startIndex + 7])
  }

  static func tag(_ data: Data) -> UInt8 { data[data.endIndex - 1] }

  /// Everything the queue will hand over now.
  static func drain(_ queue: inout MediaSendQueue, hasRoom: Bool = true) -> [Data] {
    var out: [Data] = []
    while let next = queue.next(hasRoom: hasRoom) { out.append(next) }
    return out
  }

  @Test func youngMediaGoesOutWithSoundAheadAndSequenceNumbersCounted() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    let result1 = queue.enqueuePicture(Self.picture(1, packets: 2), capture: 0, isKeyframe: true, now: 0.02)
    #expect(!result1)
    queue.enqueueSound(Self.packet(Self.audio, tag: 9), capture: 0.01, duration: 0.021, now: 0.03)
    let result2 = queue.enqueuePicture(Self.picture(2), capture: 0.017, isKeyframe: false, now: 0.04)
    #expect(!result2)
    #expect(queue.pendingBytes == 4 * 20)
    #expect(abs(queue.oldestWait(at: 0.05) - 0.03) < 1e-9)
    let result3 = queue.prune(at: 0.05)
    #expect(!result3)

    let out = Self.drain(&queue)
    #expect(out.map(Self.tag) == [9, 1, 1, 2])
    #expect(out.map(Self.sequence) == [0, 0, 1, 2], "each channel counts its own")
    #expect(queue.nextSequence(channel: Self.video) == 3)
    #expect(queue.nextSequence(channel: Self.audio) == 1)
    #expect(queue.isEmpty)
    #expect(queue.oldestWait(at: 1) == 0)
    #expect(queue.droppedFrames == 0 && queue.flushes == 0)
  }

  @Test func soundGoesBetweenThePacketsOfALargePicture() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    _ = queue.enqueuePicture(Self.picture(1, packets: 3), capture: 0, isKeyframe: true, now: 0)
    let result4 = queue.next(hasRoom: true)
    #expect(result4.map(Self.tag) == 1)
    queue.enqueueSound(Self.packet(Self.audio, tag: 9), capture: 0.01, duration: 0.021, now: 0.01)
    #expect(Self.drain(&queue).map(Self.tag) == [9, 1, 1])
  }

  @Test func aPictureTooOldDropsEverythingUpToTheNextKeyframe() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    for index in 0 ..< 4 {
      _ = queue.enqueuePicture(Self.picture(UInt8(index)), capture: Double(index) * 0.1, isKeyframe: index == 0, now: Double(index) * 0.1)
    }
    _ = queue.enqueuePicture(Self.picture(7), capture: 0.45, isKeyframe: false, now: 0.45)
    _ = queue.enqueuePicture(Self.picture(8), capture: 0.5, isKeyframe: true, now: 0.5)
    _ = queue.enqueuePicture(Self.picture(9), capture: 0.55, isKeyframe: false, now: 0.55)

    // At 0.65 s the first two pictures (0 and 0.1 s) are over half a second old. Picture 7 is young,
    // but predicts from them: only the keyframe at 0.5 s can be decoded without them.
    let result5 = queue.prune(at: 0.65)
    #expect(!result5, "a keyframe is already waiting, so none is asked for")
    #expect(queue.droppedFrames == 5)
    #expect(queue.flushes == 1)
    #expect(!queue.isDropping)
    let out = Self.drain(&queue)
    #expect(out.map(Self.tag) == [8, 9])
    #expect(out.map(Self.sequence) == [0, 1], "no hole for a receiver to read as loss")
  }

  @Test func withNoKeyframeWaitingADropAsksForOneAndDropsWhatFollows() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    _ = queue.enqueuePicture(Self.picture(1), capture: 0, isKeyframe: true, now: 0)
    _ = queue.enqueuePicture(Self.picture(2), capture: 0.1, isKeyframe: false, now: 0.1)
    #expect(Self.drain(&queue, hasRoom: false).isEmpty, "the transport is full")

    let result6 = queue.prune(at: 0.7)
    #expect(result6, "ask the encoder for a keyframe")
    #expect(queue.isDropping)
    #expect(queue.droppedFrames == 2)
    #expect(queue.keyframeRequests == 1)
    // Young, but undecodable without what was dropped. Asked again only after the interval.
    let result7 = queue.enqueuePicture(Self.picture(3), capture: 0.69, isKeyframe: false, now: 0.7)
    #expect(!result7)
    let result8 = queue.prune(at: 0.8)
    #expect(!result8)
    let result9 = queue.enqueuePicture(Self.picture(4), capture: 1.19, isKeyframe: false, now: 1.2)
    #expect(result9)
    #expect(queue.keyframeRequests == 2)
    #expect(queue.droppedFrames == 4)
    #expect(queue.isEmpty)
    #expect(queue.flushes == 1, "one drop, however many pictures")

    let result10 = queue.enqueuePicture(Self.picture(5), capture: 1.25, isKeyframe: true, now: 1.26)
    #expect(!result10)
    #expect(!queue.isDropping)
    _ = queue.enqueuePicture(Self.picture(6), capture: 1.27, isKeyframe: false, now: 1.28)
    let out = Self.drain(&queue)
    #expect(out.map(Self.tag) == [5, 6])
    #expect(out.map(Self.sequence) == [0, 1])
  }

  @Test func aStaleKeyframeIsDroppedTooAndTheNextOneEndsTheDrop() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    _ = queue.enqueuePicture(Self.picture(1), capture: 0, isKeyframe: true, now: 0)
    let result11 = queue.prune(at: 0.6)
    #expect(result11)
    #expect(queue.isDropping)
    _ = queue.enqueuePicture(Self.picture(2), capture: 0.6, isKeyframe: true, now: 0.6)
    #expect(Self.drain(&queue).map(Self.tag) == [2])
  }

  @Test func aPicturePartSentFinishesHoweverOldItGets() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    _ = queue.enqueuePicture(Self.picture(1, packets: 3), capture: 0, isKeyframe: true, now: 0)
    _ = queue.enqueuePicture(Self.picture(2), capture: 0.02, isKeyframe: false, now: 0.02)
    let result12 = queue.next(hasRoom: true)
    #expect(result12.map(Self.tag) == 1)
    let result13 = queue.prune(at: 0.9)
    #expect(result13)
    #expect(queue.droppedFrames == 1, "only the picture not yet begun")
    #expect(Self.drain(&queue).map(Self.tag) == [1, 1])
  }

  @Test func soundTooOldIsDroppedAndCounted() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    queue.enqueueSound(Self.packet(Self.audio, tag: 1), capture: 0, duration: 0.021, now: 0)
    queue.enqueueSound(Self.packet(Self.audio, tag: 2), capture: 0.021, duration: 0.021, now: 0.03)
    queue.enqueueSound(Self.packet(Self.audio, tag: 3), capture: 0.3, duration: 0.021, now: 0.3)
    queue.enqueueControl(Data("RTSP/1.0 200 OK\r\n\r\n".utf8), now: 0)
    let result14 = queue.prune(at: 0.55)
    #expect(!result14)
    #expect(queue.droppedSoundPackets == 2)
    #expect(abs(queue.droppedSoundSeconds - 0.042) < 1e-9)
    let out = Self.drain(&queue)
    #expect(out.count == 2)
    #expect(String(data: out[1], encoding: .utf8) == "RTSP/1.0 200 OK\r\n\r\n", "control is never dropped or renumbered")
    #expect(Self.sequence(out[0]) == 0, "the receiver sees a skip in the stamps, not a lost packet")
  }

  @Test func withoutRoomControlStillGoesButMediaWaits() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    let report = Self.packet(1, tag: 5)
    queue.enqueueControl(report, now: 0)
    queue.enqueueSound(Self.packet(Self.audio, tag: 9), capture: 0, duration: 0.021, now: 0)
    _ = queue.enqueuePicture(Self.picture(1), capture: 0, isKeyframe: true, now: 0)
    let result15 = queue.next(hasRoom: false)
    #expect(result15 == report)
    let result16 = queue.next(hasRoom: false)
    #expect(result16 == nil)
    let result17 = queue.next(hasRoom: true)
    #expect(result17.map(Self.tag) == 9)
    let result18 = queue.next(hasRoom: false)
    #expect(result18 == nil)
    let result19 = queue.next(hasRoom: true)
    #expect(result19.map(Self.tag) == 1)
  }

  @Test func anEmptyPictureAndOddBytesAreLeftAlone() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    let result20 = queue.enqueuePicture([], capture: 0, isKeyframe: true, now: 0)
    #expect(!result20)
    #expect(queue.isEmpty)
    let short = Data([0x24, 0, 0, 1])
    queue.enqueueSound(short, capture: 0, duration: 0, now: 0)
    let result21 = queue.next(hasRoom: true)
    #expect(result21 == short)
    let unframed = Data(repeating: 7, count: 12)
    queue.enqueueSound(unframed, capture: 0, duration: 0, now: 0)
    let result22 = queue.next(hasRoom: true)
    #expect(result22 == unframed)
  }

  @Test func aNewSessionForgetsWhatWaitedButKeepsCounting() {
    var queue = MediaSendQueue(maximumAge: 0.5)
    _ = queue.enqueuePicture(Self.picture(1), capture: 0, isKeyframe: true, now: 0)
    _ = Self.drain(&queue)
    _ = queue.enqueuePicture(Self.picture(2), capture: 0.1, isKeyframe: false, now: 0.1)
    let result23 = queue.prune(at: 1)
    #expect(result23)
    queue.enqueueSound(Self.packet(Self.audio, tag: 9), capture: 1, duration: 0.021, now: 1)
    queue.reset()
    #expect(queue.isEmpty)
    #expect(!queue.isDropping)
    #expect(queue.droppedFrames == 1)
    _ = queue.enqueuePicture(Self.picture(3), capture: 2, isKeyframe: true, now: 2)
    let result24 = queue.next(hasRoom: true)
    #expect(result24.map(Self.sequence) == 1)
  }

  @Test func theBoundIsTheReceiversLiveDelay() {
    #expect(MediaSendQueue.maximumAgeSeconds == 1)
    #expect(MediaSendQueue().maximumAge == 1)
    let queue = MediaSendQueue(maximumAge: 1)
    #expect(queue.maximumAge == 1)
  }
}

struct TransportGateTests {
  @Test func untilARateIsMeasuredTheTransportTakesSixtyFourKilobytes() {
    var gate = TransportGate()
    #expect(gate.drainRate == nil)
    #expect(gate.budgetBytes == 64 * 1024)
    gate.handed(60_000)
    #expect(gate.hasRoom(kernelBacklog: 0))
    #expect(!gate.hasRoom(kernelBacklog: 10_000))
    gate.processed(60_000)
    #expect(gate.inTransport(kernelBacklog: 10_000) == 10_000)
    #expect(gate.handedBytes == 60_000 && gate.processedBytes == 60_000)
  }

  @Test func theBudgetIsAQuarterSecondOfWhatTheLinkDrains() {
    var gate = TransportGate()
    // 400 kB/s leaves the phone: 100 kB a quarter second.
    for step in 0 ... 20 {
      let now = Double(step) * 0.1
      gate.handed(40_000)
      gate.processed(40_000)
      gate.observe(at: now, kernelBacklog: 20_000)
    }
    #expect(abs((gate.drainRate ?? 0) - 400_000) < 1)
    #expect(abs(gate.budgetBytes - 100_000) <= 1)
    // A link carrying 20 kB/s still gets the floor, a round trip's worth on a healthy one.
    var slow = TransportGate()
    for step in 0 ... 20 {
      slow.processed(2_000)
      slow.observe(at: Double(step) * 0.1, kernelBacklog: 0)
    }
    #expect(slow.budgetBytes == 32 * 1024)
  }

  @Test func bytesStillInTheKernelHaveNotLeft() {
    var gate = TransportGate()
    gate.processed(100_000)
    gate.observe(at: 0, kernelBacklog: 100_000)
    gate.observe(at: 0, kernelBacklog: 0)
    gate.observe(at: 1, kernelBacklog: 50_000)
    #expect(gate.drainRate == 50_000)
    #expect(gate.inTransport(kernelBacklog: -5) == 0)
  }
}

struct CongestionWaitingHereTests {
  @Test func mediaWaitingOnThePhoneCountsAsDelay() {
    var meter = CongestionMeter()
    meter.sent(bytes: 100, at: 0)
    let sample = meter.sample(at: 0.1, droppedFrames: 0, flushes: 0, waitingHere: 0.4)
    #expect(abs(sample.queueDelay - 0.4) < 1e-9)
    let ledger = meter.sample(at: 0.5, droppedFrames: 0, flushes: 0, waitingHere: 0.1)
    #expect(abs(ledger.queueDelay - 0.5) < 1e-9)
  }
}
