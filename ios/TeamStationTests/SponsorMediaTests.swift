import AVFoundation
import ObjectiveC
import UIKit
import XCTest

/// `TSSponsorMedia`'s one entry point, which the app declares; this bundle
/// takes no pods and cannot import the app, so the class is found by name.
@objc protocol SponsorMediaRunning {
  func run(_ request: NSDictionary, completion: @escaping (NSDictionary?, NSString?) -> Void)
}

/// The sponsor media module on the simulator: pictures shrunk and cropped
/// with their transparency kept, and a synthetic 4 s 1280 × 720 60 fps clip
/// with sound encoded to 640 × 360 H.264 at no more than 30 fps.
final class SponsorMediaTests: XCTestCase {
  private let pictureProblem = "This picture could not be read. Try another file."
  private let videoProblem = "This video could not be shrunk. Try another file."

  private var media: SponsorMediaRunning {
    let type = NSClassFromString("TSSponsorMedia") as! NSObject.Type
    class_addProtocol(type, SponsorMediaRunning.self)
    return type.init() as! SponsorMediaRunning
  }

  private struct Answer {
    let value: NSDictionary?
    let problem: String?
  }

  private func run(_ request: [String: Any]) -> Answer {
    let done = expectation(description: "answered")
    var answer: Answer?
    media.run(request as NSDictionary) { value, problem in
      answer = Answer(value: value, problem: problem as String?)
      done.fulfill()
    }
    wait(for: [done], timeout: 120)
    return answer!
  }

