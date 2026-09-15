import AVFoundation
import CoreGraphics
import Foundation
import DirectorCore
import DirectorExport
import DirectorSources
import Testing

/// End-to-end proof that a segment lands where it happened.
///
/// Two real MP4s are encoded with a `FrameMarker` painted into every frame, indexed thirteen
/// seconds apart with only three seconds of tape in each, remuxed, and then decoded back. Reading
/// the marker out of the exported picture is the only check that cannot be satisfied by bookkeeping:
/// it says which frame is actually at a given moment of the file.
@Suite("Wall-clock placement", .serialized)
struct WallClockPlacementTests {
  private static let width = 800
  private static let height = 120
  private static let fps = 30.0

  /// `spacing` is the time between frames, which a runaway clock stretches far past the frame rate.
  private func markedMovie(
    at url: URL,
    firstValue: Int,
    frames: Int,
    spacing: Double = 1 / fps
  ) async throws {
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: Self.width,
        AVVideoHeightKey: Self.height
      ]
    )
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: Self.width,
        kCVPixelBufferHeightKey as String: Self.height
      ]
    )
    writer.add(input)
    #expect(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    for index in 0..<frames {
      while !input.isReadyForMoreMediaData {
        try await Task.sleep(for: .milliseconds(2))
      }
      guard let buffer = Self.paint(value: firstValue + index) else { continue }
      adaptor.append(
        buffer,
        withPresentationTime: CMTime(seconds: Double(index) * spacing, preferredTimescale: 600)
      )
    }
    input.markAsFinished()
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      writer.finishWriting { c.resume() }
    }
  }

  /// Same as `markedMovie` but with an audio track, because a real archive has one and the
  /// composition treats video and audio differently once a gap has to be filled.
  ///
  /// `audioLead` starts the sound that long after the first picture and `audioOverrun` runs it that
  /// long past the last, which is the shape a camera segment really has: its sound begins and ends a
  /// few tens of milliseconds after its picture does.
  private func markedMovieWithAudio(
    at url: URL,
    firstValue: Int,
    frames: Int,
    audioLead: Double = 0,
    audioOverrun: Double = 0
  ) async throws {
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let video = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: Self.width,
        AVVideoHeightKey: Self.height
      ]
    )
    video.expectsMediaDataInRealTime = false
    let audio = AVAssetWriterInput(
      mediaType: .audio,
      outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 64_000
      ]
    )
    audio.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: video,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: Self.width,
        kCVPixelBufferHeightKey as String: Self.height
      ]
    )
    writer.add(video)
    writer.add(audio)
    #expect(writer.startWriting())
    writer.startSession(atSourceTime: .zero)

    // Silence, at the same length as the picture.
    let samplesPerChunk = 1_024
    let chunks = max(
      1,
      Int(((Double(frames) / Self.fps + audioOverrun - audioLead) * 44_100) / Double(samplesPerChunk))
    )
    let leadSamples = CMTimeValue((audioLead * 44_100).rounded())
    var asbd = AudioStreamBasicDescription(
      mSampleRate: 44_100, mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
      mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0
    )
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(
      allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil,
      magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format
    )
    let audioFormat = try #require(format)

    func silence(chunk: Int) -> CMSampleBuffer? {
      var block: CMBlockBuffer?
      let bytes = samplesPerChunk * 2
      CMBlockBufferCreateWithMemoryBlock(
        allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
        customBlockSource: nil, offsetToData: 0, dataLength: bytes,
        flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block
      )
      guard let block else { return nil }
      CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes)
      var sample: CMSampleBuffer?
      var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: 44_100),
        presentationTimeStamp: CMTime(
          value: leadSamples + CMTimeValue(chunk * samplesPerChunk),
          timescale: 44_100
        ),
        decodeTimeStamp: .invalid
      )
      CMSampleBufferCreateReady(
        allocator: nil, dataBuffer: block, formatDescription: audioFormat,
        sampleCount: samplesPerChunk, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 1, sampleSizeArray: [ 2 ], sampleBufferOut: &sample
      )
      return sample
    }

    // Waits for an input, and fails the fixture rather than appending to one that is not ready:
    // appending anyway throws an Objective-C exception that takes the whole test process down.
    func ready(_ input: AVAssetWriterInput) async throws {
      for _ in 0..<2_500 where !input.isReadyForMoreMediaData {
        try await Task.sleep(for: .milliseconds(2))
      }
      try #require(input.isReadyForMoreMediaData, "writer input never became ready")
    }

    // Picture and sound interleaved by time. Writing all the picture first stalls it: a writer with
    // two inputs stops taking video until the audio has caught up, and then some.
    var nextChunk = 0
    for index in 0..<frames {
      let time = Double(index) / Self.fps
      while nextChunk < chunks, audioLead + Double(nextChunk * samplesPerChunk) / 44_100 <= time {
        try await ready(audio)
        if let sample = silence(chunk: nextChunk) { audio.append(sample) }
        nextChunk += 1
        if nextChunk == chunks { audio.markAsFinished() }
      }
      // A blocked picture input is the writer waiting for sound to get ahead of it: feed it.
      while !video.isReadyForMoreMediaData, nextChunk < chunks, audio.isReadyForMoreMediaData {
        if let sample = silence(chunk: nextChunk) { audio.append(sample) }
        nextChunk += 1
        // Until the sound is marked finished the writer keeps waiting for more of it, and the
        // last second of picture never goes in.
        if nextChunk == chunks { audio.markAsFinished() }
      }
      try await ready(video)
      guard let buffer = Self.paint(value: firstValue + index) else { continue }
      adaptor.append(buffer, withPresentationTime: CMTime(seconds: time, preferredTimescale: 600))
    }
    video.markAsFinished()
    while nextChunk < chunks {
      try await ready(audio)
      if let sample = silence(chunk: nextChunk) { audio.append(sample) }
      nextChunk += 1
      if nextChunk == chunks { audio.markAsFinished() }
    }
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      writer.finishWriting { c.resume() }
    }
  }

  private static func paint(value: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(
      nil, width, height, kCVPixelFormatType_32BGRA,
      [ kCVPixelBufferCGImageCompatibilityKey: true ] as CFDictionary,
      &buffer
    )
    guard let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let context = CGContext(
      data: CVPixelBufferGetBaseAddress(buffer),
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else { return nil }
    // CoreGraphics is bottom-left; the buffer is top-down, which is what FrameMarker.read walks.
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)
    context.setFillColor(gray: 0.5, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    FrameMarker.draw(value: value, in: context)
    return buffer
  }

  /// Reads the marker out of the exported file at `seconds`, or nil where nothing was written.
  ///
  /// Decoded straight into BGRA at the file's own size with `AVAssetReader`, rather than going
  /// through `AVAssetImageGenerator`. The generator hands back a `CGImage`, and redrawing that into
  /// a buffer loses the marker — the cells are read at fixed pixel coordinates, so any resampling
  /// on the way through is fatal to them. This is also closer to what a verifier has to do.
  private func marker(in url: URL, at seconds: Double) async throws -> Int? {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { return nil }
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(
      start: CMTime(seconds: seconds, preferredTimescale: 600),
      duration: CMTime(seconds: 0.5, preferredTimescale: 600)
    )
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
      ]
    )
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }
    defer { reader.cancelReading() }
    while let sample = output.copyNextSampleBuffer() {
      guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
      if let value = FrameMarker.read(from: buffer) { return value }
    }
    return nil
  }

  @Test("The painter and the reader agree before any encoding is involved")
  func markerRoundTripsInMemory() throws {
    let buffer = try #require(Self.paint(value: 1_030))
    #expect(FrameMarker.read(from: buffer) == 1_030)
  }

  @Test("A segment after a dropout is exported where it happened, not where the tape ran to")
  func placesAfterGap() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("place-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    // Three seconds each, thirteen seconds apart: a ten-second dropout in the middle.
    try await markedMovie(at: first, firstValue: 1_000, frames: 90)
    try await markedMovie(at: second, firstValue: 500_000, frames: 90)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: [ first, second ],
      fileDurations: [ 3, 3 ],
      targetDuration: 16,
      startWalls: [ WallClock(seconds: 1_000), WallClock(seconds: 1_013) ],
      windowStart: WallClock(seconds: 1_000),
      destination: out
    )

    let duration = try await AVURLAsset(url: out).load(.duration).seconds
    // Sixteen seconds of wall clock, not the six seconds of tape it contains.
    #expect(abs(duration - 16) < 0.35)

    // One second in: the first segment, thirty frames past its start.
    let early = try await marker(in: out, at: 1.0)
    #expect(early != nil)
    #expect(abs((early ?? 0) - 1_030) <= 2)

    // Thirteen and a half seconds in: the second segment, which happened then. Before this fix it
    // sat at three seconds, ten seconds early, and every later frame with it.
    let late = try await marker(in: out, at: 13.5)
    #expect(late != nil)
    let expected = (500_000 + 15) & FrameMarker.maximumValue
    #expect(abs((late ?? 0) - expected) <= 2)
  }

  /// A gap holds the picture that was there before it.
  ///
  /// Placement alone leaves a real gap as an empty range, and an empty range has no samples at all —
  /// measured, every probe across the hole decoded nothing. So the freeze is manufactured: the last
  /// frame before the gap is inserted once and scaled to the length of the hole, which a passthrough
  /// export honours. One sample, not one per frame, so a 150 s dropout costs a single insertion.
  @Test("A gap holds the last frame before it, all the way across")
  func gapHoldsLastFrame() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("gapc-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    try await markedMovie(at: first, firstValue: 1_000, frames: 90)
    try await markedMovie(at: second, firstValue: 500_000, frames: 90)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: [ first, second ],
      fileDurations: [ 3, 3 ],
      targetDuration: 16,
      startWalls: [ WallClock(seconds: 1_000), WallClock(seconds: 1_013) ],
      windowStart: WallClock(seconds: 1_000),
      destination: out
    )

    let lastBeforeGap = (1_000 + 89) & FrameMarker.maximumValue
    // Sampled right after the gap opens, in its middle, and just before it closes: a hold that only
    // covered part of the hole would pass a single probe in the middle.
    for instant in [ 3.5, 8.0, 12.5 ] {
      let value = try await marker(in: out, at: instant)
      #expect(value != nil, "nothing at \(instant)s — the gap is empty, not held")
      #expect(abs((value ?? 0) - lastBeforeGap) <= 2, "wrong picture held at \(instant)s")
    }

    // The hold must not run over the segment that follows it.
    let after = try await marker(in: out, at: 14.5)
    #expect(abs((after ?? 0) - ((500_000 + 45) & FrameMarker.maximumValue)) <= 2)
  }

  /// rec-411's home camera after its outage: segments each holding six real pictures, a fifth of a
  /// second of the game at 30 fps, stamped half a second apart so every file claims three seconds.
  /// Their starts are right, so each has only the fifth of a second before the next.
  @Test("A segment stamped on a runaway clock plays every picture it holds, in the room it had")
  func runawaySegmentsAreSqueezedIntoTheirRoom() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("runaway-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let before = root.appendingPathComponent("before.mp4")
    try await markedMovie(at: before, firstValue: 1_000, frames: 90)
    var files = [ before ]
    var walls = [ WallClock(seconds: 1_000) ]
    for index in 0 ..< 5 {
      let runaway = root.appendingPathComponent("runaway-\(index).mp4")
      try await markedMovie(at: runaway, firstValue: 2_000 + 6 * index, frames: 6, spacing: 0.5)
      files.append(runaway)
      walls.append(WallClock(seconds: 1_003 + 0.2 * Double(index)))
    }
    let after = root.appendingPathComponent("after.mp4")
    try await markedMovie(at: after, firstValue: 500_000, frames: 90)
    files.append(after)
    walls.append(WallClock(seconds: 1_004))

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: files,
      fileDurations: [ 3, 3, 3, 3, 3, 3, 3 ],
      targetDuration: 7,
      startWalls: walls,
      windowStart: WallClock(seconds: 1_000),
      destination: out
    )

    // Mid-way through each segment's room: its fourth picture. Cut to its room instead, every
    // probe here reads the segment's first.
    for index in 0 ..< 5 {
      let instant = 3 + 0.2 * Double(index) + 3.5 / Self.fps
      let value = try await marker(in: out, at: instant)
      #expect(value != nil, "nothing at \(instant)s")
      #expect(abs((value ?? 0) - (2_000 + 6 * index + 3)) <= 1, "wrong picture at \(instant)s")
    }

    // The segment after them is still where it happened.
    let late = try await marker(in: out, at: 4.5)
    #expect(abs((late ?? 0) - ((500_000 + 15) & FrameMarker.maximumValue)) <= 2)
    let video = try #require(try await AVURLAsset(url: out).loadTracks(withMediaType: .video).first)
    #expect(abs(try await video.load(.timeRange).duration.seconds - 7) < 0.05)
  }

  /// The shape of a real archive: audio alongside the picture, and more than one gap.
  ///
  /// A stress run on the device produced an export with **two** video tracks of identical format,
  /// the second starting partway in, plus an audio track shorter than either and a container longer
  /// than the recording. Only the camera that stopped -- the one that got a hold -- came out that
  /// way. This is that case, in the small.
  @Test("Holding a gap leaves one video track and one audio track, not several")
  func holdKeepsTrackCountAtOne() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("tracks-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    var files: [URL] = []
    for index in 0..<3 {
      let url = root.appendingPathComponent("s\(index).mp4")
      try await markedMovieWithAudio(at: url, firstValue: 1_000 + index * 1_000, frames: 90)
      files.append(url)
    }

    let out = root.appendingPathComponent("out.mp4")
    // Segments whose recorded length runs past where the next one starts. This is what a camera
    // that misdeclares its frame rate actually writes -- measured at 26 overruns in 986 segments,
    // the worst 104 ms -- and placing them at their true starts makes the ranges overlap.
    try await ArchiveRemux.concatenate(
      files: files,
      fileDurations: [ 3, 3, 3 ],
      targetDuration: 30,
      startWalls: [
        WallClock(seconds: 1_000),
        WallClock(seconds: 1_002.6),
        WallClock(seconds: 1_005.1)
      ],
      windowStart: WallClock(seconds: 1_000),
      destination: out
    )

    let asset = AVURLAsset(url: out)
    let videoTracks = try await asset.loadTracks(withMediaType: .video)
    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    #expect(videoTracks.count == 1, "expected one video track, got \(videoTracks.count)")
    #expect(audioTracks.count <= 1, "expected at most one audio track, got \(audioTracks.count)")

    let container = try await asset.load(.duration).seconds
    #expect(abs(container - 30) < 0.5, "container ran to \(container)s against a 30s window")
    for track in videoTracks {
      let span = try await track.load(.timeRange)
      #expect(abs(span.end.seconds - container) < 0.5, "video track ends at \(span.end.seconds)")
    }
  }

  /// A camera segment's sound starts after its first picture and runs past its last, and the next
  /// segment's sound picks up where this one's left off. Cut to the picture's range, every seam lost
  /// the overrun and left a hole: rec-409's Pixel export had 2,334 of them, 288 s of recorded sound.
  @Test("Sound comes out as one piece the length of the window, with no seams to open")
  func soundCrossesSeamsWithoutHoles() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("seams-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    var files: [URL] = []
    for index in 0..<3 {
      let url = root.appendingPathComponent("s\(index).mp4")
      try await markedMovieWithAudio(
        at: url,
        firstValue: 1_000 + index * 1_000,
        frames: 90,
        audioLead: 0.06,
        audioOverrun: 0.12
      )
      files.append(url)
    }

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: files,
      fileDurations: [ 3, 3, 3 ],
      targetDuration: 9,
      startWalls: [ WallClock(seconds: 1_000), WallClock(seconds: 1_003), WallClock(seconds: 1_006) ],
      windowStart: WallClock(seconds: 1_000),
      destination: out
    )

    let asset = AVURLAsset(url: out)
    // One rendered piece of sound, the whole window long: nothing for an exporter to split or slide.
    let audio = try #require(try await asset.loadTracks(withMediaType: .audio).first)
    let segments = try await audio.load(.segments)
    #expect(segments.count == 1 && segments.first?.isEmpty == false, "sound in \(segments.count) pieces")
    let span = try await audio.load(.timeRange)
    #expect(abs(span.start.seconds) < 0.03, "sound starts at \(span.start.seconds) s")
    #expect(abs(span.end.seconds - 9) < 0.05, "sound ends at \(span.end.seconds) s")
    let video = try #require(try await asset.loadTracks(withMediaType: .video).first)
    #expect(abs(try await video.load(.timeRange).end.seconds - 9) < 0.05)
  }

  @Test("A camera that stops early holds its last frame to the end of the window")
  func tailHoldsLastFrame() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("tail-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let only = root.appendingPathComponent("a.mp4")
    try await markedMovie(at: only, firstValue: 7_000, frames: 90)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: [ only ],
      fileDurations: [ 3 ],
      targetDuration: 10,
      startWalls: [ WallClock(seconds: 2_000) ],
      windowStart: WallClock(seconds: 2_000),
      destination: out
    )

    let duration = try await AVURLAsset(url: out).load(.duration).seconds
    #expect(abs(duration - 10) < 0.35)
    // Seven seconds of tail the camera never covered, holding its last picture rather than going
    // black — the same answer a mid-take dropout gets.
    let value = try await marker(in: out, at: 8.0)
    #expect(value != nil)
    #expect(abs((value ?? 0) - ((7_000 + 89) & FrameMarker.maximumValue)) <= 2)
  }

  @Test("A programme part whose sound outlasts its picture holds its last frame to the end of the window")
  func programmeTailHoldsFromTheLastFrame() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("programme-tail-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    // Three seconds of picture with sound running 0.3 s past it, the shape a programme master has.
    // It starts half a second before the window, and like a programme part it declares no length.
    let part = root.appendingPathComponent("program.mp4")
    try await markedMovieWithAudio(at: part, firstValue: 9_000, frames: 90, audioOverrun: 0.3)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: [ part ],
      fileDurations: [ 0 ],
      targetDuration: 4,
      startWalls: [ WallClock(seconds: 1_999.5) ],
      windowStart: WallClock(seconds: 2_000),
      destination: out
    )

    let video = try #require(try await AVURLAsset(url: out).loadTracks(withMediaType: .video).first)
    // The picture covers the whole window, held from its last frame with no hole before the hold.
    #expect(abs(try await video.load(.timeRange).duration.seconds - 4) < 0.02)
    #expect(!(try await video.load(.segments)).contains { $0.isEmpty })
    let value = try await marker(in: out, at: 3.3)
    #expect(value != nil)
    #expect(abs((value ?? 0) - ((9_000 + 89) & FrameMarker.maximumValue)) <= 2)
  }

  @Test("The sound comes out as long as the window, to within a few milliseconds")
  func soundReachesTheEndOfTheWindow() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("sound-tail-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let part = root.appendingPathComponent("program.mp4")
    try await markedMovieWithAudio(at: part, firstValue: 11_000, frames: 90, audioOverrun: 0.3)

    let out = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.concatenate(
      files: [ part ],
      fileDurations: [ 0 ],
      targetDuration: 4,
      startWalls: [ WallClock(seconds: 1_999.5) ],
      windowStart: WallClock(seconds: 2_000),
      destination: out
    )

    let sound = try #require(try await AVURLAsset(url: out).loadTracks(withMediaType: .audio).first)
    let length = try await sound.load(.timeRange).duration.seconds
    #expect(abs(length - 4) < 0.005, "sound is \(length) s against a 4 s window")
  }

  @Test("Two cameras that dropped out differently still line up with each other")
  func anglesAgreeAcrossDifferentGaps() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("pair-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    // Camera A loses the middle; camera B runs clean but joins two seconds late.
    let a1 = root.appendingPathComponent("a1.mp4")
    let a2 = root.appendingPathComponent("a2.mp4")
    let b1 = root.appendingPathComponent("b1.mp4")
    try await markedMovie(at: a1, firstValue: 10_000, frames: 90)
    try await markedMovie(at: a2, firstValue: 20_000, frames: 90)
    try await markedMovie(at: b1, firstValue: 30_000, frames: 90)

    let outA = root.appendingPathComponent("outA.mp4")
    let outB = root.appendingPathComponent("outB.mp4")
    try await ArchiveRemux.concatenate(
      files: [ a1, a2 ],
      fileDurations: [ 3, 3 ],
      targetDuration: 16,
      startWalls: [ WallClock(seconds: 1_000), WallClock(seconds: 1_013) ],
      windowStart: WallClock(seconds: 1_000),
      destination: outA
    )
    try await ArchiveRemux.concatenate(
      files: [ b1 ],
      fileDurations: [ 3 ],
      targetDuration: 16,
      startWalls: [ WallClock(seconds: 1_013) ],
      windowStart: WallClock(seconds: 1_000),
      destination: outB
    )

    let durationA = try await AVURLAsset(url: outA).load(.duration).seconds
    let durationB = try await AVURLAsset(url: outB).load(.duration).seconds
    // Same length whatever each camera lost — which is what lets them be played side by side.
    #expect(abs(durationA - durationB) < 0.35)

    // And at the same instant, both are showing the frame they captured then.
    let atA = try await marker(in: outA, at: 13.5)
    let atB = try await marker(in: outB, at: 13.5)
    #expect(atA != nil)
    #expect(atB != nil)
    #expect(abs((atA ?? 0) - ((20_000 + 15) & FrameMarker.maximumValue)) <= 2)
    #expect(abs((atB ?? 0) - ((30_000 + 15) & FrameMarker.maximumValue)) <= 2)
  }
}
