import Testing

@testable import DirectorMedia
@testable import DirectorPipeline

/// Sound is stamped on its own clock, not on a wall clock.
///
/// An AAC packet is 1024 samples — 21.333 ms at 48 kHz — and RTMP carries whole milliseconds, so
/// the duration cannot be written exactly. Counting packets and rounding once at the end keeps the
/// error under half a millisecond for ever; measuring a clock per buffer does not, and what came
/// off the wire was runs of 19.5 to 20.5 ms with a 40 ms jump every third of a second.
struct StreamAudioTimestampTests {
  @Test func packetsAreOnePacketApart() {
    let stamps = ProgramStreamer.audioTimestamps(count: 3, from: 0, epoch: 1_000).compactMap { $0 }
    // 0, 21.333, 42.667 — rounded once, at the end.
    #expect(stamps == [1_000, 1_021, 1_043])
  }

  @Test func countingCarriesOnWhereItLeftOff() {
    let first = ProgramStreamer.audioTimestamps(count: 2, from: 0, epoch: 1_000).compactMap { $0 }
    let next = ProgramStreamer.audioTimestamps(count: 2, from: 2, epoch: 1_000).compactMap { $0 }
    #expect(first == [1_000, 1_021])
    #expect(next == [1_043, 1_064])
  }

  /// The one that matters: over a long stream the stamps must say exactly as much time as the
  /// samples contain, or a fMP4 track slips against its own sound and squeals.
  @Test func anHourOfSoundSaysAnHour() {
    let packets = 168_750  // an hour at 1024 samples per packet, 48 kHz
    let stamps = ProgramStreamer.audioTimestamps(count: 1, from: packets - 1, epoch: 0).compactMap { $0 }
    let trueMs = Double(packets - 1) * 1024 / 48_000 * 1000
    #expect(abs(Double(stamps[0]) - trueMs) <= 0.5)
  }

  /// Never two packets on one millisecond, which a server reads as the sound stopping.
  @Test func noTwoPacketsShareATime() {
    let stamps = ProgramStreamer.audioTimestamps(count: 200, from: 0, epoch: 5_000).compactMap { $0 }
    #expect(Set(stamps).count == stamps.count)
    let gaps = zip(stamps, stamps.dropFirst()).map { Int($1) - Int($0) }
    // 21 or 22, alternating as the third of a millisecond accumulates. Never 20, which is what the
    // old floor produced, and never 40, which is what it then needed to catch up.
    #expect(gaps.allSatisfy { $0 == 21 || $0 == 22 })
  }

  /// Packet 0 decodes to the sound from the encoder's priming before the mix's first sample, so it
  /// is stamped that much earlier: the live sound then plays when its mix said, with its picture.
  @Test func theEpochIsTheMixsOwnTimeLessThePriming() {
    let epoch = ProgramStreamer.audioEpochMilliseconds(inputWall: 1_000.5, startWall: 1_000, primingSamples: 2_112)
    #expect(abs(epoch - 456) < 1e-9)
    // A packet that would play before the stream began is not sent; the next one is.
    let early = ProgramStreamer.audioTimestamps(count: 3, from: 0, epoch: -30)
    #expect(early == [nil, nil, 13])
  }

  @Test func noPacketsIsNoStamps() {
    #expect(ProgramStreamer.audioTimestamps(count: 0, from: 7, epoch: 900).isEmpty)
  }
}
