import AVFoundation
import Foundation
import DirectorCore

/// Concatenates complete MP4s into one movie, preserving each file's duration.
///
/// Byte-appending complete MP4s is not a valid movie. Replay stages files separately; export
/// needs a single file whose duration is the sum of the pieces (and of any empty intervals
/// the caller inserts by supplying a longer `targetDuration`).
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

  /// `headTrim` drops that much from the front of the first file.
  ///
  /// Segments begin on their camera's own keyframes, so the first one for a given window usually
  /// starts a little before the window does — and by a different amount on every camera. Inserting
  /// each file from its own start therefore produces files that disagree about when they begin,
  /// which is what leaves cameras cut together sitting frames apart. Skipping the head lets every
  /// camera's export start at the same instant.
  public static func concatenate(
    files: [URL],
    fileDurations: [TimeInterval],
    targetDuration: TimeInterval? = nil,
    headTrim: TimeInterval = 0,
    startWalls: [WallClock] = [],
    windowStart: WallClock? = nil,
    destination: URL
  ) async throws {
    guard !files.isEmpty else { throw Error.empty }
    try? FileManager.default.removeItem(at: destination)
    if files.count == 1, targetDuration == nil, headTrim <= 0.001, startWalls.isEmpty {
      try FileManager.default.copyItem(at: files[0], to: destination)
      return
    }

    // Placement mode. With a wall clock per file and a window to measure from, a segment goes where
    // it happened -- `startWall - windowStart` -- rather than at the running total of everything
    // before it. The two agree only while a source delivered without interruption; the moment it
    // dropped out, a running cursor pulls every later frame earlier by the length of the gap, and
    // the file comes out short by the same amount. That is the whole of R2: a camera that lost
    // 150 s exported 150 s early from then on, and no two angles agreed after their first gap.
    let placed = !startWalls.isEmpty && startWalls.count == files.count && windowStart != nil
    let origin = windowStart ?? WallClock(seconds: 0)
    // The last picture placed, kept so a gap can be filled by holding it. One sample stretched over
    // the hole rather than one sample per frame: a 150 s dropout costs a single insertion.
    var held: (asset: AVURLAsset, sourceEnd: CMTime, frame: CMTime, timelineEnd: CMTime)?

    let composition = AVMutableComposition()
    var cursor = CMTime.zero
    // Each file's sound, placed after the picture is: see `placeSound`.
    var sound: [SoundPiece] = []
    var skipped: [String] = []
    for (index, file) in files.enumerated() {
      let asset = AVURLAsset(url: file)
      // A part the writer never finalised has no movie header, so loading it throws. Letting that
      // escape aborted the whole export with AVFoundation's damaged-media error: one take's
      // programme was a readable master plus a short continuation stub, left behind when a
      // recovery writer died two seconds after opening it, and the stub failed the export for all
      // of it. An unreadable piece is skipped so the readable ones still come out.
      do {
        let duration: CMTime
        if index < fileDurations.count, fileDurations[index] > 0 {
          duration = CMTime(seconds: fileDurations[index], preferredTimescale: 600)
        } else {
          duration = try await playableDuration(of: asset)
        }
        guard duration.seconds > 0.05 else { continue }
        // In placement mode a segment is trimmed by however much of it precedes the window, which
        // is a per-file question and not only the first file's. Otherwise the old rule stands:
        // only the head of the first file is trimmed, and never past its own length.
        let wantedTrim: TimeInterval
        if placed {
          wantedTrim = max(0, origin - startWalls[index])
        } else {
          wantedTrim = index == 0 ? headTrim : 0
        }
        let trim = min(max(0, wantedTrim), max(0, duration.seconds - 0.05))
        let start = CMTime(seconds: trim, preferredTimescale: 600)
        let kept = CMTimeSubtract(duration, start)
        guard kept.seconds > 0.05 else { continue }
        // Trimmed at the tail as well, for the same reason as the head: the last segment runs to
        // its camera's next keyframe, which is past where the window ends and by a different
        // amount on every camera. Without this the files still disagree by about a frame.
        // Where this segment belongs on the output timeline.
        let at: CMTime = placed
          ? CMTime(seconds: max(0, (startWalls[index] + trim) - origin), preferredTimescale: 600)
          : cursor
        // Anything between the last picture and this one is a stretch the camera did not cover.
        // Hold the last frame across it rather than leaving an empty range: an empty range has no
        // samples at all -- measured -- and a viewer should see the picture freeze, not the file
        // decide for itself what to show. Nothing is held before the first frame: at the head of a
        // file there is no picture yet, and black is the honest answer there.
        if placed, let previous = held, at > previous.timelineEnd {
          try? await holdFrame(previous, until: at, in: composition)
        }
        var use = kept
        if let targetDuration {
          let remaining = targetDuration - at.seconds
          if remaining <= 0.001 { if placed { continue } else { break } }
          if kept.seconds > remaining {
            use = CMTime(seconds: remaining, preferredTimescale: 600)
          }
        }
        // A segment may not run into the one after it.
        //
        // A recorded duration is what the writer measured, and it is occasionally a little longer
        // than the distance to the next segment's own start -- measured on a camera that misdeclares
        // its frame rate, 26 of 986 segments overran, the worst by 104 ms. Placed at their true
        // starts and inserted at full length they overlap, and a composition given overlapping
        // content puts it on a *second* video track: one stress export came back with two video
        // tracks of identical format, the second starting where the first overrun was, and a
        // container 139 s longer than the recording. Trimming the overrun costs a few milliseconds
        // of tape that the next segment is about to show anyway.
        if placed, index + 1 < startWalls.count {
          let nextAt = max(0, startWalls[index + 1] - origin)
          let room = nextAt - at.seconds
          if room > 0.001, use.seconds > room {
            use = CMTime(seconds: room, preferredTimescale: 600)
          }
        }
        guard use.seconds > 0.001 else { continue }
        let range = CMTimeRange(start: start, duration: use)
        // Inserting past the current end leaves the gap between as an empty range, which is what a
        // gap was: no camera delivered anything for it.
        try await insertPicture(range, of: asset, at: at, into: composition)
        if let piece = try await soundPiece(range, of: asset, at: at) { sound.append(piece) }
        cursor = CMTimeMaximum(cursor, CMTimeAdd(at, use))
        if placed {
          held = (
            asset: asset,
            sourceEnd: CMTimeAdd(start, use),
            frame: await Self.frameDuration(of: asset),
            timelineEnd: CMTimeAdd(at, use)
          )
        }
      } catch {
        skipped.append(file.lastPathComponent)
        continue
      }
    }
    if !skipped.isEmpty, cursor.seconds <= 0.05 {
      // Nothing readable at all is still a failure, and naming the pieces beats "no files".
      throw Error.exportFailed("unreadable: \(skipped.joined(separator: ", "))")
    }

    guard cursor.seconds > 0.05 else { throw Error.empty }
    if let targetDuration, targetDuration - cursor.seconds > 0.05 {
      let end = CMTime(seconds: targetDuration, preferredTimescale: 600)
      // A camera that stopped before the window did is the same case as one that dropped out in the
      // middle, so it gets the same answer.
      if placed, let previous = held, (try? await holdFrame(previous, until: end, in: composition)) != nil {
        cursor = end
      } else {
        let pad = CMTime(seconds: targetDuration - cursor.seconds, preferredTimescale: 600)
        composition.insertEmptyTimeRange(CMTimeRange(start: cursor, duration: pad))
      }
    }
    try placeSound(
      sound,
      until: targetDuration.map { CMTime(seconds: $0, preferredTimescale: 600) },
      in: composition
    )
    // Every track the length of the take. A camera's sound that stopped before the window did --
    // or a programme whose mix ended a beat before its picture -- runs out in silence rather than
    // leaving the file's sound shorter than its picture.
    if let targetDuration {
      let end = CMTime(seconds: targetDuration, preferredTimescale: 600)
      for track in composition.tracks where track.timeRange.isValid && track.timeRange.end < end {
        track.insertEmptyTimeRange(CMTimeRange(start: track.timeRange.end, end: end))
      }
    }

    // The sound goes out as one continuous track rendered from the composition, not as the pieces
    // the composition holds: see `renderSound`.
    let rendered = destination.deletingPathExtension().appendingPathExtension("sound.m4a")
    defer { try? FileManager.default.removeItem(at: rendered) }
    if let sound = composition.tracks(withMediaType: .audio).first,
       try await renderSound(
         of: composition,
         track: sound,
         length: CMTime(seconds: targetDuration ?? cursor.seconds, preferredTimescale: 600),
         to: rendered
       ) {
      composition.removeTrack(sound)
      let asset = AVURLAsset(url: rendered)
      if let source = try await asset.loadTracks(withMediaType: .audio).first,
         let target = composition.addMutableTrack(
           withMediaType: .audio,
           preferredTrackID: kCMPersistentTrackID_Invalid
         ) {
        try target.insertTimeRange(try await source.load(.timeRange), of: source, at: .zero)
      }
    }

    guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)
      ?? AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality)
    else {
      throw Error.exportFailed("no export session")
    }
    session.outputURL = destination
    session.outputFileType = .mp4
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      session.exportAsynchronously { continuation.resume() }
    }
    guard session.status == .completed else {
      throw Error.exportFailed(session.error?.localizedDescription ?? "\(session.status)")
    }
  }

  /// The source's picture, into the composition's one video track.
  ///
  /// `AVMutableComposition.insertTimeRange(_:of:at:)` puts a source track onto a *new* composition
  /// track whenever it will not sit on an existing one, and a programme part written after a
  /// recovered encoder is exactly such a source: the same codec and size, but a format description
  /// that differs in its colour tags. rec-409's programme came out with its last 78 minutes on a
  /// second video track, and every reader that takes the first video track showed them as one
  /// frozen picture. A composition track holds several format descriptions, so picture and sound
  /// each go into their one track by name.
  private static func insertPicture(
    _ range: CMTimeRange,
    of asset: AVURLAsset,
    at time: CMTime,
    into composition: AVMutableComposition
  ) async throws {
    guard let source = try await asset.loadTracks(withMediaType: .video).first,
          let target = try await track(.video, for: source, in: composition)
    else { return }
    let covered = CMTimeRangeGetIntersection(range, otherRange: try await source.load(.timeRange))
    guard covered.duration.seconds > 0.0005 else { return }
    try target.insertTimeRange(covered, of: source, at: CMTimeAdd(time, CMTimeSubtract(covered.start, range.start)))
  }

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

  /// The file's sound from where its picture's range starts to wherever the sound itself ends.
  ///
  /// A segment's sound starts a few tens of milliseconds after its first picture and ends as far
  /// past its last one. Cut to the picture's range, every seam lost that tail and left a hole:
  /// rec-409's Pixel export had 2,334 of them, 288 s of recorded sound missing.
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
  /// start from it lost a tick at every seam -- 531 ms per 1,000 s on rec-409's Pixel, sound
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
  /// Measured on rec-409's Pixel: the composition's own sound, read back, held within 15 ms per
  /// 1,000 s of its picture, and the same composition exported by `AVAssetExportSession` slid
  /// 531 ms per 1,000 s ahead of it, with a hole of about one AAC packet at every seam -- where two
  /// pieces meet, the exporter trims one and moves the next. So the sound is decoded exactly as
  /// placed, every stretch nothing was recorded for is filled with silence, the start and the end
  /// included, and it is encoded once. One piece of sound, the length of the take, has no seams to
  /// get wrong.
  ///
  /// Returns false, leaving `url` alone, when there is nothing to render.
  private static func renderSound(
    of composition: AVMutableComposition,
    track: AVMutableCompositionTrack,
    length: CMTime,
    to url: URL
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
    /// Appends `frames` of `bytes` (or of silence, when nil) at the running sample position.
    func append(_ bytes: Data?, frames: Int) async throws {
      var remaining = frames
      var offset = 0
      while remaining > 0 {
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
        while !input.isReadyForMoreMediaData {
          guard writer.status == .writing else { throw Error.exportFailed("sound writer \(writer.status.rawValue)") }
          try await Task.sleep(nanoseconds: 1_000_000)
        }
        guard input.append(sample) else {
          throw Error.exportFailed(writer.error?.localizedDescription ?? "sound append")
        }
        written += Int64(chunk)
        remaining -= chunk
        offset += chunk
      }
    }

    while written < total, let buffer = output.copyNextSampleBuffer() {
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
    input.markAsFinished()
    await writer.finishWriting()
    guard writer.status == .completed else {
      throw Error.exportFailed(writer.error?.localizedDescription ?? "sound finish")
    }
    return true
  }

  /// The composition's one track of `type`, made on first use.
  private static func track(
    _ type: AVMediaType,
    for source: AVAssetTrack,
    in composition: AVMutableComposition
  ) async throws -> AVMutableCompositionTrack? {
    if let existing = composition.tracks(withMediaType: type).first { return existing }
    guard let created = composition.addMutableTrack(
      withMediaType: type,
      preferredTrackID: kCMPersistentTrackID_Invalid
    ) else { return nil }
    if type == .video { created.preferredTransform = try await source.load(.preferredTransform) }
    return created
  }

  /// A take lasts hours, not days. Video tracks stamped on a compositor/boot clock report
  /// multi-day durations; the longest track inside this window is the programme.
  public static let maximumSaneDuration: TimeInterval = 20_000

  /// Holds `previous`'s last picture from where it ended until `end`.
  ///
  /// The frame is inserted once and then scaled to the length of the hole. A passthrough export
  /// copies samples rather than re-encoding them, and it honours the scaling: measured across a
  /// ten-second gap, every probe inside it decoded as the frame before the gap.
  private static func holdFrame(
    _ previous: (asset: AVURLAsset, sourceEnd: CMTime, frame: CMTime, timelineEnd: CMTime),
    until end: CMTime,
    in composition: AVMutableComposition
  ) async throws {
    let span = CMTimeSubtract(end, previous.timelineEnd)
    guard span.seconds > 0.001, previous.frame.seconds > 0 else { return }

    // Into the picture track by name, rather than letting the composition place it.
    //
    // `AVMutableComposition.insertTimeRange` inserts *every* track the source has and puts anything
    // that will not sit on an existing track onto a new one. Holding that way cost a stress run an
    // export with two video tracks of identical format and an audio track scaled to nonsense: the
    // hold's audio sliver was stretched across the hole alongside the picture, and a seam that
    // rounded a fraction long overlapped the segment after it, which is exactly when a second track
    // appears. Naming the track keeps one of each, and leaves the hole silent -- which is what a
    // gap sounded like.
    guard let videoTrack = composition.tracks(withMediaType: .video).first,
          let sourceVideo = try await previous.asset.loadTracks(withMediaType: .video).first
    else { return }
    let fallback = CMTimeRange(
      start: CMTimeMaximum(.zero, CMTimeSubtract(previous.sourceEnd, previous.frame)),
      duration: previous.frame
    )
    let picture = await lastSample(of: sourceVideo, endingBy: previous.sourceEnd) ?? fallback
    try videoTrack.insertTimeRange(picture, of: sourceVideo, at: previous.timelineEnd)
    videoTrack.scaleTimeRange(
      CMTimeRange(start: previous.timelineEnd, duration: picture.duration),
      toDuration: span
    )
  }

  /// The last sample showing before `end`, from where it starts to `end`.
  ///
  /// The hold used to take one nominal frame back from `end`, which lands on a sample boundary only
  /// when frames are exactly as long as the nominal rate says. A Pixel's are not -- its 59.5 fps
  /// comes out as ten- and eleven-tick samples at 600 -- so the range began a tick inside the
  /// sample before, and the hold carried a sliver of it. Seams between back-to-back segments leave
  /// one-tick holes from rounding, so nearly every 3 s seam got such a hold, and a passthrough export
  /// writes each as one-tick samples behind their own edits. rec-412's Pixel picture came out 101 ms
  /// per 1,000 s early while its sound held steady; its capture times were right, measured from
  /// the raw segments. Remuxed on a Mac with the hold starting on a sample, the same 605 segments
  /// export as one edit with no sliver samples, and the picture holds to 12 ms per 1,000 s.
  public static func lastSample(of track: AVAssetTrack, endingBy end: CMTime) async -> CMTimeRange? {
    guard (try? await track.load(.canProvideSampleCursors)) == true else { return nil }
    // Just before `end`, so a sample that starts exactly there -- the next segment's business -- is
    // not the one chosen.
    let probe = CMTimeSubtract(end, CMTime(value: 1, timescale: 90_000))
    guard let cursor = track.makeSampleCursor(presentationTimeStamp: probe) else { return nil }
    let start = cursor.presentationTimeStamp
    guard start.isNumeric, start < end else { return nil }
    return CMTimeRange(start: start, end: end)
  }

  /// One frame of this asset, for the hold above. Falls back to 30 fps when the track will not say,
  /// which only decides how much of the source the single held sample is taken from.
  private static func frameDuration(of asset: AVURLAsset) async -> CMTime {
    let fallback = CMTime(value: 1, timescale: 30)
    guard let track = try? await asset.loadTracks(withMediaType: .video).first,
          let rate = try? await track.load(.nominalFrameRate),
          rate > 0
    else { return fallback }
    return CMTime(seconds: 1 / Double(rate), preferredTimescale: 600)
  }

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
