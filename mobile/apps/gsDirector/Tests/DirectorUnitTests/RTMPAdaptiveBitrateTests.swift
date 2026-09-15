import AdaptiveBitrate
import Darwin
import Foundation
import Testing
@testable import DirectorRTMP

/// The stream's controller against a real socket whose peer reads at a fixed rate.
///
/// A socket stands in for the uplink, and the test reads its far end at the link's rate, so the
/// client's own send path — ledger, queue, budget — is what the controller sees. A Unix socket pair
/// holds almost nothing in the kernel, so the backlog builds in the client's own queue; loopback
/// TCP holds a large one, which only `SO_NWRITE` sees, so the two cover both halves of the sample.
///
/// The encoder is simulated: frames at 30 a second, sized from whatever rate the controller last
/// gave it, a keyframe three times the size every two seconds, and 128 kbps of audio beside them.
/// Everything runs on one thread in real time, so the numbers are the ones the app would see.
@Suite("RTMP adaptive bitrate", .serialized)
struct RTMPAdaptiveBitrateTests {
  @Test("A link at half the high bitrate brings the rate down before anything is shed")
  func throttledLinkCutsBeforeDropping() {
    let run = Self.simulate(high: 4_000_000, low: 1_000_000, link: 2_000_000, seconds: 8, transport: .unixPair)
    #expect(run.dropped == 0)
    #expect(run.decreases > 0)
    // Cut while the queue was well short of the budget: measured at 34% with the stream's tuning.
    #expect(run.peakQueuedBytes < run.budget * 45 / 100)
    // Down to what the link carries, and not below the operator's floor.
    #expect(run.finalRate <= 2_000_000)
    #expect(run.finalRate >= 1_000_000)
    #expect(run.firstCutAt != nil)
    #expect((run.firstCutAt ?? .infinity) < 1.5)
  }

  @Test("Over loopback TCP the kernel's backlog alone brings the rate down, before anything is shed")
  func throttledTCPCutsBeforeDropping() throws {
    let run = Self.simulate(high: 4_000_000, low: 1_000_000, link: 2_000_000, seconds: 10, transport: .tcpLoopback)
    try #require(run.connected)
    #expect(run.dropped == 0)
    #expect(run.decreases > 0)
    #expect(run.sawTransportBacklog)
    // Loopback acknowledges what the reader's buffer holds, which the sender cannot see, so this is
    // later than a real uplink would be; measured at 2.0 s and 38% of the budget.
    #expect((run.firstCutAt ?? .infinity) < 2.5)
    #expect(run.peakQueuedBytes < run.budget / 2)
    #expect(run.finalRate <= 2_000_000)
    #expect(run.finalRate >= 1_000_000)
  }

  @Test("A link with room to spare leaves the rate at the high bitrate")
  func openLinkHolds() {
    let run = Self.simulate(high: 3_000_000, low: 1_000_000, link: 8_000_000, seconds: 4, transport: .unixPair)
    #expect(run.dropped == 0)
    #expect(run.decreases == 0)
    #expect(run.finalRate == 3_000_000)
  }

  // MARK: - Simulation

  enum Transport {
    case unixPair
    case tcpLoopback
  }

  struct Run {
    var connected = true
    var sawTransportBacklog = false
    var dropped: UInt64
    var decreases: Int
    var finalRate: Int
    var peakQueuedBytes: Int
    var budget: Int
    var firstCutAt: Double?
  }

  static func simulate(high: Int, low: Int, link: Int, seconds: Double, transport: Transport) -> Run {
    var fds: [Int32] = [ -1, -1 ]
    switch transport {
    case .unixPair:
      _ = socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
      var size = Int32(16 * 1024)
      setsockopt(fds[0], SOL_SOCKET, SO_SNDBUF, &size, socklen_t(MemoryLayout<Int32>.size))
      setsockopt(fds[1], SOL_SOCKET, SO_RCVBUF, &size, socklen_t(MemoryLayout<Int32>.size))
    case .tcpLoopback:
      guard let pair = loopbackPair() else {
        return Run(connected: false, dropped: 0, decreases: 0, finalRate: 0, peakQueuedBytes: 0, budget: 0)
      }
      fds = [ pair.client, pair.peer ]
    }
    let client = RTMPClient()
    let budget = RTMPClient.sendBudget(forBitrate: high)
    client.attachForTesting(fd: fds[0], budgetBytes: budget)
    defer {
      client.stop()
      Darwin.close(fds[1])
    }

    var controller = AdaptiveBitrateController(ceiling: high, floor: low, tuning: RTMPClient.adaptiveBitrateTuning)
    var rate = high
    var firstCutAt: Double?
    var peakQueued = 0
    var sawTransportBacklog = false
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)

