import CameramanCore
import Foundation
import TeamStationKit

/// What the streaming screen draws, four times a second.
public struct PhoneStreamStatus: Sendable, Equatable {
  /// The stream: `idle`, `connecting`, `live` or `retrying`.
  public var phase: String
  /// While `retrying`, how long until the next redial.
  public var retryInSeconds: Double?
  /// What the stream's encoder has been told, 0 while not streaming.
  public var bitrateKbps: Int
  public var displayedZoom: Double
  public var lensLabel: String
  /// Nil when the system does not know, as on a simulator.
  public var batteryPercent: Int?
  public var charging: Bool
  /// `nominal`, `fair`, `serious` or `critical`.
  public var thermal: String
  /// How long the take has been recording, counted from its start, 0 while not recording.
  public var recordingSeconds: Double
  public var isRecording: Bool
  public var error: PhoneStreamError?

  public init(
    phase: String = "idle",
    retryInSeconds: Double? = nil,
    bitrateKbps: Int = 0,
    displayedZoom: Double = 1,
    lensLabel: String = "1x",
    batteryPercent: Int? = nil,
    charging: Bool = false,
    thermal: String = "nominal",
    recordingSeconds: Double = 0,
    isRecording: Bool = false,
    error: PhoneStreamError? = nil
  ) {
    self.phase = phase
    self.retryInSeconds = retryInSeconds
    self.bitrateKbps = bitrateKbps
    self.displayedZoom = displayedZoom
    self.lensLabel = lensLabel
    self.batteryPercent = batteryPercent
    self.charging = charging
    self.thermal = thermal
    self.recordingSeconds = recordingSeconds
    self.isRecording = isRecording
    self.error = error
  }
}

/// What went wrong, as a code the screen words for itself.
public enum PhoneStreamError: String, Error, Sendable, Equatable {
  /// The server ended this camera (410): the pill reads "Stream ended", and the recording goes on.
  case streamEnded
  /// A part finished because free space fell below 500 MB; the stream goes on.
  case recordingStoppedLowStorage
  /// Recording would not start with under 2 GB free.
  case insufficientStorage
  /// The take of this stream is being uploaded, or its upload was cut off and will resume: no part
  /// may be added after the export being sent was made.
  case uploadInProgress
  /// The stream could not be put on the air, and will not be retried.
  case streamFailed
  /// The recording's writer could not start.
  case recordingFailed
  /// `startRecording` before `open`, or a second `startRecording`.
  case notReady
  /// No take of that stream is on this phone.
  case noRecording
  /// The stream is being recorded right now; stop it first.
  case stillRecording
}

/// The engine could not be made, so phone streaming is unavailable in this process: its host
/// answers unsupported and refuses every call with `reason`, and the app carries on.
public struct PhoneStreamUnavailable: Error, Sendable, Equatable {
  public var reason: String

  public init(reason: String) {
    self.reason = reason
  }
}

/// How one upload is going.
public struct PhoneUploadProgress: Sendable, Equatable {
  public enum State: String, Sendable {
    case exporting, uploading, processing, uploaded, failed
  }

  public var liveStreamId: String
  public var state: State
  /// 0…1 of the bytes, while uploading.
  public var fraction: Double
  public var bytesSent: Int
  public var bytesTotal: Int
  /// The server's step once the bytes are in: `assembling`, `remuxing`, ….
  public var step: String?
  public var videoId: String?
  public var message: String?

  public init(
    liveStreamId: String,
    state: State,
    fraction: Double = 0,
    bytesSent: Int = 0,
    bytesTotal: Int = 0,
    step: String? = nil,
    videoId: String? = nil,
    message: String? = nil
  ) {
    self.liveStreamId = liveStreamId
    self.state = state
    self.fraction = fraction
    self.bytesSent = bytesSent
    self.bytesTotal = bytesTotal
    self.step = step
    self.videoId = videoId
    self.message = message
  }
}

/// Everything the engine tells its host.
public enum PhoneStreamEvent: Sendable, Equatable {
  case status(PhoneStreamStatus)
  case radar(PhoneRadarState)
  case upload(PhoneUploadProgress)
}

