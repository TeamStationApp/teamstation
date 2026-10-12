import CoreMedia
import DirectorCore
@testable import DirectorMedia
@testable import DirectorPipeline
import DirectorSources
import Foundation
import Testing

/// Switching the sound from one camera to another mid-take: the camera leaving fades out and the
/// camera joining fades in over the same 15 ms, at the same place in the stream and the recording.
@Suite("Sound source switch")
struct SoundSourceSwitchTests {
  static let rate = 48_000.0
  static let first = SourceID("first")
  static let third = SourceID("third")
  static let firstLevel: Int16 = 1_000
  static let thirdLevel: Int16 = 3_000

  /// Every sample a mix emits, left channel, keyed by the timeline position it was read from.
  final class Output: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [Int64: Int32] = [:]
    let lag: Int64

    init(lagSeconds: Double) {
      lag = Int64((lagSeconds * SoundSourceSwitchTests.rate).rounded())
    }

    func add(_ frame: AudioFrame) {
      let pcm = AudioPCM.stereoSamples(from: frame.sampleBuffer, sampleRate: 48_000, channelCount: 2) ?? []
      let start = Int64((frame.wallClock.seconds * SoundSourceSwitchTests.rate).rounded()) - lag
      lock.lock()
      for index in stride(from: 0, to: pcm.count, by: 2) {
        samples[start + Int64(index / 2)] = Int32(pcm[index])
      }
      lock.unlock()
    }

