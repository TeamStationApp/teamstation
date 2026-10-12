import AVFoundation
import CameramanCapture
import CameramanCore
import CoreMedia
import DirectorCore
import DirectorMedia
import DirectorSources
import Foundation

/// Maps the capture clock onto the steady wall clock and the continuous uptime the programme
/// places things by.
///
/// A captured buffer is stamped on the capture session's clock (host time). What the programme needs
/// is when that was on `SteadyWall`, which never steps, and on `ContinuousUptime`, which the sound
/// timelines place by. Both are read beside the capture clock at delivery, so the mapping carries
/// only the buffer's age, not either clock's epoch.
public struct CaptureClockMapping: Sendable {
  public let captureNow: @Sendable () -> Double
  public let wallNow: @Sendable () -> Double
  public let uptimeNow: @Sendable () -> Double

  public init(
    captureNow: @escaping @Sendable () -> Double,
    wallNow: @escaping @Sendable () -> Double,
    uptimeNow: @escaping @Sendable () -> Double
  ) {
    self.captureNow = captureNow
    self.wallNow = wallNow
    self.uptimeNow = uptimeNow
  }

  /// The capture session's host clock, `SteadyWall.shared` and `ContinuousUptime`.
  public static let system = CaptureClockMapping(
    captureNow: { CMClockGetTime(CMClockGetHostTimeClock()).seconds },
    wallNow: { SteadyWall.shared.seconds() },
    uptimeNow: { ContinuousUptime.seconds() }
  )

  /// How long ago a capture-clock instant was, never negative: a buffer is never from the future.
  public func age(ofCapture seconds: Double) -> Double {
    max(0, captureNow() - seconds)
  }

  public func wall(forCapture seconds: Double) -> WallClock {
    WallClock(seconds: wallNow() - age(ofCapture: seconds))
  }

  public func uptime(forCapture seconds: Double) -> Double {
    uptimeNow() - age(ofCapture: seconds)
  }
}

/// What `PhoneCameraSource` captures from: TS Cameraman's `CameraSession`, or a fake in a test.
public protocol PhoneCaptureDevice: AnyObject, Sendable {
  var onVideoFrame: (@Sendable (SampleBuffer) -> Void)? { get set }
  var onAudioFrame: (@Sendable (SampleBuffer) -> Void)? { get set }
  var onStateChange: (@MainActor @Sendable (CameraSession.State) -> Void)? { get set }
  /// What a preview layer draws from; nil for a device with no session.
  var previewSession: AVCaptureSession? { get }
  func configure(position: CameraPosition, settings: CameramanCore.StreamSettings)
  func start()
  func stop()
  func flip()
  func setDeviceZoom(_ value: Double)
  func setDisplayedZoom(_ value: Double)
}

extension CameraSession: PhoneCaptureDevice {
  public var previewSession: AVCaptureSession? { captureSession }
}

/// The phone's one camera as a `FrameSource`: every picture and every buffer of sound stamped with
/// when it was captured, on the steady wall clock.
///
/// Pictures go to the programme's picture queue, which shows each at its capture time plus the
/// picture delay, and sound to the mix, which places it by its capture time. In a simulator Debug
/// build a `SyntheticFrameSource` (a clock pattern and a tone) stands in for the camera, which a
/// simulator does not have; its pictures and sound are made at the moment they are delivered, so
/// that moment is their capture time.
public final class PhoneCameraSource: FrameSource, @unchecked Sendable {
  public static let id = SourceID("phone-camera")

  public enum Input: @unchecked Sendable {
    case camera(any PhoneCaptureDevice)
    case synthetic(SyntheticFrameSource)
  }

  public let sourceID = PhoneCameraSource.id
  public let displayName = "Camera"
  public let input: Input
  private let mapping: CaptureClockMapping
  private let converter: PixelConverter
  private let lock = NSLock()
  private var running = false
  private var frameID: UInt64 = 0

  public init(input: Input, mapping: CaptureClockMapping = .system, converter: PixelConverter = PixelConverter()) {
    self.input = input
    self.mapping = mapping
    self.converter = converter
  }

  /// The camera, or in a simulator Debug build the synthetic source.
  public static func standard(camera: @autoclosure () -> any PhoneCaptureDevice) -> PhoneCameraSource {
    #if targetEnvironment(simulator) && DEBUG
      PhoneCameraSource(input: .synthetic(SyntheticFrameSource(
        sourceID: PhoneCameraSource.id,
        displayName: "Synthetic camera",
        entropy: .high,
        clock: SystemClock()
      )))
    #else
      PhoneCameraSource(input: .camera(camera()))
    #endif
  }

  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  public var format: SourceFormat? {
    SourceFormat(
      width: PhoneStreamProfile.resolution.width,
      height: PhoneStreamProfile.resolution.height,
      frameRate: Double(PhoneStreamProfile.frameRate),
      pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    )
  }

