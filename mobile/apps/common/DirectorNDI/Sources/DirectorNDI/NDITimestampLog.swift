import CNDI
import Foundation
import DirectorCore

/// What an NDI sender actually stamps on its pictures, written to a CSV in Documents so it can be
/// copied off the iPad and read next to the arrival times. Debug builds only.
///
/// `NDIReceiveClock` takes a frame's `timestamp` as its capture time only when it is set and within
/// an hour of our clock; otherwise the frame is placed at its arrival, and nothing records which of
/// the two happened or what the sender sent. This does, from the same SDK the Director receives
/// with: every frame for the first minute of a receiver, then one in sixty.
///
/// Columns: frame, our wall clock at arrival (s), the raw `timestamp` (100 ns ticks since 1970, or
/// `undefined`), sender minus arrival (s), the raw `timecode`, the declared rate, and the size.
final class NDITimestampLog: @unchecked Sendable {
  private static let everyFrameCount: UInt64 = 3_600
  private static let thinnedEvery: UInt64 = 60

  private let queue: DispatchQueue
  private var handle: FileHandle?
  private var count: UInt64 = 0

  init?(sourceID: SourceID) {
    #if DEBUG
      let directory = DirectorPaths.documents.appendingPathComponent("NDITimestamps", isDirectory: true)
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.dateFormat = "yyyyMMdd-HHmmss"
      let url = directory.appendingPathComponent("\(sourceID.slug)-\(formatter.string(from: Date())).csv")
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let header = "frame,arrivalSeconds,senderTimestamp,senderMinusArrivalSeconds,timecode,declaredRate,width,height\n"
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

  /// Called on the receive thread for every video frame, before the receive clock judges it.
  func note(_ frame: NDIlib_video_frame_v2_t, arrivalSeconds: Double) {
    count += 1
    guard count <= Self.everyFrameCount || count % Self.thinnedEvery == 0 else { return }
    let index = count - 1
    let timestamp = frame.timestamp
    let timecode = frame.timecode
    let declared = frame.frame_rate_D == 0 ? 0 : Double(frame.frame_rate_N) / Double(frame.frame_rate_D)
    let width = frame.xres
    let height = frame.yres
    queue.async { [weak self] in
      guard let handle = self?.handle else { return }
      let stamped = timestamp != NDIlib_recv_timestamp_undefined && timestamp > 0
      let sender = stamped ? String(timestamp) : "undefined"
      let skew = stamped
        ? String(format: "%.6f", Double(timestamp) / NDIReceiveClock.ticksPerSecond - arrivalSeconds)
        : ""
      let row = String(format: "%llu,%.6f,", index, arrivalSeconds)
        + "\(sender),\(skew),\(timecode),\(String(format: "%.3f", declared)),\(width),\(height)\n"
      handle.write(Data(row.utf8))
    }
  }

  deinit {
    let handle = self.handle
    queue.async { try? handle?.close() }
  }
}
