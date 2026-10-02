import CameramanCore
import DirectorRTSP
import Foundation

/// Asks a TS Cameraman what frame rate it is set to.
///
/// An RTSP camera states nothing about its rate in the stream itself, so Director has measured it
/// from the timestamps, and replay pacing and the delay line's size are built on that measurement. A
/// Cameraman does say, over its control channel, and what it says is exact from the first picture.
/// The measurement stays as the fallback for a camera that does not answer.
public enum CameraFrameRateQuery {
  /// The phone's `videoEncoder.rateControl.frameRateLimit`, or nil when it could not be asked or
  /// did not say.
  public static func frameRate(host: String, port: Int, path: String) async -> Double? {
    let session = RTSPParameterSession(host: host, port: port, path: path, userAgent: "TS Director/1.0")
    session.start()
    defer { session.stop() }
    // A request is refused until the connection is up, so wait for it, briefly.
    for _ in 0 ..< 30 {
      switch session.state {
      case .ready: break
      case .unsupported, .failed: return nil
      case .idle, .connecting:
        try? await Task.sleep(for: .milliseconds(100))
        continue
      }
      break
    }
    guard session.state == .ready,
          let reply = try? await session.get(CameraParameterName.frameRate),
          reply.isSuccess
    else { return nil }
    return frameRate(in: reply.body)
  }

  /// The rate in a `text/parameters` reply: the `videoEncoder.rateControl.frameRateLimit: 60` line.
  public static func frameRate(in body: String) -> Double? {
    for line in body.split(whereSeparator: \.isNewline) {
      let parts = line.split(separator: ":", maxSplits: 1)
      guard parts.count == 2,
            parts[0].trimmingCharacters(in: .whitespaces) == CameraParameterName.frameRate,
            let rate = Double(parts[1].trimmingCharacters(in: .whitespaces)),
            rate > 0, rate.isFinite
      else { continue }
      return rate
    }
    return nil
  }
}
