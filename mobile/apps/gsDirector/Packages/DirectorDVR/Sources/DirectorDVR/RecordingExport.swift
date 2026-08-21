import Foundation
import DirectorCore

/// Names and sanitising for whole-session AirDrop packages.
public enum RecordingExport {
  /// `2026-08-16-09-04-12` from a recording's start.
  public static func timestamp(from wall: WallClock) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "yyyy-MM-dd-HH-mm-ss"
    return formatter.string(from: wall.date)
  }

  /// Primary programme file: `2026-08-16-09-04-12.mov`
  public static func programFilename(startedAt: WallClock) -> String {
    "\(timestamp(from: startedAt)).mov"
  }

  /// Per-camera file: `2026-08-16-09-04-12-camera_name.mov`
  public static func cameraFilename(startedAt: WallClock, cameraName: String) -> String {
    "\(timestamp(from: startedAt))-\(sanitise(cameraName)).mov"
  }

  /// Spaces and every character illegal in a filename become underscores. Adjacent
  /// underscores collapse so `Cam  1/2` does not become `Cam__1_2` with a hole.
  public static func sanitise(_ name: String) -> String {
    let illegal = CharacterSet(charactersIn: "/\\:*?\"<>|")
      .union(.newlines)
      .union(.controlCharacters)
    var scalars: [Character] = []
    for scalar in name.unicodeScalars {
      if scalar == " " || illegal.contains(scalar) {
        if scalars.last != "_" { scalars.append("_") }
      } else {
        scalars.append(Character(scalar))
      }
    }
    while scalars.first == "." || scalars.first == "_" { scalars.removeFirst() }
    while scalars.last == "." || scalars.last == "_" { scalars.removeLast() }
    let trimmed = String(scalars)
    return trimmed.isEmpty ? "camera" : trimmed
  }
}
