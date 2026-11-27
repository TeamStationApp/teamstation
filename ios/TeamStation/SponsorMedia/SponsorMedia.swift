import AVFoundation
import Foundation
import UIKit

/**
 * The phone's half of a sponsor upload: logos and Schedule row pictures
 * shrunk or cropped with UIKit, and reels re-encoded on the hardware H.264
 * encoder, so the server only has to check them. `RCTSponsorMedia.mm` hands
 * each JavaScript call here as one request; the answer is a new file in the
 * app's temporary directory.
 */
@objc(TSSponsorMedia)
final class SponsorMedia: NSObject {
  /**
   * Runs `request["op"]` (`resizeImage`, `cropSquare`, `cropCover` or
   * `encodeReel`) and calls `completion` once, with the answer or with the
   * sentence the screen shows.
   */
  @objc(run:completion:)
  func run(_ request: NSDictionary, completion: @escaping (NSDictionary?, NSString?) -> Void) {
    Task.detached(priority: .userInitiated) {
      do {
        completion(try await Self.answer(request) as NSDictionary, nil)
      } catch let problem as SponsorMediaCore.Problem {
        completion(nil, problem.sentence as NSString)
      } catch {
        completion(nil, SponsorMediaCore.videoProblem as NSString)
      }
    }
  }

  private static func answer(_ request: NSDictionary) async throws -> [String: Any] {
    let uri = request["uri"] as? String ?? ""
    let number = { (key: String) in (request[key] as? NSNumber)?.doubleValue ?? 0 }
    switch request["op"] as? String {
    case "encodeReel":
      return try await encodeReel(
        uri, box: (number("width"), number("height")), fps: number("fps"),
        videoBitrate: Int(number("videoBitrate")), audioBitrate: Int(number("audioBitrate")))
    case "resizeImage":
      return try image(uri, request) { width, height in
        let size = SponsorMediaCore.fit(
          width: width, height: height, maxWidth: number("maxWidth"),
          maxHeight: number("maxHeight"), even: false)
        return (CGRect(x: 0, y: 0, width: width, height: height), size.width, size.height)
      }
    case "cropSquare":
      return try image(uri, request) { width, height in
        let side = Int(number("size"))
        return (SponsorMediaCore.squareCrop(width: width, height: height), side, side)
      }
    case "cropCover":
      return try image(uri, request) { width, height in
        SponsorMediaCore.coverCrop(
          width: width, height: height, boxWidth: number("width"), boxHeight: number("height"))
      }
    default:
      throw SponsorMediaCore.Problem(sentence: SponsorMediaCore.pictureProblem)
    }
  }

  /**
   * The picture at `uri`, upright, with the part `layout` names drawn at
   * the size it names, written as `request["format"]`. A PNG keeps its
   * transparency.
   */
  private static func image(
    _ uri: String, _ request: NSDictionary,
    layout: (Double, Double) -> (crop: CGRect, width: Int, height: Int)
  ) throws -> [String: Any] {
    let problem = SponsorMediaCore.Problem(sentence: SponsorMediaCore.pictureProblem)
    let format = try SponsorMediaCore.format(request["format"] as? String ?? "")
    let url = try SponsorMediaCore.fileURL(uri, problem: SponsorMediaCore.pictureProblem)
    guard let data = try? Data(contentsOf: url), let picture = UIImage(data: data, scale: 1)
    else { throw problem }
    let (crop, width, height) = layout(picture.size.width, picture.size.height)
    let rendererFormat = UIGraphicsImageRendererFormat()
    rendererFormat.scale = 1
    rendererFormat.opaque = format == .jpeg
    let renderer = UIGraphicsImageRenderer(
      size: CGSize(width: width, height: height), format: rendererFormat)
    let scale = Double(width) / crop.width
    let draw = { (_: UIGraphicsImageRendererContext) in
      picture.draw(
        in: CGRect(
          x: -crop.minX * scale, y: -crop.minY * scale,
          width: picture.size.width * scale, height: picture.size.height * scale))
    }
    let bytes =
      format == .png
      ? renderer.pngData(actions: draw) : renderer.jpegData(withCompressionQuality: 0.9, actions: draw)
    let out = SponsorMediaCore.outputURL(format.fileExtension)
    try bytes.write(to: out)
    return ["uri": out.absoluteString, "bytes": bytes.count, "width": width, "height": height]
  }

