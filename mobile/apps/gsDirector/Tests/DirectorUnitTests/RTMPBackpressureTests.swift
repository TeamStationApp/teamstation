import Darwin
import Foundation
import Testing
@testable import DirectorRTMP

/// Backpressure over a real socket whose peer never reads.
///
/// A `socketpair` with a small send buffer reproduces the shape that killed the app on
/// 2026-09-05: the peer accepts everything, reads nothing, and `send` blocks on the serial queue
/// while the encoder keeps handing over frames. The assertion that matters is not that memory
/// stays flat — a unit test cannot see that — but that `droppedPackets` *rises*. On the old code
/// it stayed at zero for the whole stall, because the cap was compared against a queue that was
/// always empty.
@Suite("RTMP backpressure")
struct RTMPBackpressureTests {
  private static let budget = 64 * 1024

  @Test("A peer that never reads makes the client shed, not grow")
  func stalledPeerSheds() {
    let pair = SocketPair()
    defer { pair.close() }
    let client = RTMPClient()
    client.attachForTesting(fd: pair.client, budgetBytes: Self.budget)
    defer { client.stop() }

    for _ in 0 ..< 200 {
      client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 8 * 1024))
    }

    let metrics = client.metrics
    // One chunk may be admitted at the moment the budget is crossed, and chunk framing adds a
    // header every 128 bytes, so the ceiling is the budget plus generous slack for one tag.
    #expect(metrics.queuedBytes <= Self.budget + 64 * 1024)
    #expect(metrics.droppedPackets > 0)
  }

  @Test("Video resumes on a keyframe rather than mid-GOP")
  func resumesOnKeyframe() {
    let pair = SocketPair()
    defer { pair.close() }
    let client = RTMPClient()
    client.attachForTesting(fd: pair.client, budgetBytes: Self.budget)
    defer { client.stop() }

    var sawOverBudget = false
    for _ in 0 ..< 200 where !sawOverBudget {
      if client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 8 * 1024))
        == .droppedOverBudget
      {
        sawOverBudget = true
      }
    }
    #expect(sawOverBudget)

    // Still over budget, so a P-frame is refused for the keyframe reason rather than admitted.
    #expect(
      client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 32))
        != .sent
    )

    // Drain, then the next P-frame is still refused until a keyframe has gone through.
    pair.drain(untilQueuedFallsBelow: Self.budget, of: client)
    #expect(
      client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 32))
        == .droppedAwaitingKeyframe
    )
    #expect(client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: true, bytes: 32)) == .sent)
    #expect(client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 32)) == .sent)
  }

  @Test("Sequence headers are never shed")
  func sequenceHeaderSurvivesTheBudget() {
    let pair = SocketPair()
    defer { pair.close() }
    let client = RTMPClient()
    client.attachForTesting(fd: pair.client, budgetBytes: Self.budget)
    defer { client.stop() }

    for _ in 0 ..< 200 {
      client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 8 * 1024))
    }
    #expect(client.metrics.droppedPackets > 0)

    // The decoder cannot read anything that follows without these, so the budget does not apply.
    let record = FLVTag.video(keyframe: true, packetType: 0, payload: Data(repeating: 9, count: 64))
    #expect(client.sendVideo(timestampMs: 0, tag: record) == .sent)
    let cookie = FLVTag.audio(packetType: 0, payload: Data([ 0x12, 0x10 ]))
    #expect(client.sendAudio(timestampMs: 0, tag: cookie) == .sent)
  }

  @Test("Audio is not gated behind video's keyframe")
  func audioIsNotKeyframeGated() {
    let pair = SocketPair()
    defer { pair.close() }
    let client = RTMPClient()
    client.attachForTesting(fd: pair.client, budgetBytes: Self.budget)
    defer { client.stop() }

    var sawOverBudget = false
    for _ in 0 ..< 200 where !sawOverBudget {
      if client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 8 * 1024))
        == .droppedOverBudget
      {
        sawOverBudget = true
      }
    }
    #expect(sawOverBudget)

    pair.drain(untilQueuedFallsBelow: Self.budget, of: client)
    // AAC frames decode independently, so there is nothing to wait for.
    #expect(client.sendAudio(timestampMs: 0, tag: FLVTag.audio(packetType: 1, payload: Data(repeating: 3, count: 64))) == .sent)
  }

  @Test("A peer that stops reading becomes a disconnect, not an indefinite park")
  func stalledPeerTimesOut() {
    let pair = SocketPair()
    defer { pair.close() }
    let client = RTMPClient()
    client.attachForTesting(fd: pair.client, budgetBytes: 8 * 1024 * 1024, sendTimeoutSeconds: 0.5)
    let failure = Box<RTMPClientError?>(nil)
    client.onFailure { error in failure.value = error }
    defer { client.stop() }

    for _ in 0 ..< 400 {
      client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 8 * 1024))
    }

    #expect(waitUntil(seconds: 5) { failure.value != nil })
    if case let .disconnected(reason) = failure.value {
      #expect(reason.contains("stopped accepting data"))
    } else {
      Issue.record("expected a disconnect, got \(String(describing: failure.value))")
    }
    #expect(client.metrics.queuedBytes == 0)
  }

  @Test("Stopping while a send is blocked returns promptly and reports no error")
  func stopUnblocksASend() {
    let pair = SocketPair()
    defer { pair.close() }
    let client = RTMPClient()
    client.attachForTesting(fd: pair.client, budgetBytes: 8 * 1024 * 1024, sendTimeoutSeconds: 30)
    let failure = Box<RTMPClientError?>(nil)
    client.onFailure { error in failure.value = error }

    for _ in 0 ..< 400 {
      client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 8 * 1024))
    }

    let started = Date()
    client.stop()
    #expect(waitUntil(seconds: 5) { !client.isLive })
    // Well inside the 30 s send timeout it would otherwise have waited out.
    #expect(Date().timeIntervalSince(started) < 5)
    // Cancellation is not a stream failure, so the operator sees no error banner.
    #expect(failure.value == nil)
  }

  @Test("Draining the peer returns the queue to zero")
  func drainingClearsTheQueue() {
    let pair = SocketPair()
    defer { pair.close() }
    let client = RTMPClient()
    client.attachForTesting(fd: pair.client, budgetBytes: Self.budget)
    defer { client.stop() }

    for _ in 0 ..< 60 {
      client.sendVideo(timestampMs: 0, tag: videoTag(keyframe: false, bytes: 8 * 1024))
    }
    pair.drain(untilQueuedFallsBelow: 1, of: client)
    #expect(client.metrics.queuedBytes == 0)
    #expect(client.bytesSentForTesting > 0)
  }

  // MARK: - Helpers

  private func videoTag(keyframe: Bool, bytes: Int) -> Data {
    FLVTag.video(keyframe: keyframe, packetType: 1, payload: Data(repeating: 7, count: bytes))
  }
}

