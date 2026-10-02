import AVFoundation
import CameramanEncode
import CoreMedia
import CoreVideo
import Foundation
import Testing

@testable import CameramanUI

/// What can be settled without a display attached: which mode is chosen, what a blank frame becomes,
/// and that the frame handed to the layer is a new buffer over the same pixels, marked to show now.
@Suite("Clean feed")
struct CleanFeedTests {
  private static let hd = CGSize(width: 1920, height: 1080)

  /// A capture-shaped frame: bi-planar video-range 4:2:0, the format the camera delivers.
  private static func captureFrame(width: Int = 64, height: Int = 36) throws -> CMSampleBuffer {
    var pixels: CVPixelBuffer?
    #expect(CVPixelBufferCreate(
      kCFAllocatorDefault, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &pixels
    ) == kCVReturnSuccess)
    let image = try #require(pixels)
    let description = try #require(CleanFeedFrame.formatDescription(for: image))
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: 30),
      presentationTimeStamp: CMTime(value: 7, timescale: 30),
      decodeTimeStamp: .invalid
    )
    var sample: CMSampleBuffer?
    #expect(CMSampleBufferCreateReadyWithImageBuffer(
      allocator: kCFAllocatorDefault,
      imageBuffer: image,
      formatDescription: description,
      sampleTiming: &timing,
      sampleBufferOut: &sample
    ) == noErr)
    return try #require(sample)
  }

  @Test("The mode matching the stream wins, else the largest, and nothing is chosen from nothing")
  func modeSelection() {
    let modes = [ CGSize(width: 1280, height: 720), Self.hd, CGSize(width: 3840, height: 2160) ]
    #expect(CleanFeedController.modeIndex(matching: Self.hd, in: modes) == 1)
    #expect(CleanFeedController.modeIndex(matching: CGSize(width: 1280, height: 720), in: modes) == 0)
    // A 4K stream on a display that tops out at 1080p: the largest it has.
    #expect(CleanFeedController.modeIndex(matching: CGSize(width: 3840, height: 2160), in: [ modes[0], modes[1] ]) == 1)
    #expect(CleanFeedController.modeIndex(matching: Self.hd, in: []) == nil)
  }

  @Test("The display frame is a new sample over the capture pixels, marked to show immediately")
  func wrappedFrameSharesPixelsAndDisplaysImmediately() throws {
    let captured = try Self.captureFrame()
    let shown = try #require(CleanFeedFrame.displayable(captured))
    #expect(shown !== captured)
    #expect(CMSampleBufferGetImageBuffer(shown) === CMSampleBufferGetImageBuffer(captured))
    #expect(CMSampleBufferGetPresentationTimeStamp(shown) == CMSampleBufferGetPresentationTimeStamp(captured))
    #expect(CleanFeedFrame.displaysImmediately(shown))
    // The encoder reads the original after this returns; it must not have been touched.
    #expect(CleanFeedFrame.displaysImmediately(captured) == false)
  }

  @Test("A blank frame is black at the capture's size and format, and the black buffer is reused")
  func blankFramesAreCachedBlack() throws {
    let captured = try Self.captureFrame(width: 64, height: 36)
    let image = try #require(CMSampleBufferGetImageBuffer(captured))
    var cache = BlackFrameCache()
    let created = cache.buffer(matching: image)
    let black = try #require(created)
    #expect(black !== image)
    #expect(CVPixelBufferGetWidth(black) == 64)
    #expect(CVPixelBufferGetHeight(black) == 36)
    #expect(CVPixelBufferGetPixelFormatType(black) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    CVPixelBufferLockBaseAddress(black, .readOnly)
    let luma = try #require(CVPixelBufferGetBaseAddressOfPlane(black, 0)).assumingMemoryBound(to: UInt8.self)
    let chroma = try #require(CVPixelBufferGetBaseAddressOfPlane(black, 1)).assumingMemoryBound(to: UInt8.self)
    #expect(luma[0] == 16, "video-range black")
    #expect(chroma[0] == 128)
    CVPixelBufferUnlockBaseAddress(black, .readOnly)
    let again = cache.buffer(matching: image)
    #expect(again === black)
    let other = try #require(CMSampleBufferGetImageBuffer(try Self.captureFrame(width: 32, height: 18)))
    let smaller = cache.buffer(matching: other)
    #expect(smaller !== black)

    let shown = try #require(CleanFeedFrame.displayable(
      captured, image: black, formatDescription: CleanFeedFrame.formatDescription(for: black)
    ))
    #expect(CMSampleBufferGetImageBuffer(shown) === black)
    #expect(CleanFeedFrame.displaysImmediately(shown))
  }

  @Test("Frames are counted only while a layer is attached, and turning the feed off detaches it")
  @MainActor
  func gatingAndCounter() throws {
    let controller = CleanFeedController()
    let frame = try Self.captureFrame()
    #expect(controller.status == CleanFeedController.Status(connected: false, mode: nil, framesEnqueued: 0))

    controller.enqueue(SampleBufferRef(frame), blank: false)
    #expect(controller.status.framesEnqueued == 0, "no display, nothing to draw on")

    let view = CleanFeedLayerView()
    controller.sink.attach(view.displayLayer)
    controller.enqueue(SampleBufferRef(frame), blank: false)
    controller.enqueue(SampleBufferRef(frame), blank: true)
    #expect(controller.status.framesEnqueued == 2)

    controller.setEnabled(false)
    #expect(controller.isEnabled == false)
    #expect(controller.sink.isAttached == false)
    controller.enqueue(SampleBufferRef(frame), blank: false)
    #expect(controller.status.framesEnqueued == 2)
  }

  @Test("The stream size is remembered for the next display even with none connected")
  @MainActor
  func streamSizeIsKept() {
    let controller = CleanFeedController()
    controller.setStreamSize(width: 1280, height: 720)
    #expect(controller.streamSize == CGSize(width: 1280, height: 720))
    #expect(controller.status.connected == false)
  }
}
