import AVFoundation
import Foundation
import DirectorExport
import Testing

/// A programme copied from inside its part keeps its sound under the same head as its pictures.
///
/// A window that opens between two key frames keeps the pictures from the key frame before it, for
/// the first one to decode, and an edit list hides them. A reader that applies the edit list sees
/// the window; one that does not, FFmpeg's copy into HLS among them, sees everything the file holds.
/// The sound has to hold the same stretch, or that reader finds pictures with no sound under them:
/// what every phone take uploaded with, its sound starting 0.96 s after its picture.
@Suite("Programme copy from inside the part")
struct ProgrammeCopyHeadTests {
  static let width = 160
  static let height = 120
  static let fps = 30
  static let rate = 48_000.0
  /// One AAC packet, in seconds.
  static let packet = 1_024 / rate
  /// AAC's encoder delay, which the sound may reach back ahead of the pictures.
  static let priming = 2_112 / rate
  /// Where the click in the fixture's sound is, on the part's own timeline.
  static let click = 2.25

  @Test(
    "Cut between key frames, the sound starts with the pictures in the file and with the window when played",
    arguments: [ 0.5, 1.5 ]
  )
  func soundHoldsThePicturesHead(offset: Double) async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-head-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let part = root.appendingPathComponent("program.mp4")
    try await Self.writePart(to: part, seconds: 4)

    let copy = root.appendingPathComponent("copy.mov")
    let length = 2.0
    try await ArchiveRemux.copyProgramme(part: part, offset: offset, length: length, destination: copy)

    let asset = AVURLAsset(url: copy)
    let video = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let audio = try #require(try await asset.loadTracks(withMediaType: .audio).first)

    // Played: the window, both tracks from 0 for its length.
    let pictures = try await video.load(.timeRange)
    let sound = try await audio.load(.timeRange)
    #expect(abs(pictures.start.seconds) < 0.001, "pictures start at \(pictures.start.seconds)")
    #expect(abs(pictures.duration.seconds - length) <= 1.0 / Double(Self.fps) + 0.001, "pictures last \(pictures.duration.seconds)")
    #expect(abs(sound.start.seconds) <= Self.packet, "sound starts at \(sound.start.seconds)")
    // Whole packets: the last one may run past the window by up to two.
    #expect(abs(sound.duration.seconds - length) <= 2 * Self.packet, "sound lasts \(sound.duration.seconds)")
    // In sync: the click is where the part had it, less the offset.
    let heard = try #require(try await Self.firstLoud(in: copy))
    #expect(abs(heard - (Self.click - offset)) <= Self.packet, "click at \(heard), wanted \(Self.click - offset)")

