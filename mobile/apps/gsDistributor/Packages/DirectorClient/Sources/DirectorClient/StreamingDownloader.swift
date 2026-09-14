import Foundation

/// Downloads that write each chunk to disk as it arrives and resume with a byte range.
///
/// URLSession's download tasks resume only from their own resume data, and its async byte stream
/// hands bytes over one at a time, far too slowly for a cable that moves 700 MB/s. A data task
/// with a delegate gets the body in the chunks the network delivered them in.
final class StreamingDownloader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var transfers: [Int: Transfer] = [:]
  private var session: URLSession!

  init(configuration: URLSessionConfiguration) {
    super.init()
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }

  deinit {
    session.invalidateAndCancel()
  }

  func download(
    from url: URL,
    to destination: URL,
    progress: (@Sendable (Int64, Int64) -> Void)?
  ) async throws {
    let manager = FileManager.default
    try manager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    let partial = destination.appendingPathExtension("partial")
    if !manager.fileExists(atPath: partial.path) {
      manager.createFile(atPath: partial.path, contents: nil)
    }
    let have = ((try? manager.attributesOfItem(atPath: partial.path)[.size]) as? NSNumber)?.int64Value ?? 0

    var request = URLRequest(url: url)
    if have > 0 { request.setValue("bytes=\(have)-", forHTTPHeaderField: "Range") }
    let handle = try FileHandle(forWritingTo: partial)

    let outcome: Outcome
    do {
      outcome = try await withCheckedThrowingContinuation { continuation in
        let task = session.dataTask(with: request)
        lock.withLock {
          transfers[task.taskIdentifier] = Transfer(
            handle: handle,
            offset: have,
            progress: progress,
            continuation: continuation
          )
        }
        task.resume()
      }
    } catch {
      try? handle.close()
      throw error
    }
    try? handle.close()

    switch outcome {
    case .complete(let total):
      let size = ((try? manager.attributesOfItem(atPath: partial.path)[.size]) as? NSNumber)?.int64Value ?? -1
      guard size == total else {
        throw DirectorClientError.http(status: 206, message: "got \(size) of \(total) bytes; try again to resume")
      }
      try? manager.removeItem(at: destination)
      try manager.moveItem(at: partial, to: destination)
    case .alreadyComplete:
      try? manager.removeItem(at: destination)
      try manager.moveItem(at: partial, to: destination)
    case .failed(let status, let body):
      throw DirectorConnection.failure(status, body)
    }
  }

  // MARK: - URLSessionDataDelegate

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    lock.withLock {
      guard let transfer = transfers[dataTask.taskIdentifier] else { return }
      transfer.status = status
      let http = response as? HTTPURLResponse
      switch status {
      case 206:
        // `bytes a-b/total`: the range must start where the partial file ends.
        let range = http?.value(forHTTPHeaderField: "Content-Range") ?? ""
        transfer.total = Int64(range.split(separator: "/").last ?? "") ?? -1
        let start = Int64(range.dropFirst("bytes ".count).split(separator: "-").first ?? "") ?? -1
        if start != transfer.offset { transfer.status = 0 }
      case 200:
        // A whole file: whatever was there before is discarded.
        transfer.offset = 0
        try? transfer.handle.truncate(atOffset: 0)
        transfer.total = response.expectedContentLength
      case 416:
        // Nothing past the end: the partial file is already the whole file if the sizes agree.
        let range = http?.value(forHTTPHeaderField: "Content-Range") ?? ""
        transfer.total = Int64(range.split(separator: "/").last ?? "") ?? -1
      default:
        break
      }
      if transfer.status == 200 || transfer.status == 206 {
        try? transfer.handle.seek(toOffset: UInt64(transfer.offset))
      }
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.withLock {
      guard let transfer = transfers[dataTask.taskIdentifier] else { return }
      if transfer.status == 200 || transfer.status == 206 {
        do {
          try transfer.handle.write(contentsOf: data)
          transfer.offset += Int64(data.count)
          transfer.progress?(transfer.offset, transfer.total)
        } catch {
          transfer.writeError = error
          dataTask.cancel()
        }
      } else {
        transfer.errorBody.append(data)
      }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let transfer = lock.withLock { transfers.removeValue(forKey: task.taskIdentifier) }
    guard let transfer else { return }
    if let error = transfer.writeError ?? error {
      transfer.continuation.resume(throwing: error)
      return
    }
    switch transfer.status {
    case 200, 206:
      transfer.continuation.resume(returning: .complete(total: transfer.total))
    case 416 where transfer.total >= 0 && transfer.total == transfer.offset:
      transfer.continuation.resume(returning: .alreadyComplete)
    default:
      transfer.continuation.resume(returning: .failed(status: transfer.status, body: transfer.errorBody))
    }
  }

  // MARK: - State

  enum Outcome: Sendable {
    case complete(total: Int64)
    case alreadyComplete
    case failed(status: Int, body: Data)
  }

  /// One download in flight. Touched only under `lock`.
  final class Transfer: @unchecked Sendable {
    let handle: FileHandle
    var offset: Int64
    let progress: (@Sendable (Int64, Int64) -> Void)?
    let continuation: CheckedContinuation<Outcome, Error>
    var status = 0
    var total: Int64 = -1
    var errorBody = Data()
    var writeError: Error?

    init(
      handle: FileHandle,
      offset: Int64,
      progress: (@Sendable (Int64, Int64) -> Void)?,
      continuation: CheckedContinuation<Outcome, Error>
    ) {
      self.handle = handle
      self.offset = offset
      self.progress = progress
      self.continuation = continuation
    }
  }
}
