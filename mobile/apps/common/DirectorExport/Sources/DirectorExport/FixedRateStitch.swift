import AVFoundation
import CoreVideo
import Foundation
import os
import VideoToolbox
import DirectorCore

extension ArchiveRemux {
  /// Re-encodes archive files placed on the wall clock into one file at a fixed frame rate.
  ///
  /// Output frame n sits at `n / settings.frameRate` seconds into the file, for exactly `length`
  /// seconds, and shows the latest archive picture placed at or before that instant. A picture's
  /// instant is its file's start wall plus its presentation time in the file, less `windowStart`.
  /// A camera sending faster than the setting has pictures skipped; one sending slower, or not at
  /// all, has its last picture repeated as a real encoded frame; before its first picture the output
  /// is black.
  ///
  /// Repeated rather than held. A copy of the archive filled a gap by stretching one sample across
  /// it, which is cheap and exact on paper, and some players -- IINA among them -- hang on a sample
  /// that lasts minutes. Every output frame is its own sample here, so a gap is a run of identical
  /// pictures, which the encoder compresses to almost nothing between keyframes.
  ///
  /// `blankGaps` leaves the hole empty instead. The outgoing picture keeps the one frame it was
  /// encoded on, and every frame until the next part is left out.
  ///
  /// Without `startWalls` the files are laid end to end from the start of the output. `length` nil
  /// runs to the end of the last file.
  ///
  /// Pictures are decoded one at a time with `AVAssetReader`, fitted into the setting's size with
  /// their shape kept (black bars where the shapes differ), encoded by VideoToolbox at the setting's
  /// codec, bitrate, frame rate and keyframe spacing, and written with `AVAssetWriter`. The sound is
  /// the files' own, placed the same way and rendered as one continuous track the length of the
  /// output, then joined to the pictures without touching either.
  ///
  /// `progress` hears 0 to 1, only ever moving forward, and always hears 1 last. Cancelling the task
  /// stops the work between frames, throws `CancellationError`, and leaves no file behind.
  public static func stitch(
    files: [URL],
    fileDurations: [TimeInterval],
    startWalls: [WallClock] = [],
    windowStart: WallClock? = nil,
    length: TimeInterval? = nil,
    settings: EncodeSettings,
    destination: URL,
    blankGaps: Bool = false,
    progress: (@Sendable (Double) -> Void)? = nil
  ) async throws {
    guard !files.isEmpty else { throw Error.empty }
    try? FileManager.default.removeItem(at: destination)
    let pictures = destination.deletingPathExtension().appendingPathExtension("pictures.mp4")
    let rendered = destination.deletingPathExtension().appendingPathExtension("sound.m4a")
    defer {
      try? FileManager.default.removeItem(at: pictures)
      try? FileManager.default.removeItem(at: rendered)
    }
    do {
      let plan = try await place(
        files: files,
        fileDurations: fileDurations,
        startWalls: startWalls,
        windowStart: windowStart,
        length: length
      )
      let span = CMTime(seconds: length ?? plan.end.seconds, preferredTimescale: 600)
      guard span.seconds > 0.05 else { throw Error.empty }
      // Pictures are nearly all of the work. The sound render is a decode and an AAC encode of the
      // take's sound, and joining copies the two into one file.
      let withSound = await hasSound(plan.placements)
      let pictureShare = withSound ? 0.85 : 0.95
      let soundShare = withSound ? 0.1 : 0
      try await encodePictures(
        plan.placements,
        length: span,
        settings: settings,
        to: pictures,
        blankGaps: blankGaps,
        progress: progress.map { report in { @Sendable fraction in report(fraction * pictureShare) } }
      )
      let hasRendered = withSound
        ? try await renderPlacedSound(
          plan.placements,
          length: span,
          to: rendered,
          progress: progress.map { report in
            { @Sendable fraction in report(pictureShare + fraction * soundShare) }
          }
        )
        : false
      try Task.checkCancellation()
      if hasRendered {
        try await join(pictures: pictures, sound: rendered, length: span, to: destination)
      } else {
        // Nothing to add to the pictures: they are the file.
        try FileManager.default.moveItem(at: pictures, to: destination)
      }
      progress?(1)
    } catch {
      try? FileManager.default.removeItem(at: destination)
      if error is CancellationError || Task.isCancelled { throw CancellationError() }
      throw error
    }
  }

