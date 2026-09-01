import AVFoundation
import Foundation
import DirectorCore

/// Concatenates complete MP4s into one movie, preserving each file's duration.
///
/// Byte-appending complete MP4s is not a valid movie. Replay stages files separately; export
/// needs a single file whose duration is the sum of the pieces (and of any empty intervals
/// the caller inserts by supplying a longer `targetDuration`).
public enum ArchiveRemux {
  public enum Error: Swift.Error, CustomStringConvertible {
    case empty
    case exportFailed(String)

    public var description: String {
      switch self {
      case .empty: "no files to remux"
      case let .exportFailed(reason): "remux failed: \(reason)"
      }
    }
  }

  public static func concatenate(
    files: [URL],
    fileDurations: [TimeInterval],
    targetDuration: TimeInterval? = nil,
    destination: URL
  ) async throws {
    guard !files.isEmpty else { throw Error.empty }
    try? FileManager.default.removeItem(at: destination)
    if files.count == 1, targetDuration == nil {
      try FileManager.default.copyItem(at: files[0], to: destination)
      return
    }

    let composition = AVMutableComposition()
    var cursor = CMTime.zero
    for (index, file) in files.enumerated() {
      let asset = AVURLAsset(url: file)
      let duration: CMTime
      if index < fileDurations.count, fileDurations[index] > 0 {
        duration = CMTime(seconds: fileDurations[index], preferredTimescale: 600)
      } else {
        duration = try await asset.load(.duration)
      }
      let range = CMTimeRange(start: .zero, duration: duration)
      try await composition.insertTimeRange(range, of: asset, at: cursor)
      cursor = CMTimeAdd(cursor, duration)
    }
    if let targetDuration, targetDuration - cursor.seconds > 0.05 {
      let pad = CMTime(seconds: targetDuration - cursor.seconds, preferredTimescale: 600)
      composition.insertEmptyTimeRange(CMTimeRange(start: cursor, duration: pad))
    }

    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)
      ?? AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality)
    else {
      throw Error.exportFailed("no export session")
    }
    session.outputURL = destination
    session.outputFileType = .mp4
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      session.exportAsynchronously { continuation.resume() }
    }
    guard session.status == .completed else {
      throw Error.exportFailed(session.error?.localizedDescription ?? "\(session.status)")
    }
  }
}
