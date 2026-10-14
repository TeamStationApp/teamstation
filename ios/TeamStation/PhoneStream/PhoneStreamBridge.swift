import AVFoundation
import CameramanCapture
import Foundation
import PhoneStream
import react_native_video
import UIKit

/// What every call hands back to `RCTPhoneStream`: a value to resolve with, or an error code (the
/// engine's own, such as `uploadInProgress`) and a message to reject with.
typealias PhoneStreamReply = (_ value: Any?, _ code: String?, _ message: String?) -> Void

/**
 * `PhoneStreamEngine` for the `TSPhoneStream` TurboModule, in Foundation types the Objective-C++
 * module can pass straight through: arguments come in as strings, numbers and dictionaries, and
 * results, refusals and events go back as dictionaries shaped like `NativePhoneStream.ts`. The
 * engine lives on the main actor; every call hops there.
 *
 * Declared again by hand in `RCTPhoneStream.mm`: the generated Swift header also declares the app
 * delegate, whose Objective-C superclass an Objective-C++ file cannot import as a module.
 */
@objc(TSPhoneStreamBridge)
final class TSPhoneStreamBridge: NSObject {
  /// Posted on the main queue whenever the preview's capture session may have changed: after an
  /// `open` or a `close`.
  @objc static let previewSessionChanged = Notification.Name("TSPhoneStreamPreviewSessionChanged")

  @objc var onStatus: (([String: Any]) -> Void)?
  @objc var onRadar: (([String: Any]) -> Void)?
  @objc var onUpload: (([String: Any]) -> Void)?

  private var observation: PhoneStreamObservation?

  @objc func startObserving() {
    Task { @MainActor in
      guard self.observation == nil else { return }
      self.observation = PhoneStreamEngine.shared.observe { [weak self] event in
        self?.deliver(event)
      }
    }
  }

  @objc func stopObserving() {
    let observation = self.observation
    self.observation = nil
    observation?.cancel()
  }

  private func deliver(_ event: PhoneStreamEvent) {
    switch event {
    case let .status(status): onStatus?(Self.dictionary(status))
    case let .radar(radar): onRadar?(Self.dictionary(radar))
    case let .upload(upload): onUpload?(Self.dictionary(upload))
    }
  }

  /// The capture session the preview layer draws, nil before `open` and on a simulator.
  @MainActor @objc static func previewSession() -> AVCaptureSession? {
    PhoneStreamEngine.shared.previewSession
  }

  // MARK: - Calls

  @objc func capabilities(_ reply: @escaping PhoneStreamReply) {
    reply(["supported": PhoneStreamCapabilities.isSupported, "deviceModel": PhoneStreamCapabilities.deviceModel], nil, nil)
  }

  @objc func open(_ angleName: String, audioEnabled: Bool, disabledLenses: [String], reply: @escaping PhoneStreamReply) {
    Self.allowCapture(audio: true) { allowed in
      guard allowed else {
        reply(nil, "permission", "The camera or the microphone is not allowed")
        return
      }
      Self.run(reply) { engine in
        // The capture owns the audio session while the engine is open. The video player sets it
        // back to playback whenever its category changes, and the capture session sets it to play
        // and record each time it rebuilds its graph, as a rotation does: the microphone then fails
        // the rebuild with a runtime error that stops the camera.
        PublicAudioSessionManager.setIsAudioSessionManagementDisabled(true)
        do {
          try engine.open(angleName: angleName, audioEnabled: audioEnabled, disabledLenses: Set(disabledLenses))
        } catch {
          if !engine.isOpen { PublicAudioSessionManager.setIsAudioSessionManagementDisabled(false) }
          throw error
        }
        // The streaming screen is up while the engine is open: the phone stays awake for it.
        UIApplication.shared.isIdleTimerDisabled = true
        NotificationCenter.default.post(name: Self.previewSessionChanged, object: nil)
        return nil
      }
    }
  }

  @objc func close(_ reply: @escaping PhoneStreamReply) {
    Self.runAsync(reply) { engine in
      await engine.close()
      PublicAudioSessionManager.setIsAudioSessionManagementDisabled(false)
      UIApplication.shared.isIdleTimerDisabled = false
      NotificationCenter.default.post(name: Self.previewSessionChanged, object: nil)
      return nil
    }
  }

