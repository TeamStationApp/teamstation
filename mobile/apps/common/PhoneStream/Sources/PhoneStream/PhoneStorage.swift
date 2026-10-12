import DirectorCore
import DirectorExport
import Foundation

/// Where a phone keeps its recordings and their catalog: `Application Support/PhoneStream/`, out of
/// the device backup. A two-hour take is gigabytes, and it is on its way to the server anyway.
public struct PhoneStorage: Sendable {
  public let root: URL

  public init(root: URL) {
    self.root = root
  }

  /// `Application Support/PhoneStream/` in the app's own container.
  public static var standard: PhoneStorage {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return PhoneStorage(root: support.appendingPathComponent("PhoneStream", isDirectory: true))
  }

  public var program: URL { root.appendingPathComponent("Program", isDirectory: true) }
  public var prepared: URL { root.appendingPathComponent("Prepared", isDirectory: true) }
  public var index: URL { root.appendingPathComponent("index.sqlite") }

  /// The roots `ArchiveIndex` deletes a take's files from. A phone writes no camera archive and no
  /// proxies; the directories are named so a delete has somewhere to look.
  public var fileRoots: RecordingFileRoots {
    RecordingFileRoots(
      archives: root.appendingPathComponent("Archives", isDirectory: true),
      program: program,
      proxies: root.appendingPathComponent("Proxies", isDirectory: true),
      prepared: prepared
    )
  }

  /// Makes the directories, and keeps the whole tree out of the device backup.
  public func prepare() throws {
    for directory in [ root, program, prepared ] {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var url = root
    try url.setResourceValues(values)
  }

  /// Free space on the volume the recordings are on, measured at the nearest directory that exists:
  /// before the first recording the tree itself may not, and an unmeasured volume must not read as
  /// a full one.
  public func freeBytes() -> Int64 {
    var place = root
    while !FileManager.default.fileExists(atPath: place.path), place.pathComponents.count > 1 {
      place = place.deletingLastPathComponent()
    }
    let values = try? place.resourceValues(forKeys: [ .volumeAvailableCapacityForImportantUsageKey ])
    if let important = values?.volumeAvailableCapacityForImportantUsage, important > 0 { return important }
    let attributes = try? FileManager.default.attributesOfFileSystem(forPath: place.path)
    return (attributes?[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
  }
}

/// When a phone may record, by the space it has left.
///
/// A recording does not start with under 2 GB free: that is under an hour at 6 Mbps, and a game is
/// longer. A part that is running finishes cleanly when free space falls below 500 MB, which leaves
/// room for its export and for the phone itself; the stream carries on.
public struct PhoneStorageRules: Sendable, Equatable {
  public var startFloorBytes: Int64
  public var stopFloorBytes: Int64

  public static let standard = PhoneStorageRules(
    startFloorBytes: 2_000_000_000,
    stopFloorBytes: 500_000_000
  )

  public init(startFloorBytes: Int64, stopFloorBytes: Int64) {
    self.startFloorBytes = startFloorBytes
    self.stopFloorBytes = stopFloorBytes
  }

  public func canStart(freeBytes: Int64) -> Bool { freeBytes >= startFloorBytes }
  public func mustStop(freeBytes: Int64) -> Bool { freeBytes < stopFloorBytes }
}

/// The phone's retention: a recording is the higher-quality copy of what the stream published, so
/// it is never deleted before the server has it. One whose upload has been ready for seven days goes
/// on a sweep, files and row; nothing else is ever swept.
///
/// TS Director's `RetentionPolicy` reclaims camera archive segments, which a phone never writes, so
/// the phone's rule is its own.
public struct PhoneRetentionPolicy: Sendable {
  public static let keepUploadedSeconds: TimeInterval = 7 * 24 * 3_600

  public var keepUploadedSeconds: TimeInterval

  public init(keepUploadedSeconds: TimeInterval = PhoneRetentionPolicy.keepUploadedSeconds) {
    self.keepUploadedSeconds = keepUploadedSeconds
  }

  /// The recordings to delete at `now`: uploaded, ready for at least the keep, and not `protecting`.
  public func expired(
    _ recordings: [PhoneRecording],
    now: WallClock,
    protecting: Set<Int64> = []
  ) -> [PhoneRecording] {
    recordings.filter { recording in
      guard let uploadedAt = recording.uploadedAt else { return false }
      return !protecting.contains(recording.recordingID) && now - uploadedAt >= keepUploadedSeconds
    }
  }

  /// Deletes what `expired` names, files and rows. Answers how many went.
  @discardableResult
  public func sweep(
    catalog: PhoneCatalog,
    index: ArchiveIndex,
    storage: PhoneStorage,
    now: WallClock,
    protecting: Set<Int64> = []
  ) throws -> Int {
    let doomed = expired(try catalog.recordings(), now: now, protecting: protecting)
    for recording in doomed {
      try index.deleteRecording(recording.recordingID, roots: storage.fileRoots)
      try catalog.delete(recording.recordingID)
    }
    return doomed.count
  }
}
