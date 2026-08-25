import AVFoundation
import CoreMedia
import CoreVideo
import DirectorSources
import Foundation
import VideoToolbox

/// Sequential replay over complete archive MP4s.
///
/// One producer thread walks files in order, decodes, and appends pixels to a FIFO. The
/// display thread only pops that FIFO — it never opens a file or sees a boundary. The queue
/// holds about two to three seconds of frames: when it drops below two seconds, the producer
/// decodes one more second. Leftover queued frames are discarded when replay stops.
final class ReplayFileReader: @unchecked Sendable {
  private let lock = NSCondition()
  private var urls: [URL]
  private var durations: [TimeInterval]
  private let frameRate: Double
  private let playDuration: TimeInterval?
  private var cursor: FileCursor?
  private var frames: [(pixel: CVPixelBuffer, time: CMTime, media: TimeInterval)] = []
  private var cancelled = false
  private var firstReady = false
  private var openError: Error?
  private var startSkip: TimeInterval = 0
  private var startOrigin: TimeInterval = 0
  private var startIndex = 0
  private var fileIndex = 0
  private var producedSeconds: TimeInterval = 0
  private var producerExhausted = false
  private let hardware = ReplayHardwareDecoder()
  private var pool: PixelBufferFactory?
  private let pixelLock = NSLock()
  private let worker = DispatchQueue(
    label: "co.gamestation.director.replay.file",
    qos: .userInitiated
  )

  private static let lowWatermark: TimeInterval = 2
  private static let fillQuantum: TimeInterval = 1

  init(
    urls: [URL],
    durations: [TimeInterval] = [],
    frameRate: Double = 30,
    playDuration: TimeInterval? = nil
  ) {
    self.urls = urls
    self.durations = durations
    self.frameRate = max(frameRate, 1)
    self.playDuration = playDuration
  }

  func open(startOffset: TimeInterval) throws {
    lock.lock()
    cancelled = false
    firstReady = false
    openError = nil
    frames = []
    cursor = nil
    producerExhausted = false
    producedSeconds = 0
    startSkip = 0
    startOrigin = 0
    startIndex = 0
    fileIndex = 0
    lock.unlock()
    guard let start = findStart(startOffset) else {
      throw ReplayDecoder.ReplayError.noSamples
    }
    lock.lock()
    startIndex = start.index
    fileIndex = start.index
    startSkip = start.skip
    startOrigin = start.origin
    let snapshot = urls
    lock.unlock()
    FileCursor.preload(urls: snapshot, from: start.index)
    worker.async { [weak self] in
      self?.produce()
    }
    lock.lock()
    let deadline = Date().addingTimeInterval(2)
    while !firstReady, openError == nil, !cancelled, Date() < deadline {
      lock.wait(until: deadline)
    }
    let error = openError
    let ready = firstReady
    lock.unlock()
    if let error { throw error }
    if !ready { throw ReplayDecoder.ReplayError.noSamples }
  }

  func append(urls: [URL], durations: [TimeInterval]) {
    lock.lock()
    var existing = Set(self.urls.map(\.lastPathComponent))
    for (index, url) in urls.enumerated() {
      let name = url.lastPathComponent
      if existing.contains(name) { continue }
      existing.insert(name)
      self.urls.append(url)
      self.durations.append(index < durations.count ? durations[index] : 0)
    }
    producerExhausted = false
    let snapshot = self.urls
    let next = fileIndex
    lock.broadcast()
    lock.unlock()
    FileCursor.preload(urls: snapshot, from: next)
    worker.async { [weak self] in
      self?.produce()
    }
  }

  /// Blocking pop used by tests. Waits until a frame is queued or the producer is done.
  func next() -> (pixel: CVPixelBuffer, time: CMTime, media: TimeInterval)? {
    lock.lock()
    let deadline = Date().addingTimeInterval(2)
    while frames.isEmpty, !cancelled, !producerExhausted, Date() < deadline {
      lock.unlock()
      worker.async { [weak self] in
        self?.produce()
      }
      lock.lock()
      lock.wait(until: Date().addingTimeInterval(0.05))
    }
    return takeFrame()
  }

  /// Non-blocking pop for the display thread. Returns nil on underrun; the last picture stays.
  func pop() -> (pixel: CVPixelBuffer, time: CMTime, media: TimeInterval)? {
    lock.lock()
    return takeFrame()
  }

