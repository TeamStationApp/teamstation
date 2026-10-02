import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import DirectorSources

/// Feeds one camera's `AVSampleBufferDisplayLayer`s (main tile and thumbnail) from
/// decoded `PixelFrame`s.
public final class PreviewRenderer: @unchecked Sendable {
  private final class WeakLayer {
    weak var layer: AVSampleBufferDisplayLayer?
    init(_ layer: AVSampleBufferDisplayLayer) { self.layer = layer }
  }

  private let lock = NSLock()
  private var layers: [WeakLayer] = []
  private var formatDescription: CMFormatDescription?
  private var lastPixelFormat: OSType = 0
  private var lastDimensions = CMVideoDimensions(width: 0, height: 0)

  public init() {}

  public func attach(layer: AVSampleBufferDisplayLayer?) {
    guard let layer else { return }
    lock.lock()
    layers.removeAll { $0.layer == nil || $0.layer === layer }
    layers.append(WeakLayer(layer))
    lock.unlock()
  }

  public func detach(layer: AVSampleBufferDisplayLayer?) {
    lock.lock()
    layers.removeAll { $0.layer == nil || $0.layer === layer }
    lock.unlock()
  }

  @discardableResult
  public func enqueue(_ frame: PixelFrame) -> Bool {
    enqueue(pixelBuffer: frame.pixelBuffer, presentationTime: frame.presentationTime)
  }

  @discardableResult
  public func enqueue(pixelBuffer: CVPixelBuffer, presentationTime: CMTime) -> Bool {
    lock.lock()
    let targets = layers.compactMap(\.layer)
    let dimensions = CMVideoDimensions(
      width: Int32(CVPixelBufferGetWidth(pixelBuffer)),
      height: Int32(CVPixelBufferGetHeight(pixelBuffer))
    )
    let pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer)
    if formatDescription == nil
      || pixelFormat != lastPixelFormat
      || dimensions.width != lastDimensions.width
      || dimensions.height != lastDimensions.height {
      var created: CMFormatDescription?
      let status = CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: kCFAllocatorDefault,
        imageBuffer: pixelBuffer,
        formatDescriptionOut: &created
      )
      guard status == noErr, let created else {
        lock.unlock()
        return false
      }
      formatDescription = created
      lastPixelFormat = pixelFormat
      lastDimensions = dimensions
    }
    let formatDescription = self.formatDescription
    lock.unlock()

    guard !targets.isEmpty, let formatDescription else { return false }

    var enqueued = false
    for layer in targets {
      guard let sampleBuffer = Self.makeSampleBuffer(
        pixelBuffer: pixelBuffer,
        formatDescription: formatDescription,
        presentationTime: presentationTime
      ) else { continue }
      let renderer = layer.sampleBufferRenderer
      renderer.flush(removingDisplayedImage: false)
      renderer.enqueue(sampleBuffer)
      enqueued = true
    }
    return enqueued
  }

  private static func makeSampleBuffer(
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
    guard status == noErr, let sampleBuffer else { return nil }

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
    return sampleBuffer
  }
}
