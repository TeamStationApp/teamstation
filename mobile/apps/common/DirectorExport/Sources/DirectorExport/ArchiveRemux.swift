import AVFoundation
import Foundation
import DirectorCore

/// Builds export files out of archive pieces placed on the wall clock.
///
/// A camera's export is re-encoded at a fixed frame rate (see `stitch`), with its sound rendered as
/// one continuous track and joined to the pictures without re-encoding either. A programme master
/// that is unbroken is copied as it is (see `copyProgramme`); one that is not goes through `stitch`
/// like a camera.
public enum ArchiveRemux {
  public enum Error: Swift.Error, CustomStringConvertible {
    case empty
    case exportFailed(String)

    public var description: String {
      switch self {
      case .empty: "no files to remux"
      case let .exportFailed(reason): "remux failed: \(reason)"
      }
    }
  }

  // MARK: - Placement

  /// Where one archive file's pictures and sound go on the output.
  struct Placement {
    var file: URL
    /// Held so the tracks stay usable: an `AVAssetTrack` does not keep its asset alive.
    var asset: AVURLAsset
    /// Nil for a file that holds sound and no picture.
    var video: AVAssetTrack?
    /// Where the kept stretch starts on the file's own timeline: what precedes the window is cut.
    var start: CMTime
    /// How much of the file from `start` is used.
    var taken: CMTime
    /// Where `start` goes on the output.
    var at: CMTime
    /// How long the stretch lasts on the output: `taken`, unless the file was squeezed into its room.
    var use: CMTime

    /// Where a picture presented at `time` on the file's own timeline falls on the output, in seconds.
    /// A squeezed file's pictures are spaced out over its room at the pace they were taken.
    func outputSeconds(of time: CMTime) -> Double {
      let scale = taken.seconds > 0 ? use.seconds / taken.seconds : 1
      return at.seconds + (time.seconds - start.seconds) * scale
    }

    /// The end of the stretch on the file's own timeline. Pictures from here on belong to whatever
    /// follows.
    var end: CMTime { CMTimeAdd(start, taken) }
  }

  /// Every readable file's place, and where the last one ends.
  struct PlacementPlan {
    var placements: [Placement]
    var end: CMTime
  }

