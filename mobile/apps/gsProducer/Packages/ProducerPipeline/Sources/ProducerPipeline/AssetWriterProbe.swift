import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ProducerCore
import ProducerSources
import UniformTypeIdentifiers
import VideoToolbox

/// Pushes generated frames through a segmented `AVAssetWriter` configured exactly like the DVR's.
///
/// `EncodeSessionProbe` answers "will VideoToolbox encode for us at all". This answers the next
/// question down: "will an `AVAssetWriter` configured the way we configure it accept a stream of
/// frames". The two together separate a device that has stopped encoding from settings that were
/// never valid, which is otherwise guesswork — the writer reports both cases as "Cannot Encode".
public enum AssetWriterProbe {
  public struct Result: Sendable, Codable, Equatable {
    public var attempted: Int
    public var appended: Int
    public var segments: Int
    public var error: String?

    public var configuration = ""

    public var summary: String {
      var text = "writer probe [\(configuration)]: \(appended)/\(attempted) appended, \(segments) segments"
      if let error { text += " — \(error)" }
      return text
    }
  }

  /// Query-string entry point so a bisect can be driven from the control channel without a rebuild.
  public static func probe(options: [String: String], defaultCodec: ProgramCodec) -> Result {
    func integer(_ key: String, _ fallback: Int) -> Int { options[key].flatMap { Int($0) } ?? fallback }
    func flag(_ key: String, _ fallback: Bool) -> Bool {
      guard let raw = options[key]?.lowercased() else { return fallback }
      return raw == "1" || raw == "true" || raw == "yes"
    }

    let width = integer("width", 1920)
    let height = integer("height", 1080)
    let segmented = flag("segmented", true)
    let minimal = flag("minimal", false)
    let adaptorPool = flag("adaptorpool", false)
    let codec = options["codec"] == "hevc" ? ProgramCodec.hevc
      : options["codec"] == "h264" ? ProgramCodec.h264
      : defaultCodec

    var result = probe(
      frames: integer("frames", 60),
      width: width,
      height: height,
      frameRate: integer("fps", 30),
      bitrate: integer("bitrate", 14_000_000),
      codec: codec,
      segmented: segmented,
      minimal: minimal,
      adaptorPool: adaptorPool
    )
    result.configuration = "\(width)x\(height) \(codec == .hevc ? "hevc" : "h264")"
      + (segmented ? " segmented" : " file")
      + (minimal ? " minimal" : "")
      + (adaptorPool ? " adaptor-pool" : "")
    return result
  }

  public static func probe(
    frames: Int = 60,
    width: Int = 1920,
    height: Int = 1080,
    frameRate: Int = 30,
    bitrate: Int = 14_000_000,
    segmentSeconds: Double = 2,
    codec: ProgramCodec = .h264,
    segmented: Bool = true,
    minimal: Bool = false,
    adaptorPool: Bool = false
  ) -> Result {
    let collector = SegmentCollector()
    let directory = ProducerPaths.archives.appendingPathComponent("writer-probe", isDirectory: true)
    try? FileManager.default.removeItem(at: directory)

    let writer: AVAssetWriter
    if segmented {
      writer = AVAssetWriter(contentType: UTType.mpeg4Movie)
      writer.outputFileTypeProfile = .mpeg4AppleHLS
      writer.preferredOutputSegmentInterval = CMTime(seconds: segmentSeconds, preferredTimescale: 1)
      writer.initialSegmentStartTime = .zero
      writer.delegate = collector
    } else {
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let url = directory.appendingPathComponent("probe.mp4")
      guard let fileWriter = try? AVAssetWriter(outputURL: url, fileType: .mp4) else {
        return Result(attempted: 0, appended: 0, segments: 0, error: "could not create a file writer")
      }
      writer = fileWriter
    }

    let compression: [String: Any] = minimal
      ? [AVVideoAverageBitRateKey: bitrate]
      : [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoMaxKeyFrameIntervalDurationKey: 2,
        AVVideoExpectedSourceFrameRateKey: frameRate,
        AVVideoAllowFrameReorderingKey: false,
        AVVideoProfileLevelKey: codec == .hevc
          ? kVTProfileLevel_HEVC_Main_AutoLevel as String
          : AVVideoProfileLevelH264HighAutoLevel
      ]
    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: codec == .hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: compression
    ])
    videoInput.expectsMediaDataInRealTime = true
    guard writer.canAdd(videoInput) else {
      return Result(attempted: 0, appended: 0, segments: 0, error: "writer rejected the video input")
    }
    writer.add(videoInput)

    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: videoInput,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height
      ]
    )

    guard writer.startWriting() else {
      return Result(
        attempted: 0,
        appended: 0,
        segments: 0,
        error: "startWriting: \(ProgramEncoder.describe(writer.error))"
      )
    }
    writer.startSession(atSourceTime: .zero)

    let factory: PixelBufferFactory?
    if adaptorPool {
      factory = nil
    } else {
      guard let created = PixelBufferFactory(
        width: width,
        height: height,
        pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      ) else {
        writer.cancelWriting()
        return Result(attempted: 0, appended: 0, segments: 0, error: "could not create a buffer pool")
      }
      factory = created
    }

    func makeBuffer() -> CVPixelBuffer? {
      if let factory { return factory.makeBuffer() }
      guard let pool = adaptor.pixelBufferPool else { return nil }
      var buffer: CVPixelBuffer?
      guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer) == kCVReturnSuccess else {
        return nil
      }
      return buffer
    }

    var appended = 0
    var failure: String?
    for index in 0 ..< frames {
      guard writer.status == .writing else {
        failure = "status \(writer.status.rawValue) at frame \(index): \(ProgramEncoder.describe(writer.error))"
        break
      }
      guard videoInput.isReadyForMoreMediaData else {
        // Real-time inputs go not-ready when the encoder is behind; wait briefly rather than
        // counting it as a failure.
        Thread.sleep(forTimeInterval: 1.0 / Double(frameRate))
        continue
      }
      guard let buffer = makeBuffer() else {
        failure = "pool exhausted at frame \(index)"
        break
      }
      let time = CMTime(value: CMTimeValue(index), timescale: CMTimeScale(frameRate))
      if adaptor.append(buffer, withPresentationTime: time) {
        appended += 1
      } else {
        failure = "append rejected at frame \(index): \(ProgramEncoder.describe(writer.error))"
        break
      }
      Thread.sleep(forTimeInterval: 1.0 / Double(frameRate))
    }

    videoInput.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    let finished = done.wait(timeout: .now() + 20) == .success
    if !finished, failure == nil {
      failure = "finishWriting did not return within 20s"
    }

    return Result(
      attempted: frames,
      appended: appended,
      segments: collector.count,
      error: failure
    )
  }

  private final class SegmentCollector: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var segments = 0

    var count: Int {
      lock.lock()
      defer { lock.unlock() }
      return segments
    }

    func assetWriter(
      _ writer: AVAssetWriter,
      didOutputSegmentData segmentData: Data,
      segmentType: AVAssetSegmentType,
      segmentReport: AVAssetSegmentReport?
    ) {
      lock.lock()
      segments += 1
      lock.unlock()
    }
  }
}
