import CameramanEncode
import Testing

@Suite("Video encoder blank IDR")
struct VideoEncoderKeyframeTests {
  @Test("The first blank frame and the first live frame after it both force a keyframe")
  func blankTransitionForcesKeyframe() {
    #expect(VideoEncoder.shouldForceKeyframe(blank: true, wasBlank: false))
    #expect(VideoEncoder.shouldForceKeyframe(blank: false, wasBlank: true))
    #expect(!VideoEncoder.shouldForceKeyframe(blank: true, wasBlank: true))
    #expect(!VideoEncoder.shouldForceKeyframe(blank: false, wasBlank: false))
  }
}
