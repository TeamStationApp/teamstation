import Foundation
import DirectorPipeline
import Testing

@Suite("Shed keyframe requests")
struct ShedKeyframeRequestTests {
  /// Whether each drop, at the times given, asked for a keyframe.
  private func asks(_ times: [Double]) -> [Bool] {
    var requests = ShedKeyframeRequest()
    return times.map { requests.shouldRequest(now: $0) }
  }

  @Test("The first drop of a wait asks for a keyframe")
  func firstDropAsks() {
    #expect(asks([ 100 ]) == [ true ])
  }

  @Test("A picture-rate run of drops asks once a second, not once a picture")
  func dropsAtFrameRateAskOnceASecond() {
    // Ten seconds of 60 fps pictures, every one dropped while the link is stuck.
    let asked = asks((0 ..< 600).map { 100 + Double($0) / 60 })
    #expect(asked.filter { $0 }.count == 10)
  }

  @Test("A drop a second or more after the last request asks again")
  func askAgainAfterTheInterval() {
    #expect(asks([ 100, 100.999, 100 + ShedKeyframeRequest.minimumInterval ]) == [ true, false, true ])
  }

  @Test("A clock that stepped back does not hold requests off")
  func clockSteppedBack() {
    #expect(asks([ 100, 40, 40.5 ]) == [ true, true, false ])
  }
}
