import Foundation

/// Whether the encoders should run this frame.
///
/// Compressing for nobody is the single largest battery cost on a phone that is only being polled
/// for telemetry and control, which is exactly the phone whose picture reaches Director over HDMI.
/// So with no playing client the frame is captured, counted and drawn on the external display but
/// not encoded. Two exceptions: a diagnostic launch that asks for encoding regardless, and a video
/// encoder that has not yet produced its parameter sets, because `DESCRIBE` needs those in the SDP
/// before the first client can `PLAY`.
public enum EncoderIdlePolicy {
  public static func shouldEncodeVideo(
    playingClients: Int,
    encodeWhenIdle: Bool,
    hasParameterSets: Bool
  ) -> Bool {
    encodeWhenIdle || playingClients > 0 || !hasParameterSets
  }

  /// Audio has no parameter sets to collect: its `AudioSpecificConfig` is fixed at configure time.
  public static func shouldEncodeAudio(playingClients: Int, encodeWhenIdle: Bool) -> Bool {
    encodeWhenIdle || playingClients > 0
  }

  /// The first client's `PLAY` already asks for a keyframe; this covers a client whose request
  /// landed while the encoder was still idle and so had no frame to attach it to.
  public static func needsKeyframe(previousClients: Int, currentClients: Int) -> Bool {
    previousClients == 0 && currentClients > 0
  }
}