    // In the file: what each track holds ahead of the window, which a reader that ignores the edit
    // list plays first. The pictures' head runs back to the key frame; the sound's must too.
    let pictureHead = try await Self.headSeconds(of: video)
    let soundHead = try await Self.headSeconds(of: audio)
    let keyFrame = offset.rounded(.down)
    #expect(abs(pictureHead - (offset - keyFrame)) <= 1.0 / Double(Self.fps) + 0.001, "picture head \(pictureHead)")
    #expect(soundHead >= pictureHead - Self.packet, "sound head \(soundHead) against picture head \(pictureHead)")
    // At most the decoder's priming and a packet more, and the writer counts the encoder's delay
    // into the sound's edit on top of that.
    #expect(soundHead <= pictureHead + 2 * Self.priming + Self.packet, "sound head \(soundHead) against picture head \(pictureHead)")
  }

  @Test("A copy from the start of the part is the part, cut to the window")
  func copyFromTheStart() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-head-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let part = root.appendingPathComponent("program.mp4")
    try await Self.writePart(to: part, seconds: 3)
    let copy = root.appendingPathComponent("copy.mov")
    try await ArchiveRemux.copyProgramme(part: part, offset: 0, length: nil, destination: copy)
    let heard = try #require(try await Self.firstLoud(in: copy))
    #expect(abs(heard - Self.click) <= Self.packet)
  }

  @Test("A window that runs to the part's end copies every sample from the key frame on, in sync")
  func copyToTheEnd() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-head-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let part = root.appendingPathComponent("program.mp4")
    try await Self.writePart(to: part, seconds: 3)
    let copy = root.appendingPathComponent("copy.mov")
    try await ArchiveRemux.copyProgramme(part: part, offset: 1.5, length: nil, destination: copy)
    let asset = AVURLAsset(url: copy)
    let video = try #require(try await asset.loadTracks(withMediaType: .video).first)
    let pictures = try await video.load(.timeRange)
    #expect(abs(pictures.duration.seconds - 1.5) <= 1.0 / Double(Self.fps) + 0.001, "pictures last \(pictures.duration.seconds)")
    let heard = try #require(try await Self.firstLoud(in: copy))
    #expect(abs(heard - (Self.click - 1.5)) <= Self.packet)
    #expect(abs(try await Self.headSeconds(of: video) - 0.5) <= 1.0 / Double(Self.fps) + 0.001)
  }

  @Test("A part with no pictures is refused rather than copied as sound alone")
  func noPicturesIsRefused() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-head-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let part = root.appendingPathComponent("sound.mp4")
    try await Self.writePart(to: part, seconds: 1, pictures: false)
    await #expect(throws: ArchiveRemux.Error.self) {
      try await ArchiveRemux.copyProgramme(part: part, offset: 0.5, length: nil, destination: root.appendingPathComponent("copy.mov"))
    }
  }

  // MARK: - Fixtures

  /// How long the track's media runs before its first edit begins: the head a reader that ignores
  /// the edit list plays ahead of the window.
  static func headSeconds(of track: AVAssetTrack) async throws -> Double {
    let segments = try await track.load(.segments)
    let first = try #require(segments.first { !$0.isEmpty })
    return first.timeMapping.source.start.seconds
  }

  /// When the click is heard, playing the file as AVFoundation does.
  static func firstLoud(in url: URL) async throws -> Double? {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return nil }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
      AVSampleRateKey: rate,
      AVNumberOfChannelsKey: 1
    ])
    reader.add(output)
    reader.startReading()
    defer { reader.cancelReading() }
    while let sample = output.copyNextSampleBuffer() {
      guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      let start = CMSampleBufferGetPresentationTimeStamp(sample).seconds
      let length = CMBlockBufferGetDataLength(block)
      var values = [Int16](repeating: 0, count: length / 2)
      _ = values.withUnsafeMutableBytes {
        CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!)
      }
      if let index = values.firstIndex(where: { abs(Int($0)) > 4_000 }) {
        return start + Double(index) / rate
      }
    }
    return nil
  }

  /// A part as `ProgramEncoder` writes one: H.264 with a key frame every second and no reordering,
  /// and AAC at 48 kHz, silent but for a click at `click` seconds. Without `pictures`, sound alone.
  static func writePart(to url: URL, seconds: Int, pictures: Bool = true) async throws {
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoMaxKeyFrameIntervalKey: fps,
        AVVideoAllowFrameReorderingKey: false
      ]
    ])
    video.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height
    ])
    let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: rate,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 64_000
    ])
    audio.expectsMediaDataInRealTime = false
    if pictures { writer.add(video) }
    writer.add(audio)
    #expect(writer.startWriting())
    writer.startSession(atSourceTime: .zero)

    var asbd = AudioStreamBasicDescription(
      mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
      mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0
    )
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(
      allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil,
      magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format
    )
    let soundFormat = try #require(format)
    let chunk = 1_024
    let clickAt = Int(click * rate)
    func sound(_ index: Int) -> CMSampleBuffer? {
      let first = index * chunk
      let values = (0 ..< chunk).map { first + $0 >= clickAt && first + $0 < clickAt + 480 ? Int16(20_000) : Int16(0) }
      var block: CMBlockBuffer?
      let bytes = chunk * 2
      CMBlockBufferCreateWithMemoryBlock(
        allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
        customBlockSource: nil, offsetToData: 0, dataLength: bytes,
        flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block
      )
      guard let block else { return nil }
      _ = values.withUnsafeBytes {
        CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes)
      }
      var sample: CMSampleBuffer?
      var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: CMTimeScale(rate)),
        presentationTimeStamp: CMTime(value: CMTimeValue(first), timescale: CMTimeScale(rate)),
        decodeTimeStamp: .invalid
      )
      CMSampleBufferCreateReady(
        allocator: nil, dataBuffer: block, formatDescription: soundFormat,
        sampleCount: chunk, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 1, sampleSizeArray: [ 2 ], sampleBufferOut: &sample
      )
      return sample
    }
    func ready(_ input: AVAssetWriterInput) async throws {
      for _ in 0 ..< 2_500 where !input.isReadyForMoreMediaData {
        try await Task.sleep(for: .milliseconds(2))
      }
      try #require(input.isReadyForMoreMediaData, "writer input never became ready")
    }

    let chunks = Int(Double(seconds) * rate) / chunk
    let frames = pictures ? seconds * fps : 0
    var nextChunk = 0
    func feedSound(through time: Double) async throws {
      while nextChunk < chunks, Double(nextChunk * chunk) / rate <= time {
        try await ready(audio)
        if let sample = sound(nextChunk) { audio.append(sample) }
        nextChunk += 1
        // Until the sound is marked finished the writer waits for more of it, and holds the
        // pictures back.
        if nextChunk == chunks { audio.markAsFinished() }
      }
    }
    for index in 0 ..< frames {
      let time = Double(index) / Double(fps)
      try await feedSound(through: time)
      // A blocked picture input is the writer waiting for sound to get ahead of it: feed it.
      while !video.isReadyForMoreMediaData, nextChunk < chunks, audio.isReadyForMoreMediaData {
        if let sample = sound(nextChunk) { audio.append(sample) }
        nextChunk += 1
        if nextChunk == chunks { audio.markAsFinished() }
      }
      try await ready(video)
      var buffer: CVPixelBuffer?
      CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &buffer)
      guard let buffer else { continue }
      CVPixelBufferLockBaseAddress(buffer, [])
      if let base = CVPixelBufferGetBaseAddress(buffer) {
        memset(base, Int32(index % 200), CVPixelBufferGetBytesPerRow(buffer) * height)
      }
      CVPixelBufferUnlockBaseAddress(buffer, [])
      adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: CMTimeScale(fps)))
    }
    if pictures { video.markAsFinished() }
    try await feedSound(through: .infinity)
    await writer.finishWriting()
    #expect(writer.status == .completed, "fixture: \(String(describing: writer.error))")
  }
}
