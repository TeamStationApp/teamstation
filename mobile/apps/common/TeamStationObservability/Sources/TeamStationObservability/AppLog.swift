import Foundation
import CryptoKit

public enum LogEndpoint {
  public static func from(dsn: String) -> URL? {
    guard let parts = URLComponents(string: dsn), parts.scheme == "https",
          parts.password == nil, parts.query == nil, parts.fragment == nil,
          let host = parts.host, !host.isEmpty,
          let user = parts.user, user.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil,
          parts.path.range(of: "^/[0-9]{1,20}$", options: .regularExpression) != nil else { return nil }
    var endpoint = parts
    endpoint.user = nil
    endpoint.path = "/ingest" + parts.path
    return endpoint.url
  }
}

/// A process-wide logger with closed event types. Raw errors and device details cannot enter it.
@MainActor public enum AppLog {
  private static var queue: LogQueue?
  private static var app: LogApp?
  private static var pending: Task<Void, Never>?
  private static var input: [LogRecord] = []
  private static var version: String?
  private static var closing = false
  public private(set) static var dropped = 0

  public static func start(app: LogApp, bundle: Bundle = .main) {
    let dsn = (bundle.object(forInfoDictionaryKey: "TSSentryDsn") as? String) ?? ""
    let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let partition = SHA256.hash(data: Data((app.rawValue + dsn).utf8)).map { String(format: "%02x", $0) }.joined()
    let version = (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
    let build = (bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "0"
    start(app: app, dsn: dsn, file: directory.appendingPathComponent("TeamStationLogs/" + partition + ".json"), version: version + "+" + build)
  }

  public static func start(app: LogApp, dsn: String, file: URL, version: String? = nil, sender: LogQueue.Sender? = nil) {
    guard !closing, queue == nil, let endpoint = LogEndpoint.from(dsn: dsn) else { return }
    self.app = app
    self.version = version
    let created = LogQueue(file: file, send: sender ?? LogQueue.sender(endpoint: endpoint))
    queue = created
    Task { await created.start() }
    record(.started, operation: .service)
  }

  public static func record(_ kind: LogKind, operation: LogOperation? = nil, error: LogError? = nil,
                            milliseconds: Double? = nil, count: Int? = nil, video: String? = nil) {
    guard !closing, let app, let queue,
          let record = LogRecord(app: app, kind: kind, operation: operation, error: error,
                                 milliseconds: milliseconds, count: count, video: video, version: version) else { return }
    if input.count == 500 { input.removeFirst(); dropped += 1 }
    input.append(record)
    guard pending == nil else { return }
    pending = Task {
      while !input.isEmpty { await queue.enqueue(input.removeFirst()) }
      pending = nil
    }
  }

  public static func close() async {
    guard !closing, let queue, let app else { return }
    closing = true
    await pending?.value; pending = nil
    if let record = LogRecord(app: app, kind: .stopped, operation: .service, version: version) { await queue.enqueue(record) }
    version = nil
    await queue.flush()
    await queue.stop()
    self.queue = nil; self.app = nil
    closing = false
  }
}
