import Foundation

public enum LogApp: String, Codable, Sendable, CaseIterable {
  case director = "TS dir", cameraman = "cam", distributor = "TS dist"
}
public enum LogKind: String, Codable, Sendable, CaseIterable {
  case started = "service_started", stopped = "service_stopped", error = "app_error"
  case streamStarted = "stream_started", streamStopped = "stream_stopped", streamFailed = "stream_failed"
  case recordingRequested = "recording_requested", recordingStarted = "recording_started"
  case recordingStopped = "recording_stopped", recordingFailed = "recording_failed"
  case uploadStarted = "upload_started", uploadCompleted = "upload_completed", uploadFailed = "upload_failed", uploadRetry = "upload_retry"
  case exportStarted = "export_started", exportCompleted = "export_completed", exportFailed = "export_failed"
}
public enum LogOperation: String, Codable, Sendable, CaseIterable {
  case record, upload, playback, export, service, request, other
}
public enum LogError: String, Codable, Sendable, CaseIterable {
  case invalid, expired, rateLimited = "rate_limited", offline, internalError = "internal"
  case timeout, permission, storage, cancelled, unknown
}

/// Closed types prevent chat, credentials, URLs and arbitrary error descriptions from entering a log.
public struct LogRecord: Codable, Sendable, Equatable {
  public let D: String
  public let A: LogApp
  public let I: String
  public let E: LogKind
  public let L: String
  public let R: Int
  public let V: String?
  public let P: Properties

  public struct Properties: Codable, Sendable, Equatable {
    public let op: LogOperation?
    public let ec: LogError?
    public let ms: Double?
    public let n: Int?
    public let vi: String?
  }

  public init?(app: LogApp, kind: LogKind, at: Date = Date(), id: UUID = UUID(),
               operation: LogOperation? = nil, error: LogError? = nil,
               milliseconds: Double? = nil, count: Int? = nil, video: String? = nil, version: String? = nil) {
    guard at.timeIntervalSince1970.isFinite,
          milliseconds.map({ $0.isFinite && $0 >= 0 && $0 <= 15000 }) ?? true,
          count.map({ $0 >= 0 && $0 <= 1_000_000_000 }) ?? true,
          video.map({ $0.range(of: "^vid_[A-Za-z0-9_-]{1,96}$", options: .regularExpression) != nil }) ?? true,
          version.map({ $0.range(of: "^[0-9][0-9A-Za-z.+_-]{0,63}$", options: .regularExpression) != nil }) ?? true
    else { return nil }
    let videoKind = kind.rawValue.hasPrefix("recording_") || kind.rawValue.hasPrefix("upload_")
    guard videoKind ? operation == nil && count == nil : video == nil else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    D = formatter.string(from: at)
    A = app; I = id.uuidString.lowercased(); E = kind; L = error == nil ? "info" : "error"; R = 1
    V = version
    P = Properties(op: operation, ec: error, ms: milliseconds, n: count, vi: video)
  }

  /// Revalidate decoded queues. Codable alone must not admit an edited local file.
  public var validated: LogRecord? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: D), let id = UUID(uuidString: I), R == 1,
          let record = LogRecord(app: A, kind: E, at: date, id: id, operation: P.op,
                                 error: P.ec, milliseconds: P.ms, count: P.n, video: P.vi, version: V),
          record == self else { return nil }
    return record
  }

  public var date: Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: D) ?? .distantPast
  }

  /// Canonical JSONL always begins with D; JSON dictionaries do not preserve ordering.
  public func jsonLine() throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    var fields = try JSONSerialization.jsonObject(with: encoder.encode(self)) as! [String: Any]
    fields.removeValue(forKey: "D")
    let remainder = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
    let dateJSON = String(decoding: try encoder.encode(D), as: UTF8.self)
    return "{\"D\":\(dateJSON)," + String(decoding: remainder, as: UTF8.self).dropFirst() + "\n"
  }
}
