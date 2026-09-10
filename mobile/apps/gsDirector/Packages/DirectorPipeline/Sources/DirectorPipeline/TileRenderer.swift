import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import DirectorSources

/// Feeds one tile's `AVSampleBufferDisplayLayer` (D3).
///
/// The layer is attached from the main actor when the view appears and detached when it goes
/// away; frames arrive on the source's own queue and are enqueued directly. Nothing about the
/// frame path touches the main actor, which is the point (I6).
public final class TileRenderer: @unchecked Sendable {
  private let lock = NSLock()
  private weak var layer: AVSampleBufferDisplayLayer?
  /// Extra monitors (the camera picker thumbnail) that must not steal the grid tile's layer.
  private let previewLayers = NSHashTable<AVSampleBufferDisplayLayer>.weakObjects()
  /// Programme overlay for Picture-in-Picture. Same enqueue path as the Output tile.
  private weak var pictureInPictureLayer: AVSampleBufferDisplayLayer?
  private var formatDescription: CMFormatDescription?
  private var lastPixelFormat: OSType = 0
  private var lastDimensions = CMVideoDimensions(width: 0, height: 0)
  private var isPaused = false
  private var failCountsStorage = TileEnqueueFails()

  public var failCounts: TileEnqueueFails {
    lock.lock()
    defer { lock.unlock() }
    return failCountsStorage
  }

  public init() {}

  public func attach(layer: AVSampleBufferDisplayLayer?) {
    lock.lock()
    self.layer = layer
    lock.unlock()
  }

  public var attachedLayer: AVSampleBufferDisplayLayer? {
    lock.lock()
    defer { lock.unlock() }
    return layer
  }

  public func attachPreview(_ layer: AVSampleBufferDisplayLayer) {
    lock.lock()
    previewLayers.add(layer)
    lock.unlock()
  }

  public func detachPreview(_ layer: AVSampleBufferDisplayLayer) {
    lock.lock()
    previewLayers.remove(layer)
    lock.unlock()
  }

  public func attachPictureInPicture(_ layer: AVSampleBufferDisplayLayer) {
    lock.lock()
    pictureInPictureLayer = layer
    lock.unlock()
    var timebase: CMTimebase?
    CMTimebaseCreateWithSourceClock(
      allocator: kCFAllocatorDefault,
      sourceClock: CMClockGetHostTimeClock(),
      timebaseOut: &timebase
    )
    if let timebase {
      CMTimebaseSetTime(timebase, time: CMClockGetTime(CMClockGetHostTimeClock()))
      CMTimebaseSetRate(timebase, rate: 1.0)
      layer.controlTimebase = timebase
    }
  }

  public func detachPictureInPicture(_ layer: AVSampleBufferDisplayLayer) {
    lock.lock()
    if pictureInPictureLayer === layer {
      pictureInPictureLayer = nil
    }
    lock.unlock()
  }

  /// While a tile is scrubbing, live frames must keep being received, converted, proxied and
  /// archived — they simply must not reach the screen. Pausing here rather than upstream is
  /// what guarantees the timeline being scrubbed has no hole in it.
  public func setPaused(_ paused: Bool) {
    lock.lock()
    isPaused = paused
    lock.unlock()
  }

  public func flush() {
    for layer in snapshotLayers() {
      layer.sampleBufferRenderer.flush(removingDisplayedImage: false)
    }
  }

  /// Live frames after replay often share NV12 dimensions with the replay buffers but come from a
  /// different pixel-buffer pool. The cached `CMFormatDescription` then makes
  /// `CMSampleBufferCreateReadyWithImageBuffer` fail, which leaves the small preview frozen while
  /// the program compositor — a different format — keeps moving. Keep the last replay frame on
  /// screen until a live sample actually enqueues, so returning to live is not a blank gap.
  public func prepareForLive() {
    lock.lock()
    isPaused = false
    clearFormatCacheLocked()
    lock.unlock()
    for layer in snapshotLayers() {
      layer.sampleBufferRenderer.flush(removingDisplayedImage: false)
    }
  }

