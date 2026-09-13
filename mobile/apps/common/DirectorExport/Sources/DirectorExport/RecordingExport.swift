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

  public static func preparedDirectory(recordingID: Int64, in preparedRoot: URL) -> URL {
    preparedRoot.appendingPathComponent("rec-\(recordingID)", isDirectory: true)
  }

  /// The programme master plus any continuation files opened after a writer failure
  /// (`program-…mp4`, `program-…-2.mp4`, …).
  public static func programSourceFiles(named filename: String, in directory: URL) -> [URL] {
    let primary = filename
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty } ?? filename
    let stem = URL(fileURLWithPath: primary).deletingPathExtension().lastPathComponent
    guard let entries = try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    ) else {
      let primaryURL = directory.appendingPathComponent(primary)
      return FileManager.default.fileExists(atPath: primaryURL.path) ? [primaryURL] : []
    }
    return entries.filter { url in
      let name = url.lastPathComponent
      let ext = url.pathExtension.lowercased()
      guard ext == "mp4" || ext == "mov" else { return false }
      return name == primary || name.hasPrefix(stem + "-")
    }
    .sorted { lhs, rhs in
      let left = lhs.lastPathComponent
      let right = rhs.lastPathComponent
      if left == primary { return true }
      if right == primary { return false }
      return left.localizedStandardCompare(right) == .orderedAscending
    }
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
