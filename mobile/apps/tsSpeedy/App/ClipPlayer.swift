import AVFoundation
import Foundation
import SpeedyCore
import SpeedyVoice

/// The audio session TS Speedy speaks through.
@MainActor
protocol SpeechSession: AnyObject {
  func activate()
  func deactivate()
}

/// Speaks under the silent switch and lowers other audio while a phrase plays, then gives it back.
@MainActor
final class SystemSpeechSession: SpeechSession {
  func activate() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .spokenAudio, options: [ .duckOthers ])
    try? session.setActive(true)
  }

  func deactivate() {
    try? AVAudioSession.sharedInstance().setActive(false, options: [ .notifyOthersOnDeactivation ])
  }
}

/// Plays phrases from the bundled clips.
///
/// A phrase's clips are joined into one buffer before it is scheduled, so its words follow each
/// other with no gap. Phrases play in the order they arrive. The engine runs only while something
/// is playing, and the audio session is held only for that long.
@MainActor
final class ClipPlayer: PhrasePlayer {
  static let format = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: Double(Wav.rate),
    channels: 1,
    interleaved: false
  )!

  let engine = AVAudioEngine()
  let node = AVAudioPlayerNode()
  /// Under a UI test, what the player node plays is also written to a file the test can pull.
  let capture: SpeechCapture?

  private let session: SpeechSession
  private let clipData: (String) -> Data?
  private var cache: [String: [Int16]] = [:]
  private(set) var queued = 0
  /// Tells completions of buffers scheduled before a stop from those after it.
  private var generation = 0

  init(
    session: SpeechSession = SystemSpeechSession(),
    capture: SpeechCapture? = nil,
    clipData: @escaping (String) -> Data? = { name in SpeedyVoice.clipURL(name).flatMap { try? Data(contentsOf: $0) } }
  ) {
    self.session = session
    self.capture = capture
    self.clipData = clipData
    engine.attach(node)
    engine.connect(node, to: engine.mainMixerNode, format: Self.format)
    if let capture {
      node.installTap(onBus: 0, bufferSize: 4096, format: Self.format, block: Self.tap(capture))
    }
  }

  func play(_ clips: [String]) {
    guard let buffer = try? buffer(for: clips) else { return }
    if !engine.isRunning {
      session.activate()
      engine.prepare()
      do {
        try engine.start()
      } catch {
        session.deactivate()
        return
      }
    }
    queued += 1
    let generation = self.generation
    node.scheduleBuffer(
      buffer,
      completionCallbackType: .dataPlayedBack,
      completionHandler: Self.completion { [weak self] in self?.finished(generation) }
    )
    if !node.isPlaying { node.play() }
  }

  func stop() {
    generation += 1
    queued = 0
    idle()
  }

  /// One buffer holding every clip of a phrase, end to end.
  func buffer(for clips: [String]) throws -> AVAudioPCMBuffer {
    let parts = try clips.map(samples(of:))
    let count = parts.reduce(0) { $0 + $1.count }
    guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: Self.format, frameCapacity: AVAudioFrameCount(count)) else {
      throw Wav.Failure.truncated(clips.joined(separator: "+"))
    }
    let channel = buffer.floatChannelData![0]
    var at = 0
    for part in parts {
      for sample in part {
        channel[at] = Float(sample) / 32768
        at += 1
      }
    }
    buffer.frameLength = AVAudioFrameCount(count)
    return buffer
  }

  /// A clip's samples, read once.
  func samples(of name: String) throws -> [Int16] {
    if let cached = cache[name] { return cached }
    guard let data = clipData(name) else { throw Wav.Failure.notWave(name) }
    let samples = try Wav.samples(data, name: name)
    cache[name] = samples
    return samples
  }

  // AVFoundation calls these on its own threads. Built here, outside the main actor, they carry no
  // main-actor isolation for Swift to trap on; the completion hops back before touching the player.
  nonisolated static func tap(_ capture: SpeechCapture) -> AVAudioNodeTapBlock {
    { buffer, _ in capture.append(buffer) }
  }

  nonisolated static func completion(
    _ work: @escaping @MainActor @Sendable () -> Void
  ) -> AVAudioPlayerNodeCompletionHandler {
    { _ in Task { @MainActor in work() } }
  }

  /// How long the engine stays up after the last phrase: long enough for the node's tap to hand
  /// over its last buffer, and for a phrase right behind it to start without a restart.
  static let linger: Duration = .milliseconds(300)

  private func finished(_ generation: Int) {
    guard generation == self.generation else { return }
    queued = max(0, queued - 1)
    guard queued == 0 else { return }
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: Self.linger)
      guard let self, self.queued == 0, self.generation == generation else { return }
      self.idle()
    }
  }

  /// Stops the node as well as the engine: a node left playing on a stopped engine is never told
  /// to play again, and every phrase after the first would be scheduled into silence.
  private func idle() {
    node.stop()
    if engine.isRunning { engine.stop() }
    session.deactivate()
    capture?.flush()
  }
}

/// Collects what the player node plays and writes it as a WAV, for a UI test to pull off the
/// phone and listen to. Taps run on the audio thread, so the samples are guarded by a lock.
final class SpeechCapture: @unchecked Sendable {
  let url: URL
  private let lock = NSLock()
  private var samples: [Int16] = []

  init(url: URL) {
    self.url = url
  }

  /// The capture a UI-test launch writes: `Documents/speech-capture.wav`, started empty.
  static func forUITest() -> SpeechCapture? {
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return nil }
    let capture = SpeechCapture(url: documents.appendingPathComponent("speech-capture.wav"))
    try? FileManager.default.removeItem(at: capture.url)
    return capture
  }

  func append(_ buffer: AVAudioPCMBuffer) {
    guard let channel = buffer.floatChannelData?[0] else { return }
    var chunk = [Int16](repeating: 0, count: Int(buffer.frameLength))
    for index in chunk.indices {
      chunk[index] = Int16(max(-1, min(1, channel[index])) * 32767)
    }
    lock.lock()
    samples.append(contentsOf: chunk)
    lock.unlock()
  }

  var captured: [Int16] {
    lock.lock()
    defer { lock.unlock() }
    return samples
  }

  /// Writes everything captured so far.
  func flush() {
    try? Wav.data(captured).write(to: url, options: .atomic)
  }
}
