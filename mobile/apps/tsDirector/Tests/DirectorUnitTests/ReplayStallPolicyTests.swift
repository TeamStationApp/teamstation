import DirectorPipeline
import Foundation
import Testing

@Suite("Replay stall policy")
struct ReplayStallPolicyTests {
  private let policy = ReplayStallPolicy(timeout: 2)

  @Test("No picture yet does not finish")
  func noPictureYetDoesNotFinish() {
    #expect(!policy.shouldFinish(now: 100, lastDeliveredAt: 0))
  }

  @Test("A fresh frame does not finish")
  func freshFrameDoesNotFinish() {
    #expect(!policy.shouldFinish(now: 100, lastDeliveredAt: 99.5))
  }

  @Test("Two seconds without a frame finishes")
  func twoSecondsWithoutAFrameFinishes() {
    #expect(policy.shouldFinish(now: 100, lastDeliveredAt: 98))
  }

  @Test("Just under the timeout keeps waiting")
  func justUnderTimeoutKeepsWaiting() {
    #expect(!policy.shouldFinish(now: 100, lastDeliveredAt: 98.05))
  }
}
