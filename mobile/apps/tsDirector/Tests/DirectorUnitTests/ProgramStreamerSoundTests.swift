import CoreMedia
import Darwin
import DirectorCore
@testable import DirectorMedia
@testable import DirectorPipeline
@testable import DirectorRTMP
import DirectorSources
import Foundation
import Testing

/// The stream's sound on the wire: counted stamps that never go back, and an encoder that starts
/// again after a break in the mix.
@Suite("Program streamer sound", .serialized)
struct ProgramStreamerSoundTests {
  @Test("A break in the mix is more than 10 ms off where the last frame ended")
  func breaks() {
    #expect(ProgramStreamer.audioBreaks(expected: nil, at: 100) == false)
    #expect(ProgramStreamer.audioBreaks(expected: 100, at: 100.009) == false)
    #expect(ProgramStreamer.audioBreaks(expected: 100, at: 100.011))
    #expect(ProgramStreamer.audioBreaks(expected: 100, at: 99.98))
  }

  @Test("No stamp goes at or before the last one sent")
  func monotonic() {
    #expect(ProgramStreamer.monotonicAudioStamps([ 5, 6, 6, nil, 4, 7 ], after: nil) == [ 5, 6, nil, nil, nil, 7 ])
    #expect(ProgramStreamer.monotonicAudioStamps([ 990, 1_000 ], after: 990) == [ nil, 1_000 ])
    #expect(ProgramStreamer.monotonicAudioStamps([], after: 3).isEmpty)
  }

  @Test("Sound reaches the socket across a break in the mix")
  func soundGoesOut() throws {
    var fds: [Int32] = [ 0, 0 ]
    #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
    defer {
      Darwin.close(fds[0])
      Darwin.close(fds[1])
    }
    let client = RTMPClient()
    client.attachForTesting(fd: fds[0], budgetBytes: 4 * 1024 * 1024)
    defer { client.stop() }
    let streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter())
    let start = CFAbsoluteTimeGetCurrent()
    streamer.goLiveForTesting(client: client, startWall: start)

    let format = try #require(
      AudioSampleBuilder.makeFormatDescription(
        AudioSampleBuilder.interleavedInt16Description(sampleRate: 48_000, channels: 2)
      )
    )
    let samples = 960
    let tone = (0 ..< samples * 2).map { Int16(truncatingIfNeeded: ($0 * 37) % 4_000) }
    func send(_ count: Int, from wall: CFAbsoluteTime) throws {
      for index in 0 ..< count {
        let at = wall + Double(index * samples) / 48_000
        let buffer = try #require(
          AudioSampleBuilder.makeSampleBuffer(
            samples: tone,
            formatDescription: format,
            presentationTime: CMTime(value: CMTimeValue(index * samples), timescale: 48_000)
          )
        )
        streamer.append(
          audio: AudioFrame(
            sourceID: SourceID("mix"),
            sampleBuffer: buffer,
            wallClock: WallClock(seconds: at + kCFAbsoluteTimeIntervalSince1970)
          )
        )
      }
    }
    try send(50, from: start + 0.5)
    // Half a second of nothing, then the mix again: the encoder starts over from the new frame.
    try send(50, from: start + 1.5 + 0.5)

    var received = 0
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    let deadline = Date().addingTimeInterval(3)
    while Date() < deadline {
      let read = buffer.withUnsafeMutableBytes { recv(fds[1], $0.baseAddress, $0.count, MSG_DONTWAIT) }
      if read > 0 { received += read } else { usleep(20_000) }
      if received > 0, client.metrics.queuedBytes == 0 { break }
    }
    #expect(received > 0)
    #expect(client.metrics.droppedPackets == 0)
  }

  @Test("A publish that cannot connect throws and leaves the streamer stopped")
  func unreachable() async {
    let streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter())
    let settings = StreamSettings(config: .default)
    await #expect(throws: (any Error).self) {
      try await streamer.start(urlString: "not a url", settings: settings, onFailure: nil)
    }
    await #expect(throws: (any Error).self) {
      try await streamer.start(urlString: "rtmp://127.0.0.1:9/live/test", settings: settings, onFailure: nil)
    }
    #expect(streamer.running == false)
  }
}
