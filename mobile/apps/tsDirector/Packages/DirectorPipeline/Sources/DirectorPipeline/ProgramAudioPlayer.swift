import AVFoundation
import CoreMedia
import Foundation
import DirectorSources

/// Plays the programme mix through the iPad's current audio route.
///
/// The mixer already emits a continuous 48 kHz stereo bus, including silence. Playing that bus
/// is what makes `UIBackgroundModes = audio` mean anything: iOS keeps a process running only
/// while audio is flowing. The route is left to the system — no speaker override.
public final class ProgramAudioPlayer: @unchecked Sendable {
  public private(set) var isRunning = false

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let lock = NSLock()
  private var pendingChunks = 0
  private var didInstallObservers = false
  private var isConnected = false

  /// About half a second of mixer chunks. Scheduling further ahead does not help the ear and
  /// would keep growing if the output device stalled.
  private static let maximumPendingChunks = 25

  public static let outputFormat = AVAudioFormat(
    standardFormatWithSampleRate: AudioMixer.sampleRate,
    channels: AVAudioChannelCount(AudioMixer.channelCount)
  )!

  public init() {
    engine.attach(player)
  }

  public func start() {
    lock.lock()
    if isRunning {
      lock.unlock()
      return
    }
    lock.unlock()

    configureSession()
    installObservers()
    connectIfNeeded()

    do {
      try engine.start()
      player.play()
      lock.lock()
      isRunning = true
      lock.unlock()
    } catch {
      lock.lock()
      isRunning = false
      lock.unlock()
    }
  }

  public func stop() {
    lock.lock()
    let running = isRunning
    isRunning = false
    pendingChunks = 0
    lock.unlock()
    guard running else { return }
    player.stop()
    engine.stop()
  }

  /// Hands one mixer chunk to the output node. A no-op until `start`, so the mixer's callback
  /// does not have to know whether anyone is listening.
  public func schedule(_ frame: AudioFrame) {
    lock.lock()
    let running = isRunning
    lock.unlock()
    guard running, let buffer = Self.makePCMBuffer(from: frame.sampleBuffer) else { return }

    lock.lock()
    if pendingChunks >= Self.maximumPendingChunks {
      lock.unlock()
      return
    }
    pendingChunks += 1
    lock.unlock()

    player.scheduleBuffer(buffer) { [weak self] in
      guard let self else { return }
      self.lock.lock()
      self.pendingChunks = max(0, self.pendingChunks - 1)
      self.lock.unlock()
    }
  }

  /// Builds the float32 stereo buffer the player node consumes. Public for tests so the
  /// conversion can be checked without opening an audio unit.
  public static func makePCMBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
    guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(
      block,
      atOffset: 0,
      lengthAtOffsetOut: nil,
      totalLengthOut: &length,
      dataPointerOut: &pointer
    ) == kCMBlockBufferNoErr, let pointer, length >= 4
    else { return nil }

    let channels = AudioMixer.channelCount
    let source = UnsafeRawPointer(pointer).bindMemory(to: Int16.self, capacity: length / 2)
    let frameCount = AVAudioFrameCount((length / 2) / channels)
    guard frameCount > 0 else { return nil }

    guard let pcm = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: frameCount)
    else { return nil }
    pcm.frameLength = frameCount
    guard let left = pcm.floatChannelData?[0], let right = pcm.floatChannelData?[1] else {
      return nil
    }

    for index in 0 ..< Int(frameCount) {
      left[index] = Float(source[index * channels]) / 32768
      right[index] = Float(source[index * channels + 1]) / 32768
    }
    return pcm
  }

  private func connectIfNeeded() {
    guard !isConnected else { return }
    engine.connect(player, to: engine.mainMixerNode, format: Self.outputFormat)
    isConnected = true
  }

  private func configureSession() {
    let session = AVAudioSession.sharedInstance()
    // Playback, not playAndRecord: this app does not use the iPad microphone. No route override
    // so Bluetooth, HDMI, or the built-in speaker — whatever iOS currently has — stay in charge.
    try? session.setCategory(.playback, mode: .moviePlayback, options: [])
    try? session.setActive(true)
  }

  private func installObservers() {
    guard !didInstallObservers else { return }
    didInstallObservers = true
    NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: AVAudioSession.sharedInstance(),
      queue: .main
    ) { [weak self] notification in
      self?.handleInterruption(notification)
    }
  }

  private func handleInterruption(_ notification: Notification) {
    guard
      let info = notification.userInfo,
      let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: typeValue)
    else { return }

    switch type {
    case .began:
      break
    case .ended:
      let optionsValue = info[AVAudioSessionInterruptionOptionKey] as? UInt
      let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue ?? 0)
      guard options.contains(.shouldResume) else { return }
      lock.lock()
      let running = isRunning
      lock.unlock()
      guard running else { return }
      try? AVAudioSession.sharedInstance().setActive(true)
      try? engine.start()
      player.play()
    @unknown default:
      break
    }
  }
}