  /// How many frames a file `length` seconds long has at `rate`: enough to cover it, the last one cut
  /// short by the end of the file when the length is not a whole number of frames.
  public static func frameCount(length: TimeInterval, rate: Int) -> Int {
    max(1, Int((length * Double(max(1, rate)) - 1e-6).rounded(.up)))
  }

  /// How far after an output frame's instant a picture may be placed and still count as at or before
  /// it.
  ///
  /// Placement is computed in seconds from times rounded to a 600 timescale, so a picture meant for
  /// exactly a frame's instant can come out a hair after it and be shown a frame late. A millisecond
  /// is far below a frame at any rate offered (the fastest is 60 fps, 16.7 ms) and far above the
  /// rounding.
  static let pictureTolerance: TimeInterval = 0.001

  /// Whether an output frame in a blank gap is left out.
  ///
  /// The picture already encoded keeps its one frame. Every later frame until the next part is
  /// left blank, including the one immediately before that part.
  public static func leavesGapFrameBlank(hasNewPicture: Bool, hasShownPicture: Bool) -> Bool {
    !hasNewPicture && hasShownPicture
  }

  /// Every output frame of `placements`, encoded into `url` at `settings`.
  private static func encodePictures(
    _ placements: [Placement],
    length: CMTime,
    settings: EncodeSettings,
    to url: URL,
    blankGaps: Bool = false,
    progress: (@Sendable (Double) -> Void)?
  ) async throws {
    try? FileManager.default.removeItem(at: url)
    var transform = CGAffineTransform.identity
    if let track = placements.lazy.compactMap(\.video).first,
       let loaded = try? await track.load(.preferredTransform) {
      transform = loaded
    }
    do {
      let encoder = try PictureEncoder(
        url: url,
        settings: settings,
        length: length,
        transform: transform,
        feed: PictureFeed(placements),
        blankGaps: blankGaps,
        progress: progress
      )
      try await encoder.run()
    } catch {
      try? FileManager.default.removeItem(at: url)
      throw error
    }
  }
}

/// Encodes every output frame with a VideoToolbox compression session, a few frames in flight at a
/// time, and writes what it makes with an `AVAssetWriter`.
///
/// Not the writer's own encoder. Measured on an M-series Mac, an `AVAssetWriterInput` given output
/// settings takes one frame at a time -- it stops taking frames after nearly every append until the
/// encoder has handed that one back -- and managed 49 fps of 1080p HEVC and 102 fps of a repeated
/// 320x240 picture, with the encoder and the process both nearly idle. A compression session fed
/// directly keeps several frames in the encoder at once and made 235 fps of 1080p HEVC and 1,313 fps
/// of the small picture. The writer is left to what it is quick at: putting encoded samples in a file.
private final class PictureEncoder: @unchecked Sendable {
  /// Frames handed to the encoder and not yet in the file. Enough to keep the hardware busy; few
  /// enough that the fitted pictures waiting on it are megabytes, not the take.
  private static let inFlight = 8

  private let session: VTCompressionSession
  /// Whether VideoToolbox gave the session a hardware encoder. A software one, which the simulator
  /// and an iPad out of hardware sessions get, keeps frames back to look ahead; see `encodeAll`.
  private let usesHardware: Bool
  private let writer: AVAssetWriter
  private let feed: PictureFeed
  private let fitter: PictureFitter
  private let frames: Int
  private let rate: Int
  private let length: CMTime
  private let transform: CGAffineTransform
  private let progress: (@Sendable (Double) -> Void)?
  /// A frame with no new picture is left out. The picture already encoded keeps its one frame.
  private let blankGaps: Bool
  /// Made empty and filled in `init`. A semaphore made with a count traps if it is freed holding less
  /// than that count, which is exactly what a cancelled encode leaves -- a place taken for a frame
  /// that never went in. Made at zero, it can go at any count.
  private let slots = DispatchSemaphore(value: 0)
  private let state = OSAllocatedUnfairLock(initialState: State())

