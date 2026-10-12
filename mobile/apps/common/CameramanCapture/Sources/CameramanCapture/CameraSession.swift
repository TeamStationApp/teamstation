import AVFoundation
import CameramanCore
import Foundation
import QuartzCore

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
/// exactly as the operator taps the flip button. A preview layer drawn through `showPreview` is
/// attached, turned and detached on that queue too.
public final class CameraSession: @unchecked Sendable {
  public struct State: Sendable, Equatable {
    public var position: CameraPosition = .back
    public var deviceType: String = ""
    public var mapping: ZoomMapping = ZoomMapping(maximumDeviceZoom: 1)
    public var deviceZoom: Double = 1
    public var activeFormat: CaptureFormatDescriptor?
    /// Every format the current device offers, for the settings picker. Read from the device rather
    /// than assumed, because the front and back cameras offer different sets and neither matches
    /// what a hardcoded list would say.
    public var availableFormats: [CaptureFormatDescriptor] = []
    /// Optical cameras measured on this handset, including native crops. Empty on a simulator.
    public var availableLenses: [CameraLens] = []
    public var isRunning = false
    public var failure: String?
    public var isInterrupted = false
    public var interruptionReason: String?
    /// 0° or 180° last applied to the capture connection. The preview layer uses the same value so
    /// the operator frames what the encoder sends, including after a front-camera flip.
    public var captureRotationAngle: Double = 180

    public init() {}

    public var displayedZoom: Double { mapping.displayedZoom(forDevice: deviceZoom) }
    public var lensIndex: Int { mapping.lensIndex(forDevice: deviceZoom) }
  }

  private let queue = DispatchQueue(label: "app.teamstation.cameraman.capture")
  private let session = AVCaptureSession()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let audioOutput = AVCaptureAudioDataOutput()
  private let outputDelegate = OutputDelegate()

  private var device: AVCaptureDevice?
  private var input: AVCaptureDeviceInput?
  private var audioInput: AVCaptureDeviceInput?
  private var settings = StreamSettings.default
  private var state = State()
  private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
  private var rotationObservation: NSKeyValueObservation?
  /// Last 0°/180° applied to the capture connection. Portrait angles from the coordinator at launch
  /// would swap 1920×1080 into portrait; those are ignored and this is used instead.
  private var lastLandscapeCaptureAngle: CGFloat = 180
  private var sessionObservers: [any NSObjectProtocol] = []
  /// The preview layers drawing this session, with the angle and mirroring each was asked for.
  private var previews: [ObjectIdentifier: PreviewHold] = [:]

  /// Delivered on the main queue, because every consumer is UI.
  public var onStateChange: (@MainActor @Sendable (State) -> Void)?
  /// Fired on the capture queue when the encoded buffers are rotated. A client that has already
  /// decoded a GOP at the previous angle otherwise shows the next frames inverted until a keyframe.
  public var onCaptureRotationChange: (@Sendable () -> Void)?
  public var onVideoFrame: (@Sendable (SampleBuffer) -> Void)? {
    get { outputDelegate.onVideo }
    set { outputDelegate.onVideo = newValue }
  }
  public var onAudioFrame: (@Sendable (SampleBuffer) -> Void)? {
    get { outputDelegate.onAudio }
    set { outputDelegate.onAudio = newValue }
  }

  public init() {
    observeSessionLifecycle()
  }

  deinit {
    sessionObservers.forEach { NotificationCenter.default.removeObserver($0) }
  }

  /// The session itself, to tell which session a layer draws. A preview layer is attached, turned
  /// and detached only through `showPreview` and `hidePreview`, never by setting its session.
  public var captureSession: AVCaptureSession { session }