  private func temporary(_ name: String) -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("test-\(name)")
    try? FileManager.default.removeItem(at: url)
    return url
  }

  /// A transparent picture with an opaque red block in its upper-right quarter.
  private func picture(_ width: Int, _ height: Int, _ name: String, jpeg: Bool = false) -> URL {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = false
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
    let draw = { (context: UIGraphicsImageRendererContext) in
      UIColor.red.setFill()
      context.fill(CGRect(x: width / 2, y: 0, width: width / 2, height: height / 2))
    }
    let data = jpeg ? renderer.jpegData(withCompressionQuality: 1, actions: draw) : renderer.pngData(actions: draw)
    let url = temporary(name)
    try! data.write(to: url)
    return url
  }

  /// The RGBA bytes of the picture an answer names, with its size.
  private func pixels(_ answer: Answer) -> (width: Int, height: Int, rgba: [UInt8]) {
    let url = URL(string: answer.value!["uri"] as! String)!
    let size = try! FileManager.default.attributesOfItem(atPath: url.path)[.size] as! NSNumber
    XCTAssertEqual(answer.value!["bytes"] as? NSNumber, size)
    let image = UIImage(contentsOfFile: url.path)!.cgImage!
    var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let context = CGContext(
      data: &rgba, width: image.width, height: image.height, bitsPerComponent: 8,
      bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return (image.width, image.height, rgba)
  }

  /// The red and alpha of the pixel `x` across and `y` down.
  private func pixel(_ picture: (width: Int, height: Int, rgba: [UInt8]), _ x: Int, _ y: Int) -> (red: UInt8, alpha: UInt8) {
    let at = (y * picture.width + x) * 4
    return (picture.rgba[at], picture.rgba[at + 3])
  }

  func testALargePngIsShrunkKeepingItsTransparency() {
    let source = picture(960, 540, "logo.png")
    let answer = run([
      "op": "resizeImage", "uri": source.absoluteString, "maxWidth": 480, "maxHeight": 270, "format": "png",
    ])
    XCTAssertEqual(answer.value?["width"] as? Int, 480)
    XCTAssertEqual(answer.value?["height"] as? Int, 270)
    let out = pixels(answer)
    XCTAssertEqual(out.width, 480)
    XCTAssertEqual(pixel(out, 10, 260).alpha, 0)
    XCTAssertEqual(pixel(out, 470, 10).red, 255)
    XCTAssertEqual(pixel(out, 470, 10).alpha, 255)
  }

  func testASmallPictureByPathIsKeptAtItsSizeAsJpeg() {
    let source = picture(300, 100, "small.png")
    let answer = run([
      "op": "resizeImage", "uri": source.path, "maxWidth": 480, "maxHeight": 270, "format": "jpeg",
    ])
    XCTAssertTrue((answer.value?["uri"] as? String ?? "").hasSuffix(".jpg"))
    let out = pixels(answer)
    XCTAssertEqual(out.width, 300)
    XCTAssertEqual(out.height, 100)
  }

  func testRowLogosAreCentreCroppedToASquare() {
    let source = picture(400, 200, "row.jpg", jpeg: true)
    let answer = run(["op": "cropSquare", "uri": source.absoluteString, "size": 128, "format": "jpeg"])
    let out = pixels(answer)
    XCTAssertEqual(out.width, 128)
    XCTAssertEqual(out.height, 128)
    // The square is the middle of the picture: red on its right, upper half.
    XCTAssertGreaterThan(pixel(out, 120, 10).red, 245)
  }

  func testBackgroundsAreCroppedFromTheUpperRight() {
    let wide = picture(4000, 224, "wide.png")
    let cover = pixels(run(["op": "cropCover", "uri": wide.absoluteString, "width": 1920, "height": 224, "format": "png"]))
    XCTAssertEqual(cover.width, 1920)
    XCTAssertEqual(cover.height, 224)
    // Only the right-hand 1920 of 4000 are kept, all of it in the red half's columns.
    XCTAssertEqual(pixel(cover, 10, 10).red, 255)
    XCTAssertEqual(pixel(cover, 10, 200).alpha, 0)
    let narrow = picture(960, 540, "narrow.png")
    let top = pixels(run(["op": "cropCover", "uri": narrow.absoluteString, "width": 1920, "height": 224, "format": "png"]))
    XCTAssertEqual(top.width, 960)
    XCTAssertEqual(top.height, 112)
    XCTAssertEqual(pixel(top, 950, 100).red, 255)
    XCTAssertEqual(pixel(top, 10, 100).alpha, 0)
  }

  func testPicturesThatCannotBeUsedAreRefusedWithTheSentence() {
    let source = picture(20, 20, "format.png")
    let notAPicture = temporary("text.png")
    try! Data("not a picture".utf8).write(to: notAPicture)
    for request: [String: Any] in [
      ["op": "resizeImage", "uri": temporary("missing.png").absoluteString, "maxWidth": 10, "maxHeight": 10, "format": "png"],
      ["op": "cropSquare", "uri": notAPicture.absoluteString, "size": 10, "format": "png"],
      ["op": "cropSquare", "uri": source.absoluteString, "size": 10, "format": "gif"],
      ["op": "cropSquare", "uri": "content://media/1", "size": 10, "format": "png"],
      ["op": "rotate", "uri": source.absoluteString],
    ] {
      XCTAssertEqual(run(request).problem, pictureProblem, "\(request)")
    }
  }

  func testVideosThatCannotBeReadAreRefusedWithTheSentence() {
    let notAVideo = temporary("text.mp4")
    try! Data("not a video".utf8).write(to: notAVideo)
    let soundOnly = temporary("sound.m4a")
    writeClip(to: soundOnly, video: false)
    for uri in [notAVideo.absoluteString, temporary("missing.mp4").absoluteString, "content://media/2", soundOnly.absoluteString] {
      let answer = run(reel(uri))
      XCTAssertEqual(answer.problem, videoProblem, uri)
    }
  }

  private func reel(_ uri: String) -> [String: Any] {
    ["op": "encodeReel", "uri": uri, "width": 640, "height": 360, "fps": 30, "videoBitrate": 1_000_000, "audioBitrate": 128_000]
  }

  func testASixtyFpsClipIsEncodedToThirtyFpsH264Within640By360() throws {
    let source = temporary("source.mov")
    writeClip(to: source, video: true)
    let answer = run(reel(source.absoluteString))
    let value = try XCTUnwrap(answer.value, answer.problem ?? "")
    XCTAssertEqual(value["width"] as? Int, 640)
    XCTAssertEqual(value["height"] as? Int, 360)
    let durationMs = try XCTUnwrap(value["durationMs"] as? Int)
    XCTAssertEqual(Double(durationMs), 4000, accuracy: 100)
    let out = URL(string: value["uri"] as! String)!
    XCTAssertEqual(out.pathExtension, "mp4")
    let size = try FileManager.default.attributesOfItem(atPath: out.path)[.size] as! NSNumber
    XCTAssertEqual(value["bytes"] as? NSNumber, size)

    let asset = AVURLAsset(url: out)
    let track = try XCTUnwrap(asset.tracks(withMediaType: .video).first)
    XCTAssertEqual(track.naturalSize, CGSize(width: 640, height: 360))
    let picture = track.formatDescriptions[0] as! CMFormatDescription
    XCTAssertEqual(CMFormatDescriptionGetMediaSubType(picture), kCMVideoCodecType_H264)
    let sound = try XCTUnwrap(asset.tracks(withMediaType: .audio).first)
    let soundFormat = sound.formatDescriptions[0] as! CMFormatDescription
    XCTAssertEqual(CMFormatDescriptionGetMediaSubType(soundFormat), kAudioFormatMPEG4AAC)

    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    reader.add(output)
    XCTAssertTrue(reader.startReading())
    var times = [Double]()
    while let sample = output.copyNextSampleBuffer() {
      if CMSampleBufferGetNumSamples(sample) > 0 {
        times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
      }
    }
    times.sort()
    XCTAssertGreaterThanOrEqual(times.count, 110)
    XCTAssertLessThanOrEqual(times.count, 121)
    for (earlier, later) in zip(times, times.dropFirst()) {
      XCTAssertGreaterThanOrEqual(later - earlier, 1.0 / 30 - 1e-3)
    }
  }

  /// A 4 s clip: 1280 × 720 at 60 fps with a moving block when `video`, and a 440 Hz tone.
  private func writeClip(to url: URL, video: Bool) {
    let writer = try! AVAssetWriter(outputURL: url, fileType: video ? .mov : .m4a)
    var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    var picture: AVAssetWriterInput?
    if video {
      let input = AVAssetWriterInput(
        mediaType: .video,
        outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 1280, AVVideoHeightKey: 720])
      input.expectsMediaDataInRealTime = false
      writer.add(input)
      picture = input
      adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [
          kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
          kCVPixelBufferWidthKey as String: 1280, kCVPixelBufferHeightKey as String: 720,
        ])
    }
    let rate = 44_100.0
    var description = AudioStreamBasicDescription(
      mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2,
      mBitsPerChannel: 16, mReserved: 0)
    let sound = AVAssetWriterInput(
      mediaType: .audio,
      outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 2])
    sound.expectsMediaDataInRealTime = false
    writer.add(sound)
    XCTAssertTrue(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(
      allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0,
      magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
    // Each input asks for its samples when the writer is ready for them, so
    // the writer interleaves them as it needs.
    let frames = 240
    let chunk = Int(rate) / 60
    let group = DispatchGroup()
    if let picture, let adaptor {
      group.enter()
      var frame = 0
      picture.requestMediaDataWhenReady(on: DispatchQueue(label: "test.picture")) {
        while picture.isReadyForMoreMediaData {
          if frame == frames {
            picture.markAsFinished()
            group.leave()
            return
          }
          var buffer: CVPixelBuffer?
          CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
          CVPixelBufferLockBaseAddress(buffer!, [])
          let base = CVPixelBufferGetBaseAddress(buffer!)!.assumingMemoryBound(to: UInt8.self)
          let row = CVPixelBufferGetBytesPerRow(buffer!)
          memset(base, 40, row * 720)
          for y in 300..<420 {
            memset(base + y * row + (frame * 4) * 4, 255, 120 * 4)
          }
          CVPixelBufferUnlockBaseAddress(buffer!, [])
          adaptor.append(buffer!, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 60))
          frame += 1
        }
      }
    }
    group.enter()
    var part = 0
    sound.requestMediaDataWhenReady(on: DispatchQueue(label: "test.sound")) {
      while sound.isReadyForMoreMediaData {
        if part == frames {
          sound.markAsFinished()
          group.leave()
          return
        }
        let start = part * chunk
        var samples = [Int16](repeating: 0, count: chunk * 2)
        for i in 0..<chunk {
          let value = Int16(sin(2 * .pi * 440 * Double(start + i) / rate) * 8000)
          samples[2 * i] = value
          samples[2 * i + 1] = value
        }
        var block: CMBlockBuffer?
        let bytes = samples.count * 2
        CMBlockBufferCreateWithMemoryBlock(
          allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
          customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block)
        samples.withUnsafeBytes { raw in
          _ = CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes)
        }
        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
          allocator: nil, dataBuffer: block!, formatDescription: format!, sampleCount: chunk,
          presentationTimeStamp: CMTime(value: CMTimeValue(start), timescale: CMTimeScale(rate)),
          packetDescriptions: nil, sampleBufferOut: &sample)
        sound.append(sample!)
        part += 1
      }
    }
    XCTAssertEqual(group.wait(timeout: .now() + 60), .success, "the clip was written")
    let finished = expectation(description: "clip written")
    writer.finishWriting { finished.fulfill() }
    wait(for: [finished], timeout: 60)
    XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
  }
}
