import CameramanCapture
import DirectorCore
import DirectorMedia
import Foundation
import UIKit

/// Work that must not be cut off when the app goes to the background: an upload, or the part the
/// background finishes. The system's `beginBackgroundTask`, or nothing in a test.
///
/// `begin` takes what to do when the system's background time runs out first: the work winds down
/// (an upload stops where it is and keeps its id, to resume in the foreground), and the task is
/// ended for it. A task left running past its time gets the app killed.
public struct PhoneBackgroundWork: Sendable {
  public var begin: @MainActor @Sendable (_ name: String, _ expired: @escaping @MainActor @Sendable () -> Void) -> Int
  public var end: @MainActor @Sendable (Int) -> Void

  public init(
    begin: @escaping @MainActor @Sendable (_ name: String, _ expired: @escaping @MainActor @Sendable () -> Void) -> Int,
    end: @escaping @MainActor @Sendable (Int) -> Void
  ) {
    self.begin = begin
    self.end = end
  }

  public static let system = PhoneBackgroundWork.tasks(
    begin: { name, expired in
      UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: expired).rawValue
    },
    end: { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: $0)) }
  )

  public static let none = PhoneBackgroundWork(begin: { _, _ in 0 }, end: { _ in })

  /// Background tasks from the system's two calls: `begin(name, handler)` answers the task's id and
  /// calls `handler` on the main thread when its time runs out. On expiry the work's own handler
  /// runs, then the task ends; its owner's later `end` finds it ended and does nothing, so every
  /// task is ended exactly once.
  static func tasks(
    begin: @escaping @MainActor @Sendable (String, @escaping @Sendable () -> Void) -> Int,
    end: @escaping @MainActor @Sendable (Int) -> Void
  ) -> PhoneBackgroundWork {
    let open = OpenTasks()
    return PhoneBackgroundWork(
      begin: { name, expired in
        let slot = OpenTasks.Slot()
        let id = begin(name) {
          MainActor.assumeIsolated {
            expired()
            if let id = slot.id, open.close(id) { end(id) }
          }
        }
        slot.id = id
        open.add(id)
        return id
      },
      end: { id in
        if open.close(id) { end(id) }
      }
    )
  }

  /// The tasks begun and not yet ended. Touched only on the main thread.
  private final class OpenTasks: @unchecked Sendable {
    final class Slot: @unchecked Sendable { var id: Int? }
    private var ids: Set<Int> = []
    func add(_ id: Int) { ids.insert(id) }
    /// Whether `id` was open; it is not any more.
    func close(_ id: Int) -> Bool { ids.remove(id) != nil }
  }
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
      makeSource: { PhoneCameraSource.standard(camera: CameraSession()) },
      storageRules: .forLaunch()
    )
  }
}
