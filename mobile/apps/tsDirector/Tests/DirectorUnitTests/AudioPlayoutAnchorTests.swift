import Foundation
import DirectorSources
import Testing

@Suite("Audio playout anchor")
struct AudioPlayoutAnchorTests {
  /// One 48 kHz AAC access unit.
  private static let unit = 1_024.0 / 48_000

  @Test("Sound the mix can take keeps the picture's timing")
  func usableDueTimePassesThrough() {
    var anchor = AudioPlayoutAnchor()
    let result = anchor.schedule(due: 100.3, nowUptime: 100, holdSeconds: 0.3)
    #expect(result.due == 100.3)
    #expect(!result.reanchored)
    #expect(anchor.correction == nil)
  }

  /// rec-361: First's picture fell 7.4 s behind its sound, so every sample came due seconds ahead
  /// and the delay queue dropped all of them before any came due.
  @Test("Sound the picture has fallen seconds behind is re-anchored once and then runs on its own timeline")
  func soundFarAheadIsReanchoredOnce() {
    var anchor = AudioPlayoutAnchor()
    var reanchors = 0
    var leads: [Double] = []
    for index in 0 ..< 200 {
      let now = 100 + Double(index) * Self.unit
      let result = anchor.schedule(due: now + 7, nowUptime: now, holdSeconds: 0.3)
      if result.reanchored { reanchors += 1 }
      leads.append(result.due - now)
    }
    #expect(reanchors == 1)
    #expect(leads.allSatisfy { abs($0 - 0.3) < 0.000_1 }, "leads \(Set(leads))")
  }

  @Test("Sound that arrives after its due time is re-anchored rather than refused as late")
  func soundPastDueIsReanchored() {
    var anchor = AudioPlayoutAnchor()
    let result = anchor.schedule(due: 98.5, nowUptime: 100, holdSeconds: 0.3)
    #expect(result.reanchored)
    #expect(abs(result.due - 100.3) < 0.000_1)
  }

  @Test("Once the picture's timing is usable again the sound goes back onto it")
  func returnsToThePictureTiming() {
    var anchor = AudioPlayoutAnchor()
    _ = anchor.schedule(due: 107, nowUptime: 100, holdSeconds: 0.3)
    #expect(anchor.correction != nil)

    let result = anchor.schedule(due: 101.4, nowUptime: 101, holdSeconds: 0.3)
    #expect(result.due == 101.4)
    #expect(!result.reanchored)
    #expect(anchor.correction == nil)
  }

  @Test("A correction the picture's timing has moved out of the window is taken again")
  func staleCorrectionIsRetaken() {
    var anchor = AudioPlayoutAnchor()
    _ = anchor.schedule(due: 107, nowUptime: 100, holdSeconds: 0.3)
    // The picture's offset grew by another five seconds.
    let result = anchor.schedule(due: 112.1, nowUptime: 100.1, holdSeconds: 0.3)
    #expect(result.reanchored)
    #expect(abs(result.due - 100.4) < 0.000_1)
  }

  @Test("A hold longer than the window allows does not push the sound out of it")
  func holdIsCapped() {
    var anchor = AudioPlayoutAnchor()
    let result = anchor.schedule(due: 110, nowUptime: 100, holdSeconds: 5)
    #expect(AudioPlayoutAnchor.accepts(result.due, now: 100))
  }
}
