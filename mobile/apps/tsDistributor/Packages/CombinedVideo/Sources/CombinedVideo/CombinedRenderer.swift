import AVFoundation
import CoreGraphics
import DistributorWire
import Foundation
import VideoToolbox

/// One camera's stitched file and the rectangle it goes into on the canvas.
public struct CombinedInput: Sendable {
  public var camera: String
  public var url: URL
  public var frame: CGRect

  public init(camera: String, url: URL, frame: CGRect) {
    self.camera = camera
    self.url = url
    self.frame = frame
  }
}

public enum CombinedRenderError: Error, Equatable, CustomStringConvertible, Sendable {
  case noCameras
  case unreadable(String)
  case writerFailed(String)

  public var description: String {
    switch self {
    case .noCameras: "no cameras to combine"
    case .unreadable(let file): "cannot read \(file)"
    case .writerFailed(let reason): "the combined video could not be written: \(reason)"
    }
  }
}

/// Renders the combined video: every camera at once, each fitted into its rectangle on a black
/// canvas, encoded as HEVC at the rate the cameras were recorded at, with one chosen camera's
/// sound.
///
/// The cameras are TS Director's stitched files for one export, so they share a window and a
/// length, and the same moment is the same time into each of them.
public enum CombinedRenderer {
  public static func render(
    inputs: [CombinedInput],
    audioFrom: URL?,
    canvas: CGSize = CombinedGeometry.canvas,
    bitsPerSecond: Int,
    frameRate: Int32 = 30,
    to destination: URL,
    progress: (@Sendable (Double) -> Void)? = nil
  ) async throws {
    guard !inputs.isEmpty else { throw CombinedRenderError.noCameras }

    let composition = AVMutableComposition()
    var layers: [AVMutableVideoCompositionLayerInstruction] = []
    var duration = CMTime.zero
    for input in inputs {
      let asset = AVURLAsset(url: input.url)
      guard let source = try await asset.loadTracks(withMediaType: .video).first,
            let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
      else { throw CombinedRenderError.unreadable(input.url.lastPathComponent) }
      let range = try await source.load(.timeRange)
      try track.insertTimeRange(range, of: source, at: .zero)
      duration = max(duration, range.duration)

      let natural = try await source.load(.naturalSize)
      let oriented = try await source.load(.preferredTransform)
      let upright = CGRect(origin: .zero, size: natural).applying(oriented)
      let size = CGSize(width: abs(upright.width), height: abs(upright.height))
      let scale = min(input.frame.width / size.width, input.frame.height / size.height)
      let fitted = CGSize(width: size.width * scale, height: size.height * scale)
      let origin = CGPoint(
        x: input.frame.midX - fitted.width / 2,
        y: input.frame.midY - fitted.height / 2
      )
      let placement = oriented
        .concatenating(CGAffineTransform(translationX: -upright.minX, y: -upright.minY))
        .concatenating(CGAffineTransform(scaleX: scale, y: scale))
        .concatenating(CGAffineTransform(translationX: origin.x, y: origin.y))
      let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
      layer.setTransform(placement, at: .zero)
      layers.append(layer)
    }

    var soundTrack: AVMutableCompositionTrack?
    if let audioFrom {
      let asset = AVURLAsset(url: audioFrom)
      if let source = try await asset.loadTracks(withMediaType: .audio).first,
         let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
        let range = try await source.load(.timeRange)
        try track.insertTimeRange(CMTimeRange(start: range.start, duration: min(range.duration, duration)), of: source, at: .zero)
        soundTrack = track
      }
    }

    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
    instruction.backgroundColor = CGColor(red: 0, green: 0, blue: 0, alpha: 1)
    instruction.layerInstructions = layers
    let videoComposition = AVMutableVideoComposition()
    videoComposition.renderSize = canvas
    videoComposition.frameDuration = CMTime(value: 1, timescale: frameRate)
    videoComposition.instructions = [ instruction ]

    let reader = try AVAssetReader(asset: composition)
    let pictures = AVAssetReaderVideoCompositionOutput(
      videoTracks: composition.tracks(withMediaType: .video),
      videoSettings: [ kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ]
    )
    pictures.videoComposition = videoComposition
    pictures.alwaysCopiesSampleData = false
    reader.add(pictures)
    var sound: AVAssetReaderTrackOutput?
    if let soundTrack {
      let output = AVAssetReaderTrackOutput(track: soundTrack, outputSettings: [ AVFormatIDKey: kAudioFormatLinearPCM ])
      reader.add(output)
      sound = output
    }

