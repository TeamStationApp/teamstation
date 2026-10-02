import CoreMedia
import CoreVideo
import DirectorCore
import DirectorSources
import Foundation
import Testing
@testable import DirectorPipeline

/// The stream end to end: the programme streamer publishing to a stand-in RTMP server.
///
/// Off unless `RTMP_SINK_URL` names a server, because it needs one running on this Mac:
/// `node scripts/rtmpSink.js --once --expect-codec hevc --expect-size 1920x1080 --expect-fps 60
/// --max-bitrate 6`, then `TEST_RUNNER_RTMP_SINK_URL=rtmp://127.0.0.1:19350/live/test` for the test
/// run. The server checks what arrived — codec as framed, sequence header first, gaps, frame rate,
/// size, bitrate — and this side checks nothing was shed on the way out.
@Suite(
  "Program streamer into a stand-in server",
  .serialized,
  .enabled(if: ProcessInfo.processInfo.environment["RTMP_SINK_URL"] != nil)
)
struct ProgramStreamerSinkTests {
  @Test("Ten seconds of the default stream reach the server with nothing shed")
  func defaultStream() async throws {
    let url = try #require(ProcessInfo.processInfo.environment["RTMP_SINK_URL"])
    let config = AppConfig.default
    let streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter())
    try await streamer.start(urlString: url, config: config, onFailure: nil)
    #expect(streamer.running)

    // A bar that moves across a grey picture, so each frame costs the encoder something.
    let width = config.streamResolution.width
    let height = config.streamResolution.height
    let pictures = try (0 ..< 30).map { step in
      try #require(Self.picture(width: width, height: height, barAt: step * width / 30))
    }

    let rate = config.streamFrameRate
    let clock = ContinuousClock()
    let start = clock.now
    for frame in 0 ..< 10 * rate {
      try await clock.sleep(until: start + .seconds(Double(frame) / Double(rate)))
      streamer.append(
        pictures[frame % pictures.count],
        presentationTime: CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(rate))
      )
    }
    // Let the last frames out before hanging up.
    try await Task.sleep(for: .seconds(1))
    let metrics = streamer.metrics
    streamer.stop()
    #expect(metrics.droppedPackets == 0)
  }

  /// BGRA, grey, with a white bar 1/30 of the width wide. Filled a row at a time so a 1080p picture
  /// is quick to make in a debug build.
  private static func picture(width: Int, height: Int, barAt x: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      kCVPixelFormatType_32BGRA,
      [ kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any] ] as CFDictionary,
      &buffer
    )
    guard status == kCVReturnSuccess, let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
    let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
    let barWidth = max(1, width / 30)
    for row in 0 ..< height {
      let line = base.advanced(by: row * bytesPerRow)
      memset(line, 0x60, width * 4)
      memset(line.advanced(by: min(x, width - barWidth) * 4), 0xFF, barWidth * 4)
    }
    return buffer
  }
}
