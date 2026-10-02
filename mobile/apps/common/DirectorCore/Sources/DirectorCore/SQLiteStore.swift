import Foundation
import SQLite3

public enum SQLiteError: Error, CustomStringConvertible {
  case open(String)
  case prepare(String, sql: String)
  case step(String, sql: String)

  public var description: String {
    switch self {
    case let .open(message): "sqlite open failed: \(message)"
    case let .prepare(message, sql): "sqlite prepare failed: \(message) — \(sql)"
    case let .step(message, sql): "sqlite step failed: \(message) — \(sql)"
    }
  }
}

public enum SQLiteValue: Sendable, Equatable {
  case integer(Int64)
  case real(Double)
  case text(String)
  case blob(Data)
  case null
}

/// One row of results, addressed by column index.
public struct SQLiteRow: Sendable {
  public let values: [SQLiteValue]

  public init(values: [SQLiteValue]) {
    self.values = values
  }

  public func int(_ index: Int) -> Int64 {
    switch values[index] {
    case let .integer(value): value
    case let .real(value): Int64(value)
    case let .text(value): Int64(value) ?? 0
    default: 0
    }
  }

  public func double(_ index: Int) -> Double {
    switch values[index] {
    case let .real(value): value
    case let .integer(value): Double(value)
    case let .text(value): Double(value) ?? 0
    default: 0
    }
  }

  public func string(_ index: Int) -> String {
    switch values[index] {
    case let .text(value): value
    case let .integer(value): String(value)
    case let .real(value): String(value)
    default: ""
    }
  }

  public func data(_ index: Int) -> Data {
    if case let .blob(value) = values[index] { return value }
    return Data()
  }
}

/// D4: SQLite through the system C API, one writer connection serialised on a private queue,
/// WAL journalling so the UI can read while the DVR writes. Deliberately small — the index
/// needs about a dozen statements and nothing here should grow into an ORM.
public final class SQLiteStore: @unchecked Sendable {
  private var handle: OpaquePointer?
  private let queue = DispatchQueue(label: "app.teamstation.director.sqlite")

  public let url: URL

  public init(url: URL) throws {
    self.url = url
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )

    var handle: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK, let handle else {
      let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
      sqlite3_close_v2(handle)
      throw SQLiteError.open(message)
    }
    self.handle = handle

    sqlite3_busy_timeout(handle, 5_000)
    try executeUnsynchronized("PRAGMA journal_mode=WAL;")
    try executeUnsynchronized("PRAGMA synchronous=NORMAL;")
    try executeUnsynchronized("PRAGMA foreign_keys=ON;")
  }

  deinit {
    if let handle { sqlite3_close_v2(handle) }
  }

  public func close() {
    queue.sync {
      if let handle { sqlite3_close_v2(handle) }
      handle = nil
    }
  }

  @discardableResult
  public func execute(_ sql: String, _ bindings: [SQLiteValue] = []) throws -> Int64 {
    try queue.sync { try executeUnsynchronized(sql, bindings) }
  }

  public func query(_ sql: String, _ bindings: [SQLiteValue] = []) throws -> [SQLiteRow] {
    try queue.sync { try queryUnsynchronized(sql, bindings) }
  }

  /// Runs `body` inside a single transaction. Every DVR index mutation that spans more than
  /// one statement goes through here so a crash cannot leave a half-written segment record.
  public func transaction<T>(_ body: (SQLiteTransaction) throws -> T) throws -> T {
    try queue.sync {
      try executeUnsynchronized("BEGIN IMMEDIATE;")
      do {
        let result = try body(SQLiteTransaction(store: self))
        try executeUnsynchronized("COMMIT;")
        return result
      } catch {
        try? executeUnsynchronized("ROLLBACK;")
        throw error
      }
    }
  }

  // MARK: - Unsynchronised core (callers must already hold `queue`)

  @discardableResult
  fileprivate func executeUnsynchronized(_ sql: String, _ bindings: [SQLiteValue] = []) throws -> Int64 {
    guard let handle else { return 0 }
    let statement = try prepare(sql, bindings)
    defer { sqlite3_finalize(statement) }

    let status = sqlite3_step(statement)
    guard status == SQLITE_DONE || status == SQLITE_ROW else {
      throw SQLiteError.step(String(cString: sqlite3_errmsg(handle)), sql: sql)
    }
    return sqlite3_last_insert_rowid(handle)
  }

  fileprivate func queryUnsynchronized(_ sql: String, _ bindings: [SQLiteValue] = []) throws -> [SQLiteRow] {
    guard let handle else { return [] }
    let statement = try prepare(sql, bindings)
    defer { sqlite3_finalize(statement) }

    var rows: [SQLiteRow] = []
    while true {
      let status = sqlite3_step(statement)
      if status == SQLITE_DONE { break }
      guard status == SQLITE_ROW else {
        throw SQLiteError.step(String(cString: sqlite3_errmsg(handle)), sql: sql)
      }
      let columnCount = Int(sqlite3_column_count(statement))
      var values: [SQLiteValue] = []
      values.reserveCapacity(columnCount)
      for column in 0 ..< Int32(columnCount) {
        values.append(readColumn(statement, column))
      }
      rows.append(SQLiteRow(values: values))
    }
    return rows
  }

  private func prepare(_ sql: String, _ bindings: [SQLiteValue]) throws -> OpaquePointer? {
    guard let handle else { return nil }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
      throw SQLiteError.prepare(String(cString: sqlite3_errmsg(handle)), sql: sql)
    }
    for (offset, binding) in bindings.enumerated() {
      let index = Int32(offset + 1)
      switch binding {
      case let .integer(value):
        sqlite3_bind_int64(statement, index, value)
      case let .real(value):
        sqlite3_bind_double(statement, index, value)
      case let .text(value):
        sqlite3_bind_text(statement, index, value, -1, Self.transient)
      case let .blob(value):
        _ = value.withUnsafeBytes { buffer in
          sqlite3_bind_blob(statement, index, buffer.baseAddress, Int32(buffer.count), Self.transient)
        }
      case .null:
        sqlite3_bind_null(statement, index)
      }
    }
    return statement
  }

  private func readColumn(_ statement: OpaquePointer?, _ column: Int32) -> SQLiteValue {
    switch sqlite3_column_type(statement, column) {
    case SQLITE_INTEGER:
      return .integer(sqlite3_column_int64(statement, column))
    case SQLITE_FLOAT:
      return .real(sqlite3_column_double(statement, column))
    case SQLITE_TEXT:
      guard let bytes = sqlite3_column_text(statement, column) else { return .null }
      return .text(String(cString: bytes))
    case SQLITE_BLOB:
      let length = Int(sqlite3_column_bytes(statement, column))
      guard length > 0, let bytes = sqlite3_column_blob(statement, column) else { return .blob(Data()) }
      return .blob(Data(bytes: bytes, count: length))
    default:
      return .null
    }
  }

  private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
}

/// Handle passed into `SQLiteStore.transaction`. Reuses the already-held queue, so it must
/// never escape the transaction body.
public struct SQLiteTransaction {
  fileprivate let store: SQLiteStore

  @discardableResult
  public func execute(_ sql: String, _ bindings: [SQLiteValue] = []) throws -> Int64 {
    try store.executeUnsynchronized(sql, bindings)
  }

  public func query(_ sql: String, _ bindings: [SQLiteValue] = []) throws -> [SQLiteRow] {
    try store.queryUnsynchronized(sql, bindings)
  }
}
