import Foundation
import Testing
import DirectorSources

@Suite("Subnet scan pacing")
struct SubnetScanPacingTests {
  /// Five every 200 ms is a /24 in about ten seconds. The numbers matter: every probe of an empty
  /// address is an ARP broadcast the whole segment has to process, and firing 254 of them as fast
  /// as the sockets allow was measured stalling a camera's delivery for over a second.
  @Test("A paced sweep spreads a /24 over about ten seconds")
  func paceCoversASlashTwentyFourInTenSeconds() {
    let hosts = 254.0
    let batches = (hosts / Double(SubnetScanner.pacedBatchSize)).rounded(.up)
    let seconds = batches * Double(SubnetScanner.pacedGapMilliseconds) / 1000
    #expect(SubnetScanner.pacedBatchSize == 5)
    #expect(SubnetScanner.pacedGapMilliseconds == 200)
    #expect(seconds >= 9 && seconds <= 11, "a /24 would take \(seconds)s")
  }

  @Test("The paced batch is far smaller than the unpaced one")
  func pacedBatchIsSmallerThanConcurrency() {
    // The unpaced path still opens as many sockets as it safely can; that path is only used for
    // the handful of addresses already known to hold a camera.
    #expect(SubnetScanner.pacedBatchSize < 32)
  }
}
