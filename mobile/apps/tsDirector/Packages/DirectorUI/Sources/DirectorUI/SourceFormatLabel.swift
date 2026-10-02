import DirectorPipeline
import Foundation

/// The one-line "HEVC · 1920×1080 · 30 fps" caption under a camera's name.
///
/// Split out of the row so the assembly rules can be tested without SwiftUI, because each part
/// becomes known at a different moment: the codec comes from the SDP the instant the camera is
/// switched on, the size only once a picture has been decoded, and the rate only once enough frames
/// have arrived to measure it. A caption that showed "0×0" or "0 fps" in those gaps would read as a
/// broken camera rather than one still starting up.
public enum SourceFormatLabel {
  public static let separator = " · "

  /// Nil when nothing is known yet, so the caller can leave the row as it was.
  public static func text(for tile: TileTelemetry) -> String? {
    text(
      codec: tile.sourceCodec,
      width: tile.sourceWidth,
      height: tile.sourceHeight,
      framesPerSecond: tile.framesPerSecond
    )
  }

  public static func text(
    codec: String,
    width: Int,
    height: Int,
    framesPerSecond: Double
  ) -> String? {
    var parts: [String] = []
    if !codec.isEmpty { parts.append(codec) }
    if width > 0, height > 0 { parts.append("\(width)×\(height)") }
    // Rounded: the measured rate wanders a tenth either side of nominal, and a caption that flickers
    // between 29.9 and 30.1 reads as instability rather than as a camera holding 30.
    if framesPerSecond >= 0.5 { parts.append("\(Int(framesPerSecond.rounded())) fps") }
    return parts.isEmpty ? nil : parts.joined(separator: separator)
  }
}
