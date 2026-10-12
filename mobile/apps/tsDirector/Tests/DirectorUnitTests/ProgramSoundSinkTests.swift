import AVFoundation
import CoreMedia
import DirectorCore
@testable import DirectorMedia
@testable import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// A sound input that can be made to refuse, which is the condition that matters.
///
/// The 2026-09-21 soak died because every chunk queued while the writer was unready was stamped
/// with the same instant, and an `AVAssetWriterInput` fails on a timestamp that does not increase.
/// Nothing caught it because nothing could make a real writer refuse on demand: it is created with
/// `expectsMediaDataInRealTime`, which makes it accept aggressively, so a test using one is a test
/// of the happy path whatever it asserts.
final class FakeSoundSink: SoundSink, @unchecked Sendable {
  private let lock = NSLock()
  private var _ready = true
  private(set) var timestamps: [Double] = []
  private(set) var refusals = 0
  var refuseEverything = false

  var isReadyForMoreSound: Bool {
    lock.lock(); defer { lock.unlock() }
    return _ready
  }

  func setReady(_ ready: Bool) {
    lock.lock(); _ready = ready; lock.unlock()
  }

  private(set) var appendsAfterFinish = 0

  func appendSound(_ sample: CMSampleBuffer) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if finished { appendsAfterFinish += 1 }
    if refuseEverything {
      refusals += 1
      return false
    }
    timestamps.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
    return true
  }

  private(set) var finished = false

  /// Recorded, not ignored: an append after this is the `signal 6` crash the video path was fixed
  /// for, and the whole point of the seam is being able to catch it.
  func finishSound() {
    lock.lock(); finished = true; lock.unlock()
  }

  var isStrictlyIncreasing: Bool {
    zip(timestamps, timestamps.dropFirst()).allSatisfy { $1 > $0 }
  }

  /// The first pair that did not increase, for a failure message worth reading.
  var firstRepeat: (index: Int, at: Double)? {
    for i in 1 ..< max(1, timestamps.count) where timestamps[i] <= timestamps[i - 1] {
      return (i, timestamps[i])
    }
    return nil
  }
}

@Suite("Programme sound timestamps")
struct ProgramSoundSinkTests {
  private func encoder(_ root: URL) -> ProgramEncoder {
    ProgramEncoder(
      telemetry: PipelineTelemetry(),
      converter: PixelConverter(),
      config: AppConfig(
        programCodec: .h264,
        programResolution: ProgramResolution(width: 160, height: 120),
        programBitrate: 1_000_000
      ),
      directory: root
    )
  }

  private func staging() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("sound-sink-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  /// Sound is fed while the sink refuses for stretches, which is exactly what a writer under load
  /// does. Every timestamp the sink is offered must still increase.
  @Test("Timestamps strictly increase even when the writer keeps refusing")
  func monotonicUnderBackpressure() async throws {
    let root = try staging()
    defer { try? FileManager.default.removeItem(at: root) }
    let encoder = encoder(root)
    let sink = FakeSoundSink()
    encoder.soundSinkOverride = sink

    // A real instant: `contentLagSeconds` only sets when the capture wall is within 10 s of now,
    // so a fixture epoch leaves the origin anchored to `Date()` and every chunk lands before the
    // part. Tests that assert only on file duration pass anyway, on the Stop fill alone.
    let origin = Date().timeIntervalSince1970
    try encoder.start(at: WallClock(seconds: origin))
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let picture = try #require(factory.makeBuffer())
    // Enough picture to settle the origin.
    for index in 0 ..< 120 {
      encoder.append(
        picture,
        presentationTime: CMTime(value: CMTimeValue(index), timescale: 30),
        captureWall: WallClock(seconds: origin + Double(index) / 30),
        // As the programme clock feeds them. Without this the grid-slack rule replaces each
        // frame's slot with real time's, and a test loop that runs faster than real time has all
        // but the first frame dropped — so programme time never advances and the origin never
        // settles.
        onClockGrid: true
      )
    }

    // 40 s of mix, with the sink closing every third second.
    for index in 0 ..< 2_000 {
      if index % 150 == 0 { sink.setReady(false) }
      if index % 150 == 60 { sink.setReady(true) }
      encoder.append(
        audio: RecordingSoundTests.frame(
          RecordingSoundTests.tone(8_000, seconds: 0.02),
          at: origin + Double(index) * 0.02
        )
      )
    }
    sink.setReady(true)
    for _ in 0 ..< 200 { encoder.append(audio: RecordingSoundTests.frame(RecordingSoundTests.tone(8_000, seconds: 0.02), at: origin + 40)) }

    let d = encoder.soundDiagnosticsForTesting
    if sink.timestamps.count <= 100 {
      Issue.record(
        """
        sink took \(sink.timestamps.count); offered \(d.offered) unseeded \(d.unseeded) \
        beforePart \(d.beforePart) behind \(d.behind) origin \(d.origin) tgt \(d.first)..\(d.last)
        """
      )
    }
    if let repeated = sink.firstRepeat {
      Issue.record("timestamp \(repeated.at) s repeated at index \(repeated.index)")
    }
    #expect(sink.isStrictlyIncreasing)

    // Again after finishing. The tail's `fillUntil` branch is the newest code in the drain and
    // runs only here, so asserting before `finish` leaves it unchecked.
    let beforeFinish = sink.timestamps.count
    _ = await encoder.finish(until: WallClock(seconds: origin + 41))
    #expect(sink.timestamps.count > beforeFinish, "the tail fill wrote nothing")
    if let repeated = sink.firstRepeat {
      Issue.record("after finish, timestamp \(repeated.at) s repeated at index \(repeated.index)")
    }
    #expect(sink.isStrictlyIncreasing)
    #expect(sink.finished, "the sink was never finished")
    #expect(sink.appendsAfterFinish == 0, "\(sink.appendsAfterFinish) appends outlived markAsFinished")
  }

  /// A refusal must cost the sound in that buffer and nothing else. The cursor may not advance on
  /// a refusal, or the track would claim time the file does not hold.
  @Test("A sink that refuses everything advances the track not at all")
  func refusalCostsContentNotLength() async throws {
    let root = try staging()
    defer { try? FileManager.default.removeItem(at: root) }
    let encoder = encoder(root)
    let sink = FakeSoundSink()
    sink.refuseEverything = true
    encoder.soundSinkOverride = sink

    let origin = Date().timeIntervalSince1970
    try encoder.start(at: WallClock(seconds: origin))
    let factory = try #require(
      PixelBufferFactory(width: 160, height: 120, pixelFormat: kCVPixelFormatType_32BGRA)
    )
    let picture = try #require(factory.makeBuffer())
    for index in 0 ..< 120 {
      encoder.append(
        picture,
        presentationTime: CMTime(value: CMTimeValue(index), timescale: 30),
        captureWall: WallClock(seconds: origin + Double(index) / 30),
        // As the programme clock feeds them. Without this the grid-slack rule replaces each
        // frame's slot with real time's, and a test loop that runs faster than real time has all
        // but the first frame dropped — so programme time never advances and the origin never
        // settles.
        onClockGrid: true
      )
    }
    for index in 0 ..< 500 {
      encoder.append(
        audio: RecordingSoundTests.frame(
          RecordingSoundTests.tone(8_000, seconds: 0.02),
          at: origin + Double(index) * 0.02
        )
      )
    }
    #expect(sink.timestamps.isEmpty)
    #expect(sink.refusals > 0)
    #expect(encoder.writtenSoundEndForTesting == 0, "the cursor moved on a refusal")
    _ = await encoder.finish(until: WallClock(seconds: origin + 11))
  }
}
