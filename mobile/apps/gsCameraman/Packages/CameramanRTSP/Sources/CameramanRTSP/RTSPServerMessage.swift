import Foundation

/// The server half of RFC 2326's message syntax: requests parsed, responses written.
///
/// GS Producer's `RTSPMessage` is the mirror image of this — it writes requests and parses responses.
/// The two are deliberately not shared, because a bug in shared code would cancel itself out in any
/// test that used both ends.
public struct RTSPServerRequest: Sendable, Equatable {
  public let method: String
  public let uri: String
  /// Lower-cased keys. No client agrees with any other about capitalisation.
  public let headers: [String: String]
  public let body: Data

  public init(method: String, uri: String, headers: [String: String], body: Data = Data()) {
    self.method = method
    self.uri = uri
    self.headers = headers
    self.body = body
  }

  public var cseq: String? { headers["cseq"] }

  /// Session identifier without the `;timeout=` parameter a client may echo back.
  public var session: String? {
    headers["session"]?.split(separator: ";").first.map {
      $0.trimmingCharacters(in: .whitespaces)
    }
  }

  /// Parses one request, returning how many bytes it consumed. `nil` means "not yet complete", which
  /// is the normal case on a streaming socket and must never be treated as an error.
  public static func parse(_ data: Data) -> (request: RTSPServerRequest, consumed: Int)? {
    guard let terminator = headerTerminator(in: data) else { return nil }

    let headerText = String(decoding: data[data.startIndex ..< terminator.start], as: UTF8.self)
    var lines = unfolded(headerText)
    guard let requestLine = lines.first else { return nil }
    lines.removeFirst()

    // "DESCRIBE rtsp://host/live RTSP/1.0"
    let parts = requestLine.split(separator: " ").map(String.init)
    guard parts.count >= 3 else { return nil }

    var headers: [String: String] = [:]
    for line in lines {
      guard let separator = line.firstIndex(of: ":") else { continue }
      let name = line[line.startIndex ..< separator]
        .trimmingCharacters(in: .whitespaces)
        .lowercased()
      headers[name] = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
    }

    let contentLength = headers["content-length"].flatMap { Int($0) } ?? 0
    let available = data.distance(from: terminator.end, to: data.endIndex)
    guard available >= contentLength else { return nil }

    let bodyEnd = data.index(terminator.end, offsetBy: contentLength)
    return (
      RTSPServerRequest(
        method: parts[0].uppercased(),
        uri: parts[1],
        headers: headers,
        body: Data(data[terminator.end ..< bodyEnd])
      ),
      data.distance(from: data.startIndex, to: bodyEnd)
    )
  }

  private static func headerTerminator(in data: Data) -> (start: Data.Index, end: Data.Index)? {
    // A client sending bare LFs would otherwise never look complete, so LFLF is accepted too.
    var index = data.startIndex
    while index < data.endIndex {
      if matches(data, at: index, [ 0x0D, 0x0A, 0x0D, 0x0A ]) {
        return (index, data.index(index, offsetBy: 4))
      }
      if matches(data, at: index, [ 0x0A, 0x0A ]) {
        return (index, data.index(index, offsetBy: 2))
      }
      index = data.index(after: index)
    }
    return nil
  }

  private static func matches(_ data: Data, at index: Data.Index, _ pattern: [UInt8]) -> Bool {
    var cursor = index
    for byte in pattern {
      guard cursor < data.endIndex, data[cursor] == byte else { return false }
      cursor = data.index(after: cursor)
    }
    return true
  }

  /// Joins continuation lines. A header value may wrap onto following lines that begin with
  /// whitespace, and splitting on newlines alone silently loses the remainder.
  private static func unfolded(_ text: String) -> [String] {
    var result: [String] = []
    for raw in text.components(separatedBy: "\n") {
      let line = raw.hasSuffix("\r") ? String(raw.dropLast()) : raw
      if let first = line.first, first == " " || first == "\t", !result.isEmpty {
        result[result.count - 1] += " " + line.trimmingCharacters(in: .whitespaces)
      } else {
        result.append(line)
      }
    }
    return result.filter { !$0.isEmpty }
  }
}

public struct RTSPServerResponse: Sendable {
  public var statusCode: Int
  public var reasonPhrase: String
  /// Ordered so the wire form is byte-for-byte predictable in tests.
  public var headers: [(name: String, value: String)]
  public var body: Data

  public init(
    statusCode: Int = 200,
    reasonPhrase: String = "OK",
    headers: [(name: String, value: String)] = [],
    body: Data = Data()
  ) {
    self.statusCode = statusCode
    self.reasonPhrase = reasonPhrase
    self.headers = headers
    self.body = body
  }

  public var wireFormat: Data {
    var text = "RTSP/1.0 \(statusCode) \(reasonPhrase)\r\n"
    for header in headers {
      text += "\(header.name): \(header.value)\r\n"
    }
    if !body.isEmpty {
      text += "Content-Length: \(body.count)\r\n"
    }
    text += "\r\n"

    var data = Data(text.utf8)
    data.append(body)
    return data
  }

  public static func status(_ code: Int, _ reason: String, cseq: String?) -> RTSPServerResponse {
    var headers: [(name: String, value: String)] = []
    // Echoing CSeq is mandatory even on an error. A client that cannot match the response to its
    // request treats the session as desynchronised.
    if let cseq { headers.append((name: "CSeq", value: cseq)) }
    return RTSPServerResponse(statusCode: code, reasonPhrase: reason, headers: headers)
  }
}
