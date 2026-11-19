import AVFoundation
import Foundation
@testable import Speedy
@testable import SpeedyCore
import SpeedyVoice
import Testing
import UIKit

@MainActor
final class RecordingSession: SpeechSession {
  private(set) var events: [String] = []
  func activate() { events.append("activate") }
  func deactivate() { events.append("deactivate") }
}

/// Every clip name a reading can ask for.
let everyClipName: [String] = Phrase.speakable.flatMap { [ "n\($0)-final", "n\($0)-and", "n\($0)-exit" ] }
  + [ "word-and", "word-exit" ]

@Suite("Voice clips")
struct VoiceClipTests {
  @Test
  func everyClipAPhraseCanNameIsBundledAndParses() throws {
    #expect(everyClipName.count == 242)
    for name in everyClipName {
      let url = try #require(SpeedyVoice.clipURL(name), "\(name) is bundled")
      let samples = try Wav.samples(Data(contentsOf: url), name: name)
      #expect(samples.count > Wav.rate / 20, "\(name) is longer than 50 ms")
      #expect(Wav.levelDB(samples) > -40, "\(name) is not silent")
    }
  }

  @Test
  func anUnknownClipIsNil() {
    #expect(SpeedyVoice.clipURL("n19-final") == nil)
  }
}

@Suite("WAV")
struct WavTests {
  @Test
  func roundTrips() throws {
    let samples: [Int16] = [ 0, 1, -1, .max, .min, 1234 ]
    let data = Wav.data(samples)
    #expect(data.count == 44 + 12)
    #expect(try Wav.samples(data, name: "x") == samples)
  }

  @Test
  func skipsOtherChunksIncludingAnOddOne() throws {
    var data = Wav.data([ 7, 8 ])
    let list = Data("LIST".utf8) + Data([ 3, 0, 0, 0, 1, 2, 3, 0 ])
    data.insert(contentsOf: list, at: 36)
    #expect(try Wav.samples(data, name: "x") == [ 7, 8 ])
  }

  @Test
  func rejectsTheWrongFormat() {
    func patched(_ offset: Int, _ value: UInt16) -> Data {
      var data = Wav.data([ 1, 2 ])
      data[offset] = UInt8(value & 0xFF)
      data[offset + 1] = UInt8(value >> 8)
      return data
    }
    #expect(throws: Wav.Failure.format("x", "codec 3, not PCM")) { try Wav.samples(patched(20, 3), name: "x") }
    #expect(throws: Wav.Failure.format("x", "2 channels, not mono")) { try Wav.samples(patched(22, 2), name: "x") }
    #expect(throws: Wav.Failure.format("x", "16000 Hz, not 24000")) { try Wav.samples(patched(24, 16000), name: "x") }
    #expect(throws: Wav.Failure.format("x", "8-bit, not 16")) { try Wav.samples(patched(34, 8), name: "x") }
  }

  @Test
  func rejectsBrokenFiles() {
    #expect(throws: Wav.Failure.notWave("x")) { try Wav.samples(Data("nope".utf8), name: "x") }
    let full = Wav.data([ 1, 2, 3, 4 ])
    #expect(throws: Wav.Failure.truncated("x")) { try Wav.samples(full.prefix(46), name: "x") }
    #expect(throws: Wav.Failure.truncated("x")) { try Wav.samples(full.prefix(36), name: "x") }
    var shortFormat = Data("RIFF".utf8) + Data([ 0, 0, 0, 0 ]) + Data("WAVEfmt ".utf8)
    shortFormat += Data([ 4, 0, 0, 0, 1, 0, 1, 0 ])
    #expect(throws: Wav.Failure.truncated("x")) { try Wav.samples(shortFormat, name: "x") }
    let dataFirst = full.prefix(12) + full.suffix(from: 36)
    #expect(throws: Wav.Failure.format("x", "data before fmt")) { try Wav.samples(Data(dataFirst), name: "x") }
    #expect(Wav.Failure.notWave("x").description == "x: not a RIFF WAVE file")
    #expect(Wav.Failure.truncated("x").description == "x: truncated")
    #expect(Wav.Failure.format("x", "why").description == "x: why")
  }

