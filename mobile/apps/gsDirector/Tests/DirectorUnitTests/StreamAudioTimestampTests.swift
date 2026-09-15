import Testing
@testable import DirectorPipeline

@Suite("Stream sound timestamps")
struct StreamAudioTimestampTests {
  @Test("Packets from one buffer are a packet apart, the last of them at the moment sent")
  func packetApart() {
    // A packet is 1024 frames at 48 kHz: 21.33 ms.
    #expect(ProgramStreamer.audioTimestamps(count: 3, newest: 1_000, after: nil) == [ 957, 979, 1_000 ])
  }

  @Test("No packet is at or before the one sent last")
  func alwaysAfterThePrevious() {
    #expect(ProgramStreamer.audioTimestamps(count: 2, newest: 1_000, after: 995) == [ 1_016, 1_037 ])
    #expect(ProgramStreamer.audioTimestamps(count: 1, newest: 1_000, after: 1_000) == [ 1_021 ])
  }

  @Test("A buffer too short for a packet stamps nothing")
  func nothingToStamp() {
    #expect(ProgramStreamer.audioTimestamps(count: 0, newest: 1_000, after: 900).isEmpty)
  }
}
