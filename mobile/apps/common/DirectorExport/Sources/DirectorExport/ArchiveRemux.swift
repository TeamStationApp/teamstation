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
  /// aborted the whole export with AVFoundation's damaged-media error: rec-253's programme was a
  /// readable 1h46m master plus a 5 MB continuation stub, left behind when a recovery writer died two
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
  /// trimming it loses nothing the next segment does not show. A runaway is not. rec-361's Cosmo came
  /// back from a half-hour outage with its frame rate misread as 1.9 fps, and for a minute every
  /// segment held six real pictures, 0.1 s of the game, stamped as 3.26 s. Cut to its room, each gave
  /// the export its first picture and dropped the other five, so the minute played one frame in six.
  /// Scaled into the room, all six play at the pace they were taken.
  static let runawayRatio = 2.0

  // MARK: - Sound

  /// One file's sound and where on the output it belongs.
  private struct SoundPiece {
    /// Held so the track stays usable: an `AVAssetTrack` does not keep its asset alive, and a
    /// piece placed after the loop that opened its file otherwise fails every insert (-12780).
    var asset: AVURLAsset
    var source: AVAssetTrack
    /// On the file's own timeline.
    var span: CMTimeRange
    /// Where `span.start` goes on the output.
    var place: CMTime
  }

  /// The placed files' sound, laid where it happened in a composition of its own and rendered as one
  /// continuous AAC track `length` long, written to `url`.
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
      let range = CMTimeRange(start: placement.start, duration: placement.taken)
      if let piece = try? await soundPiece(range, of: placement.asset, at: placement.at) {
        pieces.append(piece)
      }
    }
    guard !pieces.isEmpty else { return false }
    let composition = AVMutableComposition()
    try placeSound(pieces, until: length, in: composition)
    guard let track = composition.tracks(withMediaType: .audio).first else { return false }
    return try await renderSound(of: composition, track: track, length: length, to: url, progress: progress)
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

  /// The file's sound from where its picture's range starts to wherever the sound itself ends.
  ///
  /// A segment's sound starts a few tens of milliseconds after its first picture and ends as far
  /// past its last one. Cut to the picture's range, every seam lost that tail and left a hole:
  /// rec-351's Pixel export had 2,334 of them, 288 s of recorded sound missing.
  private static func soundPiece(
    _ range: CMTimeRange,
    of asset: AVURLAsset,
    at time: CMTime
  ) async throws -> SoundPiece? {
    guard let source = try await asset.loadTracks(withMediaType: .audio).first else { return nil }
    // Where the sound is actually audible, not the track's whole range: a segment's sound track
    // opens on an empty stretch before its first sample, and a piece placed from the start of
    // that stretch cut the previous piece's overrun there and put silence in its place.
    let segments = try await source.load(.segments)
    guard let first = segments.first(where: { !$0.isEmpty }),
          let last = segments.last(where: { !$0.isEmpty })
    else { return nil }
    let audible = CMTimeRange(start: first.timeMapping.target.start, end: last.timeMapping.target.end)
    let start = CMTimeMaximum(audible.start, range.start)
    guard audible.end > start else { return nil }
    return SoundPiece(
      asset: asset,
      source: source,
      span: CMTimeRange(start: start, end: audible.end),
      place: CMTimeAdd(time, CMTimeSubtract(start, range.start))
    )
  }

  /// Every piece of sound where it happened, each stopping where the next begins.
  ///
  /// Placed only from each piece's own position, never from where the composition says the last
  /// one ended: that end is rounded to the composition's timescale, and taking the next piece's
  /// start from it lost a tick at every seam -- 531 ms per 1,000 s on rec-351's Pixel, sound
  /// sliding steadily ahead of picture. A piece that would run into the next is cut at the next
  /// one's start (inserting into a composition track shifts what follows, so nothing may overlap),
  /// and nothing runs past `windowEnd`.
  private static func placeSound(
    _ pieces: [SoundPiece],
    until windowEnd: CMTime?,
    in composition: AVMutableComposition
  ) throws {
    let ordered = pieces.sorted { $0.place < $1.place }
    for (index, piece) in ordered.enumerated() {
      var stop = CMTimeAdd(piece.place, piece.span.duration)
      if index + 1 < ordered.count { stop = CMTimeMinimum(stop, ordered[index + 1].place) }
      if let windowEnd { stop = CMTimeMinimum(stop, windowEnd) }
      let length = CMTimeSubtract(stop, piece.place)
      guard length.seconds > 0.0005 else { continue }
      guard let target = composition.tracks(withMediaType: .audio).first
        ?? composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
      else { return }
      try target.insertTimeRange(
        CMTimeRange(start: piece.span.start, duration: length),
        of: piece.source,
        at: piece.place
      )
    }
  }

  /// The composition's sound as one continuous AAC track, `length` long, written to `url`.
  ///
  /// A passthrough export of sound laid down piece by piece does not keep it where it was put.
  /// Measured on rec-351's Pixel: the composition's own sound, read back, held within 15 ms per
  /// 1,000 s of its picture, and the same composition exported by `AVAssetExportSession` slid
  /// 531 ms per 1,000 s ahead of it, with a hole of about one AAC packet at every seam -- where two
  /// pieces meet, the exporter trims one and moves the next. So the sound is decoded exactly as
  /// placed, every stretch nothing was recorded for is filled with silence, the start and the end
  /// included, and it is encoded once. One piece of sound, the length of the take, has no seams to
  /// get wrong.
  ///
  /// Stops at the next chunk when its task is cancelled, throwing `CancellationError` and leaving no
  /// file behind.
  ///
  /// Returns false, leaving `url` alone, when there is nothing to render.
  private static func renderSound(
    of composition: AVMutableComposition,
    track: AVMutableCompositionTrack,
    length: CMTime,
    to url: URL,
    progress: (@Sendable (Double) -> Void)?
  ) async throws -> Bool {
    guard length.seconds > 0.05 else { return false }
    // The rate and layout of the sound that was recorded, so the render neither resamples nor folds.
    var rate = 48_000.0
    var channels: UInt32 = 1
    if let description = track.formatDescriptions.first,
       let basic = CMAudioFormatDescriptionGetStreamBasicDescription(description as! CMAudioFormatDescription)?.pointee {
      if basic.mSampleRate > 0 { rate = basic.mSampleRate }
      if basic.mChannelsPerFrame > 0 { channels = min(basic.mChannelsPerFrame, 2) }
    }
    let reader = try AVAssetReader(asset: composition)
    reader.timeRange = CMTimeRange(start: .zero, duration: length)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
      AVSampleRateKey: rate,
      AVNumberOfChannelsKey: channels
    ])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { return false }
    reader.add(output)

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
      mBytesPerPacket: 2 * channels,
      mFramesPerPacket: 1,
      mBytesPerFrame: 2 * channels,
      mChannelsPerFrame: channels,
      mBitsPerChannel: 16,
      mReserved: 0
    )
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(
      allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil,
      magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format
    )
    guard let format, reader.startReading(), writer.startWriting() else { return false }
    writer.startSession(atSourceTime: .zero)

    let bytesPerFrame = Int(2 * channels)
    let total = Int64((length.seconds * rate).rounded())
    var written: Int64 = 0
    var reported = 0.0
    /// Appends `frames` of `bytes` (or of silence, when nil) at the running sample position.
    func append(_ bytes: Data?, frames: Int) async throws {
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
        if let bytes {
          bytes.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            CMBlockBufferReplaceDataBytes(
              with: base.advanced(by: offset * bytesPerFrame), blockBuffer: block,
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
        offset += chunk
        // A percent at a time: an hour of sound is some forty thousand chunks.
        let fraction = total > 0 ? min(1, Double(written) / Double(total)) : 1
        if fraction - reported >= 0.01 || (fraction >= 1 && reported < 1) {
          reported = fraction
          progress?(fraction)
        }
      }
    }

    do {
      while written < total, let buffer = output.copyNextSampleBuffer() {
        try Task.checkCancellation()
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
        let frames = CMSampleBufferGetNumSamples(buffer)
        guard frames > 0 else { continue }
        // Where this buffer was placed, in samples. Anything between the last sample written and here
        // is a stretch no camera sound covered: silence, so what follows stays where it belongs.
        let at = Int64((CMSampleBufferGetPresentationTimeStamp(buffer).seconds * rate).rounded())
        if at > written { try await append(nil, frames: Int(min(at, total) - written)) }
        // Sound already written for this stretch keeps its place; the overlap is dropped.
        let skip = Int(max(0, written - at))
        let keep = min(frames - skip, Int(total - written))
        guard keep > 0 else { continue }
        var data = Data(count: frames * bytesPerFrame)
        let copied = data.withUnsafeMutableBytes { raw -> Bool in
          guard let base = raw.baseAddress else { return false }
          return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: frames * bytesPerFrame, destination: base) == noErr
        }
        guard copied else { continue }
        try await append(data.subdata(in: (skip * bytesPerFrame)..<((skip + keep) * bytesPerFrame)), frames: keep)
      }
      if reader.status == .failed { throw Error.exportFailed(reader.error?.localizedDescription ?? "sound read") }
      // To the end of the take, whatever the last camera sound reached.
      if written < total { try await append(nil, frames: Int(total - written)) }
      // The encoded file plays the encoder's priming -- 2,112 samples, 44 ms at 48 kHz -- short of
      // what was written, since its edit list skips the priming at the front. Written to exactly
      // `total`, rec-361's programme sound ended that much before its window. So a little more
      // silence goes in here, and `join` takes exactly the take's length back out of the file.
      try await append(nil, frames: 8_192)
    } catch {
      reader.cancelReading()
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
  /// What actually distinguishes a broken header is that the samples are not there. Recording 253's
  /// continuation stub declared 6,550 s while holding a single frame -- 0.00015 fps -- and the
  /// export believed it, turning that frame into a 128-second second video track. Even a hold
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
