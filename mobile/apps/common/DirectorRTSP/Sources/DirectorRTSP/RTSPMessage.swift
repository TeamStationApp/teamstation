import Foundation

public enum RTSPMethod: String, Sendable, CaseIterable {
  case options = "OPTIONS"
  case describe = "DESCRIBE"
  case setup = "SETUP"
  case play = "PLAY"
  case pause = "PAUSE"
  case teardown = "TEARDOWN"
  case getParameter = "GET_PARAMETER"
  case setParameter = "SET_PARAMETER"
}

/// One request, ready to put on the wire.
public struct RTSPRequest: Sendable, Equatable {
  public var method: RTSPMethod
  public var uri: String
  public var cseq: Int
  /// Ordered rather than a dictionary so the wire form is byte-for-byte predictable in tests.
  public var headers: [(name: String, value: String)]
  public var body: Data?

  public init(
    method: RTSPMethod,
    uri: String,
    cseq: Int,
    headers: [(name: String, value: String)] = [],
    body: Data? = nil
  ) {
    self.method = method
    self.uri = uri
    self.cseq = cseq
    self.headers = headers
    self.body = body
  }

  public static func == (lhs: RTSPRequest, rhs: RTSPRequest) -> Bool {
    lhs.method == rhs.method
      && lhs.uri == rhs.uri
      && lhs.cseq == rhs.cseq
      && lhs.body == rhs.body
      && lhs.headers.map { [ $0.name, $0.value ] } == rhs.headers.map { [ $0.name, $0.value ] }
  }

  public var wireFormat: Data {
    var text = "\(method.rawValue) \(uri) RTSP/1.0\r\n"
    text += "CSeq: \(cseq)\r\n"
    for header in headers {
      text += "\(header.name): \(header.value)\r\n"
    }
    if let body, !body.isEmpty {
      text += "Content-Length: \(body.count)\r\n"
    }
    text += "\r\n"

    var data = Data(text.utf8)
    if let body { data.append(body) }
    return data
  }
}

public struct RTSPResponse: Sendable, Equatable {
  public let statusCode: Int
  public let reasonPhrase: String
  /// Keys are lower-cased, because no camera agrees with any other about capitalisation.
  public let headers: [String: String]
  public let body: Data

  public init(statusCode: Int, reasonPhrase: String, headers: [String: String], body: Data = Data()) {
    self.statusCode = statusCode
    self.reasonPhrase = reasonPhrase
    self.headers = headers
    self.body = body
  }

  public var isSuccess: Bool { (200 ..< 300).contains(statusCode) }
  public var cseq: Int? { headers["cseq"].flatMap { Int($0.trimmingCharacters(in: .whitespaces)) } }
  public var bodyText: String { String(decoding: body, as: UTF8.self) }

  public func header(_ name: String) -> String? { headers[name.lowercased()] }

  /// Session identifier without the `;timeout=` parameter some cameras append.
  public var session: String? {
    header("session")?
      .split(separator: ";")
      .first
      .map { $0.trimmingCharacters(in: .whitespaces) }
  }

  /// Seconds a session survives without a keepalive. Absent on the cameras measured here, in which
  /// case RFC 2326's 60 s default applies rather than "forever".
  public var sessionTimeout: Int {
    let parameters = header("session")?.split(separator: ";").dropFirst() ?? []
    for parameter in parameters {
      let parts = parameter.split(separator: "=", maxSplits: 1)
      guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "timeout" else {
        continue
      }
      if let value = Int(parts[1].trimmingCharacters(in: .whitespaces)) { return value }
    }
    return 60
  }

