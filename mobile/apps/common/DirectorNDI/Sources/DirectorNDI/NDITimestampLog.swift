import CNDI
import Foundation
import DirectorCore

/// What an NDI sender actually stamps on its pictures, written to a CSV in Documents so it can be
/// copied off the iPad and read next to the arrival times. Debug builds only.
///
/// `NDIReceiveClock` maps a frame's `timestamp` onto our clock whenever it is set, and places the
/// frame at its arrival otherwise. This records what the sender sent and which of the two happened,
/// from the same SDK the Director receives with: every frame for the first minute of each receiver
/// (counted afresh whenever the source reconnects, as it does after a sender reboots), then one in
/// sixty.
///
/// Columns: frame, our wall clock at arrival (s), the raw `timestamp` (100 ns ticks on the sender's
/// clock, or `undefined`), sender minus arrival (s), the raw `timecode`, the declared rate, the
/// size, the capture time the receive clock gave it on our clock (s), and where that came from:
/// `sender`, `arrival`, or `dropped` for a frame refused as out of order.
final class NDITimestampLog: @unchecked Sendable {
  private static let everyFrameCount: UInt64 = 3_600
  private static let thinnedEvery: UInt64 = 60
  /// Logs kept in the directory when a new one opens: each debug run adds one per source.
  static let keptLogs = 20

  private let queue: DispatchQueue
  private var handle: FileHandle?
  private var count: UInt64 = 0

  init?(sourceID: SourceID) {
    #if DEBUG
      let directory = DirectorPaths.ndiTimestamps
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.dateFormat = "yyyyMMdd-HHmmss"
      let url = directory.appendingPathComponent("\(sourceID.slug)-\(formatter.string(from: Date())).csv")
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        Self.prune(directory, keeping: Self.keptLogs - 1)
        let header = "frame,arrivalSeconds,senderTimestamp,senderMinusArrivalSeconds,timecode,declaredRate,width,height,captureSeconds,captureFrom\n"
        try Data(header.utf8).write(to: url)
        handle = try FileHandle(forWritingTo: url)
        handle?.seekToEndOfFile()
      } catch {
        return nil
      }
      queue = DispatchQueue(label: "app.teamstation.director.ndi.timestampLog.\(sourceID.slug)", qos: .utility)
    #else
      return nil
    #endif
  }

  /// Deletes all but the newest `keeping` CSVs in `directory`, by modification date.
  static func prune(_ directory: URL, keeping: Int) {
    let manager = FileManager.default
    let files = (try? manager.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [ .contentModificationDateKey ]
    )) ?? []
    let logs = files
      .filter { $0.pathExtension == "csv" }
      .map { ($0, (try? $0.resourceValues(forKeys: [ .contentModificationDateKey ]).contentModificationDate) ?? .distantPast) }
      .sorted { $0.1 > $1.1 }
    for (url, _) in logs.dropFirst(max(0, keeping)) {
      try? manager.removeItem(at: url)
    }
  }

  /// A receiver was (re)opened: its first minute is logged frame by frame again. Called before
  /// the receive threads for it start.
  func receiverOpened() {
    count = 0
  }

  /// Called on the receive thread for every video frame, with what the receive clock made of it.
  func note(_ frame: NDIlib_video_frame_v2_t, arrivalSeconds: Double, timing: NDIReceiveClock.Timing?) {
    count += 1
    guard count <= Self.everyFrameCount || count % Self.thinnedEvery == 0 else { return }
    let index = count - 1
    let timestamp = frame.timestamp
    let timecode = frame.timecode
    let declared = frame.frame_rate_D == 0 ? 0 : Double(frame.frame_rate_N) / Double(frame.frame_rate_D)
    let width = frame.xres
    let height = frame.yres
    let capture = timing?.captureWallClock.map { String(format: "%.6f", $0.seconds) } ?? ""
    let from = timing.map { $0.isSenderCapture ? "sender" : "arrival" } ?? "dropped"
    // The handle, not the log: rows still queued when the log goes are the last frames before a
    // teardown, and `deinit` closes the handle only after them.
    guard let handle else { return }
    queue.async {
      let stamped = timestamp != NDIlib_recv_timestamp_undefined && timestamp > 0
      let sender = stamped ? String(timestamp) : "undefined"
      let skew = stamped
        ? String(format: "%.6f", Double(timestamp) / NDIReceiveClock.ticksPerSecond - arrivalSeconds)
        : ""
      let row = String(format: "%llu,%.6f,", index, arrivalSeconds)
        + "\(sender),\(skew),\(timecode),\(String(format: "%.3f", declared)),\(width),\(height),"
        + "\(capture),\(from)\n"
      handle.write(Data(row.utf8))
    }
  }

  deinit {
    let handle = self.handle
    queue.async { try? handle?.close() }
  }
}
