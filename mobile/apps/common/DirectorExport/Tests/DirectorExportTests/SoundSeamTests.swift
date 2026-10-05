import AudioToolbox
import AVFoundation
import Foundation
import DirectorCore
@testable import DirectorExport
import Testing

/// Sound split across archive segments the way TS Director's segment writer splits it, rendered back
/// into one track.
///
/// A camera's AAC is one continuous stream that the writer cuts at each segment boundary and copies
/// into the files without re-encoding. `AVAssetWriter` gives every such file three copies of its
/// first packet and an edit list that AVFoundation reports as ending 24 ms before the sound it plays.
/// Fixtures encoded by `AVAssetWriter` itself carry an Apple encoder's priming, report their ends
/// truthfully and so cannot show this; these are written as the archive is.
@Suite("Sound across segment seams", .serialized)
struct SoundSeamTests {
  static let rate = 48_000.0
  static let samplesPerPacket = 1_024

  /// A steady 440 Hz tone, `seconds` long, as raw AAC packets and the format they need.
  static func tone(seconds: Double) throws -> (packets: [Data], format: CMAudioFormatDescription) {
    var input = AudioStreamBasicDescription(
      mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
      mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0
    )
    var output = AudioStreamBasicDescription(
      mSampleRate: rate, mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0,
      mBytesPerPacket: 0, mFramesPerPacket: UInt32(samplesPerPacket), mBytesPerFrame: 0,
      mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0
    )
    var made: AudioConverterRef?
    try #require(AudioConverterNew(&input, &output, &made) == noErr)
    let converter = try #require(made)
    defer { AudioConverterDispose(converter) }

    final class Source {
      var samples: [Int16]
      var position = 0
      init(_ samples: [Int16]) { self.samples = samples }
    }
    let count = Int(seconds * rate)
    let source = Source((0..<count).map { Int16(8_000 * sin(Double($0) * 2 * .pi * 440 / rate)) })

    var packets: [Data] = []
    while true {
      var bytes = [UInt8](repeating: 0, count: 4_096)
      var description = AudioStreamPacketDescription()
      var wanted: UInt32 = 1
      let status = bytes.withUnsafeMutableBytes { raw -> OSStatus in
        var list = AudioBufferList(
          mNumberBuffers: 1,
          mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(raw.count), mData: raw.baseAddress)
        )
        return AudioConverterFillComplexBuffer(
          converter,
          { _, packetCount, data, _, user in
            let source = Unmanaged<Source>.fromOpaque(user!).takeUnretainedValue()
            let left = source.samples.count - source.position
            guard left > 0 else {
              packetCount.pointee = 0
              return noErr
            }
            let taken = min(Int(packetCount.pointee), left)
            source.samples.withUnsafeMutableBytes { samples in
              data.pointee.mBuffers.mData = samples.baseAddress!.advanced(by: source.position * 2)
            }
            data.pointee.mBuffers.mDataByteSize = UInt32(taken * 2)
            packetCount.pointee = UInt32(taken)
            source.position += taken
            return noErr
          },
          Unmanaged.passUnretained(source).toOpaque(),
          &wanted,
          &list,
          &description
        )
      }
      guard status == noErr, wanted > 0 else { break }
      packets.append(Data(bytes[0..<Int(description.mDataByteSize)]))
    }

    var cookieSize: UInt32 = 0
    AudioConverterGetPropertyInfo(converter, kAudioConverterCompressionMagicCookie, &cookieSize, nil)
    var cookie = Data(count: Int(cookieSize))
    cookie.withUnsafeMutableBytes { raw in
      _ = AudioConverterGetProperty(converter, kAudioConverterCompressionMagicCookie, &cookieSize, raw.baseAddress!)
    }
    var format: CMAudioFormatDescription?
    cookie.withUnsafeBytes { raw in
      _ = CMAudioFormatDescriptionCreate(
        allocator: nil, asbd: &output, layoutSize: 0, layout: nil,
        magicCookieSize: raw.count, magicCookie: raw.baseAddress, extensions: nil,
        formatDescriptionOut: &format
      )
    }
    return (packets, try #require(format))
  }