  /**
   * The video at `uri`, upright, re-encoded as an H.264 MP4 within `box`
   * (its proportions kept, never enlarged) at `videoBitrate`, with no two
   * frames closer than `1 / fps`, and its sound, if it has any, as AAC at
   * `audioBitrate`. AVAssetExportSession cannot be given a bitrate, so the
   * reader and writer are driven directly.
   */
  private static func encodeReel(
    _ uri: String, box: (Double, Double), fps: Double, videoBitrate: Int, audioBitrate: Int
  ) async throws -> [String: Any] {
    let problem = SponsorMediaCore.Problem(sentence: SponsorMediaCore.videoProblem)
    let asset = AVURLAsset(url: try SponsorMediaCore.fileURL(uri, problem: problem.sentence))
    guard let track = try await asset.loadTracks(withMediaType: .video).first else {
      throw problem
    }
    let audio = try await asset.loadTracks(withMediaType: .audio).first
    let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
    let upright = natural.applying(transform)
    let size = SponsorMediaCore.fit(
      width: abs(upright.width), height: abs(upright.height), maxWidth: box.0,
      maxHeight: box.1, even: true)
    let duration = try await asset.load(.duration)

    let reader = try AVAssetReader(asset: asset)
    let frames = AVAssetReaderVideoCompositionOutput(
      videoTracks: [track],
      videoSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      ])
    frames.videoComposition = try await AVVideoComposition.videoComposition(withPropertiesOf: asset)
    reader.add(frames)
    let out = SponsorMediaCore.outputURL("mp4")
    let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
    writer.shouldOptimizeForNetworkUse = true
    let video = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: size.width,
        AVVideoHeightKey: size.height,
        AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
        AVVideoCompressionPropertiesKey: [
          AVVideoAverageBitRateKey: videoBitrate,
          AVVideoExpectedSourceFrameRateKey: fps,
          AVVideoMaxKeyFrameIntervalKey: Int(fps * 2),
          AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
          AVVideoAllowFrameReorderingKey: false,
        ],
      ])
    video.expectsMediaDataInRealTime = false
    writer.add(video)
    var pumps = [(AVAssetReaderOutput, AVAssetWriterInput, Bool)]()
    pumps.append((frames, video, true))
    if let audio {
      let samples = AVAssetReaderTrackOutput(
        track: audio,
        outputSettings: [
          AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 2,
        ])
      reader.add(samples)
      let sound = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 2,
          AVEncoderBitRateKey: audioBitrate,
        ])
      writer.add(sound)
      pumps.append((samples, sound, false))
    }
    guard reader.startReading(), writer.startWriting() else { throw problem }
    writer.startSession(atSourceTime: .zero)
    await withTaskGroup(of: Void.self) { group in
      for (output, input, paced) in pumps {
        group.addTask { await pump(output, into: input, fps: paced ? fps : nil) }
      }
    }
    await writer.finishWriting()
    guard reader.status == .completed, writer.status == .completed else { throw problem }
    let bytes = (try FileManager.default.attributesOfItem(atPath: out.path)[.size] as? NSNumber)?
      .intValue ?? 0
    return [
      "uri": out.absoluteString, "bytes": bytes, "width": size.width, "height": size.height,
      "durationMs": Int((duration.seconds * 1000).rounded()),
    ]
  }

  /**
   * Copies `output`'s samples into `input` until the output runs dry,
   * dropping video frames that would come sooner than `1 / fps` after the
   * last one kept.
   */
  private static func pump(
    _ output: AVAssetReaderOutput, into input: AVAssetWriterInput, fps: Double?
  ) async {
    var pacer = fps.map(SponsorMediaCore.FramePacer.init(fps:))
    let queue = DispatchQueue(label: "app.teamstation.sponsorMedia.pump")
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      input.requestMediaDataWhenReady(on: queue) {
        while input.isReadyForMoreMediaData {
          guard let sample = output.copyNextSampleBuffer() else {
            input.markAsFinished()
            done.resume()
            return
          }
          let seconds = CMSampleBufferGetPresentationTimeStamp(sample).seconds
          if pacer?.keep(seconds) == false { continue }
          if !input.append(sample) {
            // The writer failed; its status says so once the reel is finished.
            input.markAsFinished()
            done.resume()
            return
          }
        }
      }
    }
  }
}