  func cancel() {
    lock.lock()
    cancelled = true
    producerExhausted = true
    let playing = cursor
    frames = []
    lock.broadcast()
    lock.unlock()
    playing?.abortReader()
    worker.async { [weak self] in
      self?.closeCursor()
      self?.hardware.invalidate()
    }
    FileCursor.clearPreparedAssets()
  }

  var shouldPrefetchMore: Bool {
    lock.lock()
    defer { lock.unlock() }
    return fileIndex >= urls.count && !producerExhausted
  }

  var isExhausted: Bool {
    lock.lock()
    defer { lock.unlock() }
    return producerExhausted && frames.isEmpty
  }

  /// Must be called with `lock` held. Releases the lock.
  private func takeFrame() -> (pixel: CVPixelBuffer, time: CMTime, media: TimeInterval)? {
    let fps = frameRate
    guard !frames.isEmpty else {
      let need = !cancelled && !producerExhausted
      lock.unlock()
      if need {
        worker.async { [weak self] in
          self?.produce()
        }
      }
      return nil
    }
    let frame = frames.removeFirst()
    let need = Double(frames.count) / fps < Self.lowWatermark && !cancelled && !producerExhausted
    lock.broadcast()
    lock.unlock()
    if need {
      worker.async { [weak self] in
        self?.produce()
      }
    }
    return frame
  }

  /// Runs only on `worker`. Fills the FIFO in 1s chunks while it holds less than 2s of frames.
  private func produce() {
    while true {
      lock.lock()
      if cancelled {
        lock.unlock()
        closeCursor()
        return
      }
      if let cap = playDuration, producedSeconds >= cap {
        producerExhausted = true
        lock.broadcast()
        lock.unlock()
        closeCursor()
        return
      }
      let queued = Double(frames.count) / frameRate
      let done = producerExhausted
      lock.unlock()
      if done || queued >= Self.lowWatermark { return }

      var added: TimeInterval = 0
      while added < Self.fillQuantum {
        lock.lock()
        let stop = cancelled || (playDuration.map { producedSeconds >= $0 } ?? false)
        lock.unlock()
        if stop { break }
        guard let frame = nextDecodedFrame() else {
          return
        }
        guard let copy = copyPixelWaiting(frame.pixel) else { break }
        let step = 1 / frameRate
        lock.lock()
        if cancelled {
          lock.unlock()
          closeCursor()
          return
        }
        let media = startOrigin + producedSeconds
        producedSeconds += step
        frames.append((copy, frame.time, media))
        firstReady = true
        if let cap = playDuration, producedSeconds >= cap {
          producerExhausted = true
        }
        lock.broadcast()
        lock.unlock()
        added += step
      }

      lock.lock()
      let queuedAfter = Double(frames.count) / frameRate
      let exhausted = producerExhausted
      let stillShort = queuedAfter < Self.lowWatermark && !exhausted && !cancelled
      lock.unlock()
      if !stillShort { return }
    }
  }

  private func nextDecodedFrame() -> (pixel: CVPixelBuffer, time: CMTime, media: TimeInterval)? {
    if activeCursor() == nil, !openNextFile() { return nil }
    if let frame = activeCursor()?.next() { return frame }
    closeCursor()
    if !openNextFile() { return nil }
    return activeCursor()?.next()
  }

  private func activeCursor() -> FileCursor? {
    lock.lock()
    defer { lock.unlock() }
    return cursor
  }

  private func openNextFile() -> Bool {
    lock.lock()
    if cancelled {
      lock.unlock()
      return false
    }
    let index = fileIndex
    guard index < urls.count else {
      let cap = playDuration
      if cap == nil || producedSeconds >= (cap ?? 0) - 0.02 {
        producerExhausted = true
      }
      lock.broadcast()
      lock.unlock()
      return false
    }
    let skip = index == startIndex ? startSkip : 0
    let origin = index == startIndex ? startOrigin : startOrigin + producedSeconds
    let url = urls[index]
    fileIndex = index + 1
    let snapshot = urls
    let preloadFrom = fileIndex
    lock.unlock()
    FileCursor.preload(urls: snapshot, from: preloadFrom)
    do {
      let opened = try FileCursor(
        url: url,
        index: index,
        skip: skip,
        origin: origin,
        hardware: hardware
      )
      lock.lock()
      if cancelled {
        lock.unlock()
        opened.cancel()
        return false
      }
      cursor = opened
      lock.unlock()
      return true
    } catch {
      lock.lock()
      openError = error
      producerExhausted = true
      lock.broadcast()
      lock.unlock()
      return false
    }
  }

