import AdaptiveBitrate
import Foundation

/// The ledger a `CongestionSample` is read from: every write the client makes, in order, and how
/// much of it the socket has taken — the RTMP client's counterpart of the Cameraman's
/// `CongestionMeter`.
///
/// Writes reach the socket in the order they were made, because the link is one TCP stream, so the
/// oldest write the socket has not finished taking is always the first entry, and its age is how
/// long the newest frame will wait. Entries are made where `RTMPClient` counts a write as queued —
/// when it is submitted, before it reaches the serial queue — so the age covers a backlog parked in
/// the dispatch queue behind a blocked `send`, which is where the 2026-09-05 backlog built up.
///
/// Commands and metadata go through the ledger too, so the bytes it counts delivered balance with
/// what the socket took. What the encoder offered counts media only.
struct RTMPSendLedger {
  private var waitingSince: [Double] = []
  private var waitingBytes: [Int] = []
  private var head = 0

  private var deliveredSinceSample = 0
  private var offeredVideoSinceSample = 0
  private var offeredAudioSinceSample = 0
  private var lastSampleTime: Double?
  private var lastDroppedPackets: UInt64 = 0
  private var lastBacklog: Int?

  /// Bytes submitted and not yet taken by the socket.
  var pendingBytes: Int { waitingBytes[head...].reduce(0, +) }

  /// A write of `bytes` was submitted at `time`.
  mutating func submitted(bytes: Int, at time: Double) {
    guard bytes > 0 else { return }
    waitingSince.append(time)
    waitingBytes.append(bytes)
  }

  /// The socket took `bytes` more, which may finish several writes or only part of one.
  mutating func delivered(bytes: Int) {
    deliveredSinceSample += bytes
    var remaining = bytes
    while remaining > 0, head < waitingBytes.count {
      let taken = min(remaining, waitingBytes[head])
      waitingBytes[head] -= taken
      remaining -= taken
      if waitingBytes[head] == 0 { head += 1 }
    }
    // Compacted in batches so a long run does not grow the arrays forever, and finishing a write is
    // not an O(n) shift.
    if head >= 256, head * 2 >= waitingBytes.count {
      waitingSince.removeFirst(head)
      waitingBytes.removeFirst(head)
      head = 0
    }
  }

  /// A media tag handed to the client, whether it was then sent or shed. Audio is kept apart so it
  /// can be taken out of the delivery rate: the controller sets the video bitrate, and a cut to what
  /// the link delivered would otherwise hand the video the audio's share as well.
  mutating func offered(bytes: Int, isAudio: Bool) {
    if isAudio {
      offeredAudioSinceSample += bytes
    } else {
      offeredVideoSinceSample += bytes
    }
  }

  /// The connection is gone and every write with it.
  mutating func clear() {
    waitingSince.removeAll()
    waitingBytes.removeAll()
    head = 0
  }

  func queueDelay(at now: Double) -> Double {
    guard head < waitingSince.count else { return 0 }
    return max(0, now - waitingSince[head])
  }

  /// Everything since the previous call, in video's terms. `droppedPackets` is the client's running
  /// total; the sample carries how much it grew. `transportBacklogBytes` is what the kernel holds
  /// unsent, when it can be read.
  ///
  /// The audio offered in the interval is taken out of what was delivered and drained. Audio is
  /// never held back for a keyframe and is a steady 128 kbps, so over the controller's one-second
  /// delivery window what was offered is what went; the remainder is what the link gave the video.
  mutating func sample(at now: Double, droppedPackets: UInt64, transportBacklogBytes: Int?) -> CongestionSample {
    let interval = lastSampleTime.map { max(0, now - $0) } ?? 0
    var drained = deliveredSinceSample
    if let backlog = transportBacklogBytes, let previous = lastBacklog {
      drained = max(0, deliveredSinceSample - (backlog - previous))
    }
    let audio = offeredAudioSinceSample
    let sample = CongestionSample(
      interval: interval,
      queueDelay: queueDelay(at: now),
      deliveredBytes: max(0, deliveredSinceSample - audio),
      offeredBytes: offeredVideoSinceSample,
      transportBacklogBytes: transportBacklogBytes,
      drainedBytes: max(0, drained - audio),
      droppedFrames: Int(clamping: droppedPackets &- min(droppedPackets, lastDroppedPackets)),
      flushes: 0
    )
    lastSampleTime = now
    lastDroppedPackets = droppedPackets
    lastBacklog = transportBacklogBytes
    deliveredSinceSample = 0
    offeredVideoSinceSample = 0
    offeredAudioSinceSample = 0
    return sample
  }
}
