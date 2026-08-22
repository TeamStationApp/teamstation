import Foundation

/// Whether iOS should be asked to keep the process running after the scene backgrounds.
///
/// The `audio` background mode only applies while audio is actually playing. Recording and
/// streaming both need the pipeline (ingest, mix, encode, publish) to keep moving, so those are
/// the sessions that keep the programme bus audible on the system route.
public enum BackgroundKeepAlive: Sendable {
  public static func shouldStayActive(isRecording: Bool, isStreaming: Bool) -> Bool {
    isRecording || isStreaming
  }
}