  private func closeCursor() {
    lock.lock()
    let closing = cursor
    cursor = nil
    lock.unlock()
    closing?.cancel()
  }

  private func findStart(
    _ startOffset: TimeInterval
  ) -> (index: Int, skip: TimeInterval, origin: TimeInterval)? {
    var skip = max(0, startOffset)
    var origin: TimeInterval = 0
    var index = 0
    lock.lock()
    let count = urls.count
    lock.unlock()
    while index < count {
      let duration = durationAt(index)
      if duration <= 0.04 || skip < duration - 0.04 {
        return (index, skip, origin)
      }
      skip -= duration
      origin += duration
      index += 1
    }
    return nil
  }

  private func durationAt(_ index: Int) -> TimeInterval {
    lock.lock()
    let indexed = index < durations.count ? durations[index] : 0
    let url = index < urls.count ? urls[index] : nil
    lock.unlock()
    if indexed > 0 { return indexed }
    guard let url else { return 0 }
    return FileCursor.duration(of: url)
  }

  private func copyPixelWaiting(_ source: CVPixelBuffer) -> CVPixelBuffer? {
    var copy = copyPixel(source)
    if copy != nil { return copy }
    lock.lock()
    while copy == nil, !cancelled {
      lock.wait(until: Date().addingTimeInterval(0.05))
      lock.unlock()
      copy = copyPixel(source)
      lock.lock()
    }
    lock.unlock()
    return copy
  }

  private func copyPixel(_ source: CVPixelBuffer) -> CVPixelBuffer? {
    pixelLock.lock()
    defer { pixelLock.unlock() }
    let width = CVPixelBufferGetWidth(source)
    let height = CVPixelBufferGetHeight(source)
    let format = CVPixelBufferGetPixelFormatType(source)
    if pool?.width != width || pool?.height != height || pool?.pixelFormat != format {
      pool = PixelBufferFactory(
        width: width,
        height: height,
        pixelFormat: format,
        minimumBuffers: 32,
        maximumBuffers: 96
      )
    }
    guard let destination = pool?.makeBuffer() else { return nil }
    return ReplayHardwareDecoder.copyPlanes(from: source, to: destination) ? destination : nil
  }
}

/// One archive file. VideoToolbox is shared across files so a 3s cut does not drop the next GOP.
private final class FileCursor: @unchecked Sendable {
  let index: Int
  private(set) var lastMedia: TimeInterval = 0

  private static let assetLock = NSLock()
  nonisolated(unsafe) private static var preparedAssets: [String: AVURLAsset] = [:]

  private var reader: AVAssetReader?
  private var output: AVAssetReaderTrackOutput?
  private let hardware: ReplayHardwareDecoder
  private let trackFormat: CMFormatDescription?
  private var pendingSamples: [CMSampleBuffer] = []
  private var primed: [(pixel: CVPixelBuffer, time: CMTime, media: TimeInterval)] = []
  private var timelineOrigin: TimeInterval
  private var fileStartPTS: TimeInterval = 0
  private var didAnchorPTS = false
  private var skipRemaining: TimeInterval
  private var retainedSample: CMSampleBuffer?
  private var pool: PixelBufferFactory?
  private let cancelLock = NSLock()
  private var didCancel = false

  init(
    url: URL,
    index: Int,
    skip: TimeInterval,
    origin: TimeInterval,
    hardware: ReplayHardwareDecoder
  ) throws {
    self.index = index
    self.hardware = hardware
    self.timelineOrigin = origin
    self.skipRemaining = max(0, skip)
    self.lastMedia = origin
    let opened = try Self.openReader(url: url)
    reader = opened.reader
    output = opened.output
    trackFormat = opened.format
    pendingSamples = [ opened.sample ]
  }

  @discardableResult
  func fillPrime(_ count: Int) -> Bool {
    while primed.count < count {
      guard let frame = pullOne() else { break }
      guard let copy = copyPixel(frame.pixel) else { break }
      primed.append((copy, frame.time, frame.media))
    }
    return !primed.isEmpty
  }

