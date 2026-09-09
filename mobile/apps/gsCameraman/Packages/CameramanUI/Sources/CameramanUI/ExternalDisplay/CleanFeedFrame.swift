import CoreMedia
import CoreVideo
import Foundation

/// Turns a capture frame into one an `AVSampleBufferDisplayLayer` shows at once.
///
/// The capture buffer is shared with the encoder, which reads it on its own queue after this
/// closure returns, so nothing here touches it: the display gets a new `CMSampleBuffer` that
/// references the same pixels. `DisplayImmediately` is set on the copy because the layer would
/// otherwise schedule the picture against its own timebase, which is not the capture clock, and
/// hold it.
public enum CleanFeedFrame {
  /// `image` replaces the sample's own picture (black when video is off); it must match
  /// `formatDescription`. Nil for both uses the sample's own picture and description.
  public static func displayable(
    _ sample: CMSampleBuffer,
    image: CVPixelBuffer? = nil,
    formatDescription: CMVideoFormatDescription? = nil
  ) -> CMSampleBuffer? {
    guard let pixels = image ?? CMSampleBufferGetImageBuffer(sample),
          let description = formatDescription ?? CMSampleBufferGetFormatDescription(sample)
    else { return nil }
    var timing = CMSampleTimingInfo(
      duration: CMSampleBufferGetDuration(sample),
      presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sample),
      decodeTimeStamp: .invalid
    )
    var created: CMSampleBuffer?
    guard CMSampleBufferCreateReadyWithImageBuffer(
      allocator: kCFAllocatorDefault,
      imageBuffer: pixels,
      formatDescription: description,
      sampleTiming: &timing,
      sampleBufferOut: &created
    ) == noErr, let created else { return nil }
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(created, createIfNecessary: true),
          CFArrayGetCount(attachments) > 0
    else { return nil }
    let first = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
    CFDictionarySetValue(
      first,
      Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
      Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
    )
    return created
  }

  /// Whether `sample` carries the attachment, for the tests and for anyone debugging a held frame.
  public static func displaysImmediately(_ sample: CMSampleBuffer) -> Bool {
    guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
          let first = (attachments as NSArray).firstObject as? NSDictionary
    else { return false }
    return first[kCMSampleAttachmentKey_DisplayImmediately as String] as? Bool ?? false
  }

  /// A format description for a substitute picture, created once per black buffer rather than per
  /// frame.
  public static func formatDescription(for image: CVPixelBuffer) -> CMVideoFormatDescription? {
    var description: CMVideoFormatDescription?
    guard CMVideoFormatDescriptionCreateForImageBuffer(
      allocator: kCFAllocatorDefault,
      imageBuffer: image,
      formatDescriptionOut: &description
    ) == noErr else { return nil }
    return description
  }
}
