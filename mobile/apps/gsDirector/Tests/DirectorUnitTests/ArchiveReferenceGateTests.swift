import Foundation
import Testing
@testable import DirectorRTSP

@Suite("Archive reference gate")
struct ArchiveReferenceGateTests {
  /// Runs pictures through a gate, each as (isKeyframe, isCorrupt), and returns what it admitted.
  private func admitted(_ pictures: [(Bool, Bool)], gate: inout ArchiveReferenceGate) -> [Bool] {
    pictures.map { gate.admit(isKeyframe: $0.0, isCorrupt: $0.1) }
  }

  @Test("An unbroken stream archives every picture")
  func unbrokenStreamPasses() {
    var gate = ArchiveReferenceGate()
    let result = admitted([(true, false), (false, false), (false, false), (true, false), (false, false)], gate: &gate)
    #expect(result == [true, true, true, true, true])
  }

  /// rec-404: a flushed send queue dropped whole pictures, and the intact ones after them were
  /// archived and could not be decoded.
  @Test("After a damaged picture nothing is archived until the next keyframe")
  func waitsForKeyframeAfterLoss() {
    var gate = ArchiveReferenceGate()
    let result = admitted(
      [(true, false), (false, false), (false, true), (false, false), (false, false), (true, false), (false, false)],
      gate: &gate
    )
    #expect(result == [true, true, false, false, false, true, true])
    #expect(gate.skipped == 2)
  }

  @Test("A damaged keyframe does not reopen the archive")
  func damagedKeyframeKeepsWaiting() {
    var gate = ArchiveReferenceGate()
    let result = admitted([(true, true), (false, false), (true, false)], gate: &gate)
    #expect(result == [false, false, true])
  }

  @Test("A new session starts clean")
  func resetClears() {
    var gate = ArchiveReferenceGate()
    _ = admitted([(false, true)], gate: &gate)
    gate.reset()
    #expect(admitted([(false, false)], gate: &gate) == [true])
  }
}
