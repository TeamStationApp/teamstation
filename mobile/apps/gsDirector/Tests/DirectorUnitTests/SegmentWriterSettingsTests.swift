import Foundation
import DirectorDVR
import Testing

@Suite("Segment writer settings")
struct SegmentWriterSettingsTests {
  @Test("Audio stays on after a reopen once it has been seen")
  func includesAudioAfterReopen() {
    #expect(
      SegmentWriterSettings.shouldIncludeAudio(
        archiveAudioEnabled: true,
        hasDeliveredAudio: false,
        previousWriterIncludesAudio: true
      )
    )
    #expect(
      SegmentWriterSettings.shouldIncludeAudio(
        archiveAudioEnabled: true,
        hasDeliveredAudio: true,
        previousWriterIncludesAudio: false
      )
    )
    #expect(
      !SegmentWriterSettings.shouldIncludeAudio(
        archiveAudioEnabled: true,
        hasDeliveredAudio: false,
        previousWriterIncludesAudio: false
      )
    )
    #expect(
      !SegmentWriterSettings.shouldIncludeAudio(
        archiveAudioEnabled: false,
        hasDeliveredAudio: true,
        previousWriterIncludesAudio: true
      )
    )
  }

  @Test("A replacement writer uses the last sequence, not max plus one")
  func sequenceDoesNotSkipOnReopen() {
    #expect(SegmentWriterSettings.sequenceBeforeNextFile(maxExisting: -1) == 0)
    #expect(SegmentWriterSettings.sequenceBeforeNextFile(maxExisting: 0) == 0)
    #expect(SegmentWriterSettings.sequenceBeforeNextFile(maxExisting: 196) == 196)
  }
}