  func rebase(to origin: TimeInterval) {
    let delta = origin - timelineOrigin
    guard abs(delta) > 0.001 else { return }
    timelineOrigin = origin
    lastMedia += delta
    primed = primed.map { ($0.pixel, $0.time, $0.media + delta) }
  }

  func next() -> (pixel: CVPixelBuffer, time: CMTime, media: TimeInterval)? {
    if !primed.isEmpty { return primed.removeFirst() }
    return pullOne()
  }

  /// Unblock `copyNextSampleBuffer` from another thread. VideoToolbox invalidate stays
  /// on `cancel()`, which the worker that opened this cursor must call.
  func abortReader() {
    cancelLock.lock()
    let reader = self.reader
    self.reader = nil
    output = nil
    cancelLock.unlock()
    reader?.cancelReading()
  }

  func cancel() {
    cancelLock.lock()
    guard !didCancel else {
      cancelLock.unlock()
      return
    }
    didCancel = true
    let reader = self.reader
    self.reader = nil
    output = nil
    primed = []
    pendingSamples = []
    retainedSample = nil
    cancelLock.unlock()
    reader?.cancelReading()
    pool = nil
  }

  private func pullOne() -> (pixel: CVPixelBuffer, time: CMTime, media: TimeInterval)? {
    while true {
      let sample: CMSampleBuffer
      if !pendingSamples.isEmpty {
        sample = pendingSamples.removeFirst()
      } else if let pulled = output?.copyNextSampleBuffer() {
        sample = pulled
      } else {
        return nil
      }
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      let ptsSec = pts.seconds.isFinite ? pts.seconds : 0
      if !didAnchorPTS {
        fileStartPTS = ptsSec
        didAnchorPTS = true
      }
      let intoFile = max(0, ptsSec - fileStartPTS)
      // Feed every sample to the decoder so the file's IDR is not dropped, then hold the
      // pictures until the playhead is at the requested offset.
      let image: CVPixelBuffer
      if let attached = CMSampleBufferGetImageBuffer(sample) {
        image = attached
      } else if let decoded = hardware.decode(sample, fallbackFormat: trackFormat) {
        image = decoded
      } else {
        // P-frames before the first successful IDR cannot be shown, but an IDR that
        // fails once is retried inside decode. Skipping here is a true decode miss.
        continue
      }
      lastMedia = timelineOrigin + intoFile
      retainedSample = sample
      if intoFile + 0.001 < skipRemaining {
        continue
      }
      skipRemaining = 0
      return (image, pts, lastMedia)
    }
  }

  private func copyPixel(_ source: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(source)
    let height = CVPixelBufferGetHeight(source)
    let format = CVPixelBufferGetPixelFormatType(source)
    if pool?.width != width || pool?.height != height || pool?.pixelFormat != format {
      pool = PixelBufferFactory(
        width: width,
        height: height,
        pixelFormat: format,
        minimumBuffers: 4,
        maximumBuffers: 12
      )
    }
    guard let destination = pool?.makeBuffer() else { return nil }
    return ReplayHardwareDecoder.copyPlanes(from: source, to: destination) ? destination : nil
  }

  private static func openReader(
    url: URL
  ) throws -> (
    reader: AVAssetReader,
    output: AVAssetReaderTrackOutput,
    sample: CMSampleBuffer,
    format: CMFormatDescription?
  ) {
    let asset = preparedAsset(url: url)
    guard let track = asset.tracks(withMediaType: .video).first else {
      throw ReplayDecoder.ReplayError.noVideoTrack
    }
    let format: CMFormatDescription?
    if let raw = track.formatDescriptions.first {
      format = (raw as! CMFormatDescription)
    } else {
      format = nil
    }
    if let passthrough = makeCompressedReader(asset: asset, track: track) {
      return (passthrough.reader, passthrough.output, passthrough.sample, format)
    }
    if let pixels = makePixelReader(asset: asset, track: track) {
      return (pixels.reader, pixels.output, pixels.sample, format)
    }
    throw ReplayDecoder.ReplayError.startFailed("no compressed samples")
  }