    let start = ProcessInfo.processInfo.systemUptime
    var lastRead = start
    var readAllowance = 0.0
    var nextFrame = start
    var frame = 0
    var nextTick = start + 0.25
    _ = client.congestionSample(at: start)

    while true {
      let now = ProcessInfo.processInfo.systemUptime
      if now - start >= seconds { break }

      // The link: the far end reads no faster than `link`.
      readAllowance = min(readAllowance + (now - lastRead) * Double(link) / 8, 64 * 1024)
      lastRead = now
      while readAllowance >= 1 {
        let want = min(Int(readAllowance), buffer.count)
        let read = buffer.withUnsafeMutableBytes { Darwin.recv(fds[1], $0.baseAddress, want, MSG_DONTWAIT) }
        if read <= 0 { break }
        readAllowance -= Double(read)
      }

      // The encoder, at whatever it was last told.
      if now >= nextFrame {
        let keyframe = frame % 60 == 0
        let bytes = max(64, rate / 8 / 30) * (keyframe ? 3 : 1)
        client.sendVideo(
          timestampMs: UInt32(frame * 33),
          tag: FLVTag.videoFrame(codec: .hevc, keyframe: keyframe, payload: Data(repeating: 7, count: bytes))
        )
        client.sendAudio(
          timestampMs: UInt32(frame * 33),
          tag: FLVTag.audio(packetType: 1, payload: Data(repeating: 3, count: 128_000 / 8 / 30))
        )
        frame += 1
        nextFrame += 1.0 / 30
      }

      if now >= nextTick {
        let sample = client.congestionSample(at: now)
        if (sample.transportBacklogBytes ?? 0) > 64 * 1024 { sawTransportBacklog = true }
        if let next = controller.update(sample, now: now) {
          if next < rate, firstCutAt == nil { firstCutAt = now - start }
          rate = next
        }
        nextTick += 0.25
      }

      peakQueued = max(peakQueued, client.metrics.queuedBytes)
      usleep(2_000)
    }

    // Printed so a run shows the numbers the assertions bound.
    print(
      "[adaptive] \(transport) high=\(high) link=\(link) firstCut=\(firstCutAt.map { String(format: "%.2f s", $0) } ?? "none")"
        + " final=\(rate) decreases=\(controller.status.decreases) dropped=\(client.metrics.droppedPackets)"
        + " peakQueued=\(peakQueued)/\(budget) transportBacklogSeen=\(sawTransportBacklog)"
    )
    return Run(
      sawTransportBacklog: sawTransportBacklog,
      dropped: client.metrics.droppedPackets,
      decreases: controller.status.decreases,
      finalRate: rate,
      peakQueuedBytes: peakQueued,
      budget: budget,
      firstCutAt: firstCutAt
    )
  }

  /// A connected loopback TCP pair: the client end and the accepted peer end.
  static func loopbackPair() -> (client: Int32, peer: Int32)? {
    let listener = Darwin.socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard listener >= 0 else { return nil }
    defer { Darwin.close(listener) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    address.sin_port = 0
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0, Darwin.listen(listener, 1) == 0 else { return nil }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) }
    }
    let client = Darwin.socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
    guard client >= 0 else { return nil }
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(client, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard connected == 0 else {
      Darwin.close(client)
      return nil
    }
    let peer = Darwin.accept(listener, nil, nil)
    guard peer >= 0 else {
      Darwin.close(client)
      return nil
    }
    return (client, peer)
  }
}
