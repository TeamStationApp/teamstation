import AVFoundation
import CameramanCore
import Foundation

/// `CMSampleBuffer` is not `Sendable`, but a captured frame has exactly one owner at a time: the
/// capture queue hands it over and does not touch it again. The box makes that hand-off explicit
/// rather than scattering `@unchecked Sendable` closures through the encoder.
public struct SampleBuffer: @unchecked Sendable {
  public let buffer: CMSampleBuffer

  public init(_ buffer: CMSampleBuffer) {
    self.buffer = buffer
  }
}

/// Owns the `AVCaptureSession` and everything that has to be configured on it.
///
/// All AVFoundation access is confined to one serial queue. Configuring a session on the main thread
/// works but stalls it for hundreds of milliseconds on `startRunning`, which on this app would land
/// exactly as the operator taps the flip button.
public final class CameraSession: @unchecked Sendable {
  public struct State: Sendable, Equatable {
    public var position: CameraPosition = .back
    public var deviceType: String = ""
    public var mapping: ZoomMapping = ZoomMapping(maximumDeviceZoom: 1)
    public var deviceZoom: Double = 1
    public var activeFormat: CaptureFormatDescriptor?
    public var isRunning = false
    public var failure: String?

    public init() {}

    public var displayedZoom: Double { mapping.displayedZoom(forDevice: deviceZoom) }
    public var lensIndex: Int { mapping.lensIndex(forDevice: deviceZoom) }
  }

  private let queue = DispatchQueue(label: "co.gamestation.cameraman.capture")
  private let session = AVCaptureSession()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let audioOutput = AVCaptureAudioDataOutput()
  private let outputDelegate = OutputDelegate()

  private var device: AVCaptureDevice?
  private var input: AVCaptureDeviceInput?
  private var audioInput: AVCaptureDeviceInput?
  private var settings = StreamSettings.default
  private var state = State()

  /// Delivered on the main queue, because every consumer is UI.
  public var onStateChange: (@MainActor @Sendable (State) -> Void)?
  public var onVideoFrame: (@Sendable (SampleBuffer) -> Void)? {
    get { outputDelegate.onVideo }
    set { outputDelegate.onVideo = newValue }
  }
  public var onAudioFrame: (@Sendable (SampleBuffer) -> Void)? {
    get { outputDelegate.onAudio }
    set { outputDelegate.onAudio = newValue }
  }

  public init() {}

  /// Handed to the preview layer. Safe to read from the main thread: `AVCaptureVideoPreviewLayer`
  /// is designed to be attached on the main thread to a session running on another queue.
  public var captureSession: AVCaptureSession { session }

  public func configure(position: CameraPosition, settings: StreamSettings) {
    queue.async { [self] in
      self.settings = settings
      applyDevice(position: position)
    }
  }

  public func start() {
    queue.async { [self] in
      guard !session.isRunning else { return }
      session.startRunning()
      state.isRunning = session.isRunning
      publish()
    }
  }

  public func stop() {
    queue.async { [self] in
      guard session.isRunning else { return }
      session.stopRunning()
      state.isRunning = false
      publish()
    }
  }

  public func flip() {
    queue.async { [self] in
      applyDevice(position: state.position == .back ? .front : .back)
    }
  }

  /// Sets zoom in device units. Clamped to the mapping, which is derived from the recommended range
  /// rather than the 189x digital-upscaling maximum.
  public func setDeviceZoom(_ value: Double) {
    queue.async { [self] in applyZoom(value) }
  }

  public func setDisplayedZoom(_ value: Double) {
    queue.async { [self] in applyZoom(state.mapping.deviceZoom(forDisplayed: value)) }
  }

  private func applyZoom(_ value: Double) {
    guard let device else { return }
    let clamped = state.mapping.clampDeviceZoom(value)
    do {
      try device.lockForConfiguration()
    } catch {
      return
    }
    device.videoZoomFactor = clamped
    device.unlockForConfiguration()
    state.deviceZoom = clamped
    publish()
  }

  // MARK: - Configuration

  private func applyDevice(position: CameraPosition) {
    guard let selected = Self.preferredDevice(for: position) else {
      state.failure = "no camera available for \(position.rawValue)"
      publish()
      return
    }

    session.beginConfiguration()
    // `inputPriority` is required before setting `activeFormat`: with any other preset the session
    // owns the format and silently overrides the chosen one.
    session.sessionPreset = .inputPriority

    if let input { session.removeInput(input) }
    guard let newInput = try? AVCaptureDeviceInput(device: selected), session.canAddInput(newInput) else {
      session.commitConfiguration()
      state.failure = "could not open \(selected.localizedName)"
      publish()
      return
    }
    session.addInput(newInput)
    input = newInput
    device = selected

    attachOutputs()
    session.commitConfiguration()

    applyFormat(to: selected)
    state.position = position
    state.deviceType = selected.deviceType.rawValue
    state.mapping = Self.mapping(for: selected)
    state.failure = nil
    // Start at the wide lens rather than the ultra-wide: 1x is what an operator pointing a phone at a
    // field expects to see, and 0.5x on a triple camera is a noticeably distorted framing.
    applyZoom(state.mapping.deviceZoom(forDisplayed: 1))
  }