  private static func preparedAsset(url: URL) -> AVURLAsset {
    assetLock.lock()
    if let cached = preparedAssets[url.path] {
      let asset = cached
      assetLock.unlock()
      if asset.statusOfValue(forKey: "tracks", error: nil) == .loaded {
        return asset
      }
      let group = DispatchGroup()
      group.enter()
      asset.loadValuesAsynchronously(forKeys: [ "tracks", "duration" ]) { group.leave() }
      _ = group.wait(timeout: .now() + 0.4)
      return asset
    }
    let asset = AVURLAsset(url: url)
    preparedAssets[url.path] = asset
    assetLock.unlock()
    let keys = [ "tracks", "duration" ]
    let group = DispatchGroup()
    group.enter()
    asset.loadValuesAsynchronously(forKeys: keys) { group.leave() }
    _ = group.wait(timeout: .now() + 0.4)
    return asset
  }

  static func preload(urls: [URL], from index: Int) {
    guard index < urls.count else { return }
    let slice = Array(urls[index...])
    DispatchQueue.global(qos: .userInitiated).async {
      for url in slice {
        _ = preparedAsset(url: url)
      }
    }
  }

  static func clearPreparedAssets() {
    assetLock.lock()
    preparedAssets = [:]
    assetLock.unlock()
  }

  static func duration(of url: URL) -> TimeInterval {
    let seconds = AVURLAsset(url: url).duration.seconds
    return seconds.isFinite && seconds > 0 ? seconds : 0
  }

  private static func makeCompressedReader(
    asset: AVURLAsset,
    track: AVAssetTrack
  ) -> (reader: AVAssetReader, output: AVAssetReaderTrackOutput, sample: CMSampleBuffer)? {
    guard let reader = try? AVAssetReader(asset: asset) else { return nil }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = true
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }
    var pulled = 0
    while pulled < 3 {
      guard let sample = output.copyNextSampleBuffer() else { break }
      pulled += 1
      if CMSampleBufferGetDataBuffer(sample) != nil || CMSampleBufferGetImageBuffer(sample) != nil {
        return (reader, output, sample)
      }
    }
    reader.cancelReading()
    return nil
  }

  private static func makePixelReader(
    asset: AVURLAsset,
    track: AVAssetTrack
  ) -> (reader: AVAssetReader, output: AVAssetReaderTrackOutput, sample: CMSampleBuffer)? {
    let formats: [OSType] = [
      kCVPixelFormatType_32BGRA,
      kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
      kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ]
    for format in formats {
      guard let reader = try? AVAssetReader(asset: asset) else { continue }
      let output = AVAssetReaderTrackOutput(
        track: track,
        outputSettings: [
          kCVPixelBufferPixelFormatTypeKey as String: format,
          kCVPixelBufferMetalCompatibilityKey as String: true,
          kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]
        ]
      )
      output.alwaysCopiesSampleData = false
      guard reader.canAdd(output) else { continue }
      reader.add(output)
      guard reader.startReading() else {
        reader.cancelReading()
        continue
      }
      var pulled = 0
      while pulled < 3 {
        guard let sample = output.copyNextSampleBuffer() else { break }
        pulled += 1
        if CMSampleBufferGetImageBuffer(sample) != nil {
          return (reader, output, sample)
        }
      }
      reader.cancelReading()
    }
    return nil
  }
}

/// Decodes passthrough archive samples. One session is reused across files so a segment
/// boundary does not drop the next GOP while VideoToolbox is torn down and rebuilt.
private final class ReplayHardwareDecoder: @unchecked Sendable {
  private var session: VTDecompressionSession?
  private var sessionFormat: CMFormatDescription?
  private var lastPixel: CVPixelBuffer?

  deinit { invalidate() }

  func invalidate() {
    if let session {
      VTDecompressionSessionInvalidate(session)
    }
    session = nil
    sessionFormat = nil
    lastPixel = nil
  }

  func decode(
    _ sample: CMSampleBuffer,
    fallbackFormat: CMFormatDescription? = nil
  ) -> CVPixelBuffer? {
    let description = CMSampleBufferGetFormatDescription(sample) ?? fallbackFormat
    guard let description else { return nil }
    if session == nil {
      rebuild(description)
    }
    guard session != nil else { return nil }
    if let image = decodeOnce(sample) { return image }
    let same = sessionFormat.map { CMFormatDescriptionEqual($0, otherFormatDescription: description) } ?? false
    if !same {
      rebuild(description)
    }
    return decodeOnce(sample)
  }