  /// Draws this session in a preview layer, turned by `rotationAngle` and mirrored when asked. Called
  /// again for the same layer, it changes the angle or the mirroring.
  ///
  /// A preview layer's session, and its connection's angle and mirroring, are the session's
  /// configuration: AVFoundation brackets each change in `beginConfiguration` and
  /// `commitConfiguration`. `startRunning` and `stopRunning` raise an exception when they run inside
  /// such a bracket opened on another thread, so these changes are made on the capture queue, in
  /// order with `start`, `stop` and every other change, never on the main thread. The angle and the
  /// mirroring are kept and applied again whenever the connection is rebuilt: after a flip, and when
  /// the session starts.
  public func showPreview(in layer: AVCaptureVideoPreviewLayer, rotationAngle: CGFloat, mirrored: Bool) {
    let target = PreviewHold(layer: layer, rotationAngle: rotationAngle, mirrored: mirrored)
    let key = ObjectIdentifier(layer)
    queue.async { [self] in
      guard let layer = target.layer else { return }
      previews[key] = target
      Self.withoutAnimation {
        if layer.session !== session { layer.session = session }
        applyPreview(target)
      }
    }
  }

  /// Stops drawing this session in a preview layer, on the capture queue, after every change and
  /// every start or stop asked for before it, then calls `done` there. The layer is held until then:
  /// a preview layer freed while attached detaches itself on the thread that frees it.
  ///
  /// A layer that is to draw another session is shown there only after `done`. Setting a layer's
  /// session detaches it from the one it had, on the calling thread, so showing it on another
  /// session's queue first would detach it from this session off this queue.
  public func hidePreview(in layer: AVCaptureVideoPreviewLayer, then done: (@Sendable () -> Void)? = nil) {
    let held = HeldLayer(layer)
    let key = ObjectIdentifier(layer)
    queue.async { [self] in
      previews[key] = nil
      if held.layer.session === session {
        Self.withoutAnimation { held.layer.session = nil }
      }
      done?()
    }
  }

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
      applyPreviews()
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
      let catalog = state.availableLenses
      let selection = LensSelection(disabledIDs: settings.disabledLensIDs).normalized(in: catalog)
      let target: CameraPosition = state.position == .back ? .front : .back
      // An empty catalog is a simulator (or a probe that has not run yet); flipping still has to
      // work there. On a handset, a position with every lens toggled off is not a camera.
      if !catalog.isEmpty, !selection.hasEnabledLens(at: target, in: catalog) { return }
      applyDevice(position: target)
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

