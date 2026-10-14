import AVFoundation
import Foundation

/**
 * The iPhone microphone as 16 kHz mono 16-bit PCM, the format the dictation
 * model takes. Hardware arrives as float at its own rate; this converts it
 * and hands over about a tenth of a second at a time, base64, on the main
 * queue.
 */
@objc(TSDictationMicrophone)
final class TSDictationMicrophone: NSObject {
  @objc var onPcm: ((String) -> Void)?
  @objc var onEnded: ((String) -> Void)?

  private var engine = AVAudioEngine()
  private let queue = DispatchQueue(label: "app.teamstation.dictation-microphone")
  private var converter: AVAudioConverter?
  private var outputFormat: AVAudioFormat?
  private var pending = Data()
  private var tapped = false
  private var running = false
  private var reported = false
  private var savedCategory: AVAudioSession.Category?
  private var savedMode: AVAudioSession.Mode?
  private var savedOptions: AVAudioSession.CategoryOptions = []

  /// Whole frames of a tenth of a second. Shorter leftovers wait.
  private let frameBytes = 3200

  @objc(start:)
  func start(_ done: @escaping (String?) -> Void) {
    let finish: (Bool) -> Void = { granted in
      DispatchQueue.main.async {
        if !granted {
          done("permission denied")
          return
        }
        do {
          try self.begin()
          done(nil)
        } catch {
          // `begin` installs the tap and switches the audio category before
          // `engine.start()` can throw. Leaving that in place makes the next
          // `start` install a second tap, which terminates the app, and
          // overwrites the category walk-up music needs restored.
          self.stop()
          done(error.localizedDescription)
        }
      }
    }
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: finish)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(finish)
    }
  }

  @objc func stop() {
    running = false
    reported = false
    if tapped {
      engine.inputNode.removeTap(onBus: 0)
      tapped = false
    }
    engine.stop()
    queue.async { [weak self] in
      self?.pending.removeAll()
    }
    let session = AVAudioSession.sharedInstance()
    if let savedCategory {
      try? session.setCategory(
        savedCategory,
        mode: savedMode ?? .default,
        options: savedOptions
      )
    }
    savedCategory = nil
  }

  private func begin() throws {
    if running { return }
    reported = false
    let session = AVAudioSession.sharedInstance()
    savedCategory = session.category
    savedMode = session.mode
    savedOptions = session.categoryOptions
    // The microphone and walk-up music share this session. Mixing lets the
    // music keep playing while dictation is on.
    try session.setCategory(
      .playAndRecord,
      mode: .default,
      options: [.defaultToSpeaker, .allowBluetoothHFP, .mixWithOthers]
    )
    try session.setActive(true)

    guard
      let output = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
      )
    else {
      throw MicError.unreadable
    }
    outputFormat = output
    // The first buffer names the hardware format. `prepare` before the
    // input node exists asserts (inputNode != nullptr || outputNode !=
    // nullptr) and terminates the app, so the tap attaches the input and
    // `start` prepares. A format read before the route has settled is
    // tried once more on a new engine.
    converter = nil
    renewEngine()
    if let reason = installTap() {
      renewEngine()
      try session.setActive(true)
      if let again = installTap() { throw MicError.failed(again) }
    }
    tapped = true
    try engine.start()
    running = true
  }

  /// The tap, or why it could not be installed. A failure leaves no tap.
  /// Reading the input node here would be an NSException Swift cannot catch.
  private func installTap() -> String? {
    TSInstallDictationTap(engine) { [weak self] buffer, _ in
      self?.copyAndConvert(buffer)
    }
  }

  /// A new engine, after the session can record. One left from a failed
  /// start has no input node, and preparing it terminates the app.
  private func renewEngine() {
    if tapped {
      engine.inputNode.removeTap(onBus: 0)
      tapped = false
    }
    engine.stop()
    engine = AVAudioEngine()
  }

  /// One failure is enough. The scoring screen turns dictation off from it.
  private func reportStopped() {
    if reported { return }
    reported = true
    DispatchQueue.main.async { [weak self] in
      self?.onEnded?("the microphone stopped")
    }
  }

  /// Whether the converter already accepts this hardware format.
  private func sameInput(_ format: AVAudioFormat) -> Bool {
    guard let current = converter?.inputFormat else { return false }
    return current.sampleRate == format.sampleRate
      && current.channelCount == format.channelCount
      && current.commonFormat == format.commonFormat
      && current.isInterleaved == format.isInterleaved
  }

  /// Copies the tap's buffer before the audio thread reuses it, then converts
  /// off that thread.
  private func copyAndConvert(_ buffer: AVAudioPCMBuffer) {
    guard
      buffer.frameLength > 0,
      let copy = AVAudioPCMBuffer(
        pcmFormat: buffer.format,
        frameCapacity: buffer.frameCapacity
      )
    else { return }
    copy.frameLength = buffer.frameLength
    let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    guard source.count == destination.count else { return }
    for index in 0..<source.count {
      guard let from = source[index].mData, let to = destination[index].mData else { return }
      memcpy(to, from, Int(source[index].mDataByteSize))
      destination[index].mDataByteSize = source[index].mDataByteSize
    }
    queue.async { [weak self] in
      self?.convert(copy)
    }
  }

  private func convert(_ buffer: AVAudioPCMBuffer) {
    guard running, let outputFormat else { return }
    if !sameInput(buffer.format) {
      converter = AVAudioConverter(from: buffer.format, to: outputFormat)
    }
    guard
      let converter,
      let output = AVAudioPCMBuffer(
        pcmFormat: outputFormat,
        frameCapacity: AVAudioFrameCount(
          (Double(buffer.frameLength) * outputFormat.sampleRate / buffer.format.sampleRate)
            .rounded(.up)
        ) + 32
      )
    else { return }
    var fed = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    if error != nil {
      reportStopped()
      return
    }
    guard let samples = output.int16ChannelData else { return }
    let count = Int(output.frameLength) * MemoryLayout<Int16>.size
    if count == 0 { return }
    pending.append(Data(bytes: samples[0], count: count))
    while pending.count >= frameBytes {
      let chunk = pending.prefix(frameBytes)
      pending.removeFirst(frameBytes)
      let encoded = Data(chunk).base64EncodedString()
      DispatchQueue.main.async { [weak self] in
        self?.onPcm?(encoded)
      }
    }
  }
}

private enum MicError: LocalizedError {
  case unreadable
  case failed(String)

  var errorDescription: String? {
    switch self {
    case .unreadable:
      return "The microphone could not be read"
    case .failed(let reason):
      return reason
    }
  }
}