  private func decodeOnce(_ sample: CMSampleBuffer) -> CVPixelBuffer? {
    guard let session else { return nil }
    lastPixel = nil
    var infoFlags: VTDecodeInfoFlags = []
    let status = VTDecompressionSessionDecodeFrame(
      session,
      sampleBuffer: sample,
      flags: [],
      frameRefcon: nil,
      infoFlagsOut: &infoFlags
    )
    if status == kVTInvalidSessionErr {
      invalidate()
      return nil
    }
    guard status == noErr else { return nil }
    if lastPixel == nil {
      VTDecompressionSessionWaitForAsynchronousFrames(session)
    }
    return lastPixel
  }

  fileprivate func finish(status: OSStatus, image: CVImageBuffer?) {
    guard status == noErr else { return }
    lastPixel = image
  }

  private func rebuild(_ description: CMFormatDescription) {
    if let session { VTDecompressionSessionInvalidate(session) }
    session = nil
    sessionFormat = nil
    lastPixel = nil
    let imageAttributes: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
      kCVPixelBufferMetalCompatibilityKey as String: true
    ]
    var callback = VTDecompressionOutputCallbackRecord(
      decompressionOutputCallback: replayHardwareDecompressionCallback,
      decompressionOutputRefCon: Unmanaged.passUnretained(self).toOpaque()
    )
    var created: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      formatDescription: description,
      decoderSpecification: nil,
      imageBufferAttributes: imageAttributes as CFDictionary,
      outputCallback: &callback,
      decompressionSessionOut: &created
    )
    guard status == noErr else { return }
    session = created
    sessionFormat = description
  }

  static func copyPlanes(from source: CVPixelBuffer, to destination: CVPixelBuffer) -> Bool {
    let planes = max(CVPixelBufferGetPlaneCount(source), 1)
    guard planes == max(CVPixelBufferGetPlaneCount(destination), 1) else { return false }
    CVPixelBufferLockBaseAddress(source, .readOnly)
    CVPixelBufferLockBaseAddress(destination, [])
    defer {
      CVPixelBufferUnlockBaseAddress(destination, [])
      CVPixelBufferUnlockBaseAddress(source, .readOnly)
    }
    for plane in 0..<planes {
      let srcBytes = CVPixelBufferGetPlaneCount(source) == 0
        ? CVPixelBufferGetBytesPerRow(source)
        : CVPixelBufferGetBytesPerRowOfPlane(source, plane)
      let dstBytes = CVPixelBufferGetPlaneCount(destination) == 0
        ? CVPixelBufferGetBytesPerRow(destination)
        : CVPixelBufferGetBytesPerRowOfPlane(destination, plane)
      let height = CVPixelBufferGetPlaneCount(source) == 0
        ? CVPixelBufferGetHeight(source)
        : CVPixelBufferGetHeightOfPlane(source, plane)
      let width = min(srcBytes, dstBytes)
      guard
        let src = CVPixelBufferGetPlaneCount(source) == 0
          ? CVPixelBufferGetBaseAddress(source)
          : CVPixelBufferGetBaseAddressOfPlane(source, plane),
        let dst = CVPixelBufferGetPlaneCount(destination) == 0
          ? CVPixelBufferGetBaseAddress(destination)
          : CVPixelBufferGetBaseAddressOfPlane(destination, plane)
      else { return false }
      for row in 0..<height {
        memcpy(dst.advanced(by: row * dstBytes), src.advanced(by: row * srcBytes), width)
      }
    }
    return true
  }
}

private func replayHardwareDecompressionCallback(
  decompressionOutputRefCon: UnsafeMutableRawPointer?,
  sourceFrameRefCon: UnsafeMutableRawPointer?,
  status: OSStatus,
  infoFlags: VTDecodeInfoFlags,
  imageBuffer: CVImageBuffer?,
  presentationTimeStamp: CMTime,
  presentationDuration: CMTime
) {
  guard let decompressionOutputRefCon else { return }
  let decoder = Unmanaged<ReplayHardwareDecoder>
    .fromOpaque(decompressionOutputRefCon)
    .takeUnretainedValue()
  decoder.finish(status: status, image: imageBuffer)
}
