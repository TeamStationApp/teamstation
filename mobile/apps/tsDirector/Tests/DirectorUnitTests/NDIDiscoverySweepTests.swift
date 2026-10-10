import Foundation
import DirectorCore
import DirectorNDI
import DirectorSources
import Testing

@Suite("NDI discovery sweep participants")
struct NDIDiscoverySweepTests {
  private struct NoSource: Error {}

  private func discovery() -> NDIDiscovery {
    NDIDiscovery(
      configuration: NDIDiscovery.Configuration(showLocalSources: false),
      makeSource: { _, _ in throw NoSource() }
    )
  }

  @Test("Running alone, its own sweep takes a participant")
  func aloneTakesParticipant() {
    let ndi = discovery()
    // Nothing is looking yet, so nothing is swept; the participant only has to be taken.
    let participant = FakeParticipant(ports: [])
    #expect(ndi.addSweepParticipant(participant))
    #expect(ndi.addSweepParticipant(participant))
    ndi.requestSweep()
  }

  @Test("Under a shared sweep it has none of its own to join")
  func sharedRefusesParticipant() {
    let ndi = discovery()
    ndi.setSweepIsShared(true)
    #expect(ndi.addSweepParticipant(FakeParticipant(ports: [ 47614 ])) == false)
  }

  @Test("A participant added before start rides the sweeper it starts")
  func participantJoinsStartedSweeper() {
    let ndi = discovery()
    ndi.addSweepParticipant(FakeParticipant(ports: []))
    ndi.start { _ in }
    defer { ndi.stop() }
    if ndi.sweepDiagnostic != "sweep=off" {
      // The finder started, and with it the sweeper the participant joined.
      #expect(ndi.sweepDiagnostic.hasPrefix("sweeps=0"))
      ndi.addSweepParticipant(FakeParticipant(ports: []))
    }
  }
}
