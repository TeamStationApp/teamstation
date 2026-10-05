import CameramanCore
import CameramanRTSP
import DirectorRTSP
import Foundation
import Testing

/// A whole session on the wire (E-C1's unit half): each stream's sender report precedes its first
/// packet, and the audio stamps follow capture position, skipping over a microphone gap.
@Suite("Capture-stamped session", .serialized)
struct CaptureStampSessionTests {
  private static let identity = DeviceIdentity(uuid: "00000000-0000-4000-8000-000000000001", name: "Loopback")
  private static let frame = 1_024.0 / 48_000

  /// `$`-framed packets out of a TCP stream: (channel, payload).
  private static func interleaved(_ data: Data) -> [(UInt8, Data)] {
    var packets: [(UInt8, Data)] = []
    var bytes = [UInt8](data)
    while bytes.count >= 4, let start = bytes.firstIndex(of: 0x24) {
      bytes.removeFirst(start)
      guard bytes.count >= 4 else { break }
      let length = Int(bytes[2]) << 8 | Int(bytes[3])
      guard bytes.count >= 4 + length else { break }
      packets.append((bytes[1], Data(bytes[4 ..< 4 + length])))
      bytes.removeFirst(4 + length)
    }
    return packets
  }

  @Test("Reports lead each stream, and the audio stamps follow capture through a dropout")
  func session() async throws {
    let server = RTSPServer(
      describe: { videoSSRC, audioSSRC in
        SDPBuilder(
          identity: Self.identity,
          video: .init(codec: .h264, parameterSets: [ Data([0x67, 0x42, 0, 0x1F]), Data([0x68, 0xCE, 0x3C, 0x80]) ], width: 1920, height: 1080),
          audio: .init(audioSpecificConfig: Data([0x11, 0x90]), sampleRate: 48_000, channelCount: 1),
          videoSSRC: videoSSRC,
          audioSSRC: audioSSRC
        ).build()
      },
      hasAudio: { true },
      identity: { Self.identity },
      requestKeyframe: {}
    )
    server.start(port: 0, path: "/live/mainstream", advertise: false)
    for _ in 0 ..< 60 where server.status.port == nil { try await Task.sleep(for: .milliseconds(50)) }
    let port = try #require(server.status.port)
    defer { server.stop() }

    let client = try await LoopbackRTSPClient(port: port)
    defer { client.close() }
    let url = "rtsp://127.0.0.1:\(port)/live/mainstream"
    let describe = try await client.exchange("DESCRIBE \(url) RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n")
    #expect(describe.statusCode == 200)
    let video = try await client.exchange("SETUP \(url)/trackID=0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n")
    let sessionHeader = video.headers.first { $0.key.lowercased() == "session" }?.value ?? ""
    let session = sessionHeader.split(separator: ";").first.map(String.init) ?? ""
    _ = try await client.exchange("SETUP \(url)/trackID=1 RTSP/1.0\r\nCSeq: 3\r\nSession: \(session)\r\nTransport: RTP/AVP/TCP;unicast;interleaved=2-3\r\n\r\n")
    let play = try await client.exchange("PLAY \(url) RTSP/1.0\r\nCSeq: 4\r\nSession: \(session)\r\n\r\n")
    #expect(play.statusCode == 200)

    // A keyframe, then ten sound frames with 4,800 samples (100 ms) lost after the fifth.
    server.send(video: EncodedVideoFrame(nalUnits: [ Data([0x65, 0x88, 0x84, 0x00]) ], isKeyframe: true, presentationTime: 50), codec: .h264)
    for index in 0 ..< 10 {
      let capture = 50 + Double(index) * Self.frame + (index >= 5 ? 0.1 : 0)
      server.send(audio: EncodedAudioFrame(data: Data(repeating: 0x21, count: 40), presentationTime: capture, sampleRate: 48_000, channelCount: 1, captureTime: capture))
    }
    var received = Data()
    for _ in 0 ..< 20 {
      received += try await client.read(atLeast: 1, seconds: 0.5)
      if Self.interleaved(received).filter({ $0.0 == 2 }).count >= 10 { break }
    }
    let packets = Self.interleaved(received)

    // Each stream's first packet on its data channel comes after a sender report on its control channel.
    let firstVideo = try #require(packets.firstIndex { $0.0 == 0 })
    let firstVideoReport = try #require(packets.firstIndex { $0.0 == 1 })
    #expect(firstVideoReport < firstVideo)
    let firstAudio = try #require(packets.firstIndex { $0.0 == 2 })
    let firstAudioReport = try #require(packets.firstIndex { $0.0 == 3 })
    #expect(firstAudioReport < firstAudio)
    let report = try #require(RTCPReport.parse(packets[firstAudioReport].1))
    #expect(report.senderReports.first?.rtpTimestamp == 0)
    #expect(report.cname == Self.identity.cname)
    // Picture and sound were both captured at 50 s; the sound is reported the phone's capture trim
    // later, which is where it lines up with the picture.
    let videoReport = try #require(RTCPReport.parse(packets[firstVideoReport].1)?.senderReports.first)
    let audioReport = try #require(report.senderReports.first)
    #expect(abs(audioReport.ntpDate.timeIntervalSince(videoReport.ntpDate) - 0.056) < 0.000_1)

    // Stamps by capture position: 1,024 apart, then a skip of the 4,800 samples lost.
    let stamps = packets.filter { $0.0 == 2 }.compactMap { RTPPacket.parse($0.1)?.timestamp }
    let expected: [UInt32] = [ 0, 1_024, 2_048, 3_072, 4_096, 9_920, 10_944, 11_968, 12_992, 14_016 ]
    #expect(stamps == expected)
  }
}
