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

  /// `headTrim` drops that much from the front of the first file.
  ///
  /// Segments begin on their camera's own keyframes, so the first one for a given window usually
  /// starts a little before the window does — and by a different amount on every camera. Inserting
  /// each file from its own start therefore produces files that disagree about when they begin,
  /// which is what leaves cameras cut together sitting frames apart. Skipping the head lets every
  /// camera's export start at the same instant.
  public static func concatenate(
    files: [URL],
    fileDurations: [TimeInterval],
    targetDuration: TimeInterval? = nil,
    headTrim: TimeInterval = 0,
    destination: URL
  ) async throws {
    guard !files.isEmpty else { throw Error.empty }
    try? FileManager.default.removeItem(at: destination)
    if files.count == 1, targetDuration == nil, headTrim <= 0.001 {
      try FileManager.default.copyItem(at: files[0], to: destination)
      return
    }

    let composition = AVMutableComposition()
    var cursor = CMTime.zero
    var skipped: [String] = []
    for (index, file) in files.enumerated() {
      let asset = AVURLAsset(url: file)
      // A part the writer never finalised has no movie header, so loading it throws. Letting that
      // escape aborted the whole export with AVFoundation's damaged-media error: rec-253's
      // programme was a readable 1h46m master plus a 5 MB continuation stub, left behind when a
      // recovery writer died two seconds after opening it, and the stub failed the export for all
      // of it. An unreadable piece is skipped so the readable ones still come out.
      do {
        let duration: CMTime
        if index < fileDurations.count, fileDurations[index] > 0 {
          duration = CMTime(seconds: fileDurations[index], preferredTimescale: 600)
        } else {
          duration = try await playableDuration(of: asset)
        }
        guard duration.seconds > 0.05 else { continue }
        // Only the first file is trimmed, and never past its own length.
        let trim = index == 0 ? min(max(0, headTrim), max(0, duration.seconds - 0.05)) : 0
        let start = CMTime(seconds: trim, preferredTimescale: 600)
        let kept = CMTimeSubtract(duration, start)
        guard kept.seconds > 0.05 else { continue }
        // Trimmed at the tail as well, for the same reason as the head: the last segment runs to
        // its camera's next keyframe, which is past where the window ends and by a different
        // amount on every camera. Without this the files still disagree by about a frame.
        var use = kept
        if let targetDuration {
          let remaining = targetDuration - cursor.seconds
          if remaining <= 0.001 { break }
          if kept.seconds > remaining {
            use = CMTime(seconds: remaining, preferredTimescale: 600)
          }
        }
        guard use.seconds > 0.001 else { continue }
        let range = CMTimeRange(start: start, duration: use)
        try await composition.insertTimeRange(range, of: asset, at: cursor)
        cursor = CMTimeAdd(cursor, use)
      } catch {
        skipped.append(file.lastPathComponent)
        continue
      }
    }
    if !skipped.isEmpty, cursor.seconds <= 0.05 {
      // Nothing readable at all is still a failure, and naming the pieces beats "no files".
      throw Error.exportFailed("unreadable: \(skipped.joined(separator: ", "))")
    }

    guard cursor.seconds > 0.05 else { throw Error.empty }
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

  /// A take lasts hours, not days. Video tracks stamped on a compositor/boot clock report
  /// multi-day durations; the longest track inside this window is the programme.
  public static let maximumSaneDuration: TimeInterval = 20_000

  public static func playableDuration(of asset: AVURLAsset) async throws -> CMTime {
    var best: TimeInterval = 0
    for type in [AVMediaType.audio, .video] {
      for track in try await asset.loadTracks(withMediaType: type) {
        let seconds = try await track.load(.timeRange).duration.seconds
        if seconds > 0.05, seconds < maximumSaneDuration {
          best = max(best, seconds)
        }
      }
    }
    if best > 0 {
      return CMTime(seconds: best, preferredTimescale: 600)
    }
    let loaded = try await asset.load(.duration)
    if loaded.seconds.isFinite, loaded.seconds > 0.05, loaded.seconds < maximumSaneDuration {
      return loaded
    }
    return .zero
  }
}
