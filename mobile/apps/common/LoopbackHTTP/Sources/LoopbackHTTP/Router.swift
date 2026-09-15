import Foundation

/// A failure a route reports to its caller: an HTTP status, a stable code a script can match on,
/// and a sentence for a person.
public struct HTTPError: Error, Equatable, Sendable {
  public var status: Int
  public var code: String
  public var message: String

  public init(_ status: Int, _ code: String, _ message: String) {
    self.status = status
    self.code = code
    self.message = message
  }

  public static func badRequest(_ message: String) -> HTTPError { HTTPError(400, "badRequest", message) }
  public static func notFound(_ message: String) -> HTTPError { HTTPError(404, "notFound", message) }

  /// `{"error": "<code>", "message": "..."}` with the status.
  public var response: HTTPResponse {
    .apiJSON(Body(error: code, message: message), status: status)
  }

  struct Body: Codable {
    var error: String
    var message: String
  }
}

/// Sends each request to the route whose method and path pattern match it. A pattern is a path
/// with `{name}` for a segment the handler reads back from `RouteParameters`:
/// `/api/v1/recordings/{id}/still`.
public struct Router: Sendable {
  public typealias Handler = @Sendable (HTTPRequest, RouteParameters) async throws -> HTTPResponse

  public struct Route: Sendable {
    public var method: String
    public var pattern: String
    public var summary: String
    let segments: [Segment]
    let handler: Handler
  }

  enum Segment: Equatable, Sendable {
    case literal(String)
    case parameter(String)
  }

  public private(set) var routes: [Route] = []

  public init() {}

  /// `summary` is one line saying what the route does, for an index of the routes.
  public mutating func add(_ method: String, _ pattern: String, summary: String = "", _ handler: @escaping Handler) {
    routes.append(Route(
      method: method.uppercased(),
      pattern: pattern,
      summary: summary,
      segments: Self.segments(of: pattern).map { part in
        part.hasPrefix("{") && part.hasSuffix("}") ? .parameter(String(part.dropFirst().dropLast())) : .literal(part)
      },
      handler: handler
    ))
  }

  /// Answers 404 when no pattern matches the path, and 405 when one does but not for this method.
  /// A thrown `HTTPError` becomes its response; anything else thrown is a 500.
  public func handle(_ request: HTTPRequest) async -> HTTPResponse {
    let path = Self.segments(of: request.path)
    var pathMatched = false
    for route in routes {
      guard let parameters = Self.match(route.segments, path) else { continue }
      pathMatched = true
      guard route.method == request.method else { continue }
      do {
        return try await route.handler(request, RouteParameters(values: parameters))
      } catch let error as HTTPError {
        return error.response
      } catch {
        return HTTPError(500, "internal", "\(error)").response
      }
    }
    return pathMatched
      ? HTTPError(405, "methodNotAllowed", "\(request.method) is not allowed on \(request.path)").response
      : HTTPError.notFound("no route \(request.path)").response
  }

  static func segments(of path: String) -> [String] {
    path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
  }

  static func match(_ pattern: [Segment], _ path: [String]) -> [String: String]? {
    guard pattern.count == path.count else { return nil }
    var parameters: [String: String] = [:]
    for (segment, part) in zip(pattern, path) {
      switch segment {
      case .literal(let literal):
        guard literal == part else { return nil }
      case .parameter(let name):
        parameters[name] = part
      }
    }
    return parameters
  }
}

/// The `{name}` segments of a matched path.
public struct RouteParameters: Sendable {
  public let values: [String: String]

  public subscript(_ name: String) -> String? { values[name] }

  /// A segment that must be a whole number; a 400 when it is not.
  public func int64(_ name: String) throws(HTTPError) -> Int64 {
    guard let value = values[name].flatMap(Int64.init) else {
      throw .badRequest("\(name) must be a whole number")
    }
    return value
  }
}

public extension HTTPRequest {
  /// The JSON body as `Value`; a 400 naming what was wrong when it does not decode.
  func decode<Value: Decodable>(_ type: Value.Type = Value.self) throws(HTTPError) -> Value {
    do {
      return try JSONDecoder.api.decode(Value.self, from: body.isEmpty ? Data("{}".utf8) : body)
    } catch {
      throw .badRequest("the body is not a \(Value.self): \(Self.describe(error))")
    }
  }

  private static func describe(_ error: Error) -> String {
    switch error {
    case DecodingError.keyNotFound(let key, _): "\(key.stringValue) is missing"
    case DecodingError.typeMismatch(_, let context), DecodingError.valueNotFound(_, let context):
      "\(context.codingPath.map(\.stringValue).joined(separator: ".")) has the wrong type"
    case DecodingError.dataCorrupted(let context): context.debugDescription
    default: "\(error)"
    }
  }
}

public extension JSONDecoder {
  /// Dates as ISO 8601, as `HTTPResponse.apiJSON` writes them.
  static var api: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}

public extension JSONEncoder {
  /// Keys sorted and dates as ISO 8601, on one line, for an event stream.
  static var api: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .sortedKeys, .withoutEscapingSlashes ]
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }
}

public extension HTTPResponse {
  /// JSON for people and scripts to read: indented, keys sorted, dates as ISO 8601.
  static func apiJSON<Value: Encodable>(_ value: Value, status: Int = 200) -> HTTPResponse {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .sortedKeys, .prettyPrinted, .withoutEscapingSlashes ]
    encoder.dateEncodingStrategy = .iso8601
    do {
      return .data(status: status, contentType: "application/json", body: try encoder.encode(value) + Data("\n".utf8))
    } catch {
      return HTTPError(500, "internal", "could not encode the answer: \(error)").response
    }
  }
}
