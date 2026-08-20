import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ProducerSources

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
  private var formatDescription: CMFormatDescription?
  private var lastPixelFormat: OSType = 0
  private var lastDimensions = CMVideoDimensions(width: 0, height: 0)
  private var isPaused = false

  public init() {}

  public func attach(layer: AVSampleBufferDisplayLayer?) {
    lock.lock()
    self.layer = layer
    lock.unlock()
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
  /// the program compositor — a different format — keeps moving.
  public func prepareForLive() {
    lock.lock()
    isPaused = false
    clearFormatCacheLocked()
    lock.unlock()
    for layer in snapshotLayers() {
      layer.sampleBufferRenderer.flush(removingDisplayedImage: true)
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
    lock.lock()
    guard !isPaused else {
      lock.unlock()
      return false
    }
    let layers = displayLayersLocked()
    guard !layers.isEmpty else {
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
      guard let created = makeFormatDescription(for: pixelBuffer) else {
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
      guard let rebuilt = makeFormatDescription(for: pixelBuffer) else {
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
      let renderer = layer.sampleBufferRenderer
      if renderer.status == .failed {
        renderer.flush(removingDisplayedImage: false)
      }
      // A live monitor only needs the newest frame. Enqueueing every arrival while the display
      // daemon is behind is how 1080p IOSurfaces piled up in `mediaplaybackd` until jetsam killed
      // Producer and left the iPad unable to swipe. Cancel anything not yet shown, keep the current
      // image, then hand over this frame — but only when the renderer is already backed up. Flushing
      // on every frame is a stutter of its own.
      if !renderer.isReadyForMoreMediaData {
        renderer.flush(removingDisplayedImage: false)
      }
      renderer.enqueue(sampleBuffer)
    }
    return true
  }

  private func snapshotLayers() -> [AVSampleBufferDisplayLayer] {
    lock.lock()
    defer { lock.unlock() }
    return displayLayersLocked()
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

  private func makeFormatDescription(for pixelBuffer: CVPixelBuffer) -> CMFormatDescription? {
    var created: CMFormatDescription?
    let status = CMVideoFormatDescriptionCreateForImageBuffer(
      allocator: kCFAllocatorDefault,
      imageBuffer: pixelBuffer,
      formatDescriptionOut: &created
    )
    guard status == noErr else { return nil }
    return created
  }

  private func makeSampleBuffer(
    pixelBuffer: CVPixelBuffer,
    formatDescription: CMFormatDescription,
    presentationTime: CMTime
  ) -> CMSampleBuffer? {
    var timing = CMSampleTimingInfo(
      duration: .invalid,
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
    guard status == noErr else { return nil }
    return sampleBuffer
  }
}
