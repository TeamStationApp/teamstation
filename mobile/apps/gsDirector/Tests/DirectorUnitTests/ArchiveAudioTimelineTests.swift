import CoreMedia
import Testing
@testable import DirectorDVR

@Suite("Archive audio timeline")
struct ArchiveAudioTimelineTests {
  @Test("A source-clock jump leaves a gap from the previous end to the next start")
  func sourceJumpLeavesGap() {
    var timeline = ArchiveAudioTimeline()
    let duration = CMTime(value: 1024, timescale: 48_000)
    _ = timeline.place(sourceTime: .zero, duration: duration, videoTime: .zero)
    let end = timeline.endTime
    let later = CMTime(seconds: 8, preferredTimescale: 48_000)
    let placed = timeline.place(sourceTime: later, duration: duration, videoTime: later)
    #expect(end != nil)
    #expect(placed != nil)
    let gap = CMTimeSubtract(placed!.start, end!).seconds
    #expect(gap > 7.5)
    #expect(gap < 8.5)
  }
}