  public func invalidateFormatCache() {
    lock.lock()
    clearFormatCacheLocked()
    lock.unlock()
  }

  @discardableResult
  public func enqueue(_ frame: PixelFrame) -> Bool {
    enqueue(pixelBuffer: frame.pixelBuffer, presentationTime: frame.presentationTime)
  }

  @discardableResult
  public func enqueue(pixelBuffer: CVPixelBuffer, presentationTime: CMTime) -> Bool {
    autoreleasepool {
      enqueueUnpooled(pixelBuffer: pixelBuffer, presentationTime: presentationTime)
    }
  }

  private func enqueueUnpooled(pixelBuffer: CVPixelBuffer, presentationTime: CMTime) -> Bool {
    lock.lock()
    guard !isPaused else {
      failCountsStorage.paused += 1
      lock.unlock()
      return false
    }
    let layers = displayLayersLocked()
    let pipLayer = pictureInPictureLayer
    guard !layers.isEmpty || pipLayer != nil else {
      failCountsStorage.noLayer += 1
      lock.unlock()
      return false
    }

    let dimensions = CMVideoDimensions(
      width: Int32(CVPixelBufferGetWidth(pixelBuffer)),
      height: Int32(CVPixelBufferGetHeight(pixelBuffer))
    )
    let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
    if formatDescription == nil
      || pixelFormat != lastPixelFormat
      || dimensions.width != lastDimensions.width
      || dimensions.height != lastDimensions.height {
      guard let created = makeFormatDescriptionLocked(for: pixelBuffer) else {
        lock.unlock()
        return false
      }
      formatDescription = created
      lastPixelFormat = pixelFormat
      lastDimensions = dimensions
    }
    var formatDescription = self.formatDescription
    lock.unlock()

    guard var formatDescription else { return false }

    var sampleBuffer = makeSampleBuffer(
      pixelBuffer: pixelBuffer,
      formatDescription: formatDescription,
      presentationTime: presentationTime
    )
    if sampleBuffer == nil {
      lock.lock()
      guard let rebuilt = makeFormatDescriptionLocked(for: pixelBuffer) else {
        lock.unlock()
        return false
      }
      self.formatDescription = rebuilt
      lastPixelFormat = pixelFormat
      lastDimensions = dimensions
      formatDescription = rebuilt
      lock.unlock()
      sampleBuffer = makeSampleBuffer(
        pixelBuffer: pixelBuffer,
        formatDescription: rebuilt,
        presentationTime: presentationTime
      )
    }
    guard let sampleBuffer else { return false }

    // Display immediately rather than scheduling against the layer's timebase: this is a live
    // monitor, so the newest frame is always the right one to show.
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true),
       CFArrayGetCount(attachments) > 0 {
      let raw = CFArrayGetValueAtIndex(attachments, 0)
      let dictionary = unsafeBitCast(raw, to: CFMutableDictionary.self)
      CFDictionarySetValue(
        dictionary,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
      )
    }