private final class Box<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value
  init(_ value: Value) { stored = value }
  var value: Value {
    get { lock.lock(); defer { lock.unlock() }; return stored }
    set { lock.lock(); stored = newValue; lock.unlock() }
  }
}

/// A connected pair whose peer end reads only when a test asks it to.
private struct SocketPair {
  let client: Int32
  let peer: Int32

  init(bufferBytes: Int32 = 4096) {
    var fds: [Int32] = [ 0, 0 ]
    _ = socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
    var size = bufferBytes
    setsockopt(fds[0], SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size))
    setsockopt(fds[1], SOL_SOCKET, SO_RCVBUF, &size, socklen_t(MemoryLayout<Int32>.size))
    client = fds[0]
    peer = fds[1]
  }

  /// Reads until the client's backlog falls below `threshold`, or a few seconds pass.
  func drain(untilQueuedFallsBelow threshold: Int, of client: RTMPClient) {
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline, client.metrics.queuedBytes >= threshold {
      let read = buffer.withUnsafeMutableBytes { Darwin.recv(peer, $0.baseAddress, $0.count, MSG_DONTWAIT) }
      if read <= 0 { usleep(10_000) }
    }
  }

  func close() {
    Darwin.close(peer)
    Darwin.close(client)
  }
}

private func waitUntil(seconds: Double, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if condition() { return true }
    usleep(20_000)
  }
  return condition()
}

@Suite("RTMP disconnect reason")
struct RTMPDisconnectReasonTests {
  @Test("A server that hangs up on a live stream is reported without the handshake trace")
  func liveHangUpDropsTrace() {
    let trace = " t5/4 t6/5 t20/165 _result#1 t20/29 _result#2"
    #expect(RTMPClient.serverClosedReason(live: true, handshakeTrace: trace) == "server closed the socket")
    #expect(RTMPClient.serverClosedReason(live: false, handshakeTrace: trace) == "server closed the socket" + trace)
  }
}
