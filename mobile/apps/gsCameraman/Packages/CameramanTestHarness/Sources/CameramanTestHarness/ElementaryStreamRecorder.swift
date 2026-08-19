import CameramanCore
import Foundation

/// Writes the encoder's output to an Annex-B file in the app's Documents directory, so the real
/// hardware-encoded bytes can be pulled off the device and put through ffprobe.
///
/// This exists because "the encoder is configured correctly" and "the encoder produces a decodable
/// stream" are different claims, and only the second one matters. A `VTCompressionSession` that
/// accepts every property and emits an undecodable stream reports no error anywhere.
public final class ElementaryStreamRecorder: @unchecked Sendable {
  public struct Summary: Sendable, Equatable, Codable {
    public var path: String
    public var frames: Int
    public var keyframes: Int
    public var bytes: Int
    public var parameterSetBytes: Int
    public var firstPresentationTime: Double
    public var lastPresentationTime: Double

    public var duration: Double { max(0, lastPresentationTime - firstPresentationTime) }
    /// Measured, so a bitrate setting that the encoder quietly ignored is visible.
    public var measuredBitrate: Int {
      duration > 0 ? Int(Double(bytes) * 8 / duration) : 0
    }
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
      keyframes: 0,
      bytes: 0,
      parameterSetBytes: 0,
      firstPresentationTime: 0,
      lastPresentationTime: 0
    )
  }

  public func append(_ frame: EncodedVideoFrame) {
    lock.withLock {
      guard let handle else { return }

      // Parameter sets go in ahead of the keyframe they describe. ffprobe can start decoding from any
      // keyframe that way, which is the same property a client joining mid-stream depends on.
      var payload = Data()
      if !frame.parameterSets.isEmpty {
        payload.append(startCodePrefixed(frame.parameterSets))
        summary.parameterSetBytes += frame.parameterSets.reduce(0) { $0 + $1.count }
      }
      payload.append(startCodePrefixed(frame.nalUnits))
      handle.write(payload)

      if summary.frames == 0 { summary.firstPresentationTime = frame.presentationTime }
      summary.lastPresentationTime = frame.presentationTime
      summary.frames += 1
      if frame.isKeyframe { summary.keyframes += 1 }
      summary.bytes += payload.count
    }
  }

  public func finish() -> Summary {
    lock.withLock {
      try? handle?.close()
      handle = nil
      return summary
    }
  }

  private func startCodePrefixed(_ units: [Data]) -> Data {
    var result = Data()
    for unit in units {
      result.append(contentsOf: [ 0x00, 0x00, 0x00, 0x01 ])
      result.append(unit)
    }
    return result
  }
}
