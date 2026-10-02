import AVFoundation
import CombinedVideo
import CoreGraphics
import DistributorWire
import Foundation
import Testing

@Suite("Combined video", .serialized)
struct CombinedRendererTests {
  /// A flat-coloured movie with no sound. Sound comes from its own file (`silence`): one writer fed
  /// all its pictures before any sound waits forever for the sound to catch up.
  static func movie(at url: URL, rgb: (UInt8, UInt8, UInt8), seconds: Double = 2) async throws {
    try await write(at: url, rgb: rgb, seconds: seconds, withSound: false)
  }

  /// `seconds` of silence as AAC, standing in for the chosen camera's sound.
  static func silence(at url: URL, seconds: Double = 2) async throws {
    try await write(at: url, rgb: nil, seconds: seconds, withSound: true)
  }

  private static func write(at url: URL, rgb: (UInt8, UInt8, UInt8)?, seconds: Double, withSound: Bool) async throws {
    let width = 320
    let height = 180
    let writer = try AVAssetWriter(outputURL: url, fileType: rgb == nil ? .m4a : .mp4)
    var video: AVAssetWriterInput?
    var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    if rgb != nil {
      let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height
      ])
      input.expectsMediaDataInRealTime = false
      adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height
      ])
      writer.add(input)
      video = input
    }
    var sound: AVAssetWriterInput?
    if withSound {
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000
      ])
      input.expectsMediaDataInRealTime = false
      writer.add(input)
      sound = input
    }
    #expect(writer.startWriting())
    writer.startSession(atSourceTime: .zero)

    let frames = (video == nil || rgb == nil) ? 0 : Int(seconds * 30)
    let rgb = rgb ?? (0, 0, 0)
    for index in 0..<frames {
      guard let video, let adaptor else { break }
      while !video.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(2)) }
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &buffer)
      guard let buffer else { continue }
      CVPixelBufferLockBaseAddress(buffer, [])
      if let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) {
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        for row in 0..<height {
          for column in 0..<width {
            let pixel = base + row * stride + column * 4
            pixel[0] = rgb.2
            pixel[1] = rgb.1
            pixel[2] = rgb.0
            pixel[3] = 255
          }
        }
      }
      CVPixelBufferUnlockBaseAddress(buffer, [])
      adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
    }
    video?.markAsFinished()

    if let sound {
      var format: CMAudioFormatDescription?
      var asbd = AudioStreamBasicDescription(
        mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1,
        mBitsPerChannel: 16, mReserved: 0
      )
      CMAudioFormatDescriptionCreate(
        allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil,
        magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format
      )
      let chunk = 4_800
      var written = 0
      while written < Int(seconds * 48_000), let format {
        while !sound.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(2)) }
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(
          allocator: nil, memoryBlock: nil, blockLength: chunk * 2, blockAllocator: nil,
          customBlockSource: nil, offsetToData: 0, dataLength: chunk * 2,
          flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block
        )
        guard let block else { break }
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: chunk * 2)
        var sample: CMSampleBuffer?
        var timing = CMSampleTimingInfo(
          duration: CMTime(value: 1, timescale: 48_000),
          presentationTimeStamp: CMTime(value: CMTimeValue(written), timescale: 48_000),
          decodeTimeStamp: .invalid
        )
        var size = 2
        CMSampleBufferCreateReady(
          allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: chunk,
          sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1,
          sampleSizeArray: &size, sampleBufferOut: &sample
        )
        if let sample { sound.append(sample) }
        written += chunk
      }
      sound.markAsFinished()
    }
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in writer.finishWriting { c.resume() } }
  }

  /// The colour at `point` of the frame one second in.
  static func colour(in url: URL, at point: CGPoint) async throws -> (Int, Int, Int) {
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    let image = try await generator.image(at: CMTime(seconds: 1, preferredTimescale: 600)).image
    var pixel = [UInt8](repeating: 0, count: 4)
    let context = CGContext(
      data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )!
    // CoreGraphics draws from the bottom up; the canvas point is from the top down.
    context.draw(image, in: CGRect(x: -point.x, y: point.y - CGFloat(image.height) + 1, width: CGFloat(image.width), height: CGFloat(image.height)))
    return (Int(pixel[0]), Int(pixel[1]), Int(pixel[2]))
  }

  static func isNear(_ colour: (Int, Int, Int), _ expected: (Int, Int, Int)) -> Bool {
    abs(colour.0 - expected.0) < 48 && abs(colour.1 - expected.1) < 48 && abs(colour.2 - expected.2) < 48
  }

  private func temporaryRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("combined-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  @Test("Four cameras land in their quadrants, as HEVC, with the chosen camera's sound")
  func fourCameras() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let colours: [(String, (UInt8, UInt8, UInt8))] = [
      ("red", (220, 30, 30)), ("green", (30, 200, 30)), ("blue", (30, 30, 220)), ("white", (230, 230, 230))
    ]
    var urls: [String: URL] = [:]
    for (name, rgb) in colours {
      let url = root.appendingPathComponent("\(name).mp4")
      try await Self.movie(at: url, rgb: rgb)
      urls[name] = url
    }
    let greenSound = root.appendingPathComponent("green-sound.m4a")
    try await Self.silence(at: greenSound)
    let canvas = CGSize(width: 640, height: 360)
    let assignment: [String: Quadrant] = [ "red": .topLeading, "green": .topTrailing, "blue": .bottomLeading, "white": .bottomTrailing ]
    let frames = CombinedGeometry.frames(assignment: assignment, solo: nil, canvas: canvas)
    let output = root.appendingPathComponent("combined.mov")
    try await CombinedRenderer.render(
      inputs: colours.map { CombinedInput(camera: $0.0, url: urls[$0.0]!, frame: frames[$0.0]!) },
      audioFrom: greenSound,
      canvas: canvas,
      bitsPerSecond: CombinedLayoutRules.bitsPerSecond(cameraCount: 4) / 36,
      to: output
    )

    #expect(Self.isNear(try await Self.colour(in: output, at: CGPoint(x: 160, y: 90)), (220, 30, 30)))
    #expect(Self.isNear(try await Self.colour(in: output, at: CGPoint(x: 480, y: 90)), (30, 200, 30)))
    #expect(Self.isNear(try await Self.colour(in: output, at: CGPoint(x: 160, y: 270)), (30, 30, 220)))
    #expect(Self.isNear(try await Self.colour(in: output, at: CGPoint(x: 480, y: 270)), (230, 230, 230)))

    let asset = AVURLAsset(url: output)
    let video = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let format = try #require(try await video.load(.formatDescriptions).first)
    #expect(CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_HEVC)
    #expect(try await video.load(.naturalSize) == canvas)
    #expect(try await asset.loadTracks(withMediaType: .audio).count == 1)
    #expect(abs(try await asset.load(.duration).seconds - 2) < 0.1)
  }

  @Test("Three cameras: the solo sits where it was slid, the empty space stays black, no sound unless chosen")
  func threeCamerasWithSolo() async throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let colours: [(String, (UInt8, UInt8, UInt8))] = [ ("red", (220, 30, 30)), ("green", (30, 200, 30)), ("blue", (30, 30, 220)) ]
    var urls: [String: URL] = [:]
    for (name, rgb) in colours {
      let url = root.appendingPathComponent("\(name).mp4")
      try await Self.movie(at: url, rgb: rgb)
      urls[name] = url
    }
    // Two on the left; blue alone on the right, slid to the vertical centre.
    let canvas = CGSize(width: 640, height: 360)
    let assignment: [String: Quadrant] = [ "red": .topLeading, "green": .bottomLeading, "blue": .topTrailing ]
    let frames = CombinedGeometry.frames(
      assignment: assignment,
      solo: SoloPlacement(camera: "blue", axis: .vertical, position: 0.5),
      canvas: canvas
    )
    let output = root.appendingPathComponent("combined.mov")
    try await CombinedRenderer.render(
      inputs: colours.map { CombinedInput(camera: $0.0, url: urls[$0.0]!, frame: frames[$0.0]!) },
      audioFrom: nil,
      canvas: canvas,
      bitsPerSecond: CombinedLayoutRules.bitsPerSecond(cameraCount: 3) / 36,
      to: output
    )

    #expect(Self.isNear(try await Self.colour(in: output, at: CGPoint(x: 480, y: 180)), (30, 30, 220)))
    #expect(Self.isNear(try await Self.colour(in: output, at: CGPoint(x: 480, y: 30)), (0, 0, 0)))
    #expect(Self.isNear(try await Self.colour(in: output, at: CGPoint(x: 480, y: 340)), (0, 0, 0)))
    #expect(Self.isNear(try await Self.colour(in: output, at: CGPoint(x: 160, y: 270)), (30, 200, 30)))
    #expect(try await AVURLAsset(url: output).loadTracks(withMediaType: .audio).isEmpty)
  }
}