  private func attachOutputs() {
    if !session.outputs.contains(videoOutput) {
      videoOutput.alwaysDiscardsLateVideoFrames = true
      videoOutput.videoSettings = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      ]
      videoOutput.setSampleBufferDelegate(outputDelegate, queue: queue)
      if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }
    }
    // Landscape only, so the connection is pinned once rather than tracked against device rotation.
    if let connection = videoOutput.connection(with: .video) {
      connection.videoRotationAngle = 0
    }

    guard settings.audioEnabled else {
      if session.outputs.contains(audioOutput) { session.removeOutput(audioOutput) }
      if let audioInput { session.removeInput(audioInput) }
      audioInput = nil
      return
    }
    if audioInput == nil, let microphone = AVCaptureDevice.default(for: .audio),
       let created = try? AVCaptureDeviceInput(device: microphone), session.canAddInput(created) {
      session.addInput(created)
      audioInput = created
    }
    if !session.outputs.contains(audioOutput) {
      audioOutput.setSampleBufferDelegate(outputDelegate, queue: queue)
      if session.canAddOutput(audioOutput) { session.addOutput(audioOutput) }
    }
  }

  private func applyFormat(to device: AVCaptureDevice) {
    let isVirtual = !device.virtualDeviceSwitchOverVideoZoomFactors.isEmpty
    let catalogue = FormatCatalogue(formats: device.formats.compactMap {
      Self.descriptor($0, keepsMultiLensSwitching: isVirtual)
    })
    guard let wanted = catalogue.selection(
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate
    ) else { return }

    // Match back to the concrete format. Several `AVCaptureDevice.Format` objects can reduce to the
    // same descriptor, and any of them will do.
    let match = device.formats.first {
      Self.descriptor($0, keepsMultiLensSwitching: isVirtual) == wanted
    }
    guard let match else { return }

    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      device.activeFormat = match
      let duration = CMTime(value: 1, timescale: CMTimeScale(settings.frameRate.rounded()))
      // Pinning both ends holds the frame rate steady. Leaving the minimum open lets the device drop
      // to 12 fps in low light, which reads on the wire as a stalled camera.
      device.activeVideoMinFrameDuration = duration
      device.activeVideoMaxFrameDuration = duration
    } catch {
      return
    }
    state.activeFormat = wanted
  }

  private func publish() {
    let snapshot = state
    guard let onStateChange else { return }
    Task { @MainActor in onStateChange(snapshot) }
  }

  // MARK: - Device selection

  /// Widest virtual device first, so the app gets every lens the handset has and degrades to fewer.
  static func preferredDevice(for position: CameraPosition) -> AVCaptureDevice? {
    let types: [AVCaptureDevice.DeviceType] = switch position {
    case .back: [ .builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera ]
    case .front: [ .builtInWideAngleCamera ]
    }
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: types,
      mediaType: .video,
      position: position == .back ? .back : .front
    )
    for type in types {
      if let match = discovery.devices.first(where: { $0.deviceType == type }) { return match }
    }
    return discovery.devices.first
  }

  static func mapping(for device: AVCaptureDevice) -> ZoomMapping {
    let recommended = device.activeFormat.systemRecommendedVideoZoomRange.map { Double($0.upperBound) }
    return ZoomMapping(
      minimumDeviceZoom: device.minAvailableVideoZoomFactor,
      maximumDeviceZoom: ZoomMapping.resolveMaximumDeviceZoom(
        recommended: recommended,
        available: device.maxAvailableVideoZoomFactor
      ),
      displayMultiplier: device.displayVideoZoomFactorMultiplier,
      switchOverDeviceZooms: device.virtualDeviceSwitchOverVideoZoomFactors.map(\.doubleValue)
    )
  }

  /// `keepsMultiLensSwitching` is a property of the device, not of the format.
  ///
  /// There is no API that answers it per format, and the measurement in `docs/capabilities.md` found
  /// no format on the iPhone 13 Pro's triple camera that loses switching — all 51 keep it. So the
  /// device-level answer is used. High-frame-rate modes still read as single-lens, because on this
  /// handset they exist only on devices that have no constituents to switch between.
  static func descriptor(
    _ format: AVCaptureDevice.Format,
    keepsMultiLensSwitching: Bool
  ) -> CaptureFormatDescriptor? {
    guard let range = format.videoSupportedFrameRateRanges.first else { return nil }
    let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
    return CaptureFormatDescriptor(
      width: Int(dimensions.width),
      height: Int(dimensions.height),
      minimumFrameRate: range.minFrameRate,
      maximumFrameRate: format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? range.maxFrameRate,
      supportsMultiLensSwitching: keepsMultiLensSwitching,
      isBinned: format.isVideoBinned
    )
  }
}

public enum CameraPosition: String, Sendable, Codable, Equatable {
  case back
  case front
}

/// Split out so the session itself does not have to inherit from `NSObject`.
private final class OutputDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
  var onVideo: (@Sendable (SampleBuffer) -> Void)?
  var onAudio: (@Sendable (SampleBuffer) -> Void)?

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    if output is AVCaptureVideoDataOutput {
      onVideo?(SampleBuffer(sampleBuffer))
    } else {
      onAudio?(SampleBuffer(sampleBuffer))
    }
  }
}
