import Foundation

/// The counters the programme's encoders and its stream and recording controllers report.
///
/// TS Director's `PipelineTelemetry` conforms, and feeds its HUD, `dump-state` and the take's
/// telemetry log. Another host keeps its own, smaller one. Every method is called from whichever
/// thread did the work, so a conformer takes its own lock.
public protocol MediaTelemetry: AnyObject, Sendable {
  /// A compression session opened (+1) or closed (-1).
  func recordEncodeSessionChange(delta: Int)
  /// A keyframe went out on the stream, `ageSeconds` after the one before.
  func recordStreamKeyframe(ageSeconds: Double)
  /// How long since the stream's last keyframe.
  func recordStreamKeyframeAge(_ seconds: Double)
  /// Frames handed to the stream's encoder and not yet back.
  func recordStreamPendingEncodes(_ count: Int)
  /// How long since the stream's encoder last called back.
  func recordStreamEncodeCallbackAge(_ seconds: Double)
  /// How old the programme picture was when it reached the stream.
  func recordProgramFrameAge(_ seconds: Double)
  /// The stream's encoder went idle and a keyframe was forced to keep the stream alive.
  func recordStreamIdleKeyframe()
  /// The stream's encoder wedged and was rebuilt.
  func recordStreamEncoderReset()
  /// A compression session reported a failure.
  func recordEncodeFailure(code: Int32)
  /// The programme master's finish, in words.
  func recordProgramFinish(_ detail: String)
  /// Something went wrong that is worth a line in the log.
  func recordError(_ message: String)
  /// The recording's last error, which a host shows the operator.
  func recordRecordingError(_ message: String)
}