  private func applyDevice(position requested: CameraPosition) {
    let catalog = LensDiscovery.discover()
    state.availableLenses = catalog
    let selection = LensSelection(disabledIDs: settings.disabledLensIDs).normalized(in: catalog)

    var position = requested
    if !catalog.isEmpty, !selection.hasEnabledLens(at: position, in: catalog) {
      let other: CameraPosition = position == .back ? .front : .back
      if selection.hasEnabledLens(at: other, in: catalog) {
        position = other
      }
    }

    guard let selected = Self.preferredDevice(
      for: position,
      types: selection.preferredDeviceTypes(for: position, in: catalog)
    ) else {
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

    // Position is recorded before the new input's rotation is applied so a flip publishes the
    // matching camera and angle together.
    state.position = position
    attachOutputs()
    session.commitConfiguration()
    attachRotationCoordinator(for: selected)

    applyFormat(to: selected)
    applySwitching(to: selected, selection: selection, catalog: catalog)
    state.deviceType = selected.deviceType.rawValue
    state.availableFormats = Self.descriptors(of: selected)
    state.mapping = Self.mapping(for: selected, selection: selection, catalog: catalog, position: position)
    state.failure = nil
    applyPreviews()
    // Start at the wide lens rather than the ultra-wide: 1x is what an operator pointing a phone at a
    // field expects to see, and 0.5x on a triple camera is a noticeably distorted framing. When 1x
    // is not among the remaining lenses, sit on the widest one that is still on.
    if state.mapping.presetDisplayedZooms.contains(where: {
      ZoomMapping.label(forDisplayed: $0) == ZoomMapping.label(forDisplayed: 1)
    }) {
      applyZoom(state.mapping.deviceZoom(forDisplayed: 1))
    } else {
      applyZoom(state.mapping.minimumDeviceZoom)
    }
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
    // Rotation is applied by `RotationCoordinator` so a 180° flip of the phone inverts the encoded
    // buffers rather than leaving Producer upside down. 0° here is only the placeholder until that
    // coordinator has a device.
    if let connection = videoOutput.connection(with: .video) {
      if connection.isVideoMirroringSupported {
        connection.automaticallyAdjustsVideoMirroring = false
        connection.isVideoMirrored = false
      }
      let angle = lastLandscapeCaptureAngle
      if connection.isVideoRotationAngleSupported(angle) {
        connection.videoRotationAngle = angle
        state.captureRotationAngle = Double(angle)
      }
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

  /// Every format the device offers, reduced to what the picker and the catalogue need.
  static func descriptors(of device: AVCaptureDevice) -> [CaptureFormatDescriptor] {
    let isVirtual = !device.virtualDeviceSwitchOverVideoZoomFactors.isEmpty
    return device.formats.compactMap { descriptor($0, keepsMultiLensSwitching: isVirtual) }
  }

  private func applyFormat(to device: AVCaptureDevice) {
    let isVirtual = !device.virtualDeviceSwitchOverVideoZoomFactors.isEmpty
    let catalogue = FormatCatalogue(formats: Self.descriptors(of: device))
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

  /// Rotates the buffers that go to the encoder so Producer is upright in both landscape holds.
  ///
  /// The preview layer uses the same 0°/180°. Pinning capture at 0° left one hold inverted on the
  /// wire. `RotationCoordinator` tracks gravity and reports the horizon-level capture angle.
  /// 90°/270° would turn 1920×1080 into portrait, which this app does not send.
  private func attachRotationCoordinator(for device: AVCaptureDevice) {
    rotationObservation?.invalidate()
    let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
    rotationCoordinator = coordinator
    applyCaptureRotation(coordinator.videoRotationAngleForHorizonLevelCapture)
    rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelCapture) { [weak self] coordinator, _ in
      let angle = coordinator.videoRotationAngleForHorizonLevelCapture
      self?.applyCaptureRotation(angle)
    }
  }

  private func applyCaptureRotation(_ proposed: CGFloat) {
    queue.async { [self] in
      switch proposed {
      case 180, 270:
        lastLandscapeCaptureAngle = 180
      case 0:
        lastLandscapeCaptureAngle = 0
      default:
        break
      }
      let angle = lastLandscapeCaptureAngle
      guard let connection = videoOutput.connection(with: .video) else { return }
      if connection.isVideoMirroringSupported {
        connection.automaticallyAdjustsVideoMirroring = false
        if connection.isVideoMirrored {
          connection.isVideoMirrored = false
        }
      }
      guard connection.isVideoRotationAngleSupported(angle) else { return }
      if connection.videoRotationAngle != angle {
        connection.videoRotationAngle = angle
        onCaptureRotationChange?()
      }
      if state.captureRotationAngle != Double(angle) {
        state.captureRotationAngle = Double(angle)
        publish()
      }
    }
  }

  /// Each preview's angle and mirroring, on its connection as it is now. A connection is made only once
  /// the session has an input, and made again when the input changes.
  private func applyPreviews() {
    previews = previews.filter { $0.value.layer != nil }
    guard !previews.isEmpty else { return }
    Self.withoutAnimation {
      for target in previews.values { applyPreview(target) }
    }
  }

  /// Only what has changed: setting a connection again on every call reconfigures a running session
  /// for nothing.
  private func applyPreview(_ target: PreviewHold) {
    guard let connection = target.layer?.connection else { return }
    if connection.videoRotationAngle != target.rotationAngle,
       connection.isVideoRotationAngleSupported(target.rotationAngle) {
      connection.videoRotationAngle = target.rotationAngle
    }
    if connection.isVideoMirroringSupported {
      if connection.automaticallyAdjustsVideoMirroring {
        connection.automaticallyAdjustsVideoMirroring = false
      }
      if connection.isVideoMirrored != target.mirrored {
        connection.isVideoMirrored = target.mirrored
      }
    }
  }

  /// A layer changed off the main thread is committed in its own transaction, without the implicit
  /// animation a layer property change would otherwise get.
  private static func withoutAnimation(_ change: () -> Void) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    change()
    CATransaction.commit()
  }

  private func publish() {
    let snapshot = state
    guard let onStateChange else { return }
    Task { @MainActor in onStateChange(snapshot) }
  }

  // MARK: - Session lifecycle

  /// Capture can die without `stop()` being called: backgrounding, another app taking the camera,
  /// or a runtime error. The soak has to see those as first-class faults, not as a silent `isRunning`.
  private func observeSessionLifecycle() {
    let center = NotificationCenter.default
    sessionObservers.append(center.addObserver(
      forName: AVCaptureSession.wasInterruptedNotification,
      object: session,
      queue: nil
    ) { [weak self] notification in
      let reason = CameraSession.interruptionReason(from: notification)
      self?.queue.async {
        guard let self else { return }
        self.state.isInterrupted = true
        self.state.interruptionReason = reason
        self.state.isRunning = self.session.isRunning
        self.publish()
      }
    })
    sessionObservers.append(center.addObserver(
      forName: AVCaptureSession.interruptionEndedNotification,
      object: session,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async {
        guard let self else { return }
        self.state.isInterrupted = false
        self.state.interruptionReason = nil
        self.state.isRunning = self.session.isRunning
        self.publish()
      }
    })
    sessionObservers.append(center.addObserver(
      forName: AVCaptureSession.runtimeErrorNotification,
      object: session,
      queue: nil
    ) { [weak self] notification in
      let error = notification.userInfo?[AVCaptureSessionErrorKey] as? NSError
      let failure = error.map {
        "runtimeError \($0.domain) \($0.code): \($0.localizedDescription)"
      } ?? "runtimeError"
      self?.queue.async {
        guard let self else { return }
        self.state.failure = failure
        self.state.isRunning = self.session.isRunning
        self.publish()
      }
    })
    sessionObservers.append(center.addObserver(
      forName: AVCaptureSession.didStartRunningNotification,
      object: session,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async { self?.syncRunningFlag() }
    })
    sessionObservers.append(center.addObserver(
      forName: AVCaptureSession.didStopRunningNotification,
      object: session,
      queue: nil
    ) { [weak self] _ in
      self?.queue.async { self?.syncRunningFlag() }
    })
  }

  private func syncRunningFlag() {
    let running = session.isRunning
    guard state.isRunning != running else { return }
    state.isRunning = running
    if running { applyPreviews() }
    publish()
  }

  /// Named for dump-state rather than the AVFoundation enum, so a soak log stays readable.
  public static func interruptionReasonName(_ reason: AVCaptureSession.InterruptionReason) -> String {
    switch reason {
    case .videoDeviceNotAvailableInBackground: "background"
    case .audioDeviceInUseByAnotherClient: "audioInUse"
    case .videoDeviceInUseByAnotherClient: "videoInUse"
    case .videoDeviceNotAvailableWithMultipleForegroundApps: "splitView"
    case .videoDeviceNotAvailableDueToSystemPressure: "systemPressure"
    @unknown default: "unknown"
    }
  }

  public static func interruptionReason(from notification: Notification) -> String {
    guard
      let boxed = notification.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber,
      let reason = AVCaptureSession.InterruptionReason(rawValue: boxed.intValue)
    else {
      return "interrupted"
    }
    return interruptionReasonName(reason)
  }

  // MARK: - Device selection

  /// Widest virtual device first, so the app gets every lens the handset has and degrades to fewer.
  static func preferredDevice(for position: CameraPosition) -> AVCaptureDevice? {
    preferredDevice(
      for: position,
      types: position == .back ? LensSelection.backDefaultPreference : LensSelection.frontDefaultPreference
    )
  }

  static func preferredDevice(for position: CameraPosition, types: [String]) -> AVCaptureDevice? {
    guard !types.isEmpty else { return nil }
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: [
        .builtInTripleCamera,
        .builtInDualWideCamera,
        .builtInDualCamera,
        .builtInWideAngleCamera,
        .builtInUltraWideCamera,
        .builtInTelephotoCamera
      ],
      mediaType: .video,
      position: position == .back ? .back : .front
    )
    for type in types {
      if let match = discovery.devices.first(where: { $0.deviceType.rawValue == type }) { return match }
    }
    return discovery.devices.first
  }

  static func mapping(
    for device: AVCaptureDevice,
    selection: LensSelection = LensSelection(),
    catalog: [CameraLens] = [],
    position: CameraPosition = .back
  ) -> ZoomMapping {
    // Lens handovers only. A native crop such as the 2x is not a lens, so it is not a stop on the
    // rail: the pills are the optical zooms an operator can aim for to avoid digital zoom.
    let switchOvers = device.virtualDeviceSwitchOverVideoZoomFactors.map(\.doubleValue).sorted()
    let multiplier = device.displayVideoZoomFactorMultiplier

    let recommended = device.activeFormat.systemRecommendedVideoZoomRange.map { Double($0.upperBound) }
    let cameraCeiling = ZoomMapping.resolveMaximumDeviceZoom(
      recommended: recommended,
      available: device.maxAvailableVideoZoomFactor
    )
    // Software zoom past the camera's own ceiling: the device crops and upscales further, which
    // `maxAvailableVideoZoomFactor` allows well beyond twice the recommended range.
    let softwareCeiling = min(cameraCeiling * ZoomMapping.softwareZoomExtension, device.maxAvailableVideoZoomFactor)
    return ZoomMapping(
      minimumDeviceZoom: device.minAvailableVideoZoomFactor,
      maximumDeviceZoom: softwareCeiling,
      displayMultiplier: multiplier,
      switchOverDeviceZooms: switchOvers,
      softwareZoomStartDeviceZoom: cameraCeiling
    )
  }

  /// Stops the virtual device falling back to a lens the operator turned off. Auto switching for
  /// focus is what an external glass on one camera loses when the phone silently hops to another.
  private func applySwitching(
    to device: AVCaptureDevice,
    selection: LensSelection,
    catalog: [CameraLens]
  ) {
    guard device.isVirtualDevice,
          device.primaryConstituentDeviceSwitchingBehavior != .unsupported
    else { return }

    let enabledIDs = Set(
      selection.enabled(in: catalog).filter { !$0.isSecondaryNative }.map(\.uniqueDeviceID)
    )
    let fallback = device.supportedFallbackPrimaryConstituentDevices.filter {
      enabledIDs.contains($0.uniqueID)
    }
    let enabledConstituents = device.constituentDevices.filter { enabledIDs.contains($0.uniqueID) }
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      device.fallbackPrimaryConstituentDevices = fallback
      if enabledConstituents.count <= 1 {
        device.setPrimaryConstituentDeviceSwitchingBehavior(
          .locked,
          restrictedSwitchingBehaviorConditions: []
        )
      } else if enabledConstituents.count < device.constituentDevices.count {
        device.setPrimaryConstituentDeviceSwitchingBehavior(
          .restricted,
          restrictedSwitchingBehaviorConditions: []
        )
      } else {
        device.setPrimaryConstituentDeviceSwitchingBehavior(
          .auto,
          restrictedSwitchingBehaviorConditions: []
        )
      }
    } catch {
      return
    }
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

/// A preview layer and what it was asked to show. The layer is a `CALayer`, which is not `Sendable`;
/// it is handed to the capture queue and touched only there, inside a transaction.
private final class PreviewHold: @unchecked Sendable {
  weak var layer: AVCaptureVideoPreviewLayer?
  let rotationAngle: CGFloat
  let mirrored: Bool

  init(layer: AVCaptureVideoPreviewLayer, rotationAngle: CGFloat, mirrored: Bool) {
    self.layer = layer
    self.rotationAngle = rotationAngle
    self.mirrored = mirrored
  }
}

/// A preview layer kept alive until the capture queue has detached it.
private struct HeldLayer: @unchecked Sendable {
  let layer: AVCaptureVideoPreviewLayer

  init(_ layer: AVCaptureVideoPreviewLayer) {
    self.layer = layer
  }
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