  private struct State {
    var cancelled = false
    var failure: String?
  }

  /// Made from the first encoded frame, whose format the file's track takes. Touched only by the
  /// session's output handler until every frame is out, and by `run` after that.
  private var input: AVAssetWriterInput?

  init(
    url: URL,
    settings: EncodeSettings,
    length: CMTime,
    transform: CGAffineTransform,
    feed: PictureFeed,
    blankGaps: Bool = false,
    progress: (@Sendable (Double) -> Void)?
  ) throws {
    let rate = max(1, settings.frameRate)
    // Encoders want even dimensions; every size offered is even already.
    let width = max(2, settings.resolution.width & ~1)
    let height = max(2, settings.resolution.height & ~1)
    writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    var created: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: nil,
      width: Int32(width),
      height: Int32(height),
      codecType: settings.codec == .hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
      encoderSpecification: nil,
      imageBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey: width,
        kCVPixelBufferHeightKey: height,
        kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()
      ] as CFDictionary,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &created
    )
    guard status == noErr, let created else {
      throw ArchiveRemux.Error.exportFailed("cannot encode \(settings.codec.displayName) (\(status))")
    }
    Self.configure(created, settings: settings, rate: rate)
    VTCompressionSessionPrepareToEncodeFrames(created)
    guard let pool = VTCompressionSessionGetPixelBufferPool(created),
          let fitter = try? PictureFitter(width: width, height: height, pool: pool)
    else {
      VTCompressionSessionInvalidate(created)
      throw ArchiveRemux.Error.exportFailed("no picture buffers")
    }
    session = created
    usesHardware = Self.usesHardwareEncoder(created)
    self.fitter = fitter
    self.feed = feed
    self.rate = rate
    frames = ArchiveRemux.frameCount(length: length.seconds, rate: rate)
    self.length = length
    self.transform = transform
    self.progress = progress
    self.blankGaps = blankGaps
    for _ in 0 ..< Self.inFlight { slots.signal() }
  }

  deinit {
    VTCompressionSessionInvalidate(session)
  }

  /// H.264 at High profile or HEVC at Main, at the setting's average bitrate, with a keyframe at
  /// least every `keyframeSeconds`, encoded for quality rather than latency. Tagged BT.709, which is
  /// what every camera and the programme are.
  private static func configure(_ session: VTCompressionSession, settings: EncodeSettings, rate: Int) {
    let keyframeSeconds = max(1 / Double(rate), settings.keyframeSeconds)
    let properties: [(CFString, CFTypeRef)] = [
      (kVTCompressionPropertyKey_RealTime, kCFBooleanFalse),
      (kVTCompressionPropertyKey_AverageBitRate, max(100_000, settings.bitrate) as CFNumber),
      (kVTCompressionPropertyKey_ExpectedFrameRate, rate as CFNumber),
      // Fewer than the frames in flight, so the encoder hands one back before every place is taken.
      (kVTCompressionPropertyKey_MaxFrameDelayCount, (inFlight - 1) as CFNumber),
      (kVTCompressionPropertyKey_MaxKeyFrameInterval, max(1, Int((keyframeSeconds * Double(rate)).rounded())) as CFNumber),
      (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, keyframeSeconds as CFNumber),
      (
        kVTCompressionPropertyKey_ProfileLevel,
        settings.codec == .hevc ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_High_AutoLevel
      ),
      (kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2),
      (kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2),
      (kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
    ]
    // One at a time: a key an encoder does not support fails alone rather than taking the rest with it.
    for (key, value) in properties {
      VTSessionSetProperty(session, key: key, value: value)
    }
    if settings.codec == .h264 {
      VTSessionSetProperty(session, key: kVTCompressionPropertyKey_H264EntropyMode, value: kVTH264EntropyMode_CABAC)
    }
  }

  /// Whether the session encodes in hardware. Read after it is configured, since the settings decide
  /// which encoder VideoToolbox picks; unknown reads as software, the case that needs the care.
  private static func usesHardwareEncoder(_ session: VTCompressionSession) -> Bool {
    var value: CFTypeRef?
    let status = withUnsafeMutablePointer(to: &value) { pointer in
      VTSessionCopyProperty(
        session,
        key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
        allocator: nil,
        valueOut: UnsafeMutableRawPointer(pointer)
      )
    }
    guard status == noErr, let value, CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
    return CFBooleanGetValue((value as! CFBoolean))
  }

  /// Returns once every frame is in the finished file; throws `CancellationError` when the task is
  /// cancelled first.
  func run() async throws {
    do {
      try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Swift.Error>) in
          // Off the cooperative pool: this waits on the encoder, and a thread blocked there must not
          // be one Swift concurrency is counting on.
          DispatchQueue.global(qos: .userInitiated).async {
            do {
              try self.encodeAll()
              continuation.resume()
            } catch {
              continuation.resume(throwing: error)
            }
          }
        }
      } onCancel: {
        state.withLock { $0.cancelled = true }
      }
      guard let input else { throw ArchiveRemux.Error.exportFailed("no pictures were encoded") }
      input.markAsFinished()
      // The last frame ends where the file does, even when that is part-way through it.
      writer.endSession(atSourceTime: length)
      await writer.finishWriting()
      guard writer.status == .completed else {
        throw ArchiveRemux.Error.exportFailed(writer.error?.localizedDescription ?? "picture finish")
      }
      progress?(1)
    } catch {
      if writer.status == .writing { writer.cancelWriting() }
      throw error
    }
  }

  /// Hands every frame to the encoder and waits for the last to come out.
  private func encodeAll() throws {
    defer { feed.stop() }
    let black = try fitter.black()
    // What the output shows now, already fitted: handed in again for every frame until a newer
    // picture replaces it, so a repeat costs an encode and no pixel work.
    var shown: CVPixelBuffer?
    // Whether the encoder keeps frames back, so it has to be asked for them; see the wait below. A
    // software encoder does from the start, and flushing it as soon as the places run out keeps a
    // half-hour hole to about a minute on the simulator; a hardware one only if it is caught at it.
    var holdsFrames = !usesHardware
    // The next decoded picture, read ahead to learn whether it belongs to this frame yet.
    var waiting: PictureFeed.Picture?
    var reported = 0.0
    let timescale = CMTimeScale(rate)
    do {
      for frame in 0 ..< frames {
        // A free place in the encoder, looking up now and then to see whether to stop waiting.
        var waits = 0
        while slots.wait(timeout: holdsFrames ? .now() : .now() + .milliseconds(5)) == .timedOut {
          waits += 1
          if waits % 10 == 0 { try check() }
          // An encoder that keeps frames until it has more to look ahead at waits on us while we
          // wait on it, which the simulator's software encoder did for good. `MaxFrameDelayCount`
          // tells it not to, and this is for one that ignores it, as that encoder does: a hardware
          // encoder frees a place within milliseconds, so 20 ms with every place taken means it is
          // holding them, and it hands back what it holds. One that has held them once is asked
          // again as soon as the places run out, or a half-hour hole would take many minutes.
          if frame > 0, holdsFrames || waits % 4 == 0 {
            holdsFrames = true
            VTCompressionSessionCompleteFrames(
              session,
              untilPresentationTimeStamp: CMTime(value: CMTimeValue(frame - 1), timescale: timescale)
            )
          }
        }
        try check()
        let instant = Double(frame) / Double(rate) + ArchiveRemux.pictureTolerance
        // Every picture placed by this frame's instant, keeping only the last: a camera faster than
        // the setting has the ones between frames skipped, and only the one shown is fitted.
        var latest: CVPixelBuffer?
        while true {
          if waiting == nil { waiting = feed.next() }
          guard let picture = waiting, picture.seconds <= instant else { break }
          latest = picture.buffer
          waiting = nil
        }
        if let latest { shown = try fitter.fit(latest) }
        if blankGaps, ArchiveRemux.leavesGapFrameBlank(hasNewPicture: latest != nil, hasShownPicture: shown != nil) {
          slots.signal()
          let fraction = Double(frame + 1) / Double(frames)
          if fraction - reported >= 0.005 {
            reported = fraction
            progress?(fraction)
          }
          continue
        }
        let status = VTCompressionSessionEncodeFrame(
          session,
          imageBuffer: shown ?? black,
          presentationTimeStamp: CMTime(value: CMTimeValue(frame), timescale: timescale),
          duration: CMTime(value: 1, timescale: timescale),
          frameProperties: nil,
          infoFlagsOut: nil
        ) { [self] status, flags, sample in
          write(status: status, flags: flags, sample: sample)
        }
        guard status == noErr else {
          throw ArchiveRemux.Error.exportFailed("picture encode failed (\(status))")
        }
        let fraction = Double(frame + 1) / Double(frames)
        if fraction - reported >= 0.005 {
          reported = fraction
          progress?(fraction)
        }
      }
      let status = VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      guard status == noErr else {
        throw ArchiveRemux.Error.exportFailed("picture encode did not finish (\(status))")
      }
      try check()
    } catch {
      // Whatever is still in the encoder comes out and is dropped, rather than written after the
      // writer has been cancelled.
      state.withLock { $0.cancelled = true }
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      throw error
    }
  }

  private func check() throws {
    let current = state.withLock { $0 }
    if current.cancelled { throw CancellationError() }
    if let failure = current.failure { throw ArchiveRemux.Error.exportFailed(failure) }
  }

  /// The session's output handler: each encoded frame into the file, in the order they come out.
  private func write(status: OSStatus, flags: VTEncodeInfoFlags, sample: CMSampleBuffer?) {
    defer { slots.signal() }
    guard !state.withLock({ $0.cancelled || $0.failure != nil }) else { return }
    guard status == noErr else {
      fail("picture encode failed (\(status))")
      return
    }
    guard let sample, !flags.contains(.frameDropped) else { return }
    if input == nil {
      guard let format = CMSampleBufferGetFormatDescription(sample) else {
        fail("an encoded picture had no format")
        return
      }
      let made = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: format)
      made.expectsMediaDataInRealTime = false
      // Every frame rate offered divides 600 exactly, so frame times are whole ticks.
      made.mediaTimeScale = 600
      made.transform = transform
      guard writer.canAdd(made) else {
        fail("the picture track could not be added")
        return
      }
      writer.add(made)
      guard writer.startWriting() else {
        fail(writer.error?.localizedDescription ?? "picture writer did not start")
        return
      }
      writer.startSession(atSourceTime: .zero)
      input = made
    }
    guard let input else { return }
    // An input that only files samples away is rarely full, and never for long.
    while !input.isReadyForMoreMediaData {
      guard writer.status == .writing, !state.withLock({ $0.cancelled }) else {
        fail(writer.error?.localizedDescription ?? "picture writer stopped")
        return
      }
      usleep(200)
    }
    if !input.append(sample) {
      fail(writer.error?.localizedDescription ?? "picture append")
    }
  }

  private func fail(_ reason: String) {
    state.withLock { if $0.failure == nil { $0.failure = reason } }
  }
}

