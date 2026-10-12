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

  /// How many times one part is tried before the upload stops.
  private let tries = 4
  private let client: TeamStationClient

  public init(client: TeamStationClient) {
    self.client = client
  }

  /// Sends the file, and answers with the video it became.
  ///
  /// `startedAt` is when the recording began — the take's own wall clock, the
  /// same for every file of it — because that is what the library aligns a
  /// take's cameras on. `serverClockOffsetMs` is the take's measured server
  /// clock offset, sent with the opening request when there is one.
  /// `uploadId` resumes an upload already opened; leaving it out opens one.
  /// `liveStreamId` and `wholeStream` say which live stream the recording is
  /// the local copy of (see `TeamStationClient.openUpload`).
  public func send(
    file: URL,
    gameId: String,
    title: String,
    kind: String,
    startedAt: Date,
    serverClockOffsetMs: Int? = nil,
    uploadId existing: String? = nil,
    liveStreamId: String? = nil,
    wholeStream: Bool? = nil,
    onProgress: @Sendable (Progress) -> Void = { _ in }
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
          serverClockOffsetMs: serverClockOffsetMs,
          liveStreamId: liveStreamId,
          wholeStream: wholeStream
        )
      }
      opened = (made.uploadId, made.partSize, made.parts, Set(made.received))
    }

    guard let handle = try? FileHandle(forReadingFrom: file) else {
      throw UploadError.cannotRead(file.lastPathComponent)
    }
    defer { try? handle.close() }

    var have = opened.have
    onProgress(
      Progress(
        sent: have.count,
        parts: opened.parts,
        bytesSent: have.count * opened.partSize,
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

      _ = try await withRetries("part \(index)") {
        try await self.client.sendPart(
          uploadId: opened.id,
          index: index,
          bytes: bytes
        )
      }
      have.insert(index)
      onProgress(
        Progress(
          sent: have.count,
          parts: opened.parts,
          bytesSent: min(size, have.count * opened.partSize),
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
  /// the work carries on either way, so the next ask picks it up.
  private func watch(
    uploadId: String,
    parts: Int,
    bytes: Int,
    onProgress: @Sendable (Progress) -> Void
  ) async throws -> String {
    let deadline = Date().addingTimeInterval(900)
    var last = "assembling"
    while Date() < deadline {
      try? await Task.sleep(nanoseconds: 5 * 1_000_000_000)
      guard let state = try? await client.uploadState(uploadId: uploadId) else { continue }
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