  @objc func setAngleName(_ name: String, reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      engine.setAngleName(name)
      return nil
    }
  }

  @objc func startRecording(
    _ rtmpUrl: String,
    liveStreamId: String,
    gameId: String,
    angleName: String,
    request: [String: Any],
    reply: @escaping PhoneStreamReply
  ) {
    guard let request = Self.request(request) else {
      reply(nil, "badRequest", "The stream request needs an apiBase")
      return
    }
    Self.run(reply) { engine in
      try engine.startRecording(
        rtmpUrl: rtmpUrl,
        liveStreamId: liveStreamId,
        gameId: gameId,
        angleName: angleName,
        request: request
      )
      return nil
    }
  }

  @objc func stopRecording(_ reply: @escaping PhoneStreamReply) {
    Self.runAsync(reply) { engine in
      await engine.stopRecording()
      return nil
    }
  }

  @objc func interruptedSession(_ reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      guard let session = engine.interruptedSession() else { return nil }
      return [
        "liveStreamId": session.liveStreamId,
        "gameId": session.gameId,
        "angleName": session.angleName,
        "streaming": session.streaming,
        "downtimeSeconds": session.downtime
      ] as [String: Any]
    }
  }

  @objc func resumeInterrupted(_ request: [String: Any], reply: @escaping PhoneStreamReply) {
    guard let request = Self.request(request) else {
      reply(nil, "badRequest", "The stream request needs an apiBase")
      return
    }
    Self.run(reply) { engine in try engine.resumeInterrupted(request: request) }
  }

  @objc func setZoom(_ displayed: Double) {
    Task { @MainActor in PhoneStreamEngine.shared.setZoom(displayed: displayed) }
  }

  @objc func pinch(_ scale: Double, ended: Bool) {
    Task { @MainActor in PhoneStreamEngine.shared.pinch(scale: scale, ended: ended) }
  }

  @objc func zoomScale(_ reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      let scale = engine.zoomScale()
      var value: [String: Any] = [
        "presets": scale.presets,
        "switchOvers": scale.switchOvers,
        "minimum": scale.minimum,
        "maximum": scale.maximum,
        "current": scale.current
      ]
      if let digitalFrom = scale.digitalFrom { value["digitalFrom"] = digitalFrom }
      return value
    }
  }

  @objc func lenses(_ reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      engine.lenses().map { lens -> [String: Any] in
        var value: [String: Any] = [
          "id": lens.lens.id,
          "position": lens.lens.position.rawValue,
          "title": lens.lens.title,
          "subtitle": lens.lens.subtitle,
          "displayedZoom": lens.lens.displayedZoom,
          "enabled": lens.enabled,
          "canDisable": lens.canDisable
        ]
        if let focal = lens.lens.focalLengthMM { value["focalLengthMM"] = focal }
        return value
      }
    }
  }

  @objc func setDisabledLenses(_ ids: [String], reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      engine.setDisabledLenses(Set(ids))
      return nil
    }
  }

  @objc func flip(_ reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      engine.flip()
      return nil
    }
  }

  @objc func setAudioEnabled(_ enabled: Bool, reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      engine.setAudioEnabled(enabled)
      return nil
    }
  }

  // MARK: - Radar

  @objc func radarSetEnabled(_ enabled: Bool, reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      engine.radar.setEnabled(enabled)
      return nil
    }
  }

  @objc func radarScan(_ reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      engine.radar.scan()
      return nil
    }
  }

  @objc func radarStopScan(_ reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      engine.radar.stopScan()
      return nil
    }
  }

  @objc func radarPair(_ serial: String, reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in engine.radar.pair(serial) }
  }

  @objc func radarUnpair(_ serial: String, reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      engine.radar.unpair(serial)
      return nil
    }
  }

  @objc func radarState(_ reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in Self.dictionary(engine.radar.state) }
  }

  // MARK: - Recordings

  @objc func recordings(_ reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      let running = engine.runningUploads
      let progress = engine.runningUploadProgress
      return try engine.recordings().map {
        Self.dictionary($0, running: running.contains($0.recordingID), progress: progress[$0.recordingID])
      }
    }
  }

  @objc func uploadRecording(
    _ liveStreamId: String,
    apiBase: String,
    token: String,
    title: String,
    reply: @escaping PhoneStreamReply
  ) {
    guard let base = URL(string: apiBase) else {
      reply(nil, "badRequest", "apiBase is not an address")
      return
    }
    Self.runAsync(reply) { engine in
      try await engine.uploadRecording(liveStreamId: liveStreamId, apiBase: base, token: token, title: title)
    }
  }

  @objc func resumePendingUploads(_ apiBase: String, token: String, reply: @escaping PhoneStreamReply) {
    guard let base = URL(string: apiBase) else {
      reply(nil, "badRequest", "apiBase is not an address")
      return
    }
    Self.run(reply) { engine in engine.resumePendingUploads(apiBase: base, token: token) }
  }

  @objc func cancelUpload(_ liveStreamId: String, reply: @escaping PhoneStreamReply) {
    Self.runAsync(reply) { engine in
      await engine.cancelUpload(liveStreamId: liveStreamId)
      return nil
    }
  }

  @objc func deleteRecording(_ liveStreamId: String, reply: @escaping PhoneStreamReply) {
    Self.run(reply) { engine in
      try engine.deleteRecording(liveStreamId: liveStreamId)
      return nil
    }
  }

  // MARK: - Running on the engine

  private static func run(_ reply: @escaping PhoneStreamReply, _ work: @escaping @MainActor (PhoneStreamEngine) throws -> Any?) {
    Task { @MainActor in
      do {
        reply(try work(PhoneStreamEngine.shared), nil, nil)
      } catch {
        reject(reply, error)
      }
    }
  }

  private static func runAsync(_ reply: @escaping PhoneStreamReply, _ work: @escaping @MainActor (PhoneStreamEngine) async throws -> Any?) {
    Task { @MainActor in
      do {
        reply(try await work(PhoneStreamEngine.shared), nil, nil)
      } catch {
        reject(reply, error)
      }
    }
  }

  private static func reject(_ reply: PhoneStreamReply, _ error: Error) {
    if let refusal = error as? PhoneStreamError {
      reply(nil, refusal.rawValue, refusal.rawValue)
    } else {
      reply(nil, "failed", "\(error)")
    }
  }

  /// The camera, and the microphone when it is wanted. The simulator has no camera: its synthetic
  /// source stands in, and needs no permission.
  private static func allowCapture(audio: Bool, _ done: @escaping @Sendable (Bool) -> Void) {
    #if targetEnvironment(simulator)
      done(true)
    #else
      AVCaptureDevice.requestAccess(for: .video) { video in
        guard video else {
          done(false)
          return
        }
        guard audio else {
          done(true)
          return
        }
        AVCaptureDevice.requestAccess(for: .audio) { done($0) }
      }
    #endif
  }

  // MARK: - Conversions

  private static func request(_ value: [String: Any]) -> PhoneStreamRequest? {
    guard let text = value["apiBase"] as? String, let apiBase = URL(string: text) else { return nil }
    return PhoneStreamRequest(
      apiBase: apiBase,
      token: value["token"] as? String ?? "",
      deviceId: value["deviceId"] as? String ?? "",
      deviceModel: value["deviceModel"] as? String ?? PhoneStreamCapabilities.deviceModel
    )
  }

  static func dictionary(_ status: PhoneStreamStatus) -> [String: Any] {
    var value: [String: Any] = [
      "phase": status.phase,
      "bitrateKbps": status.bitrateKbps,
      "displayedZoom": status.displayedZoom,
      "lensLabel": status.lensLabel,
      "charging": status.charging,
      "thermal": status.thermal,
      "recordingSeconds": status.recordingSeconds,
      "isRecording": status.isRecording
    ]
    if let retry = status.retryInSeconds { value["retryInSeconds"] = retry }
    if let battery = status.batteryPercent { value["batteryPercent"] = battery }
    if let error = status.error { value["error"] = error.rawValue }
    return value
  }

  static func dictionary(_ state: PhoneRadarState) -> [String: Any] {
    let bluetooth: String
    switch state.bluetooth {
    case .on: bluetooth = "on"
    case .off: bluetooth = "off"
    case .unknown: bluetooth = "unknown"
    }
    return [
      "enabled": state.enabled,
      "scanning": state.scanning,
      "bluetooth": bluetooth,
      "devices": state.devices.map { device -> [String: Any] in
        var value: [String: Any] = ["serial": device.serial, "connection": device.connection.rawValue]
        if let battery = device.batteryPercent { value["batteryPercent"] = battery }
        if let pitch = device.pitchMph { value["pitchMph"] = pitch }
        if let exit = device.exitMph { value["exitMph"] = exit }
        if let at = device.readingAt { value["readingAt"] = at.timeIntervalSince1970 * 1_000 }
        return value
      },
      "nearby": state.nearby
    ]
  }

  static func dictionary(_ upload: PhoneUploadProgress) -> [String: Any] {
    var value: [String: Any] = [
      "liveStreamId": upload.liveStreamId,
      "state": upload.state.rawValue,
      "fraction": upload.fraction,
      "bytesSent": upload.bytesSent,
      "bytesTotal": upload.bytesTotal
    ]
    if let step = upload.step { value["step"] = step }
    if let videoId = upload.videoId { value["videoId"] = videoId }
    if let message = upload.message { value["message"] = message }
    return value
  }

  /// A take, with where its upload stands when one runs in this process: a screen opened part-way
  /// through starts from that rather than from nothing.
  static func dictionary(
    _ recording: PhoneRecording,
    running: Bool,
    progress: PhoneUploadProgress? = nil
  ) -> [String: Any] {
    var value: [String: Any] = [
      "liveStreamId": recording.liveStreamId,
      "gameId": recording.gameId,
      "angleName": recording.angleName,
      "startedAt": recording.startedAt.seconds * 1_000,
      "parts": recording.parts,
      "stoppedForLowStorage": recording.stoppedForLowStorage,
      "publishedOutsideParts": recording.publishedOutsideParts,
      "uploadRunning": running
    ]
    if let endedAt = recording.endedAt { value["endedAt"] = endedAt.seconds * 1_000 }
    if let uploadId = recording.uploadId { value["uploadId"] = uploadId }
    if let title = recording.uploadTitle { value["uploadTitle"] = title }
    if let uploadedAt = recording.uploadedAt { value["uploadedAt"] = uploadedAt.seconds * 1_000 }
    if let videoId = recording.videoId { value["videoId"] = videoId }
    if running, let progress { value["uploadProgress"] = dictionary(progress) }
    return value
  }
}