  /// Places each file where it happened.
  ///
  /// With a wall clock per file and a window to measure from, a segment goes where it happened --
  /// `startWall - windowStart` -- rather than at the running total of everything before it. The two
  /// agree only while a source delivered without interruption; the moment it dropped out, a running
  /// cursor pulls every later frame earlier by the length of the gap, and the file comes out short by
  /// the same amount. That was R2: a camera that lost 150 s exported 150 s early from then on, and no
  /// two angles agreed after their first gap.
  ///
  /// Without start walls the files are laid end to end from the start of the output, which is all a
  /// programme recorded before anchors existed can have.
  ///
  /// A part the writer never finalised has no movie header, so loading it throws. Letting that escape
  /// aborted the whole export with AVFoundation's damaged-media error: one programme was a
  /// readable master plus a short continuation stub, left behind when a recovery writer died two
  /// seconds after opening it, and the stub failed the export for all of it. An unreadable piece is
  /// skipped so the readable ones still come out; only when nothing is readable does this throw, and
  /// then it names the pieces.
  static func place(
    files: [URL],
    fileDurations: [TimeInterval],
    startWalls: [WallClock],
    windowStart: WallClock?,
    length: TimeInterval?
  ) async throws -> PlacementPlan {
    let placed = !startWalls.isEmpty && startWalls.count == files.count && windowStart != nil
    let origin = windowStart ?? WallClock(seconds: 0)
    var placements: [Placement] = []
    var cursor = CMTime.zero
    var skipped: [String] = []
    for (index, file) in files.enumerated() {
      let asset = AVURLAsset(url: file)
      do {
        let duration: CMTime
        if index < fileDurations.count, fileDurations[index] > 0 {
          duration = CMTime(seconds: fileDurations[index], preferredTimescale: 600)
        } else {
          duration = try await playableDuration(of: asset)
        }
        guard duration.seconds > 0.05 else { continue }
        // A segment is trimmed by however much of it precedes the window, which is a per-file
        // question and not only the first file's.
        let wantedTrim = placed ? max(0, origin - startWalls[index]) : 0
        let trim = min(wantedTrim, max(0, duration.seconds - 0.05))
        let start = CMTime(seconds: trim, preferredTimescale: 600)
        let kept = CMTimeSubtract(duration, start)
        guard kept.seconds > 0.05 else { continue }
        let at: CMTime = placed
          ? CMTime(seconds: max(0, (startWalls[index] + trim) - origin), preferredTimescale: 600)
          : cursor
        var use = kept
        if let length {
          let remaining = length - at.seconds
          if remaining <= 0.001 { if placed { continue } else { break } }
          if kept.seconds > remaining {
            use = CMTime(seconds: remaining, preferredTimescale: 600)
          }
        }
        // A segment may not run into the one after it.
        //
        // A recorded duration is what the writer measured, and it is occasionally a little longer
        // than the distance to the next segment's own start -- measured on a camera that misdeclares
        // its frame rate, 26 of 986 segments overran, the worst by 104 ms. Trimming the overrun costs
        // a few milliseconds of tape that the next segment is about to show anyway.
        //
        // A segment that claims far more than its room was stamped on a runaway clock instead, and it
        // is squeezed into the room whole rather than cut to its head: see `runawayRatio`.
        var squeezed = false
        if placed, index + 1 < startWalls.count {
          let nextAt = max(0, startWalls[index + 1] - origin)
          let room = nextAt - at.seconds
          if room > 0.001, use.seconds > room {
            squeezed = use.seconds > room * Self.runawayRatio
            use = CMTime(seconds: room, preferredTimescale: 600)
          }
        }
        guard use.seconds > 0.001 else { continue }
        let video = try await asset.loadTracks(withMediaType: .video).first
        placements.append(Placement(
          file: file,
          asset: asset,
          video: video,
          start: start,
          taken: squeezed ? kept : use,
          at: at,
          use: use
        ))
        cursor = CMTimeMaximum(cursor, CMTimeAdd(at, use))
      } catch {
        skipped.append(file.lastPathComponent)
      }
    }
    if placements.isEmpty, !skipped.isEmpty {
      // Nothing readable at all is still a failure, and naming the pieces beats "no files".
      throw Error.exportFailed("unreadable: \(skipped.joined(separator: ", "))")
    }
    guard !placements.isEmpty, cursor.seconds > 0.05 else { throw Error.empty }
    return PlacementPlan(placements: placements, end: cursor)
  }

  /// How many times its room a segment may claim before it is taken for one stamped on a runaway
  /// clock and squeezed into the room whole.
  ///
  /// An honest overrun is milliseconds: the worst measured was 104 ms past a three-second room, and
  /// trimming it loses nothing the next segment does not show. A runaway is not. rec-411's Cosmo came
  /// back from a half-hour outage with its frame rate misread as 1.9 fps, and for a minute every
  /// segment held six real pictures, 0.1 s of the game, stamped as 3.26 s. Cut to its room, each gave
  /// the export its first picture and dropped the other five, so the minute played one frame in six.
  /// Scaled into the room, all six play at the pace they were taken.
  static let runawayRatio = 2.0

  // MARK: - Sound

  /// One file's sound and where on the output it belongs.
  private struct SoundPiece {
    /// Held so the track stays usable: an `AVAssetTrack` does not keep its asset alive.
    var asset: AVURLAsset
    var source: AVAssetTrack
    /// Where the file's sound starts playing on its own timeline: after the empty stretch a
    /// segment's sound track opens with.
    var audibleStart: CMTime
    /// Where on the file's own timeline the piece is used from: `audibleStart`, or later when the
    /// file starts before the window.
    var start: CMTime
    /// Where `start` goes on the output.
    var place: CMTime
  }

