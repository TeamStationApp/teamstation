import Foundation

public struct HTTPRequest: Sendable {
  public var method: String
  /// Percent-decoded, without the query.
  public var path: String
  public var query: [String: String]
  /// Names lowercased.
  public var headers: [String: String]
  public var body: Data

  public init(
    method: String,
    path: String,
    query: [String: String] = [:],
    headers: [String: String] = [:],
    body: Data = Data()
  ) {
    self.method = method
    self.path = path
    self.query = query
    self.headers = headers
    self.body = body
  }

  public func header(_ name: String) -> String? { headers[name.lowercased()] }

  public var wantsClose: Bool { header("connection")?.lowercased() == "close" }
}

public enum HTTPParser {
  public static let maximumHeadBytes = 64 * 1024
  /// Request bodies are small JSON; files only ever travel the other way.
  public static let maximumBodyBytes = 4 * 1024 * 1024

  public enum Failure: Error, Equatable, Sendable {
    case malformed
    case headTooLarge
    case bodyTooLarge
  }

  /// Parses one request from the front of `buffer`: nil when more bytes are needed, else the
  /// request and how many bytes of `buffer` it took.
  public static func parse(_ buffer: Data) throws(Failure) -> (request: HTTPRequest, consumed: Int)? {
    guard let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
      if buffer.count > maximumHeadBytes { throw .headTooLarge }
      return nil
    }
    let head = String(decoding: buffer[buffer.startIndex..<headEnd.lowerBound], as: UTF8.self)
    var lines = head.components(separatedBy: "\r\n")
    let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
    guard requestLine.count == 3, requestLine[2].hasPrefix("HTTP/1.") else { throw .malformed }

    var headers: [String: String] = [:]
    for line in lines where !line.isEmpty {
      guard let colon = line.firstIndex(of: ":") else { throw .malformed }
      let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
      headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
    }

    guard let length = Int(headers["content-length"] ?? "0"), length >= 0 else { throw .malformed }
    guard length <= maximumBodyBytes else { throw .bodyTooLarge }
    let bodyStart = headEnd.upperBound
    guard buffer.distance(from: bodyStart, to: buffer.endIndex) >= length else { return nil }
    let bodyEnd = buffer.index(bodyStart, offsetBy: length)

    guard let components = URLComponents(string: String(requestLine[1])) else { throw .malformed }
    var query: [String: String] = [:]
    for item in components.queryItems ?? [] {
      query[item.name] = item.value ?? ""
    }
    let request = HTTPRequest(
      method: requestLine[0].uppercased(),
      path: components.path,
      query: query,
      headers: headers,
      body: Data(buffer[bodyStart..<bodyEnd])
    )
    return (request, buffer.distance(from: buffer.startIndex, to: bodyEnd))
  }
}

/// One `Range: bytes=…` header against a file of known size.
public enum ByteRange: Equatable, Sendable {
  case whole
  case partial(ClosedRange<Int64>)
  case unsatisfiable

  /// `bytes=a-b`, `bytes=a-` and `bytes=-n`. A missing, multi-range or malformed header means the
  /// whole file; a range that starts past the end cannot be served.
  public static func parse(_ header: String?, size: Int64) -> ByteRange {
    guard let header, header.lowercased().hasPrefix("bytes=") else { return .whole }
    let spec = header.dropFirst("bytes=".count).trimmingCharacters(in: .whitespaces)
    guard !spec.contains(",") else { return .whole }
    let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2 else { return .whole }
    let first = parts[0].trimmingCharacters(in: .whitespaces)
    let last = parts[1].trimmingCharacters(in: .whitespaces)

    if first.isEmpty {
      guard let suffix = Int64(last), suffix > 0, size > 0 else { return .unsatisfiable }
      return .partial(max(0, size - suffix)...(size - 1))
    }
    guard let start = Int64(first), start >= 0 else { return .whole }
    guard start < size else { return .unsatisfiable }
    if last.isEmpty { return .partial(start...(size - 1)) }
    guard let end = Int64(last), end >= start else { return .whole }
    return .partial(start...min(end, size - 1))
  }
}

public enum HTTPResponse: Sendable {
  case data(status: Int, contentType: String, body: Data)
  /// Streamed from disk, honouring the request's `Range`.
  case file(URL, contentType: String)
  /// Newline-delimited JSON events until either side closes.
  case events(any EventSource)

  public static func json<Value: Encodable>(_ value: Value, status: Int = 200) -> HTTPResponse {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .sortedKeys ]
    guard let body = try? encoder.encode(value) else {
      return .data(status: 500, contentType: "application/json", body: Data(#"{"ok":false}"#.utf8))
    }
    return .data(status: status, contentType: "application/json", body: body)
  }

  public static func error(_ status: Int, _ message: String) -> HTTPResponse {
    json(ErrorBody(ok: false, error: message), status: status)
  }

  public static var ok: HTTPResponse { json(ErrorBody(ok: true, error: nil)) }
}

struct ErrorBody: Codable {
  var ok: Bool
  var error: String?
}

/// A response's status line and header fields.
struct HTTPHead {
  var status: Int
  var fields: [(String, String)] = []

  mutating func set(_ name: String, _ value: String) {
    fields.append((name, value))
  }

  var data: Data {
    var text = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
    for (name, value) in fields {
      text += "\(name): \(value)\r\n"
    }
    text += "\r\n"
    return Data(text.utf8)
  }

  static func reason(_ status: Int) -> String {
    switch status {
    case 200: "OK"
    case 206: "Partial Content"
    case 400: "Bad Request"
    case 404: "Not Found"
    case 405: "Method Not Allowed"
    case 409: "Conflict"
    case 413: "Content Too Large"
    case 416: "Range Not Satisfiable"
    case 500: "Internal Server Error"
    default: "Status"
    }
  }
}