/// The placed files' pictures in output order, decoded one at a time.
///
/// One reader is open at a time, on the file being read, so however long the take only a picture or
/// two is ever held decoded.
private final class PictureFeed {
  struct Picture {
    /// Seconds into the output.
    var seconds: Double
    var buffer: CVPixelBuffer
  }

  /// How far before a file's kept stretch its pictures are read: a picture just before the window
  /// starts is what the output's first frame shows, rather than black.
  private static let lead = CMTime(value: 2, timescale: 1)

  private let placements: [ArchiveRemux.Placement]
  /// The placement to open when the one being read runs out.
  private var upcoming = 0
  private var reader: AVAssetReader?
  private var output: AVAssetReaderTrackOutput?
  private var current: ArchiveRemux.Placement?

  init(_ placements: [ArchiveRemux.Placement]) {
    self.placements = placements
  }

  /// The next picture, or nil when every file has been read.
  ///
  /// A file that will not open or stops decoding part-way ends there, and the next file carries on:
  /// the output repeats the last good picture across whatever was lost, as it does across a gap.
  func next() -> Picture? {
    while true {
      guard let output, let placement = current else {
        guard upcoming < placements.count else { return nil }
        open(placements[upcoming])
        upcoming += 1
        continue
      }
      guard let sample = output.copyNextSampleBuffer() else {
        close()
        continue
      }
      guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
      let time = CMSampleBufferGetPresentationTimeStamp(sample)
      // Past the kept stretch is the next file's business, or past the end of the output.
      guard time.isNumeric, time < placement.end else { continue }
      return Picture(seconds: placement.outputSeconds(of: time), buffer: buffer)
    }
  }

