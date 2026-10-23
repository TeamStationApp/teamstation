import Foundation

/// One actor owns the bounded file and HTTP queue. Telemetry never throws into app work.
public actor LogQueue {
  public typealias Sender = @Sendable (Data) async throws -> Int
  private let file: URL
  private let send: Sender
  private let now: @Sendable () -> Date
  private let capacity: Int
  private var records: [LogRecord] = []
  private var sending = false
  private var stopped = false
  private var failures = 0
  private var retryAt = Date.distantPast
  private var timer: Task<Void, Never>?
  public private(set) var dropped = 0
  public private(set) var storageFailed = false

  public init(file: URL, capacity: Int = 500, now: @escaping @Sendable () -> Date = { Date() }, send: @escaping Sender) {
    self.file = file; self.capacity = max(0, min(capacity, 500)); self.now = now; self.send = send
    if let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 524288,
       let data = try? Data(contentsOf: file), data.count <= 524288,
       let decoded = try? JSONDecoder().decode([LogRecord].self, from: data) {
      records = decoded.compactMap { $0.validated }.filter { now().timeIntervalSince($0.date) <= 604800 && $0.date.timeIntervalSince(now()) <= 300 }
      if records.count > self.capacity { records = Array(records.suffix(self.capacity)) }
    }
  }

  public var count: Int { records.count }

  public func start() {
    guard timer == nil, !stopped else { return }
    timer = Task { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
        await self?.flush()
      }
    }
  }

  public func enqueue(_ record: LogRecord) {
    guard !stopped, let safe = record.validated,
          now().timeIntervalSince(safe.date) <= 604800, safe.date.timeIntervalSince(now()) <= 300 else { return }
    if !records.contains(where: { $0.I == safe.I }) { records.append(safe) }
    trim()
    persist()
  }

  public func flush() async {
    guard !stopped, !sending, now() >= retryAt else { return }
    trim()
    guard !records.isEmpty else { return }
    let batch = Array(records.prefix(50))
    guard let text = try? batch.map({ try $0.jsonLine() }).joined() else { return }
    sending = true
    let status = (try? await send(Data(text.utf8))) ?? 0
    sending = false
    guard !stopped else { return }
    if (200..<300).contains(status) || ((400..<500).contains(status) && status != 408 && status != 429) {
      let ids = Set(batch.map(\.I))
      records.removeAll { ids.contains($0.I) }
      if status >= 400 { dropped += batch.count }
      failures = 0; retryAt = .distantPast
      persist()
    } else {
      failures = min(failures + 1, 8)
      retryAt = now().addingTimeInterval(min(60, pow(2, Double(failures))) * Double.random(in: 0.5...1))
    }
  }

  public func stop() {
    stopped = true
    timer?.cancel(); timer = nil
  }

  private func trim() {
    let before = records.count
    records.removeAll { now().timeIntervalSince($0.date) > 604800 }
    if records.count > capacity { records.removeFirst(records.count - capacity) }
    dropped += before - records.count
  }

  private func persist() {
    do {
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      let data = try JSONEncoder().encode(records)
      // Closed schemas keep 500 records below 512 KiB.
      try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      storageFailed = false
    } catch { storageFailed = true }
  }

  public static func sender(endpoint: URL, session: URLSession = .shared) -> Sender {
    { data in
      var request = URLRequest(url: endpoint)
      request.httpMethod = "POST"; request.httpBody = data; request.timeoutInterval = 10
      request.setValue("application/x-ndjson", forHTTPHeaderField: "Content-Type")
      let (_, response) = try await session.data(for: request)
      return (response as? HTTPURLResponse)?.statusCode ?? 0
    }
  }
}
