import AdaptiveBitrate
import Darwin
import Foundation
import Testing
@testable import DirectorRTMP

@Suite("RTMP send ledger")
struct RTMPSendLedgerTests {
  @Test("The queue delay is the age of the oldest write the socket has not finished")
  func queueDelay() {
    var ledger = RTMPSendLedger()
    ledger.submitted(bytes: 1000, at: 0)
    ledger.submitted(bytes: 500, at: 0.1)
    #expect(abs(ledger.queueDelay(at: 0.3) - 0.3) < 1e-9)
    // Part of the second write is taken with the first: the oldest unfinished one is now the second.
    ledger.delivered(bytes: 1200)
    #expect(abs(ledger.queueDelay(at: 0.3) - 0.2) < 1e-9)
    #expect(ledger.pendingBytes == 300)
    ledger.delivered(bytes: 300)
    #expect(ledger.queueDelay(at: 0.3) == 0)
  }

  @Test("A sample is in video's terms: audio comes out of what was delivered and drained")
  func audioIsTakenOut() {
    var ledger = RTMPSendLedger()
    _ = ledger.sample(at: 0, droppedPackets: 0, transportBacklogBytes: nil)
    ledger.submitted(bytes: 1500, at: 0)
    ledger.delivered(bytes: 1500)
    ledger.offered(bytes: 1400, isAudio: false)
    ledger.offered(bytes: 100, isAudio: true)
    let sample = ledger.sample(at: 0.25, droppedPackets: 3, transportBacklogBytes: nil)
    #expect(sample.interval == 0.25)
    #expect(sample.deliveredBytes == 1400)
    #expect(sample.drainedBytes == 1400)
    #expect(sample.offeredBytes == 1400)
    #expect(sample.droppedFrames == 3)
    #expect(sample.transportBacklogBytes == nil)
  }

  @Test("What the kernel's backlog grew by was delivered to it but has not drained")
  func backlogGrowthIsNotDrained() {
    var ledger = RTMPSendLedger()
    _ = ledger.sample(at: 0, droppedPackets: 0, transportBacklogBytes: 1000)
    ledger.submitted(bytes: 4000, at: 0.1)
    ledger.delivered(bytes: 4000)
    ledger.offered(bytes: 4000, isAudio: false)
    let sample = ledger.sample(at: 0.25, droppedPackets: 2, transportBacklogBytes: 3500)
    #expect(sample.deliveredBytes == 4000)
    #expect(sample.drainedBytes == 1500)
    #expect(sample.transportBacklogBytes == 3500)
    #expect(sample.droppedFrames == 2)
  }

  @Test("The client's sample counts what it offered, what the socket took, and what the budget shed")
  func clientSample() {
    var fds: [Int32] = [ 0, 0 ]
    _ = socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
    var size = Int32(4096)
    setsockopt(fds[0], SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fds[1], SOL_SOCKET, SO_RCVBUF, &size, socklen_t(MemoryLayout<Int32>.size))
    let client = RTMPClient()
    client.attachForTesting(fd: fds[0], budgetBytes: 64 * 1024)
    defer {
      client.stop()
      Darwin.close(fds[1])
    }
    _ = client.congestionSample(at: RTMPClient.monotonicNow())

    // Far more than the peer will take, so writes wait and then the budget sheds.
    let tag = FLVTag.videoFrame(codec: .hevc, keyframe: false, payload: Data(repeating: 7, count: 8 * 1024))
    var sent = 0
    for _ in 0 ..< 40 where client.sendVideo(timestampMs: 0, tag: tag) == .sent {
      sent += 1
    }
    let audio = FLVTag.audio(packetType: 1, payload: Data(repeating: 3, count: 64))
    // Wait long enough for the oldest write to have an age worth reading.
    usleep(100_000)
    let sample = client.congestionSample(at: RTMPClient.monotonicNow())
    #expect(sample.offeredBytes == 40 * tag.count)
    #expect(sample.droppedFrames == 40 - sent)
    #expect(sample.droppedFrames > 0)
    #expect(sample.queueDelay >= 0.09)
    // A Unix socket pair keeps nothing unsent in the sender's kernel buffer.
    #expect(sample.transportBacklogBytes == 0)

    // The far end reads everything: the ledger empties and the delivery shows up.
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline, client.metrics.queuedBytes > 0 {
      let read = buffer.withUnsafeMutableBytes { Darwin.recv(fds[1], $0.baseAddress, $0.count, MSG_DONTWAIT) }
      if read <= 0 { usleep(5_000) }
    }
    client.sendAudio(timestampMs: 0, tag: audio)
    let drained = client.congestionSample(at: RTMPClient.monotonicNow())
    #expect(drained.queueDelay < 0.05)
    #expect(drained.offeredBytes == 0)
    // What the socket took, less the audio offered in the interval: at least the video that was queued.
    #expect(drained.deliveredBytes >= sent * tag.count - 64 * 1024)
    #expect(drained.droppedFrames == 0)
  }
}