  /// The placed files' sound, each where it happened, rendered as one continuous AAC track `length`
  /// long, written to `url`.
  ///
  /// Returns false, leaving `url` alone, when none of the files has any sound.
  static func renderPlacedSound(
    _ placements: [Placement],
    length: CMTime,
    to url: URL,
    progress: (@Sendable (Double) -> Void)?
  ) async throws -> Bool {
    var pieces: [SoundPiece] = []
    for placement in placements {
      if let piece = try? await soundPiece(from: placement.start, of: placement.asset, at: placement.at) {
        pieces.append(piece)
      }
    }
    guard !pieces.isEmpty else { return false }
    return try await renderSound(pieces.sorted { $0.place < $1.place }, length: length, to: url, progress: progress)
  }

  /// Whether any placed file has sound, without reading it.
  static func hasSound(_ placements: [Placement]) async -> Bool {
    for placement in placements {
      if let tracks = try? await placement.asset.loadTracks(withMediaType: .audio), !tracks.isEmpty {
        return true
      }
    }
    return false
  }

  /// The file's sound from where its picture's range starts, `start` on its own timeline, placed so
  /// that moment lands at `time`.
  ///
  /// A segment's sound starts a few tens of milliseconds after its first picture and ends as far
  /// past its last one, and all of it is used: cut to the picture's range, every seam lost that tail
  /// and left a hole -- rec-409's Pixel export had 2,334 of them, 288 s of recorded sound missing.
  private static func soundPiece(from start: CMTime, of asset: AVURLAsset, at time: CMTime) async throws -> SoundPiece? {
    guard let source = try await asset.loadTracks(withMediaType: .audio).first else { return nil }
    // Where the sound is actually audible, not the track's whole range: a segment's sound track
    // opens on an empty stretch before its first sample.
    let segments = try await source.load(.segments)
    guard let first = segments.first(where: { !$0.isEmpty }) else { return nil }
    let audibleStart = first.timeMapping.target.start
    let used = CMTimeMaximum(audibleStart, start)
    return SoundPiece(
      asset: asset,
      source: source,
      audibleStart: audibleStart,
      start: used,
      place: CMTimeAdd(time, CMTimeSubtract(used, start))
    )
  }

  /// How far apart, at most, the end of one file's sound and the start of the next may be placed and
  /// still be one stream the camera sent. Further apart, the archive has a gap there.
  static let seamTolerance = 0.02

