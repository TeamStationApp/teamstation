import DirectorUI
import Testing

@Suite("A Cameraman's stated frame rate")
struct CameraFrameRateQueryTests {
  @Test("The rate is read from its own line of the reply")
  func readsTheRate() {
    #expect(CameraFrameRateQuery.frameRate(in: "videoEncoder.rateControl.frameRateLimit: 60\r\n") == 60)
    let body = """
    videoEncoder.encoding: hevc
    videoEncoder.rateControl.frameRateLimit: 29.97
    videoEncoder.resolution.width: 1920
    """
    #expect(CameraFrameRateQuery.frameRate(in: body) == 29.97)
  }

  @Test("A reply without the rate, or with a nonsense one, says nothing")
  func missingOrNonsense() {
    #expect(CameraFrameRateQuery.frameRate(in: "") == nil)
    #expect(CameraFrameRateQuery.frameRate(in: "videoEncoder.encoding: hevc") == nil)
    #expect(CameraFrameRateQuery.frameRate(in: "videoEncoder.rateControl.frameRateLimit: 0") == nil)
    #expect(CameraFrameRateQuery.frameRate(in: "videoEncoder.rateControl.frameRateLimit: fast") == nil)
  }
}
