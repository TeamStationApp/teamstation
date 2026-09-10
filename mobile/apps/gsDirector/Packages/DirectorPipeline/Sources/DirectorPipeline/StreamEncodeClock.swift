import CoreMedia
import Foundation

/// The RTMP encoder's own timeline, independent of camera and replay clocks.
///
/// VideoToolbox's GOP duration is measured from encode PTS. Cuts and instant replay feed
/// non-monotonic source timestamps into the programme, which is how a 2-second GOP became a
/// 149-second HLS segment. Live timestamps follow **wall clock** so dropped encodes and slow-mo
/// replay cannot make the viewer fall minutes behind. The clock never goes backwards.
public struct StreamEncodeClock: Sendable {
  public var frameRate: Int
  public var gopSeconds: Double

  public private(set) var lastTime: CMTime = .negativeInfinity
  public private(set) var lastKeyframeTime: CMTime = .negativeInfinity
  public private(set) var lastKeyframeWall: CFAbsoluteTime = 0
  public private(set) var awaitingKeyframe = true
  public private(set) var startWall: CFAbsoluteTime = 0

  public init(frameRate: Int = 30, gopSeconds: Double = 2) {
    self.frameRate = max(frameRate, 1)
    self.gopSeconds = max(gopSeconds, 0.1)
  }

  public var maxKeyFrameInterval: Int {
    max(1, Int((Double(frameRate) * gopSeconds).rounded()))
  }

  public mutating func reset() {
    lastTime = .negativeInfinity
    lastKeyframeTime = .negativeInfinity
    lastKeyframeWall = 0
    awaitingKeyframe = true
    startWall = 0
  }

  /// Next submitted frame must be an IDR (programme cut, replay start, return to live).
  public mutating func requestKeyframe() {
    awaitingKeyframe = true
  }

  /// Maps the next video frame onto a monotonic wall-clock encode timeline.
  /// `source` is ignored so camera/replay PTS cannot stall or rewind the live stream.
  public mutating func nextPresentationTime(source: CMTime, now: CFAbsoluteTime) -> CMTime {
    _ = source
    if startWall == 0 { startWall = now }
    let step = CMTime(value: 1, timescale: CMTimeScale(frameRate))
    var time = CMTime(seconds: max(0, now - startWall), preferredTimescale: 600)
    if lastTime.isNumeric, time <= lastTime {
      time = CMTimeAdd(lastTime, step)
    }
    lastTime = time
    return time
  }

  /// Same wall timeline as video, without advancing the last submitted video PTS.
  public func timeNow(now: CFAbsoluteTime) -> CMTime {
    guard startWall > 0 else { return .zero }
    return CMTime(seconds: max(0, now - startWall), preferredTimescale: 1000)
  }

  public func shouldForceKey(at time: CMTime, now: CFAbsoluteTime) -> Bool {
    if awaitingKeyframe { return true }
    if lastKeyframeTime.isNumeric {
      if CMTimeSubtract(time, lastKeyframeTime).seconds >= gopSeconds { return true }
    } else {
      return true
    }
    if lastKeyframeWall > 0, now - lastKeyframeWall >= gopSeconds { return true }
    return false
  }

  public mutating func noteKeyframe(at time: CMTime, now: CFAbsoluteTime) {
    lastKeyframeTime = time
    lastKeyframeWall = now
    awaitingKeyframe = false
  }

  /// Before the first keyframe, how long the stream has gone without one — since its first frame.
  /// This returned `now` itself there, the absolute date: the stress run logged keyframe ages of
  /// 810,726,820 s, about 25.7 years, which read as a clock bug and was only "no keyframe yet".
  public func keyframeAgeSeconds(now: CFAbsoluteTime) -> Double {
    guard lastKeyframeWall > 0 else { return startWall > 0 ? max(0, now - startWall) : 0 }
    return max(0, now - lastKeyframeWall)
  }
}