    try? FileManager.default.removeItem(at: destination)
    let writer = try AVAssetWriter(outputURL: destination, fileType: .mp4)
    let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.hevc,
      AVVideoWidthKey: Int(canvas.width),
      AVVideoHeightKey: Int(canvas.height),
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitsPerSecond,
        AVVideoExpectedSourceFrameRateKey: Int(frameRate),
        AVVideoMaxKeyFrameIntervalDurationKey: 2,
        AVVideoProfileLevelKey: kVTProfileLevel_HEVC_Main_AutoLevel as String
      ] as [String: Any]
    ])
    video.expectsMediaDataInRealTime = false
    writer.add(video)
    var audio: AVAssetWriterInput?
    if sound != nil {
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 48_000,
        AVNumberOfChannelsKey: 2,
        AVEncoderBitRateKey: 192_000
      ])
      input.expectsMediaDataInRealTime = false
      writer.add(input)
      audio = input
    }

    guard reader.startReading() else {
      throw CombinedRenderError.unreadable(reader.error?.localizedDescription ?? "composition")
    }
    guard writer.startWriting() else {
      throw CombinedRenderError.writerFailed(writer.error?.localizedDescription ?? "start")
    }
    writer.startSession(atSourceTime: .zero)

    let total = max(duration.seconds, 0.001)
    let session = Session(reader: reader, writer: writer)
    let pictureLane = Lane(output: pictures, input: video)
    let soundLane = sound.flatMap { output in audio.map { Lane(output: output, input: $0) } }
    await withTaskGroup(of: Void.self) { group in
      group.addTask {
        await session.pump(pictureLane) { time in progress?(min(1, time.seconds / total)) }
      }
      if let soundLane {
        group.addTask { await session.pump(soundLane) { _ in } }
      }
    }

    if Task.isCancelled {
      reader.cancelReading()
      writer.cancelWriting()
      try? FileManager.default.removeItem(at: destination)
      throw CancellationError()
    }
    guard reader.status != .failed else {
      writer.cancelWriting()
      throw CombinedRenderError.unreadable(reader.error?.localizedDescription ?? "composition")
    }
    await writer.finishWriting()
    guard writer.status == .completed else {
      throw CombinedRenderError.writerFailed(writer.error?.localizedDescription ?? "\(writer.status.rawValue)")
    }
    progress?(1)
  }
}

/// One reader output feeding one writer input, owned by the single pump that drains it. The lane
/// ends once, whoever ends it; ending it wakes the pump's caller.
private final class Lane: @unchecked Sendable {
  let output: AVAssetReaderOutput
  let input: AVAssetWriterInput
  private let lock = NSLock()
  private var ended = false
  private var waiter: CheckedContinuation<Void, Never>?

  init(output: AVAssetReaderOutput, input: AVAssetWriterInput) {
    self.output = output
    self.input = input
  }

  var hasEnded: Bool { lock.withLock { ended } }

  /// Resumes `continuation` when the lane ends, or at once if it already has.
  func wait(_ continuation: CheckedContinuation<Void, Never>) {
    let already = lock.withLock { () -> Bool in
      if !ended { waiter = continuation }
      return ended
    }
    if already { continuation.resume() }
  }

  func end() {
    let waiting = lock.withLock { () -> CheckedContinuation<Void, Never>? in
      ended = true
      defer { waiter = nil }
      return waiter
    }
    waiting?.resume()
  }
}

/// The reader and writer of one render, shared by the picture and sound pumps. Each pump touches
/// only its own output and input; the reader and writer are read for their status.
private final class Session: @unchecked Sendable {
  let reader: AVAssetReader
  let writer: AVAssetWriter

  init(reader: AVAssetReader, writer: AVAssetWriter) {
    self.reader = reader
    self.writer = writer
  }

  /// Moves samples from the lane's output to its input whenever the writer asks for more, and
  /// returns once the output runs dry, the writer stops, or the render is cancelled. The writer's
  /// own callback drives it, so nothing waits on a timer that macOS could stretch.
  func pump(_ lane: Lane, onTime: @escaping @Sendable (CMTime) -> Void) async {
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        lane.wait(continuation)
        lane.input.requestMediaDataWhenReady(on: DispatchQueue(label: "CombinedRenderer.pump")) { [self] in
          while !lane.hasEnded && lane.input.isReadyForMoreMediaData {
            guard writer.status == .writing else {
              lane.end()
              return
            }
            guard reader.status == .reading, let sample = lane.output.copyNextSampleBuffer() else {
              lane.input.markAsFinished()
              lane.end()
              return
            }
            onTime(CMSampleBufferGetPresentationTimeStamp(sample))
            guard lane.input.append(sample) else {
              lane.input.markAsFinished()
              lane.end()
              return
            }
          }
        }
      }
    } onCancel: {
      lane.end()
    }
  }
}