  @Test
  func levels() {
    #expect(Wav.levelDB([]) == -.infinity)
    #expect(Wav.levelDB([ 0, 0 ]) == -.infinity)
    #expect(abs(Wav.levelDB([ 16384, -16384 ]) - -6.02) < 0.01)
  }
}

@Suite("Clip player")
@MainActor
struct ClipPlayerTests {
  private func samples(_ name: String) throws -> [Int16] {
    try Wav.samples(Data(contentsOf: #require(SpeedyVoice.clipURL(name))), name: name)
  }

  @Test
  func aPhraseIsItsClipsEndToEnd() throws {
    let player = ClipPlayer(session: RecordingSession())
    let clips = [ "n56-and", "word-and", "n52-exit", "word-exit" ]
    let buffer = try player.buffer(for: clips)
    let parts = try clips.map(samples)
    #expect(Int(buffer.frameLength) == parts.reduce(0) { $0 + $1.count })
    let first = parts[0]
    let channel = buffer.floatChannelData![0]
    #expect(channel[100] == Float(first[100]) / 32768)
  }

  @Test
  func aMissingOrBrokenClipIsAnError() {
    let player = ClipPlayer(session: RecordingSession()) { name in
      name == "broken" ? Data("nope".utf8) : nil
    }
    #expect(throws: Wav.Failure.notWave("missing")) { try player.buffer(for: [ "missing" ]) }
    #expect(throws: Wav.Failure.notWave("broken")) { try player.buffer(for: [ "broken" ]) }
    #expect(throws: Wav.Failure.truncated("")) { try player.buffer(for: []) }
    player.play([ "missing" ])
    #expect(player.queued == 0)
  }

  @Test
  func clipsAreReadOnce() throws {
    final class Reads { var count = 0 }
    let reads = Reads()
    let player = ClipPlayer(session: RecordingSession()) { name in
      reads.count += 1
      return SpeedyVoice.clipURL(name).flatMap { try? Data(contentsOf: $0) }
    }
    _ = try player.buffer(for: [ "n56-final" ])
    _ = try player.buffer(for: [ "n56-final" ])
    #expect(reads.count == 1)
  }

  /// The real playback path, rendered offline: the phrase's frames come out of the engine, and they
  /// are sound, not silence.
  @Test
  func thePhraseRendersThroughTheEngine() throws {
    let session = RecordingSession()
    let player = ClipPlayer(session: session)
    try player.engine.enableManualRenderingMode(.offline, format: ClipPlayer.format, maximumFrameCount: 4096)
    let clips = [ "n56-and", "word-and", "n52-exit", "word-exit" ]
    let expected = try clips.map(samples).reduce(0) { $0 + $1.count }
    player.play(clips)
    #expect(player.engine.isRunning)
    #expect(player.queued == 1)
    #expect(session.events == [ "activate" ])

    let output = AVAudioPCMBuffer(pcmFormat: player.engine.manualRenderingFormat, frameCapacity: 4096)!
    var rendered: [Float] = []
    while rendered.count < expected + 4096 {
      let status = try player.engine.renderOffline(4096, to: output)
      #expect(status == .success)
      rendered += Array(UnsafeBufferPointer(start: output.floatChannelData![0], count: Int(output.frameLength)))
    }
    let sound = rendered.prefix(expected)
    let rms = (sound.reduce(0) { $0 + Double($1) * Double($1) } / Double(expected)).squareRoot()
    #expect(20 * log10(rms) > -40, "the phrase is not silent")
    let tail = rendered.suffix(2048)
    #expect(tail.allSatisfy { abs($0) < 0.0001 }, "nothing plays after the phrase")
    player.stop()
    #expect(player.queued == 0)
    #expect(!player.engine.isRunning)
    #expect(session.events == [ "activate", "deactivate" ])
  }

  @Test
  func phrasesQueueAndFinishInOrder() async throws {
    let session = RecordingSession()
    let player = ClipPlayer(session: session)
    try player.engine.enableManualRenderingMode(.offline, format: ClipPlayer.format, maximumFrameCount: 4096)
    player.play([ "n56-final" ])
    player.play([ "n53-exit", "word-exit" ])
    #expect(player.queued == 2)
    #expect(session.events == [ "activate" ], "the session is taken once for the queue")
    player.stop()
    #expect(player.queued == 0)
  }

  /// Played for real on the simulator's output: once the phrase has been heard, the player stops its
  /// engine, gives the session back and writes its capture.
  @Test
  func aPlayedPhraseFinishesAndGivesTheSessionBack() async throws {
    let session = RecordingSession()
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("finish-\(UUID().uuidString).wav")
    let player = ClipPlayer(session: session, capture: SpeechCapture(url: url))
    player.play([ "n56-final" ])
    #expect(player.queued == 1)
    for _ in 0..<100 where player.queued > 0 || player.engine.isRunning {
      try await Task.sleep(for: .milliseconds(100))
    }
    #expect(player.queued == 0)
    #expect(!player.engine.isRunning)
    #expect(session.events == [ "activate", "deactivate" ])
    #expect(FileManager.default.fileExists(atPath: url.path))
    try? FileManager.default.removeItem(at: url)
  }

  /// A phrase after the player has gone idle, with no stop in between, is heard too: the node
  /// plays again on the restarted engine, and the capture holds both phrases.
  @Test
  func aPhraseAfterTheQueueEmptiedIsPlayedToo() async throws {
    let session = RecordingSession()
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("again-\(UUID().uuidString).wav")
    let capture = SpeechCapture(url: url)
    let player = ClipPlayer(session: session, capture: capture)
    let first = try player.buffer(for: [ "n56-final" ])
    let second = try player.buffer(for: [ "n70-final" ])
    for clips in [ [ "n56-final" ], [ "n70-final" ] ] {
      player.play(clips)
      #expect(player.node.isPlaying)
      for _ in 0..<100 where player.queued > 0 || player.engine.isRunning {
        try await Task.sleep(for: .milliseconds(100))
      }
      #expect(player.queued == 0)
      #expect(!player.engine.isRunning)
      #expect(!player.node.isPlaying)
    }
    #expect(session.events == [ "activate", "deactivate", "activate", "deactivate" ])
    func voiced(_ samples: [Int16]) -> Int { samples.filter { abs(Int($0)) > 300 }.count }
    func voiced(_ buffer: AVAudioPCMBuffer) -> Int {
      voiced((0..<Int(buffer.frameLength)).map { Int16(buffer.floatChannelData![0][$0] * 32767) })
    }
    let heard = capture.captured
    #expect(heard.count >= Int(first.frameLength) + Int(second.frameLength))
    // More sound than the first phrase holds on its own: the second was heard too.
    #expect(voiced(heard) > voiced(first) + voiced(second) / 2, "the second phrase was played, not silence")
    try? FileManager.default.removeItem(at: url)
  }

  /// A phrase right behind the last one plays on the running engine: one session for both.
  @Test
  func aPhraseInsideTheLingerKeepsTheEngine() async throws {
    let session = RecordingSession()
    let player = ClipPlayer(session: session)
    player.play([ "n56-final" ])
    for _ in 0..<100 where player.queued > 0 {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(player.engine.isRunning, "still lingering")
    player.play([ "n57-final" ])
    for _ in 0..<100 where player.queued > 0 || player.engine.isRunning {
      try await Task.sleep(for: .milliseconds(100))
    }
    #expect(session.events == [ "activate", "deactivate" ])
  }

  /// An interruption or a route change stops the engine under a phrase whose completion never
  /// comes; the player drops it, so the phrase after plays on a node told to play again.
  @Test(arguments: [ AVAudioSession.interruptionNotification, .AVAudioEngineConfigurationChange ])
  func anInterruptionDropsThePhraseAndTheNextOnePlays(_ name: Notification.Name) async throws {
    let session = RecordingSession()
    let player = ClipPlayer(session: session)
    player.play([ "n56-final" ])
    #expect(player.queued == 1)
    let isInterruption = name == AVAudioSession.interruptionNotification
    if isInterruption {
      // The end of an interruption leaves a playing phrase alone.
      NotificationCenter.default.post(name: name, object: nil, userInfo: [
        AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue
      ])
      #expect(player.queued == 1)
    }
    NotificationCenter.default.post(
      name: name,
      object: isInterruption ? nil : player.engine,
      userInfo: isInterruption ? [ AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue ] : nil
    )
    #expect(player.queued == 0)
    #expect(!player.engine.isRunning)
    #expect(!player.node.isPlaying)
    player.play([ "n70-final" ])
    #expect(player.node.isPlaying)
    player.stop()
    #expect(session.events == [ "activate", "deactivate", "activate", "deactivate" ])
  }

  @Test
  func aCompletionFromBeforeAStopIsIgnored() async throws {
    let session = RecordingSession()
    let player = ClipPlayer(session: session)
    player.play([ "n56-final" ])
    player.stop()
    player.play([ "n57-final" ])
    #expect(player.queued == 1)
    player.stop()
    #expect(session.events == [ "activate", "deactivate", "activate", "deactivate" ])
  }

  @Test
  func theCompletionHopsToTheMainActor() async throws {
    final class Ran { var count = 0 }
    let ran = Ran()
    ClipPlayer.completion { ran.count += 1 }(.dataPlayedBack)
    for _ in 0..<20 where ran.count == 0 {
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(ran.count == 1)
  }

  @Test
  func theSystemSessionCanBeTakenAndGivenBack() {
    let session = SystemSpeechSession()
    session.activate()
    #expect(AVAudioSession.sharedInstance().category == .playback)
    #expect(AVAudioSession.sharedInstance().mode == .spokenAudio)
    #expect(AVAudioSession.sharedInstance().categoryOptions.contains(.duckOthers))
    session.deactivate()
  }
}

@Suite("Speech capture")
@MainActor
struct SpeechCaptureTests {
  @Test
  func theTapWritesWhatThePlayerPlays() throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("capture-\(UUID().uuidString).wav")
    let capture = SpeechCapture(url: url)
    let player = ClipPlayer(session: RecordingSession(), capture: capture)
    let buffer = try player.buffer(for: [ "n56-final" ])
    capture.append(buffer)
    capture.flush()
    let written = try Wav.samples(Data(contentsOf: url), name: "capture")
    #expect(written.count == Int(buffer.frameLength))
    #expect(Wav.levelDB(written) > -40)
    try? FileManager.default.removeItem(at: url)
  }

  @Test
  func theTapBlockAppends() throws {
    let capture = SpeechCapture(url: FileManager.default.temporaryDirectory.appendingPathComponent("unused.wav"))
    let buffer = AVAudioPCMBuffer(pcmFormat: ClipPlayer.format, frameCapacity: 3)!
    buffer.frameLength = 3
    buffer.floatChannelData![0][0] = 2
    buffer.floatChannelData![0][1] = -2
    buffer.floatChannelData![0][2] = 0.5
    ClipPlayer.tap(capture)(buffer, AVAudioTime(sampleTime: 0, atRate: 24000))
    #expect(capture.captured == [ 32767, -32767, 16383 ])
  }

  @Test
  func aUITestCaptureStartsEmptyInDocuments() throws {
    let capture = try #require(SpeechCapture.forUITest())
    #expect(capture.url.lastPathComponent == "speech-capture.wav")
    #expect(capture.url.path.contains("/Documents/"))
    #expect(!FileManager.default.fileExists(atPath: capture.url.path))
  }
}

@Suite("App configuration")
@MainActor
struct AppConfigurationTests {
  private func info(_ key: String) -> Any? { Bundle.main.object(forInfoDictionaryKey: key) }

  @Test
  func portraitPhonesOnly() {
    #expect(info("UISupportedInterfaceOrientations") as? [String] == [ "UIInterfaceOrientationPortrait" ])
    #expect(info("UIDeviceFamily") as? [Int] == [ 1 ])
  }

  @Test
  func identityAndBluetooth() {
    #expect(Bundle.main.bundleIdentifier == "app.teamstation.speedy")
    #expect(info("CFBundleDisplayName") as? String == "TS Speedy")
    #expect((info("NSBluetoothAlwaysUsageDescription") as? String)?.isEmpty == false)
    let schemes = (info("CFBundleURLTypes") as? [[String: Any]])?.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
    #expect(schemes == [ "tsspeedy" ])
  }

  @Test
  func theScreenIsKeptAwake() {
    final class Holder: IdleTimerHolder { var isIdleTimerDisabled = false }
    let holder = Holder()
    SpeedyApp.keepAwake(holder)
    #expect(holder.isIdleTimerDisabled)
  }
}
