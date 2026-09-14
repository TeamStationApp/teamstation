import Foundation
@testable import PeerTubeKit

/// A pretend PeerTube instance behind URLProtocol, so the tests need no server. Each test builds
/// its own, with its own behaviour, and registers it on a session of its own.
final class StubPeerTube: @unchecked Sendable {
  struct Seen {
    var method: String
    var path: String
    var headers: [String: String]
    var body: Data
  }

  private let lock = NSLock()
  private(set) var requests: [Seen] = []
  var handler: @Sendable (Seen) -> (Int, [String: String], Data)

  init(handler: @escaping @Sendable (Seen) -> (Int, [String: String], Data)) {
    self.handler = handler
  }

  func record(_ seen: Seen) -> (Int, [String: String], Data) {
    lock.withLock { requests.append(seen) }
    return handler(seen)
  }

  var seen: [Seen] { lock.withLock { requests } }

  /// A session whose every request this stub answers.
  func session() -> URLSession {
    let id = UUID().uuidString
    StubProtocol.register(self, id: id)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ StubProtocol.self ]
    configuration.httpAdditionalHeaders = [ "X-Stub": id ]
    return URLSession(configuration: configuration)
  }

  static func json(_ object: Any, status: Int = 200, headers: [String: String] = [:]) -> (Int, [String: String], Data) {
    (status, headers.merging([ "Content-Type": "application/json" ]) { a, _ in a }, (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
  }
}

final class StubProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var stubs: [String: StubPeerTube] = [:]

  static func register(_ stub: StubPeerTube, id: String) {
    lock.withLock { stubs[id] = stub }
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let id = request.value(forHTTPHeaderField: "X-Stub") ?? ""
    guard let stub = Self.lock.withLock({ Self.stubs[id] }), let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }
    var body = request.httpBody ?? Data()
    if body.isEmpty, let stream = request.httpBodyStream {
      stream.open()
      var buffer = [UInt8](repeating: 0, count: 1 << 16)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        body.append(contentsOf: buffer[0..<count])
      }
      stream.close()
    }
    let path = url.path + (url.query.map { "?\($0)" } ?? "")
    let (status, headers, data) = stub.record(StubPeerTube.Seen(
      method: request.httpMethod ?? "GET",
      path: path,
      headers: request.allHTTPHeaderFields ?? [:],
      body: body
    ))
    let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