  /// The pieces' sound as one continuous AAC track, `length` long, written to `url`.
  ///
  /// Each file's packets are decoded and laid where the file was placed, every stretch nothing was
  /// recorded for is filled with silence, the start and the end included, and the whole is encoded
  /// once. One piece of sound, the length of the take, has no seams to get wrong. (A passthrough
  /// export of sound laid down piece by piece does not keep it where it was put: measured on
  /// rec-409's Pixel, it slid 531 ms per 1,000 s ahead of its picture.)
  ///
  /// A camera's sound is one AAC stream that TS Director's segment writer cuts into a file per
  /// segment, copied without re-encoding, each file with copies of its first packet in front to warm
  /// a decoder. Decoded file by file, every seam starts a fresh decoder on those copies, and the
  /// first 21 ms after it comes out wrong: against a decode of the unbroken stream, -2.4 dB for its
  /// first 256 samples and 2.3 dB to sample 1,024, a faint tick on tonal sound every few seconds.
  /// So one decoder runs on, file after file, and a file that carries the stream on -- placed where
  /// the last one's sound ended, give or take `seamTolerance` -- is fed from its first packet that
  /// plays, its copies dropped. A gap in the archive, or a file of another kind, starts a fresh
  /// decoder, and the gap is silence.
  ///
  /// Each file's sound still goes where its own placement puts it, so the sound keeps to the wall
  /// clock as the pictures do. Where that is a few samples after the stream's last one, those
  /// samples repeat rather than go silent; where it is before, the overlap is dropped.
  ///
  /// Stops at the next packet when its task is cancelled, throwing `CancellationError` and leaving
  /// no file behind.
  ///
  /// Returns false, leaving `url` alone, when there is nothing to render.
  private static func renderSound(
    _ pieces: [SoundPiece],
    length: CMTime,
    to url: URL,
    progress: (@Sendable (Double) -> Void)?
  ) async throws -> Bool {
    guard length.seconds > 0.05 else { return false }
    // The rate and layout of the sound that was recorded, so the render neither resamples nor folds.
    var rate = 48_000.0
    var channels = 1
    for piece in pieces {
      guard let description = try? await piece.source.load(.formatDescriptions).first,
            let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee
      else { continue }
      if basic.mSampleRate > 0 { rate = basic.mSampleRate }
      if basic.mChannelsPerFrame > 0 { channels = Int(min(basic.mChannelsPerFrame, 2)) }
      break
    }

    try? FileManager.default.removeItem(at: url)
    let writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: rate,
      AVNumberOfChannelsKey: channels,
      AVEncoderBitRateKey: channels > 1 ? 192_000 : 128_000
    ])
    input.expectsMediaDataInRealTime = false
    guard writer.canAdd(input) else { return false }
    writer.add(input)

    var asbd = AudioStreamBasicDescription(
      mSampleRate: rate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: UInt32(2 * channels),
      mFramesPerPacket: 1,
      mBytesPerFrame: UInt32(2 * channels),
      mChannelsPerFrame: UInt32(channels),
      mBitsPerChannel: 16,
      mReserved: 0
    )
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(
      allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil,
      magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format
    )
    guard let format, writer.startWriting() else { return false }
    writer.startSession(atSourceTime: .zero)

    let bytesPerFrame = 2 * channels
    let total = Int64((length.seconds * rate).rounded())
    let bridge = Int((seamTolerance * rate).rounded())
    var written: Int64 = 0
    var reported = 0.0
    /// The last `bridge` frames written, to repeat across a seam placed a little after them.
    var recent: [Int16] = []

    /// Appends `samples` (or `frames` of silence, when nil) at the running sample position.
    func append(_ samples: ArraySlice<Int16>?, frames: Int) async throws {
      var remaining = frames
      var offset = 0
      while remaining > 0 {
        try Task.checkCancellation()
        let chunk = min(remaining, 4_096)
        let length = chunk * bytesPerFrame
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(
          allocator: nil, memoryBlock: nil, blockLength: length, blockAllocator: nil,
          customBlockSource: nil, offsetToData: 0, dataLength: length,
          flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block
        ) == noErr, let block else { throw Error.exportFailed("sound block") }
        if let samples {
          samples.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            CMBlockBufferReplaceDataBytes(
              with: base.advanced(by: offset * 2), blockBuffer: block,
              offsetIntoDestination: 0, dataLength: length
            )
          }
        } else {
          CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0, dataLength: length)
        }
        var sample: CMSampleBuffer?
        var timing = CMSampleTimingInfo(
          duration: CMTime(value: 1, timescale: CMTimeScale(rate)),
          presentationTimeStamp: CMTime(value: written, timescale: CMTimeScale(rate)),
          decodeTimeStamp: .invalid
        )
        var size = bytesPerFrame
        guard CMSampleBufferCreateReady(
          allocator: nil, dataBuffer: block, formatDescription: format,
          sampleCount: chunk, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
          sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample
        ) == noErr, let sample else { throw Error.exportFailed("sound sample") }
        try await waitUntilReady(input, of: writer)
        guard input.append(sample) else {
          throw Error.exportFailed(writer.error?.localizedDescription ?? "sound append")
        }
        written += Int64(chunk)
        remaining -= chunk
        offset += chunk * channels
        // A percent at a time: an hour of sound is some forty thousand chunks.
        let fraction = total > 0 ? min(1, Double(written) / Double(total)) : 1
        if fraction - reported >= 0.01 || (fraction >= 1 && reported < 1) {
          reported = fraction
          progress?(fraction)
        }
      }
      let added = frames * channels
      if let samples {
        recent.append(contentsOf: samples.prefix(added))
      } else {
        recent.append(contentsOf: repeatElement(0, count: min(added, bridge * channels)))
      }
      if recent.count > bridge * channels { recent.removeFirst(recent.count - bridge * channels) }
    }

    /// Writes `samples`, whose first frame belongs at `at` on the output. Sound already written for a
    /// stretch keeps its place, and the overlap is dropped. A stretch before `at` that nothing
    /// covered is silence -- unless `carriesOn`, when it is a seam inside one stream that the
    /// placement opened by a few samples, and the samples before it repeat.
    func put(_ samples: ArraySlice<Int16>, at: Int64, carriesOn: Bool) async throws {
      let frames = samples.count / channels
      guard frames > 0, written < total else { return }
      if at > written {
        let gap = Int(min(at, total) - written)
        if carriesOn, gap <= bridge, recent.count >= gap * channels {
          try await append(recent.suffix(gap * channels), frames: gap)
        } else {
          try await append(nil, frames: gap)
        }
      }
      let skip = Int(max(0, written - at))
      let keep = min(frames - skip, Int(total - written))
      guard keep > 0 else { return }
      let from = samples.startIndex + skip * channels
      try await append(samples[from..<(from + keep * channels)], frames: keep)
    }

    // The last frames of the file being decoded wait until the next file is placed: a file's sound
    // is cut where the next one's is placed, so the next starts exactly there.
    var pending: [Int16] = []
    var pendingAt: Int64 = 0
    /// Frames after `pending` that the file's edit trims: sound the camera sent, played only if the
    /// next file carries the stream on.
    var trimmed: [Int16] = []
    /// Whether the file being decoded carries on the stream of the one before it.
    var joined = false

    /// Writes all but the last `bridge` frames waiting.
    func settle() async throws {
      let over = pending.count / channels - bridge
      guard over > 0 else { return }
      try await put(pending[0..<(over * channels)], at: pendingAt, carriesOn: joined)
      pending.removeFirst(over * channels)
      pendingAt += Int64(over)
    }

    /// Writes what is waiting, up to `next` (where the next file's sound is placed), with the trimmed
    /// tail when the next file carries the stream on.
    func close(before next: Int64?, carriesOn: Bool) async throws {
      if carriesOn { pending += trimmed }
      trimmed = []
      let frames = pending.count / channels
      let kept = next.map { Int(max(0, min(Int64(frames), $0 - pendingAt))) } ?? frames
      try await put(pending[0..<(kept * channels)], at: pendingAt, carriesOn: joined)
      pending = []
    }

    do {
      var decoder: SoundDecoder?
      var decoding: CMAudioFormatDescription?
      /// Where the stream being decoded has got to on the output: just past its last frame.
      var reached: Int64?
      for piece in pieces {
        try Task.checkCancellation()
        guard written < total else { break }
        guard let sound = SoundPackets.read(piece.source, of: piece.asset),
              let sourceRate = CMAudioFormatDescriptionGetStreamBasicDescription(sound.format)?.pointee.mSampleRate
        else { continue }
        let scale = rate / sourceRate
        // Where the first frame that plays goes, and where the frames the window keeps start.
        let first = Int64(((piece.place.seconds + piece.audibleStart.seconds - piece.start.seconds) * rate).rounded())
        let from = first + Int64(((piece.start.seconds - piece.audibleStart.seconds) * rate).rounded())
        let carriesOn = decoder != nil
          && sound.preRoll > 0
          && decoding.map { CMFormatDescriptionEqual($0, otherFormatDescription: sound.format) } == true
          && reached.map { abs(first - $0) <= Int64(bridge) } == true
        try await close(before: from, carriesOn: carriesOn)
        joined = carriesOn
        if !carriesOn {
          decoder = SoundDecoder(sound.format, rate: rate, channels: channels)
          decoding = sound.format
        }
        reached = nil
        guard let decoder else { continue }
        let packets = carriesOn ? Array(sound.packets.dropFirst(sound.preRoll)) : sound.packets
        let trimStart = carriesOn ? 0 : Int((Double(sound.trimStart) * scale).rounded())
        let trimEnd = Int((Double(sound.trimEnd) * scale).rounded())
        let decoded = Int((Double(packets.reduce(0) { $0 + $1.frames }) * scale).rounded())
        // Output position of the next frame the decoder gives, and where the frames that play end.
        var position = first - Int64(trimStart)
        let end = position + Int64(decoded - trimEnd)
        pendingAt = from
        for packet in packets {
          try Task.checkCancellation()
          let samples = try decoder.decode(packet)
          let frames = samples.count / channels
          defer { position += Int64(frames) }
          // Frames before the window or the edit are dropped; frames past the edit wait in `trimmed`.
          let lead = Int(min(Int64(frames), max(0, from - position)))
          let playing = Int(min(Int64(frames), max(Int64(lead), end - position)))
          if playing > lead {
            if pending.isEmpty { pendingAt = position + Int64(lead) }
            pending += samples[(lead * channels)..<(playing * channels)]
            try await settle()
          }
          if frames > playing { trimmed += samples[(playing * channels)...] }
          if written >= total { break }
        }
        reached = position
      }
      try await close(before: nil, carriesOn: false)
      // To the end of the take, whatever the last camera sound reached.
      if written < total { try await append(nil, frames: Int(total - written)) }
      // The encoded file plays the encoder's priming -- 2,112 samples, 44 ms at 48 kHz -- short of
      // what was written, since its edit list skips the priming at the front. Written to exactly
      // `total`, rec-411's programme sound ended that much before its window. So a little more
      // silence goes in here, and `join` takes exactly the take's length back out of the file.
      try await append(nil, frames: 8_192)
    } catch {
      writer.cancelWriting()
      try? FileManager.default.removeItem(at: url)
      throw error
    }
    input.markAsFinished()
    await writer.finishWriting()
    guard writer.status == .completed else {
      throw Error.exportFailed(writer.error?.localizedDescription ?? "sound finish")
    }
    return true
  }

  /// Waits for `input` to take more, giving up when the writer has failed or the task is cancelled.
  static func waitUntilReady(_ input: AVAssetWriterInput, of writer: AVAssetWriter) async throws {
    while !input.isReadyForMoreMediaData {
      try Task.checkCancellation()
      guard writer.status == .writing else {
        throw Error.exportFailed(writer.error?.localizedDescription ?? "writer \(writer.status.rawValue)")
      }
      try await Task.sleep(nanoseconds: 1_000_000)
    }
  }

  // MARK: - Writing the file

  /// The encoded pictures and the rendered sound as one file, `length` long, without re-encoding
  /// either.
  ///
  /// The sound goes in as the take's length plus the encoder's priming: a passthrough write of a
  /// range cut short of the file's end takes the priming off that end -- measured, a 4 s cut came
  /// out 47.9 ms short at 44.1 kHz. The render runs past the take (see `renderSound`), so the extra
  /// is there to take, and what is written is exactly the take.
  static func join(pictures: URL, sound: URL, length: CMTime, to destination: URL) async throws {
    let composition = AVMutableComposition()
    let pictureAsset = AVURLAsset(url: pictures)
    guard let source = try await pictureAsset.loadTracks(withMediaType: .video).first,
          let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    else { throw Error.exportFailed("no pictures to join") }
    let pictureRange = try await source.load(.timeRange)
    try video.insertTimeRange(
      CMTimeRange(start: pictureRange.start, duration: CMTimeMinimum(pictureRange.duration, length)),
      of: source,
      at: .zero
    )
    video.preferredTransform = try await source.load(.preferredTransform)

    let soundAsset = AVURLAsset(url: sound)
    if let rendered = try await soundAsset.loadTracks(withMediaType: .audio).first,
       let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
      let range = try await rendered.load(.timeRange)
      let priming = try await rendered.load(.segments).first?.timeMapping.source.start ?? .zero
      let wanted = CMTimeAdd(length, priming.isNumeric ? priming : .zero)
      try audio.insertTimeRange(
        CMTimeRange(start: range.start, duration: CMTimeMinimum(range.duration, wanted)),
        of: rendered,
        at: .zero
      )
    }
    try await writePassthrough(composition, timeRange: nil, to: destination)
  }

  /// Writes `asset` to `destination` as it is, samples copied rather than re-encoded.
  ///
  /// Stops when its task is cancelled, throwing `CancellationError` and leaving no file behind.
  static func writePassthrough(_ asset: AVAsset, timeRange: CMTimeRange?, to destination: URL) async throws {
    try? FileManager.default.removeItem(at: destination)
    guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
      throw Error.exportFailed("no export session")
    }
    if let timeRange { session.timeRange = timeRange }
    do {
      try await session.export(to: destination, as: .mp4)
    } catch {
      try? FileManager.default.removeItem(at: destination)
      if Task.isCancelled { throw CancellationError() }
      throw Error.exportFailed(error.localizedDescription)
    }
    if Task.isCancelled {
      try? FileManager.default.removeItem(at: destination)
      throw CancellationError()
    }
  }

  /// The programme master as it was recorded, cut to the window: every sample copied, none
  /// re-encoded, none held.
  ///
  /// `offset` is how far into the part the window starts; `length` is how long the window is, nil to
  /// run to the end of the part. Only for a master `ProgrammeExport.plan` found unbroken: nothing
  /// here places, fills or retimes anything.
  public static func copyProgramme(
    part: URL,
    offset: TimeInterval,
    length: TimeInterval?,
    destination: URL,
    progress: (@Sendable (Double) -> Void)? = nil
  ) async throws {
    progress?(0)
    let start = CMTime(seconds: max(0, offset), preferredTimescale: 600)
    let duration = length.map { CMTime(seconds: max(0, $0), preferredTimescale: 600) } ?? .positiveInfinity
    let range: CMTimeRange? = start.seconds > 0.0005 || length != nil
      ? CMTimeRange(start: start, duration: duration)
      : nil
    try await writePassthrough(AVURLAsset(url: part), timeRange: range, to: destination)
    progress?(1)
  }

  // MARK: - Durations

  /// A take lasts hours, not days. Video tracks stamped on a compositor/boot clock report
  /// multi-day durations; the longest track inside this window is the programme.
  public static let maximumSaneDuration: TimeInterval = 20_000

  /// Fewest frames per second a real part of ours can hold.
  ///
  /// Not a bitrate. An earlier attempt compared the declared duration against the file's size and
  /// rejected anything implying too few bits per second, which is wrong in both directions: a
  /// recovery hold is black and silent at 10 fps and compresses to almost nothing, so a perfectly
  /// good part looked broken.
  ///
  /// What actually distinguishes a broken header is that the samples are not there. One take's
  /// continuation stub declared hours while holding a single frame, and the
  /// export believed it, turning that frame into a long second video track. Even a hold
  /// writes ten frames a second, so anything under one is a header describing content the file does
  /// not contain.
  public static let minimumPlausibleFrameRate: Float = 1

  /// Whether a declared duration is believable for a track that reports this nominal rate.
  ///
  /// Public and pure so the decision can be tested without an asset on disk. A rate of zero is
  /// "unknown", not "empty" -- fragmented parts often report nothing -- and unknown is not evidence
  /// of anything, so it passes.
  public static func isPlausibleDuration(seconds: Double, nominalFrameRate: Float) -> Bool {
    guard seconds.isFinite, seconds > 0.05, seconds < maximumSaneDuration else { return false }
    guard nominalFrameRate > 0 else { return true }
    return nominalFrameRate >= minimumPlausibleFrameRate
  }

  public static func playableDuration(of asset: AVURLAsset) async throws -> CMTime {
    var best: TimeInterval = 0
    for type in [AVMediaType.audio, .video] {
      for track in try await asset.loadTracks(withMediaType: type) {
        let seconds = try await track.load(.timeRange).duration.seconds
        // Only video carries a frame rate worth testing; an audio track's duration is its own
        // business and is not what the stub case gets wrong.
        let rate = type == .video ? ((try? await track.load(.nominalFrameRate)) ?? 0) : 0
        if isPlausibleDuration(seconds: seconds, nominalFrameRate: rate) {
          best = max(best, seconds)
        }
      }
    }
    if best > 0 {
      return CMTime(seconds: best, preferredTimescale: 600)
    }
    let loaded = try await asset.load(.duration)
    if isPlausibleDuration(seconds: loaded.seconds, nominalFrameRate: 0) {
      return loaded
    }
    return .zero
  }
}