    for layer in layers {
      enqueue(sampleBuffer, onto: layer)
    }
    enqueueToPictureInPicture(pixelBuffer: pixelBuffer, formatDescription: formatDescription)
    return true
  }

  private func enqueueToPictureInPicture(
    pixelBuffer: CVPixelBuffer,
    formatDescription: CMFormatDescription
  ) {
    lock.lock()
    let layer = pictureInPictureLayer
    lock.unlock()
    guard let layer else { return }
    let time = CMClockGetTime(CMClockGetHostTimeClock())
    guard let sampleBuffer = makeSampleBuffer(
      pixelBuffer: pixelBuffer,
      formatDescription: formatDescription,
      presentationTime: time,
      duration: CMTime(value: 1, timescale: 30)
    ) else { return }
    enqueue(sampleBuffer, onto: layer)
  }

  private func enqueue(_ sampleBuffer: CMSampleBuffer, onto layer: AVSampleBufferDisplayLayer) {
    let renderer = layer.sampleBufferRenderer
    // A live monitor only needs the current picture. Enqueueing DisplayImmediately samples
    // without flushing first lets the layer keep every pixel buffer it has not yet retired,
    // which is how four 1080p tiles climb hundreds of megabytes a minute.
    renderer.flush(removingDisplayedImage: false)
    renderer.enqueue(sampleBuffer)

    let now = Date().timeIntervalSince1970
    let failed = renderer.status == .failed
    let needsFlush = renderer.requiresFlushToResumeDecoding
    // Read the error before taking the lock: it crosses into AVFoundation and there is no reason
    // to hold every other tile's enqueue while it does.
    let description = failed ? Self.describe(renderer.error) : ""

    lock.lock()
    failCountsStorage.lastEnqueueAt = now
    if needsFlush { failCountsStorage.requiresFlush &+= 1 }
    if failed || needsFlush {
      failCountsStorage.rendererFailed &+= 1
      if failed, failCountsStorage.lastRendererError != description {
        // Kept verbatim and stamped. A failed renderer swallows every later sample in silence, so
        // this line is the only account of why a tile stopped moving while its arrivals climbed.
        failCountsStorage.lastRendererError = description
        failCountsStorage.lastRendererFailureAt = now
      }
    }
    lock.unlock()
  }

  /// Renders a renderer error into something a `dump-state` reader can act on.
  ///
  /// Domain and code first, because those are what a search matches; the message is often generic
  /// where the pair is specific.
  private static func describe(_ error: Error?) -> String {
    guard let error else { return "failed with no error reported" }
    let ns = error as NSError
    return "\(ns.domain) \(ns.code): \(ns.localizedDescription)"
  }

  private func snapshotLayers() -> [AVSampleBufferDisplayLayer] {
    lock.lock()
    defer { lock.unlock() }
    var layers = displayLayersLocked()
    if let pictureInPictureLayer { layers.append(pictureInPictureLayer) }
    return layers
  }

  private func displayLayersLocked() -> [AVSampleBufferDisplayLayer] {
    var layers: [AVSampleBufferDisplayLayer] = []
    if let layer { layers.append(layer) }
    layers.append(contentsOf: previewLayers.allObjects)
    return layers
  }

  private func clearFormatCacheLocked() {
    formatDescription = nil
    lastPixelFormat = 0
    lastDimensions = CMVideoDimensions(width: 0, height: 0)
  }

  private func makeFormatDescriptionLocked(for pixelBuffer: CVPixelBuffer) -> CMFormatDescription? {
    var created: CMFormatDescription?
    let status = CMVideoFormatDescriptionCreateForImageBuffer(
      allocator: kCFAllocatorDefault,
      imageBuffer: pixelBuffer,
      formatDescriptionOut: &created
    )
    guard status == noErr else {
      failCountsStorage.formatDesc += 1
      failCountsStorage.lastSampleBufferStatus = status
      return nil
    }
    return created
  }

  private func makeSampleBuffer(
    pixelBuffer: CVPixelBuffer,
    formatDescription: CMFormatDescription,
    presentationTime: CMTime,
    duration: CMTime = .invalid
  ) -> CMSampleBuffer? {
    var timing = CMSampleTimingInfo(
      duration: duration,
      presentationTimeStamp: presentationTime,
      decodeTimeStamp: .invalid
    )
    var sampleBuffer: CMSampleBuffer?
    let status = CMSampleBufferCreateReadyWithImageBuffer(
      allocator: kCFAllocatorDefault,
      imageBuffer: pixelBuffer,
      formatDescription: formatDescription,
      sampleTiming: &timing,
      sampleBufferOut: &sampleBuffer
    )
    guard status == noErr else {
      lock.lock()
      failCountsStorage.sampleBuffer += 1
      failCountsStorage.lastSampleBufferStatus = status
      lock.unlock()
      return nil
    }
    return sampleBuffer
  }
}