    /// Samples from `from` for `count`, nil where nothing was emitted.
    func range(_ from: Int64, _ count: Int) -> [Int32?] {
      lock.lock()
      defer { lock.unlock() }
      return (0 ..< Int64(count)).map { samples[from + $0] }
    }
  }

  static func frame(_ id: SourceID, at wall: Double, index: Int, level: Int16) -> AudioFrame {
    let format = AudioSampleBuilder.makeFormatDescription(
      AudioSampleBuilder.interleavedInt16Description(sampleRate: 48_000, channels: 2)
    )!
    let buffer = AudioSampleBuilder.makeSampleBuffer(
      samples: [Int16](repeating: level, count: 960 * 2),
      formatDescription: format,
      presentationTime: CMTime(value: Int64(index) * 960, timescale: 48_000)
    )!
    return AudioFrame(
      sourceID: id,
      sampleBuffer: buffer,
      wallClock: WallClock(seconds: wall),
      sessionID: 1,
      sourceSamplePosition: Int64(index) * 960
    )
  }

  /// Two cameras sounding steadily from 100 s, read by a live mix (half a second behind capture) and
  /// a recording mix (five seconds behind), the first camera heard. `switches` maps a 20 ms step to
  /// the sources heard from then; `silent` says when a camera sends nothing.
  struct Run {
    let live: Output
    let recording: Output
    let positions: [Int64]
    let liveMixer: AudioMixer
    let recordingMixer: AudioMixer

    init(steps: Int = 300, switches: [Int: Set<SourceID>], silent: (SourceID, Int) -> Bool = { _, _ in false }) {
      let clock = FixedClock(100)
      let uptime: @Sendable () -> Double = { clock.now.seconds }
      let timelines = SourceSoundTimelines(clock: clock, uptime: uptime)
      let live = Output(lagSeconds: 0.5)
      let recording = Output(lagSeconds: 0)
      var positions: [Int64] = []
      let liveMixer = AudioMixer(clock: clock, readLagSeconds: 0.5, uptime: uptime, runsTimer: false, timelines: timelines) { live.add($0) }
      let recordingMixer = AudioMixer(
        clock: clock, delaySeconds: 5, windowSeconds: 10, uptime: uptime, runsTimer: false, timelines: timelines
      ) { recording.add($0) }
      for mixer in [ liveMixer, recordingMixer ] {
        mixer.start()
        mixer.setContributors([ SoundSourceSwitchTests.first ])
      }
      for step in 0 ..< steps {
        let wall = 100 + Double(step) * 0.02
        clock.set(wall)
        for (id, level) in [ (SoundSourceSwitchTests.first, SoundSourceSwitchTests.firstLevel), (SoundSourceSwitchTests.third, SoundSourceSwitchTests.thirdLevel) ]
          where !silent(id, step) {
          timelines.append(SoundSourceSwitchTests.frame(id, at: wall, index: step, level: level))
        }
        if let ids = switches[step] {
          // As the router places it: a chunk past where the live mix reads next.
          let position = liveMixer.nextReadPosition.map { $0 + 960 }
          positions.append(position ?? 0)
          liveMixer.setContributors(ids, at: position)
          recordingMixer.setContributors(ids, at: position)
        }
        liveMixer.emitReadyChunks()
        recordingMixer.emitReadyChunks()
      }
      clock.set(100 + Double(steps) * 0.02 + 6)
      liveMixer.emitReadyChunks()
      recordingMixer.emitReadyChunks()
      self.live = live
      self.recording = recording
      self.positions = positions
      self.liveMixer = liveMixer
      self.recordingMixer = recordingMixer
    }
  }

  @Test("The camera leaving fades out as the camera joining fades in, at one place in both mixes")
  func crossfadeAtOnePlaceInBothMixes() throws {
    let run = Run(switches: [ 100: [ Self.third ] ])
    let at = try #require(run.positions.first)
    let fade = SourceSoundTimeline.fadeFrames
    for output in [ run.live, run.recording ] {
      let before = output.range(at - 960, 960)
      #expect(before.allSatisfy { $0 == Int32(Self.firstLevel) })
      let crossfade = output.range(at, fade).map { $0 ?? 0 }
      // Equal-gain raised cosines: never a dip below the quieter camera, so never a hole.
      #expect(crossfade.allSatisfy { $0 >= Int32(Self.firstLevel) - 1 && $0 <= Int32(Self.thirdLevel) + 1 })
      #expect(zip(crossfade, crossfade.dropFirst()).allSatisfy { $0 <= $1 + 1 }, "a rise, no step back")
      let after = output.range(at + Int64(fade), 48_000)
      #expect(after.allSatisfy { $0 == Int32(Self.thirdLevel) })
    }
    for mixer in [ run.liveMixer, run.recordingMixer ] {
      #expect(mixer.currentContributors == [ Self.third ])
      #expect(mixer.reader(for: Self.first) == nil)
    }
  }

  @Test("A camera already silent when the sound leaves it: the new one is heard from the switch")
  func outgoingAlreadySilent() throws {
    let run = Run(switches: [ 100: [ Self.third ] ], silent: { id, step in id == Self.first && step >= 70 })
    let at = try #require(run.positions.first)
    for output in [ run.live, run.recording ] {
      #expect(output.range(at - 960, 960).allSatisfy { $0 == 0 }, "the first camera's own loss")
      let after = output.range(at + Int64(SourceSoundTimeline.fadeFrames), 96_000)
      #expect(after.allSatisfy { $0 == Int32(Self.thirdLevel) })
      #expect(output.range(at, 1).first == 0, "fading in from the switch")
    }
  }

  @Test("Two switches inside one fade: the second follows the first, with its own fade")
  func secondSwitchFollowsTheFirst() throws {
    let run = Run(switches: [ 100: [ Self.third ], 101: [ Self.first ] ])
    let firstAt = try #require(run.positions.first)
    for output in [ run.live, run.recording ] {
      let window = output.range(firstAt, 3 * 960).map { $0 ?? 0 }
      #expect(window.allSatisfy { $0 >= Int32(Self.firstLevel) - 1 }, "never a hole")
      #expect(output.range(firstAt + 4 * 960, 48_000).allSatisfy { $0 == Int32(Self.firstLevel) })
    }
    #expect(run.recordingMixer.currentContributors == [ Self.first ])
  }

  @Test("A switch the mix has already read past happens where it reads next")
  func latePositionMovesToTheNextRead() throws {
    let clock = FixedClock(100)
    let uptime: @Sendable () -> Double = { clock.now.seconds }
    let mixer = AudioMixer(clock: clock, uptime: uptime, runsTimer: false) { _ in }
    #expect(mixer.nextReadPosition == nil)
    mixer.setContributors([ Self.first ], at: 5)
    #expect(mixer.currentContributors == [ Self.first ], "stopped: at once")
    mixer.start()
    clock.set(101)
    mixer.emitReadyChunks()
    let next = try #require(mixer.nextReadPosition)
    mixer.setContributors([ Self.third ], at: 0)
    #expect(mixer.currentContributors == [ Self.first ])
    clock.set(102)
    mixer.emitReadyChunks()
    #expect(mixer.currentContributors == [ Self.third ])
    #expect(next > 100 * Int64(Self.rate))
    mixer.stop()
    #expect(mixer.currentContributors.isEmpty)
  }
}