  /// The capture device, when this source is a camera.
  public var device: (any PhoneCaptureDevice)? {
    if case let .camera(device) = input { return device }
    return nil
  }

  public func start(sinks: FrameSinks) throws {
    lock.lock()
    guard !running else {
      lock.unlock()
      return
    }
    running = true
    lock.unlock()
    switch input {
    case let .camera(device):
      device.onVideoFrame = { [weak self] sample in self?.deliverVideo(sample.buffer, to: sinks) }
      device.onAudioFrame = { [weak self] sample in self?.deliverAudio(sample.buffer, to: sinks) }
      device.start()
    case let .synthetic(source):
      try source.start(sinks: FrameSinks(
        pixel: { [weak self] frame in self?.deliverSynthetic(frame, to: sinks) },
        audio: { [weak self] frame in self?.deliverSyntheticSound(frame, to: sinks) }
      ))
    }
  }

  public func stop() {
    lock.lock()
    running = false
    lock.unlock()
    switch input {
    case let .camera(device):
      device.onVideoFrame = nil
      device.onAudioFrame = nil
      device.stop()
    case let .synthetic(source):
      source.stop()
    }
  }

  private func nextFrameID() -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    frameID += 1
    return frameID - 1
  }

  // MARK: - The camera

  /// A captured picture, stamped with its capture time on the steady wall clock.
  ///
  /// Copied into the converter's own pool before it is queued: the programme holds a second of
  /// pictures for the picture delay, and holding the capture session's own buffers that long
  /// starves its small pool, which then drops frames at the camera.
  func deliverVideo(_ buffer: CMSampleBuffer, to sinks: FrameSinks) {
    guard let captured = CMSampleBufferGetImageBuffer(buffer) else { return }
    let presentation = CMSampleBufferGetPresentationTimeStamp(buffer)
    let capture = presentation.isNumeric ? mapping.wall(forCapture: presentation.seconds) : nil
    let pixels = converter.convert(
      pixelBuffer: captured,
      width: CVPixelBufferGetWidth(captured),
      height: CVPixelBufferGetHeight(captured)
    ) ?? captured
    sinks.pixel?(PixelFrame(
      sourceID: sourceID,
      pixelBuffer: pixels,
      presentationTime: presentation,
      wallClock: WallClock(seconds: mapping.wallNow()),
      captureWallClock: capture,
      frameID: nextFrameID()
    ))
  }

  /// Captured sound, placed by its capture time on both clocks the sound path reads.
  func deliverAudio(_ buffer: CMSampleBuffer, to sinks: FrameSinks) {
    let presentation = CMSampleBufferGetPresentationTimeStamp(buffer)
    guard presentation.isNumeric else { return }
    let frame = AudioFrame(
      sourceID: sourceID,
      sampleBuffer: buffer,
      wallClock: mapping.wall(forCapture: presentation.seconds),
      isCaptureTime: true,
      captureUptime: mapping.uptime(forCapture: presentation.seconds)
    )
    sinks.audio?(frame)
    sinks.recordingAudio?(frame)
  }

  // MARK: - The simulator's stand-in

  /// A generated picture: made now, so captured now. Converted once here to the encoders' format,
  /// so the recording and the stream do not each convert it.
  func deliverSynthetic(_ frame: PixelFrame, to sinks: FrameSinks) {
    let converted = converter.convert(frame) ?? frame
    sinks.pixel?(PixelFrame(
      sourceID: sourceID,
      pixelBuffer: converted.pixelBuffer,
      presentationTime: frame.presentationTime,
      wallClock: frame.wallClock,
      captureWallClock: frame.captureWallClock ?? frame.wallClock,
      frameID: frame.frameID,
      markerValue: frame.markerValue
    ))
  }

  func deliverSyntheticSound(_ frame: AudioFrame, to sinks: FrameSinks) {
    let made = AudioFrame(
      sourceID: sourceID,
      sampleBuffer: frame.sampleBuffer,
      wallClock: frame.wallClock,
      isCaptureTime: true
    )
    sinks.audio?(made)
    sinks.recordingAudio?(made)
  }
}
