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
    startWalls: [WallClock] = [],
    windowStart: WallClock? = nil,
    destination: URL
  ) async throws {
    guard !files.isEmpty else { throw Error.empty }
    try? FileManager.default.removeItem(at: destination)
    if files.count == 1, targetDuration == nil, headTrim <= 0.001, startWalls.isEmpty {
      try FileManager.default.copyItem(at: files[0], to: destination)
      return
    }

    // Placement mode. With a wall clock per file and a window to measure from, a segment goes where
    // it happened -- `startWall - windowStart` -- rather than at the running total of everything
    // before it. The two agree only while a source delivered without interruption; the moment it
    // dropped out, a running cursor pulls every later frame earlier by the length of the gap, and
    // the file comes out short by the same amount. That is the whole of R2: a camera that lost
    // 150 s exported 150 s early from then on, and no two angles agreed after their first gap.
    let placed = !startWalls.isEmpty && startWalls.count == files.count && windowStart != nil
    let origin = windowStart ?? WallClock(seconds: 0)

    let composition = AVMutableComposition()
    var cursor = CMTime.zero
    var skipped: [String] = []
    for (index, file) in files.enumerated() {
      let asset = AVURLAsset(url: file)
      // A part the writer never finalised has no movie header, so loading it throws. Letting that
      // escape aborted the whole export with AVFoundation's damaged-media error: one take's
      // programme was a readable master plus a short continuation stub, left behind when a
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
        // In placement mode a segment is trimmed by however much of it precedes the window, which
        // is a per-file question and not only the first file's. Otherwise the old rule stands:
        // only the head of the first file is trimmed, and never past its own length.
        let wantedTrim: TimeInterval
        if placed {
          wantedTrim = max(0, origin - startWalls[index])
        } else {
          wantedTrim = index == 0 ? headTrim : 0
        }
        let trim = min(max(0, wantedTrim), max(0, duration.seconds - 0.05))
        let start = CMTime(seconds: trim, preferredTimescale: 600)
        let kept = CMTimeSubtract(duration, start)
        guard kept.seconds > 0.05 else { continue }
        // Trimmed at the tail as well, for the same reason as the head: the last segment runs to
        // its camera's next keyframe, which is past where the window ends and by a different
        // amount on every camera. Without this the files still disagree by about a frame.
        // Where this segment belongs on the output timeline.
        let at: CMTime = placed
          ? CMTime(seconds: max(0, (startWalls[index] + trim) - origin), preferredTimescale: 600)
          : cursor
        var use = kept
        if let targetDuration {
          let remaining = targetDuration - at.seconds
          if remaining <= 0.001 { if placed { continue } else { break } }
          if kept.seconds > remaining {
            use = CMTime(seconds: remaining, preferredTimescale: 600)
          }
        }
        guard use.seconds > 0.001 else { continue }
        let range = CMTimeRange(start: start, duration: use)
        // Inserting past the current end leaves the gap between as an empty range, which is what a
        // gap was: no camera delivered anything for it.
        try await composition.insertTimeRange(range, of: asset, at: at)
        cursor = CMTimeMaximum(cursor, CMTimeAdd(at, use))
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

  /// Floor on what a real recording of ours can average, in bits per second.
  ///
  /// The cameras run at megabits; the programme master is configured in the same range. A part
  /// claiming a duration so long that it would imply less than this is not a long recording, it is
  /// a short one with a broken header. A continuation stub was a small file declaring
  /// hours of duration against the bitrate of real content, and the export believed it, turning a
  /// single frame into a long second video track that confuses players and editors alike.
  ///
  /// Set two orders of magnitude below the real figure, so it only ever catches a header that is
  /// wrong rather than a stretch of genuinely quiet footage.
  public static let minimumPlausibleBitsPerSecond: Double = 50_000

  /// Whether a declared duration is believable for a file of this size.
  ///
  /// Public and pure so the decision can be tested without an asset on disk.
  public static func isPlausibleDuration(seconds: Double, byteCount: Int64) -> Bool {
    guard seconds.isFinite, seconds > 0.05, seconds < maximumSaneDuration else { return false }
    // Nothing to check against. A size we could not read is not evidence of anything.
    guard byteCount > 0 else { return true }
    return (Double(byteCount) * 8 / seconds) >= minimumPlausibleBitsPerSecond
  }

  public static func playableDuration(of asset: AVURLAsset) async throws -> CMTime {
    let byteCount = (try? FileManager.default.attributesOfItem(atPath: asset.url.path)[.size] as? Int64) ?? nil
    var best: TimeInterval = 0
    for type in [AVMediaType.audio, .video] {
      for track in try await asset.loadTracks(withMediaType: type) {
        let seconds = try await track.load(.timeRange).duration.seconds
        if isPlausibleDuration(seconds: seconds, byteCount: byteCount ?? 0) {
          best = max(best, seconds)
        }
      }
    }
    if best > 0 {
      return CMTime(seconds: best, preferredTimescale: 600)
    }
    let loaded = try await asset.load(.duration)
    if isPlausibleDuration(seconds: loaded.seconds, byteCount: byteCount ?? 0) {
      return loaded
    }
    return .zero
  }
}
