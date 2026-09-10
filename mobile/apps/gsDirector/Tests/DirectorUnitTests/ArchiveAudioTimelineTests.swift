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

  /// rec-323: every three-second segment re-anchored its audio to whatever the video was doing when
  /// the first audio buffer was written, so audio that arrived steadily later drifted the export by
  /// 129 ms per 1,000 s. With one anchor for the whole recording, a later segment places audio by
  /// the source's own clock however late it is written.
  @Test("A later segment places audio by the source clock, not by when it arrived")
  func laterSegmentFollowsSourceClock() {
    let duration = CMTime(value: 1024, timescale: 48_000)
    let anchor = ArchiveAudioTimeline.WallAnchor(sourceSeconds: 100, wallSeconds: 1_000)
    // Segment two starts at wall 1_003. Its first audio buffer was captured at source 103.02, i.e.
    // wall 1_003.02, but is written when the video is already 90 ms further on.
    var segment = ArchiveAudioTimeline()
    let placed = segment.place(
      sourceTime: CMTime(seconds: 103.02, preferredTimescale: 48_000),
      duration: duration,
      videoTime: CMTime(seconds: 0.11, preferredTimescale: 90_000),
      wallAnchor: anchor,
      segmentBaseWall: 1_003
    )
    #expect(placed != nil)
    #expect(abs((placed?.start.seconds ?? 0) - 0.02) < 0.001, "placed at \(placed?.start.seconds ?? -1)")
  }

  @Test("Without an anchor the timeline behaves as it always has")
  func noAnchorIsUnchanged() {
    let duration = CMTime(value: 1024, timescale: 48_000)
    var timeline = ArchiveAudioTimeline()
    let first = timeline.place(sourceTime: CMTime(seconds: 50, preferredTimescale: 48_000), duration: duration, videoTime: CMTime(seconds: 0.2, preferredTimescale: 90_000))
    #expect(abs((first?.start.seconds ?? 0) - 0.2) < 0.001)
  }
}
