import CameramanCapture
import DirectorCore
import DirectorMedia
import Foundation
import UIKit

/// Work that must not be cut off when the app goes to the background: an upload. The system's
/// `beginBackgroundTask`, or nothing in a test.
public struct PhoneBackgroundWork: Sendable {
  public var begin: @MainActor @Sendable (String) -> Int
  public var end: @MainActor @Sendable (Int) -> Void

  public init(
    begin: @escaping @MainActor @Sendable (String) -> Int,
    end: @escaping @MainActor @Sendable (Int) -> Void
  ) {
    self.begin = begin
    self.end = end
  }

  public static let system = PhoneBackgroundWork(
    begin: { name in UIApplication.shared.beginBackgroundTask(withName: name).rawValue },
    end: { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: $0)) }
  )

  public static let none = PhoneBackgroundWork(begin: { _ in 0 }, end: { _ in })
}

/// Everything the engine reaches outside itself, so a test can stand in for each: where it keeps
/// its files, its clocks, its camera, the network, the radars and the phone's battery.
public struct PhoneStreamEnvironment {
  public var storage: PhoneStorage
  public var clock: DirectorClock
  public var makeSource: @MainActor () -> PhoneCameraSource
  public var freeDiskBytes: @Sendable () -> Int64
  public var storageRules: PhoneStorageRules
  public var retention: PhoneRetentionPolicy
  public var urlSession: URLSession
  public var makeRetryScheduler: @MainActor () -> (any StreamRetryScheduling)?
  public var makePathMonitor: @MainActor () -> (any NetworkPathMonitoring)?
  public var heartbeatInterval: TimeInterval
  /// How often `status` is published: four times a second.
  public var statusInterval: TimeInterval
  /// How often free space is checked while recording.
  public var storageCheckInterval: TimeInterval
  /// How long the recording keeps writing after Stop, so its file reaches the moment of the Stop
  /// through the picture delay.
  public var stopTailSeconds: Double
  public var makeDeviceStatus: @MainActor () -> any PhoneDeviceStatusReading
  public var makeRadarFleet: @MainActor () -> RadarFleet
  public var backgroundWork: PhoneBackgroundWork
  /// Whether the engine follows the app into the background and back.
  public var observesApplication: Bool

  @MainActor
  public init(
    storage: PhoneStorage,
    clock: DirectorClock = SystemClock(),
    makeSource: @escaping @MainActor () -> PhoneCameraSource,
    freeDiskBytes: (@Sendable () -> Int64)? = nil,
    storageRules: PhoneStorageRules = .standard,
    retention: PhoneRetentionPolicy = PhoneRetentionPolicy(),
    urlSession: URLSession = .shared,
    makeRetryScheduler: @escaping @MainActor () -> (any StreamRetryScheduling)? = { nil },
    makePathMonitor: @escaping @MainActor () -> (any NetworkPathMonitoring)? = { SystemNetworkPathMonitor() },
    heartbeatInterval: TimeInterval = RecordingSession.defaultHeartbeatInterval,
    statusInterval: TimeInterval = 0.25,
    storageCheckInterval: TimeInterval = 5,
    stopTailSeconds: Double = PhoneStreamProfile.pictureDelaySeconds,
    makeDeviceStatus: @escaping @MainActor () -> any PhoneDeviceStatusReading = { SystemDeviceStatus() },
    makeRadarFleet: @escaping @MainActor () -> RadarFleet = { RadarFleet(storage: .phoneStream) },
    backgroundWork: PhoneBackgroundWork = .system,
    observesApplication: Bool = true
  ) {
    self.storage = storage
    self.clock = clock
    self.makeSource = makeSource
    self.freeDiskBytes = freeDiskBytes ?? { storage.freeBytes() }
    self.storageRules = storageRules
    self.retention = retention
    self.urlSession = urlSession
    self.makeRetryScheduler = makeRetryScheduler
    self.makePathMonitor = makePathMonitor
    self.heartbeatInterval = heartbeatInterval
    self.statusInterval = statusInterval
    self.storageCheckInterval = storageCheckInterval
    self.stopTailSeconds = stopTailSeconds
    self.makeDeviceStatus = makeDeviceStatus
    self.makeRadarFleet = makeRadarFleet
    self.backgroundWork = backgroundWork
    self.observesApplication = observesApplication
  }

  /// The app's own: `Application Support/PhoneStream/`, the camera (or the simulator's synthetic
  /// source), the system's network, radars and battery.
  @MainActor
  public static func live() -> PhoneStreamEnvironment {
    PhoneStreamEnvironment(
      storage: .standard,
      makeSource: { PhoneCameraSource.standard(camera: CameraSession()) }
    )
  }
}