  /// Parses one response, returning how many bytes it consumed so the caller can advance its
  /// buffer. `nil` means "not yet complete", which is the normal case on a streaming socket and
  /// must not be treated as an error.
  public static func parse(_ data: Data) -> (response: RTSPResponse, consumed: Int)? {
    guard let headerEnd = Self.headerTerminator(in: data) else { return nil }
    let headerText = String(decoding: data[data.startIndex ..< headerEnd.start], as: UTF8.self)
    var lines = Self.unfolded(headerText)
    guard let statusLine = lines.first else { return nil }
    lines.removeFirst()

    // "RTSP/1.0 200 OK", where the reason phrase may itself contain spaces.
    let statusParts = statusLine.split(separator: " ", maxSplits: 2).map(String.init)
    guard statusParts.count >= 2, let statusCode = Int(statusParts[1]) else { return nil }
    let reason = statusParts.count > 2 ? statusParts[2] : ""

    var headers: [String: String] = [:]
    for line in lines {
      guard let separator = line.firstIndex(of: ":") else { continue }
      let name = line[line.startIndex ..< separator].trimmingCharacters(in: .whitespaces).lowercased()
      let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
      // A repeated header keeps both values, comma-joined, as RFC 2616 allows.
      headers[name] = headers[name].map { "\($0), \(value)" } ?? value
    }

    let contentLength = headers["content-length"].flatMap { Int($0) } ?? 0
    let bodyStart = headerEnd.end
    let available = data.distance(from: bodyStart, to: data.endIndex)
    guard available >= contentLength else { return nil }

    let bodyEnd = data.index(bodyStart, offsetBy: contentLength)
    return (
      RTSPResponse(
        statusCode: statusCode,
        reasonPhrase: reason,
        headers: headers,
        body: Data(data[bodyStart ..< bodyEnd])
      ),
      data.distance(from: data.startIndex, to: bodyEnd)
    )
  }

  /// Header blocks end at CRLFCRLF, but a camera that emits bare LFs would otherwise never look
  /// complete, so LFLF is accepted as well.
  private static func headerTerminator(in data: Data) -> (start: Data.Index, end: Data.Index)? {
    var index = data.startIndex
    while index < data.endIndex {
      if data[index] == 0x0D,
         let one = data.index(index, offsetBy: 1, limitedBy: data.endIndex), one < data.endIndex,
         data[one] == 0x0A,
         let two = data.index(index, offsetBy: 2, limitedBy: data.endIndex), two < data.endIndex,
         data[two] == 0x0D,
         let three = data.index(index, offsetBy: 3, limitedBy: data.endIndex), three < data.endIndex,
         data[three] == 0x0A {
        return (index, data.index(after: three))
      }
      if data[index] == 0x0A,
         let one = data.index(index, offsetBy: 1, limitedBy: data.endIndex), one < data.endIndex,
         data[one] == 0x0A {
        return (index, data.index(after: one))
      }
      index = data.index(after: index)
    }
    return nil
  }

  /// Joins continuation lines — a header value may be wrapped onto following lines that begin with
  /// whitespace, and splitting on newlines alone would silently lose the remainder.
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

/// Numbers requests and carries the headers every request on a session needs.
public struct RTSPRequestBuilder: Sendable {
  public var userAgent: String
  public var session: String?
  public var authorization: String?
  private var nextCSeq = 1

  public init(userAgent: String = "GS Director/1.0") {
    self.userAgent = userAgent
  }

  /// CSeq must advance on every request, including retries after a 401, or the camera answers the
  /// wrong request and the session desynchronises for good.
  public mutating func make(
    _ method: RTSPMethod,
    uri: String,
    headers: [(name: String, value: String)] = [],
    body: Data? = nil
  ) -> RTSPRequest {
    var all: [(name: String, value: String)] = [ (name: "User-Agent", value: userAgent) ]
    if let session { all.append((name: "Session", value: session)) }
    if let authorization { all.append((name: "Authorization", value: authorization)) }
    all.append(contentsOf: headers)

    let request = RTSPRequest(method: method, uri: uri, cseq: nextCSeq, headers: all, body: body)
    nextCSeq += 1
    return request
  }
}
