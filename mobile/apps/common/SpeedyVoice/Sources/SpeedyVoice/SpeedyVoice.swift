import Foundation

/// TS Speedy's spoken clips: 24 kHz mono 16-bit WAVs, one per word take. See the package README
/// for how they were made. TS Speedy for Android reads the same files as assets.
public enum SpeedyVoice {
  /// The clip named `name` (without `.wav`), such as `n56-final` or `word-exit`; nil when there
  /// is no such clip.
  public static func clipURL(_ name: String) -> URL? {
    Bundle.module.url(forResource: name, withExtension: "wav", subdirectory: "Clips")
  }
}