  func stop() {
    close()
    upcoming = placements.count
  }

  private func open(_ placement: ArchiveRemux.Placement) {
    guard let track = placement.video, let reader = try? AVAssetReader(asset: placement.asset) else { return }
    reader.timeRange = CMTimeRange(
      start: CMTimeMaximum(.zero, CMTimeSubtract(placement.start, Self.lead)),
      end: placement.end
    )
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()
    ])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { return }
    reader.add(output)
    guard reader.startReading() else { return }
    self.reader = reader
    self.output = output
    current = placement
  }

  private func close() {
    reader?.cancelReading()
    reader = nil
    output = nil
    current = nil
  }
}

/// Fits decoded pictures into the output's size, shape kept, bars black.
private final class PictureFitter {
  private let session: VTPixelTransferSession
  private let pool: CVPixelBufferPool
  private let width: Int
  private let height: Int

  init(width: Int, height: Int, pool: CVPixelBufferPool) throws {
    var created: VTPixelTransferSession?
    guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &created) == noErr,
          let created
    else { throw ArchiveRemux.Error.exportFailed("no picture scaler") }
    VTSessionSetProperty(created, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Letterbox)
    session = created
    self.pool = pool
    self.width = width
    self.height = height
  }

  deinit {
    VTPixelTransferSessionInvalidate(session)
  }

  /// `source` fitted into a fresh output buffer.
  ///
  /// Fresh every time: the buffer shown before may still be queued in the encoder, and drawing over
  /// it would change a frame already handed in.
  func fit(_ source: CVPixelBuffer) throws -> CVPixelBuffer {
    let fitted = try make()
    // A pool hands back buffers it has used before. Where the source is another shape the bars are
    // left as they were, so they are painted black first.
    let sourceWidth = CVPixelBufferGetWidth(source)
    let sourceHeight = CVPixelBufferGetHeight(source)
    if sourceWidth * height != sourceHeight * width { Self.paintBlack(fitted) }
    guard VTPixelTransferSessionTransferImage(session, from: source, to: fitted) == noErr else {
      throw ArchiveRemux.Error.exportFailed("picture scaling failed")
    }
    return fitted
  }

  /// A black picture, for the stretch before a camera's first.
  func black() throws -> CVPixelBuffer {
    let buffer = try make()
    Self.paintBlack(buffer)
    return buffer
  }

  private func make() throws -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let buffer else {
      throw ArchiveRemux.Error.exportFailed("no picture buffer")
    }
    return buffer
  }

  /// Video-range black: luma 16, chroma 128.
  private static func paintBlack(_ buffer: CVPixelBuffer) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    for plane in 0 ..< CVPixelBufferGetPlaneCount(buffer) {
      guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) else { continue }
      let bytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane)
      memset(base, plane == 0 ? 16 : 128, bytes)
    }
  }
}
