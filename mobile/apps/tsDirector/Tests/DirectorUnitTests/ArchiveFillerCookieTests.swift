import Foundation
import DirectorDVR
import Testing

// The silent-fill packet carries its own AudioSpecificConfig. A fixed 0x11 0x90 — the value this
// was born with — claims 48 kHz stereo, which is right for none of the mono cameras and none of the
// 32 kHz ones, so the packet handed to the muxer described a track it was not joining.
@Suite("Archive filler cookie")
struct ArchiveFillerCookieTests {
  @Test("48 kHz stereo is the classic 0x11 0x90")
  func stereo48() {
    #expect(ArchiveFiller.audioSpecificConfig(sampleRate: 48_000, channels: 2) == Data([0x11, 0x90]))
  }

  @Test("48 kHz mono differs from stereo in the channel field alone")
  func mono48() {
    #expect(ArchiveFiller.audioSpecificConfig(sampleRate: 48_000, channels: 1) == Data([0x11, 0x88]))
  }

  @Test("32 kHz stereo, which is what the fixed cookie got wrong for three cameras")
  func stereo32() {
    #expect(ArchiveFiller.audioSpecificConfig(sampleRate: 32_000, channels: 2) == Data([0x12, 0x90]))
  }

  @Test("An unlisted rate falls back to 48 kHz rather than emitting a nonsense index")
  func unknownRate() {
    #expect(ArchiveFiller.audioSpecificConfig(sampleRate: 37_000, channels: 2) == Data([0x11, 0x90]))
  }
}
