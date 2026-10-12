import Foundation

/// Sending one recording to TeamStation.
///
/// The file is on the iPad and the iPad is at a ball field, so this is written
/// for the network that is actually there rather than the one anybody would
/// like. Three things follow from that, and they are the whole design:
///
/// - **It asks before it sends.** The server says which parts it already has,
///   so an upload that was cut off resumes instead of starting again. A
///   two-hour take is several gigabytes; starting again is not a recovery, it
///   is a second failure.
/// - **It reads one part at a time.** The file is never held in memory —
///   `FileHandle` seeks to the part and reads exactly its length.
/// - **It retries a step, not the upload.** A part that fails is tried again
///   with a growing wait and the ones already in stay in — and so are the two
///   requests either side of the parts, which is where a real upload died:
///   the server restarted between two files, the opening request failed once,
///   and a whole take was abandoned having sent nothing.
public actor UploadService {
  public struct Progress: Sendable, Equatable {
    public let sent: Int
    public let parts: Int
    public let bytesSent: Int
    public let bytesTotal: Int
    /// What the **server** is doing, once the bytes are all there: nil while
    /// they are still going up, then `assembling`, `probing`, `remuxing`,
    /// `uploading`, `writing`. A two-hour take spends minutes here, and a
    /// screen that cannot say so shows a full bar and looks stuck.
    public let step: String?

    public init(
      sent: Int,
      parts: Int,
      bytesSent: Int,
      bytesTotal: Int,
      step: String? = nil
    ) {
      self.sent = sent
      self.parts = parts
      self.bytesSent = bytesSent
      self.bytesTotal = bytesTotal
      self.step = step
    }

    public var fraction: Double {
      bytesTotal <= 0 ? 0 : Double(bytesSent) / Double(bytesTotal)
    }
  }

  public enum UploadError: Error, Sendable {
    case cannotRead(String)
    case refused(String)
    /// Every retry used up on one step; what is already in stays on the server.
    case gaveUp(step: String, because: String)
  }

  /// Sends one part, telling its last argument how many of the part's bytes have gone.
  typealias PartSender = @Sendable (
    _ uploadId: String,
    _ index: Int,
    _ bytes: Data,
    _ onSent: @escaping @Sendable (Int) -> Void
  ) async throws -> Void

  /// How many times one part is tried before the upload stops.
  private let tries = 4
  private let client: TeamStationClient
  private let sendPart: PartSender
  /// Seconds on a steady clock, for spacing the progress reports within a part.
  private let now: @Sendable () -> TimeInterval
  /// The least time between two reports within a part: four a second.
  private let progressInterval: TimeInterval

  public init(client: TeamStationClient) {
    self.init(client: client, sendPart: nil)
  }

  init(
    client: TeamStationClient,
    sendPart: PartSender?,
    now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    progressInterval: TimeInterval = 0.25
  ) {
    self.client = client
    self.sendPart = sendPart ?? { uploadId, index, bytes, onSent in
      _ = try await client.sendPart(uploadId: uploadId, index: index, bytes: bytes, onSent: onSent)
    }
    self.now = now
    self.progressInterval = progressInterval
  }

  /// Sends the file, and answers with the video it became.
  ///
  /// `startedAt` is when the recording began — the take's own wall clock, the
  /// same for every file of it — because that is what the library aligns a
  /// take's cameras on. `uploadId` resumes an upload already opened; leaving
  /// it out opens one. `liveStreamId` and `wholeStream` say which live stream
  /// the recording is the local copy of (see `TeamStationClient.openUpload`).
  ///
  /// `onOpened` is told the upload's id as soon as the server has opened it (or as given), before
  /// a byte is sent: a caller that keeps it can resume a killed upload from the parts the server
  /// already has, rather than open a second one.
  public func send(
    file: URL,
    gameId: String,
    title: String,
    kind: String,
    startedAt: Date,
    uploadId existing: String? = nil,
    liveStreamId: String? = nil,
    wholeStream: Bool? = nil,
    onOpened: @Sendable (String) -> Void = { _ in },
    onProgress: @escaping @Sendable (Progress) -> Void = { _ in }
  ) async throws -> String {
    let size = try fileSize(file)

    // Opening is retried like a part is. It is one small request, which makes
    // it easy to think of as safe — and it is the request that killed a real
    // upload: the server restarted between two files, the open failed once,
    // and a nine-gigabyte take was abandoned with nothing sent. A resumable
    // uploader that gives up at the handshake is not resumable.
    let opened: (id: String, partSize: Int, parts: Int, have: Set<Int>)
    if let existing {
      let state = try await withRetries("opening the upload") {
        try await self.client.uploadState(uploadId: existing)
      }
      opened = (existing, state.partSize, state.parts, Set(state.received))
    } else {
      let made = try await withRetries("opening the upload") {
        try await self.client.openUpload(
          gameId: gameId,
          title: title,
          kind: kind,
          filename: file.lastPathComponent,
          sizeBytes: size,
          startedAt: startedAt,
          liveStreamId: liveStreamId,
          wholeStream: wholeStream
        )
      }
      opened = (made.uploadId, made.partSize, made.parts, Set(made.received))
    }
    onOpened(opened.id)

    guard let handle = try? FileHandle(forReadingFrom: file) else {
      throw UploadError.cannotRead(file.lastPathComponent)
    }
    defer { try? handle.close() }

    var have = opened.have
    let resumedAt = min(size, have.count * opened.partSize)
    let pacing = ProgressPacing(interval: progressInterval, startingAt: resumedAt, now: now())
    onProgress(
      Progress(
        sent: have.count,
        parts: opened.parts,
        bytesSent: resumedAt,
        bytesTotal: size
      )
    )

    for index in 0 ..< opened.parts where !have.contains(index) {
      let start = index * opened.partSize
      let length = min(opened.partSize, size - start)
      try handle.seek(toOffset: UInt64(start))
      guard let bytes = try handle.read(upToCount: length), bytes.count == length
      else {
        throw UploadError.cannotRead(
          "part \(index) of \(file.lastPathComponent) is short on this iPad"
        )
      }

      // Within the part, the bytes as they go, four times a second at most. A retried part starts
      // from nothing again, and the bar waits for it rather than going back.
      let done = have.count
      let before = min(size, done * opened.partSize)
      let now = self.now
      let onSent: @Sendable (Int) -> Void = { sent in
        let bytesSent = min(size, before + min(sent, length))
        guard pacing.admits(bytesSent, at: now()) else { return }
        onProgress(Progress(sent: done, parts: opened.parts, bytesSent: bytesSent, bytesTotal: size))
      }
      _ = try await withRetries("part \(index)") {
        try await self.sendPart(opened.id, index, bytes, onSent)
      }
      have.insert(index)
      let after = min(size, have.count * opened.partSize)
      pacing.reached(after, at: now())
      onProgress(
        Progress(
          sent: have.count,
          parts: opened.parts,
          bytesSent: after,
          bytesTotal: size
        )
      )
    }

    return try await finish(
      uploadId: opened.id,
      parts: opened.parts,
      bytes: size,
      onProgress: onProgress
    )
  }

  /// Turns the parts into a video, and follows the server while it does.
  ///
  /// Every byte is already there by now, and what is left is the longest part
  /// of the whole business: assemble, probe, remux, copy to storage. The
  /// server acknowledges and gets on with it, so this **watches** rather than
  /// waits — which is the only arrangement that works on a connection that
  /// comes and goes, and the only one that can tell somebody what is
  /// happening while it happens.
  private func finish(
    uploadId: String,
    parts: Int,
    bytes: Int,
    onProgress: @Sendable (Progress) -> Void
  ) async throws -> String {
    let told = try await withRetries("finishing the upload") {
      try await self.client.finishUpload(uploadId: uploadId)
    }
    // Already done: asking twice gets the same video, not a second one.
    if let videoId = told.videoId { return videoId }

    onProgress(
      Progress(sent: parts, parts: parts, bytesSent: bytes, bytesTotal: bytes,
               step: told.step ?? "assembling")
    )
    return try await watch(
      uploadId: uploadId, parts: parts, bytes: bytes, onProgress: onProgress
    )
  }

  /// Asks what the server is doing until it has finished doing it.
  ///
  /// Every five seconds, for a quarter of an hour: a large recording has been
  /// measured at four to seven minutes, and a lost answer is not a failure —
  /// the work carries on either way, so the next ask picks it up. A cancelled upload stops at once:
  /// with the cancellation swallowed, its sleeps returned at once and its asks failed at once, and
  /// it spun through the quarter hour without waiting.
  private func watch(
    uploadId: String,
    parts: Int,
    bytes: Int,
    onProgress: @Sendable (Progress) -> Void
  ) async throws -> String {
    let deadline = Date().addingTimeInterval(900)
    var last = "assembling"
    while Date() < deadline {
      try await Task.sleep(nanoseconds: 5 * 1_000_000_000)
      let state: TeamStationUploadState
      do {
        state = try await client.uploadState(uploadId: uploadId)
      } catch {
        try Task.checkCancellation()
        continue
      }
      switch state.state {
      case "ready":
        if let videoId = state.videoId { return videoId }
      case "failed", "abandoned":
        throw UploadError.gaveUp(
          step: "finishing the upload",
          because: state.message ?? state.state
        )
      default:
        last = state.step ?? state.state
        onProgress(
          Progress(sent: parts, parts: parts, bytesSent: bytes, bytesTotal: bytes,
                   step: last)
        )
      }
    }
    throw UploadError.gaveUp(step: "finishing the upload", because: "still \(last)")
  }

  /// One step of the upload, tried again with a growing wait.
  ///
  /// Seconds rather than milliseconds: the thing being waited out is a phone
  /// changing cell or a field's uplink saturating, and neither clears in a
  /// tenth of a second.
  private func withRetries<Value>(
    _ step: String,
    _ work: @Sendable () async throws -> Value
  ) async throws -> Value {
    var wait: UInt64 = 1
    var last = ""
    for attempt in 1 ... tries {
      // A cancelled upload stops here rather than firing its remaining tries at the server.
      try Task.checkCancellation()
      do {
        return try await work()
      } catch {
        last = String(describing: error)
        if attempt == tries { break }
        try? await Task.sleep(nanoseconds: wait * 1_000_000_000)
        wait = min(wait * 2, 8)
      }
    }
    throw UploadError.gaveUp(step: step, because: last)
  }

  private func fileSize(_ file: URL) throws -> Int {
    let values = try? file.resourceValues(forKeys: [.fileSizeKey])
    guard let size = values?.fileSize, size > 0 else {
      throw UploadError.cannotRead("\(file.lastPathComponent) is empty or missing")
    }
    return size
  }
}

/// When a report of the bytes sent within a part is worth making: once `interval` has passed since
/// the last report, and only for more bytes than any report so far. Told from the session's
/// delegate queue and from the upload alike, hence the lock.
final class ProgressPacing: @unchecked Sendable {
  private let lock = NSLock()
  private let interval: TimeInterval
  private var reported: Int
  private var reportedAt: TimeInterval

  init(interval: TimeInterval, startingAt bytes: Int, now: TimeInterval) {
    self.interval = interval
    reported = bytes
    reportedAt = now
  }

  /// Whether `bytes` at `time` should be reported; if so, it counts as reported.
  func admits(_ bytes: Int, at time: TimeInterval) -> Bool {
    lock.withLock {
      guard bytes > reported, time - reportedAt >= interval else { return false }
      reported = bytes
      reportedAt = time
      return true
    }
  }

  /// A report made regardless, at a part's end.
  func reached(_ bytes: Int, at time: TimeInterval) {
    lock.withLock {
      reported = max(reported, bytes)
      reportedAt = time
    }
  }
}
