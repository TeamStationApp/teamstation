import CameramanCore
import CameramanEncode
import Foundation

/// Writes the AAC encoder's output to an ADTS file in the app's Documents directory, so the real
/// hardware-encoded audio can be pulled off the device and decoded by ffprobe.
///
/// The frames are wrapped in ADTS purely so the file is self-describing; the RTP path sends the same
/// access units bare.
public final class AudioStreamRecorder: @unchecked Sendable {
  public struct Summary: Sendable, Equatable, Codable {
    public var path: String
    public var frames: Int
    public var bytes: Int
    public var sampleRate: Int
    public var channelCount: Int
    public var firstPresentationTime: Double
    public var lastPresentationTime: Double
    /// Frames the encoder produced at a rate or channel count ADTS cannot express, which would
    /// otherwise be silently missing from the file.
    public var unwrappable: Int

    public var duration: Double { max(0, lastPresentationTime - firstPresentationTime) }
  }

  private let lock = NSLock()
  private var handle: FileHandle?
  private var summary: Summary

  public init(filename: String) {
    let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let url = directory.appendingPathComponent(filename)
    FileManager.default.createFile(atPath: url.path, contents: nil)
    handle = try? FileHandle(forWritingTo: url)
    summary = Summary(
      path: url.path,
      frames: 0,
      bytes: 0,
      sampleRate: 0,
      channelCount: 0,
      firstPresentationTime: 0,
      lastPresentationTime: 0,
      unwrappable: 0
    )
  }

  public func append(_ frame: EncodedAudioFrame) {
    lock.withLock {
      guard let handle else { return }
      guard let wrapped = ADTSHeader.wrap(
        frame.data,
        sampleRate: frame.sampleRate,
        channelCount: frame.channelCount
      ) else {
        summary.unwrappable += 1
        return
      }

      handle.write(wrapped)

      if summary.frames == 0 { summary.firstPresentationTime = frame.presentationTime }
      summary.lastPresentationTime = frame.presentationTime
      summary.frames += 1
      summary.bytes += wrapped.count
      summary.sampleRate = frame.sampleRate
      summary.channelCount = frame.channelCount
    }
  }

  public func finish() -> Summary {
    lock.withLock {
      try? handle?.close()
      handle = nil
      return summary
    }
  }
}
