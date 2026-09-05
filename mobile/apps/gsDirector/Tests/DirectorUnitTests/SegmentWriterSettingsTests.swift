import Foundation
import DirectorDVR
import Testing

// This suite tested `SegmentWriterSettings.shouldIncludeAudio` and `.sequenceBeforeNextFile`,
// neither of which exists any more: `37f667e` reverted the wall-clock archive writer and took both
// statics with it.
//
// The audio decision itself survives, but inlined at the call site as
// `includesAudio: pipeline.hasDeliveredAudio && launch.archiveAudio` in `DirectorUI.AppEnvironment`
// — a camera that never sends audio must not be given an audio track, because a segmented writer
// will not rotate a segment until every track reaches the boundary and the video input then goes
// permanently unready.
//
// That rule deserves a home and a test rather than a line in a view model, and Phase 5 of
// /Users/dev/agent-notes has to touch it anyway: it only covers
// the never-had-audio case, and a camera whose audio starts and then gaps is still unhandled.
// **Phase 5 owes this file a restored helper and its cases.**
@Suite("Segment writer settings")
struct SegmentWriterSettingsTests {
  @Test("Placeholder until Phase 5 restores the audio-inclusion helper")
  func pending() {
    #expect(SegmentWriterSettings(segmentSeconds: 3, includesAudio: true).includesAudio)
  }
}