/// A host's one subscription to the engine's events, which it starts and stops from any thread.
///
/// The engine lives on the main actor, so `start` registers there a moment later. A `stop` that
/// lands in that moment is not lost: the observer registered after it is cancelled at once, and a
/// second `start` while one is registered adds nothing. The engine drops a cancelled observer a
/// moment later too, so each observer delivers only while its own registration stands: an event
/// in that moment goes nowhere rather than to a host that has stopped listening.
public final class PhoneStreamEventRelay: @unchecked Sendable {
  private let lock = NSLock()
  private let engine: @MainActor () -> PhoneStreamEngine?
  private let deliver: @Sendable (PhoneStreamEvent) -> Void
  private var observation: PhoneStreamObservation?
  /// The registration in force, which `stop` closes.
  private var gate: Gate?
  private var wanted = false

  /// Whether one registration's observer still delivers.
  private final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var open = true
    var isOpen: Bool { lock.withLock { open } }
    func close() { lock.withLock { open = false } }
  }

  /// `engine` is read on the main actor at each `start`; `deliver` gets every event there.
  public init(
    engine: @escaping @MainActor () -> PhoneStreamEngine?,
    deliver: @escaping @Sendable (PhoneStreamEvent) -> Void
  ) {
    self.engine = engine
    self.deliver = deliver
  }

  /// Whether an observer is registered now.
  public var isObserving: Bool {
    lock.lock()
    defer { lock.unlock() }
    return observation != nil
  }

  /// Registers with the engine, on the main actor. Answers when that is done.
  @discardableResult
  public func start() -> Task<Void, Never> {
    lock.lock()
    wanted = true
    lock.unlock()
    return Task { @MainActor in
      guard let engine = self.engine() else { return }
      let needed = self.lock.withLock { self.wanted && self.observation == nil }
      guard needed else { return }
      let deliver = self.deliver
      let gate = Gate()
      let made = engine.observe { event in
        if gate.isOpen { deliver(event) }
      }
      let kept = self.lock.withLock {
        guard self.wanted, self.observation == nil else { return false }
        self.observation = made
        self.gate = gate
        return true
      }
      if !kept {
        gate.close()
        made.cancel()
      }
    }
  }

  /// Stops delivering, whether or not `start` has registered yet.
  public func stop() {
    lock.lock()
    wanted = false
    let observation = self.observation
    self.observation = nil
    let gate = self.gate
    self.gate = nil
    lock.unlock()
    gate?.close()
    observation?.cancel()
  }
}

/// Keeps one observer registered until it is cancelled or released.
public final class PhoneStreamObservation: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelAction: (@Sendable () -> Void)?

  init(cancel: @escaping @Sendable () -> Void) {
    cancelAction = cancel
  }

  public func cancel() {
    lock.lock()
    let action = cancelAction
    cancelAction = nil
    lock.unlock()
    action?()
  }

  deinit {
    cancel()
  }
}

/// What the engine's redial needs to ask the server for this device's stream again: the address,
/// the session's token, and this device's install id and model.
public struct PhoneStreamRequest: Sendable, Equatable {
  public var apiBase: URL
  public var token: String
  public var deviceId: String
  public var deviceModel: String

  public init(apiBase: URL, token: String, deviceId: String, deviceModel: String = DeviceModelName.current) {
    self.apiBase = apiBase
    self.token = token
    self.deviceId = deviceId
    self.deviceModel = deviceModel
  }

  /// The server's origin: `TeamStationClient` adds `/api/v1` itself, so a base given with it is
  /// taken back to the origin.
  public var serverURL: URL {
    var text = apiBase.absoluteString
    while text.hasSuffix("/") { text.removeLast() }
    if text.hasSuffix("/api/v1") { text.removeLast("/api/v1".count) }
    return URL(string: text) ?? apiBase
  }
}

/// Whether this device can stream and record, and what TeamStation lists it as.
public enum PhoneStreamCapabilities {
  /// Every iOS 18 device encodes HEVC at 1080p30.
  public static var isSupported: Bool { true }
  public static var deviceModel: String { DeviceModelName.current }
}

/// A take that was rolling when the app stopped, which reopening the streaming screen picks up.
public struct PhoneInterruptedSession: Sendable, Equatable {
  public var liveStreamId: String
  public var gameId: String
  public var angleName: String
  /// The take that continues, nil when only the stream was on the air (its part had stopped for
  /// low storage).
  public var recordingID: Int64?
  /// Whether the stream was on the air too.
  public var streaming: Bool
  /// How long the app was away.
  public var downtime: TimeInterval
}
