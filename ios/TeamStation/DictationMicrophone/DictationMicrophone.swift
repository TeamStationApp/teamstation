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

  private let engine = AVAudioEngine()
  private let queue = DispatchQueue(label: "app.teamstation.dictation-microphone")
  private var converter: AVAudioConverter?
  private var outputFormat: AVAudioFormat?
  private var pending = Data()
  private var tapped = false
  private var running = false
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
    let session = AVAudioSession.sharedInstance()
    savedCategory = session.category
    savedMode = session.mode
    savedOptions = session.categoryOptions
    try session.setCategory(
      .playAndRecord,
      mode: .voiceChat,
      options: [.defaultToSpeaker, .allowBluetoothHFP]
    )
    try session.setActive(true)

    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    if inputFormat.sampleRate == 0 || inputFormat.channelCount == 0 {
      throw MicError.noInput
    }
    guard
      let output = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
      ),
      let made = AVAudioConverter(from: inputFormat, to: output)
    else {
      throw MicError.unreadable
    }
    converter = made
    outputFormat = output
    input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) {
      [weak self] buffer, _ in
      self?.copyAndConvert(buffer)
    }
    tapped = true
    engine.prepare()
    try engine.start()
    running = true
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
    let channels = Int(buffer.format.channelCount)
    let bytes = Int(buffer.frameLength) * MemoryLayout<Float>.size
    for channel in 0..<channels {
      guard
        let source = buffer.floatChannelData?[channel],
        let destination = copy.floatChannelData?[channel]
      else { return }
      memcpy(destination, source, bytes)
    }
    queue.async { [weak self] in
      self?.convert(copy)
    }
  }

  private func convert(_ buffer: AVAudioPCMBuffer) {
    guard
      running,
      let converter,
      let outputFormat,
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
    guard error == nil, let samples = output.int16ChannelData else { return }
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
  case noInput
  case unreadable

  var errorDescription: String? {
    switch self {
    case .noInput:
      return "This phone has no microphone"
    case .unreadable:
      return "The microphone could not be read"
    }
  }
}