  /// `packets` copied into an MP4 as TS Director's segment writer copies a camera's sound: no output
  /// settings, the first packet `lead` seconds into the file and the rest one after another.
  static func segment(
    _ packets: ArraySlice<Data>,
    format: CMAudioFormatDescription,
    lead: Double,
    to url: URL
  ) async throws {
    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: format)
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    #expect(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    let first = CMTimeValue((lead * rate).rounded())
    for (index, packet) in packets.enumerated() {
      var block: CMBlockBuffer?
      CMBlockBufferCreateWithMemoryBlock(
        allocator: nil, memoryBlock: nil, blockLength: packet.count, blockAllocator: nil,
        customBlockSource: nil, offsetToData: 0, dataLength: packet.count,
        flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block
      )
      let data = try #require(block)
      packet.withUnsafeBytes { raw in
        _ = CMBlockBufferReplaceDataBytes(
          with: raw.baseAddress!, blockBuffer: data, offsetIntoDestination: 0, dataLength: packet.count
        )
      }
      var description = AudioStreamPacketDescription(
        mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count)
      )
      var sample: CMSampleBuffer?
      CMAudioSampleBufferCreateReadyWithPacketDescriptions(
        allocator: nil, dataBuffer: data, formatDescription: format, sampleCount: 1,
        presentationTimeStamp: CMTime(
          value: first + CMTimeValue(index * samplesPerPacket),
          timescale: CMTimeScale(rate)
        ),
        packetDescriptions: &description, sampleBufferOut: &sample
      )
      for _ in 0..<2_500 where !input.isReadyForMoreMediaData {
        try await Task.sleep(for: .milliseconds(2))
      }
      #expect(input.append(try #require(sample)))
    }
    input.markAsFinished()
    await writer.finishWriting()
    #expect(writer.status == .completed)
  }

  /// Every sample of `url`'s sound, from the start of the file, mono 16-bit.
  static func samples(of url: URL) async throws -> [Int16] {
    let asset = AVURLAsset(url: url)
    let track = try #require(try await asset.loadTracks(withMediaType: .audio).first)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
      AVSampleRateKey: rate, AVNumberOfChannelsKey: 1
    ])
    reader.add(output)
    #expect(reader.startReading())
    var all: [Int16] = []
    while let buffer = output.copyNextSampleBuffer() {
      let count = CMSampleBufferGetNumSamples(buffer)
      guard count > 0, let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
      let at = Int((CMSampleBufferGetPresentationTimeStamp(buffer).seconds * rate).rounded())
      if at > all.count { all += [Int16](repeating: 0, count: at - all.count) }
      var chunk = [Int16](repeating: 0, count: count)
      _ = chunk.withUnsafeMutableBytes { raw in
        CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count * 2, destination: raw.baseAddress!)
      }
      all += chunk
    }
    return all
  }

  /// Runs of at least `minimum` samples of exact zeros in `samples[range]`, as (start, length).
  static func silentRuns(in samples: [Int16], _ range: Range<Int>, minimum: Int) -> [(Int, Int)] {
    var runs: [(Int, Int)] = []
    var start: Int?
    for index in range {
      if samples[index] == 0 {
        if start == nil { start = index }
      } else if let began = start {
        if index - began >= minimum { runs.append((began, index - began)) }
        start = nil
      }
    }
    if let began = start, range.upperBound - began >= minimum { runs.append((began, range.upperBound - began)) }
    return runs
  }

  @Test("A camera's sound cut into segments renders back without a hole at any seam")
  func segmentedSoundHasNoHoles() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("sound-seams-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    let (packets, format) = try Self.tone(seconds: 12.5)
    // Four segments of slightly different lengths, the way keyframes fall, each with its sound
    // starting a little after its picture.
    let counts = [ 141, 138, 143, 140 ]
    let leads = [ 0.028, 0.018, 0.041, 0.023 ]
    #expect(packets.count >= counts.reduce(0, +))
    let windowStart = WallClock(seconds: 5_000)
    var files: [URL] = []
    var durations: [TimeInterval] = []
    var walls: [WallClock] = []
    var used = 0
    for (index, count) in counts.enumerated() {
      let url = root.appendingPathComponent("seg-\(index).mp4")
      try await Self.segment(packets[used..<(used + count)], format: format, lead: leads[index], to: url)
      // Where this segment's first packet falls in the one continuous stream, less its lead: the
      // segments' sound meets end to end, as the camera sent it.
      let streamAt = 0.5 + Double(used * Self.samplesPerPacket) / Self.rate
      walls.append(windowStart + (streamAt - leads[index]))
      files.append(url)
      used += count
    }
    for index in files.indices {
      let next = index + 1 < walls.count
        ? walls[index + 1] - walls[index]
        : Double(counts[index] * Self.samplesPerPacket) / Self.rate
      durations.append(next)
    }
    let streamEnd = 0.5 + Double(used * Self.samplesPerPacket) / Self.rate
    let length = streamEnd + 0.5

    // The shape the archive has: AVFoundation reports each segment's sound ending before it plays.
    let asset = AVURLAsset(url: files[1])
    let track = try #require(try await asset.loadTracks(withMediaType: .audio).first)
    let reported = try await track.load(.timeRange).end
    let played = try #require(ArchiveRemux.playedEnd(of: track, in: asset, reported: reported))
    #expect(played >= reported)

    let plan = try await ArchiveRemux.place(
      files: files,
      fileDurations: durations,
      startWalls: walls,
      windowStart: windowStart,
      length: length
    )
    let out = root.appendingPathComponent("sound.m4a")
    let rendered = try await ArchiveRemux.renderPlacedSound(
      plan.placements,
      length: CMTime(seconds: length, preferredTimescale: 600),
      to: out,
      progress: nil
    )
    #expect(rendered)

    let sound = try await Self.samples(of: out)
    // From just after the first segment's sound starts to just before the last one's ends: every
    // seam is inside, and a steady tone never holds zero for even a millisecond.
    let from = Int((0.5 + 0.1) * Self.rate)
    let to = min(sound.count, Int((streamEnd - 0.1) * Self.rate))
    let holes = Self.silentRuns(in: sound, from..<to, minimum: 48)
    #expect(
      holes.isEmpty,
      "holes at \(holes.map { String(format: "%.4f s +%.1f ms", Double($0.0) / Self.rate, Double($0.1) / 48) })"
    )
    // And the tone carries on to where the camera's sound ended.
    let tail = Self.silentRuns(in: sound, Int((streamEnd - 0.1) * Self.rate)..<Int((streamEnd - 0.03) * Self.rate), minimum: 48)
    #expect(tail.isEmpty, "the sound stops early: \(tail)")
  }
}
