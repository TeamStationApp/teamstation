import Foundation
import Network
import XCTest

/// `RCTConnections`'s class methods, sent by name: this bundle takes no pods
/// and cannot import the app.
@objc private protocol ConnectionsMethods {
  func handlerOfNetworking(_ networking: Any?) -> Any?
  func keepsSession(_ handler: Any?) -> Bool
  func sessionOfHandler(_ handler: Any?) -> URLSession?
  func renewSessionOf(_ handler: Any?) -> Bool
  func renewSessionOf(_ handler: Any?, forHost host: String?, ifStalledFor waitMs: Int64, done: ((Bool) -> Void)?) -> Bool
}

/// React Native's `RCTHTTPRequestHandler`'s method, declared for sending it by selector.
@objc private protocol RequestHandler {
  func sendRequest(_ request: URLRequest, withDelegate delegate: Any) -> URLSessionDataTask
}

/// React Native's HTTP handler, renewed, sends its next request on a new
/// connection and still answers the request already on the old one.
final class ConnectionsTests: XCTestCase {
  private var connections: AnyObject {
    NSClassFromString("RCTConnections")!
  }

  /// Answers every request "ok" over HTTP/1.1, keeping each connection open,
  /// `POST /upload` once it has read its body 64 KiB every 100 ms,
  /// `/slow` a second later, `/trickle` a kilobyte every 100 ms for 2 s (a
  /// byte at a time is held back before the task counts it), and
  /// `/hold` never; counts the connections it took.
  private final class Server {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "ConnectionsTests.server")
    private var taken = 0

    var connections: Int {
      queue.sync { taken }
    }

    init() throws {
      let parameters = NWParameters.tcp
      parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
      listener = try NWListener(using: parameters)
      listener.newConnectionHandler = { [weak self] connection in
        guard let self else { return }
        self.taken += 1
        connection.start(queue: self.queue)
        self.answer(connection, buffered: Data())
      }
    }

    func start() -> UInt16 {
      let ready = DispatchSemaphore(value: 0)
      listener.stateUpdateHandler = { state in
        if case .ready = state { ready.signal() }
      }
      listener.start(queue: queue)
      _ = ready.wait(timeout: .now() + 5)
      return listener.port!.rawValue
    }

    func stop() {
      listener.cancel()
    }

    /// Reads `left` more bytes of a body 64 KiB every 100 ms, then answers.
    private func drain(_ connection: NWConnection, left: Int) {
      if left <= 0 {
        let reply = Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok".utf8)
        connection.send(content: reply, completion: .contentProcessed { _ in })
        answer(connection, buffered: Data())
        return
      }
      queue.asyncAfter(deadline: .now() + .milliseconds(100)) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: min(65536, left)) { data, _, done, error in
          if done || error != nil {
            connection.cancel()
          } else {
            self.drain(connection, left: left - (data?.count ?? 0))
          }
        }
      }
    }

    private func answer(_ connection: NWConnection, buffered: Data) {
      connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, done, error in
        var buffer = buffered + (data ?? Data())
        let end = Data("\r\n\r\n".utf8)
        while let headers = buffer.range(of: end) {
          let request = String(decoding: buffer.subdata(in: 0..<headers.lowerBound), as: UTF8.self)
          buffer = buffer.subdata(in: headers.upperBound..<buffer.count)
          if request.hasPrefix("POST /upload ") {
            let length = request.split(separator: "\r\n")
              .first { $0.lowercased().hasPrefix("content-length:") }
              .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
            self.drain(connection, left: length - buffer.count)
            return
          }
          if request.hasPrefix("GET /hold ") {
            continue
          }
          if request.hasPrefix("GET /trickle ") {
            let head = Data("HTTP/1.1 200 OK\r\nContent-Length: 20480\r\nConnection: keep-alive\r\n\r\n".utf8)
            connection.send(content: head, completion: .contentProcessed { _ in })
            for i in 0..<20 {
              self.queue.asyncAfter(deadline: .now() + .milliseconds(100 * (i + 1))) {
                connection.send(content: Data(repeating: 120, count: 1024), completion: .contentProcessed { _ in })
              }
            }
            continue
          }
          let reply = Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok".utf8)
          let delay: DispatchTimeInterval = request.hasPrefix("GET /slow ") ? .seconds(1) : .seconds(0)
          self.queue.asyncAfter(deadline: .now() + delay) {
            connection.send(content: reply, completion: .contentProcessed { _ in })
          }
        }
        if done || error != nil {
          connection.cancel()
        } else {
          self.answer(connection, buffered: buffer)
        }
      }
    }
  }

  /// React Native's `RCTURLRequestDelegate`, by its selectors.
  private final class Answer: NSObject {
    /// Fulfilled once answered; none for a request the test does not wait for.
    let done: XCTestExpectation?
    private(set) var body = Data()
    private(set) var failure: Error?

    init(_ done: XCTestExpectation?) {
      self.done = done
    }

    @objc(URLRequest:didSendDataWithProgress:) func sent(_ request: Any, progress: Int64) {}
    @objc(URLRequest:didReceiveResponse:) func response(_ request: Any, response: URLResponse) {}
    @objc(URLRequest:didReceiveData:) func received(_ request: Any, data: Data) {
      body.append(data)
    }
    @objc(URLRequest:didCompleteWithError:) func completed(_ request: Any, error: Error?) {
      failure = error
      done?.fulfill()
    }
  }

  private func send(
    _ handler: AnyObject,
    port: UInt16,
    path: String = "/",
    host: String = "127.0.0.1",
    body: Data? = nil,
    awaited: Bool = true
  ) -> Answer {
    let answer = Answer(awaited ? expectation(description: "answered \(path)") : nil)
    var request = URLRequest(url: URL(string: "http://\(host):\(port)\(path)")!)
    if let body {
      request.httpMethod = "POST"
      request.httpBody = body
    }
    // Sent by selector: the handler does not declare `RequestHandler`.
    _ = handler.sendRequest(request, withDelegate: answer)
    return answer
  }

  private func reactNativesHandler() -> AnyObject {
    let handlerClass = NSClassFromString("RCTHTTPRequestHandler") as! NSObject.Type
    return handlerClass.init()
  }

  private func sendInTurn(_ handler: AnyObject, port: UInt16, count: Int) {
    for _ in 0..<count {
      let answer = send(handler, port: port)
      wait(for: [answer.done!], timeout: 10)
      XCTAssertEqual(String(decoding: answer.body, as: UTF8.self), "ok")
    }
  }

  func testAHandlerSendsRequestsInTurnOnOneConnection() throws {
    // The control: without a renewal its connection is used again.
    let server = try Server()
    defer { server.stop() }
    let port = server.start()
    sendInTurn(reactNativesHandler(), port: port, count: 3)
    XCTAssertEqual(server.connections, 1)
  }

  func testARenewedHandlerSendsItsNextRequestOnANewConnection() throws {
    let server = try Server()
    defer { server.stop() }
    let port = server.start()
    let handler = reactNativesHandler()
    sendInTurn(handler, port: port, count: 2)
    XCTAssertEqual(server.connections, 1)
    let before = connections.sessionOfHandler(handler)
    XCTAssertNotNil(before)

    // A request still out on the old session when it is renewed is answered.
    let slow = send(handler, port: port, path: "/slow")
    XCTAssertTrue(connections.renewSessionOf(handler))
    XCTAssertFalse(connections.sessionOfHandler(handler) === before)
    wait(for: [slow.done!], timeout: 10)
    XCTAssertNil(slow.failure)
    XCTAssertEqual(String(decoding: slow.body, as: UTF8.self), "ok")
    XCTAssertEqual(server.connections, 1)

    // The old connection is idle again, and the next requests do not use it.
    sendInTurn(handler, port: port, count: 2)
    XCTAssertEqual(server.connections, 2)
  }

  /// One request `renewedWhileOut` leaves out while it checks.
  private struct Out {
    var path: String
    var host = "127.0.0.1"
    var body: Data? = nil
  }

  /// Whether `renewSessionOf:forHost:ifStalledFor:` renewed `handler`'s
  /// session, for requests to 127.0.0.1, while `out` were out.
  private func renewedWhileOut(_ out: [Out], checkMs: Int64 = 500) throws -> Bool {
    let server = try Server()
    defer { server.stop() }
    let port = server.start()
    let handler = reactNativesHandler()
    sendInTurn(handler, port: port, count: 1)
    let before = connections.sessionOfHandler(handler)
    for request in out {
      _ = send(handler, port: port, path: request.path, host: request.host, body: request.body, awaited: false)
    }
    // The answers' heads, or the bodies' first bytes, are on their way first.
    Thread.sleep(forTimeInterval: 0.3)
    let checked = expectation(description: "checked")
    var renewed: Bool?
    XCTAssertTrue(connections.renewSessionOf(handler, forHost: "127.0.0.1", ifStalledFor: checkMs) { answer in
      renewed = answer
      checked.fulfill()
    })
    wait(for: [checked], timeout: 10)
    XCTAssertEqual(renewed, !(connections.sessionOfHandler(handler) === before))
    return renewed ?? false
  }

  private func renewedWhileOut(_ path: String, checkMs: Int64 = 500) throws -> Bool {
    try renewedWhileOut([Out(path: path)], checkMs: checkMs)
  }

  func testKeepsTheSessionOfASlowAnswerStillComing() throws {
    XCTAssertFalse(try renewedWhileOut("/trickle"))
  }

  func testKeepsTheSessionOfARequestAnsweredDuringTheCheck() throws {
    // `/slow` is answered a second after it is sent, within the check: it
    // has left the session's tasks by then, and still counts.
    XCTAssertFalse(try renewedWhileOut("/slow", checkMs: 1500))
  }

  func testKeepsTheSessionWhenOneOfTwoRequestsIsAnswered() throws {
    XCTAssertFalse(try renewedWhileOut([Out(path: "/slow"), Out(path: "/hold")], checkMs: 1500))
  }

  func testKeepsTheSessionOfAnUploadStillSending() throws {
    // Far more than the sockets on both ends take at once: the rest goes as
    // the server reads it.
    let body = Data(repeating: 120, count: 64 * 1024 * 1024)
    XCTAssertFalse(try renewedWhileOut([Out(path: "/upload", body: body)], checkMs: 1000))
  }

  func testRenewsTheSessionWhileOnlyAnotherHostsRequestProgresses() throws {
    // `localhost` is the same server, by another host name: its trickle is
    // not TeamStation's connection moving.
    XCTAssertTrue(try renewedWhileOut([Out(path: "/hold"), Out(path: "/trickle", host: "localhost")]))
  }

  func testRenewsTheSessionOfARequestThatReceivesNothing() throws {
    XCTAssertTrue(try renewedWhileOut("/hold"))
  }

  func testRenewsNothingBeforeTheFirstRequest() {
    let handler = reactNativesHandler()
    XCTAssertTrue(connections.keepsSession(handler))
    XCTAssertNil(connections.sessionOfHandler(handler))
    XCTAssertTrue(connections.renewSessionOf(handler))
    XCTAssertNil(connections.sessionOfHandler(handler))
  }

  func testFindsTheHTTPHandlerReactNativesNetworkingSendsHTTPSThrough() {
    // `RCTNetworking` as `RCTAppSetupDefaultModuleFromClass` makes it, with
    // React Native's own handlers.
    let provider: @convention(block) (AnyObject?) -> NSArray = { _ in
      ["RCTHTTPRequestHandler", "RCTDataRequestHandler", "RCTFileRequestHandler"]
        .map { (NSClassFromString($0) as! NSObject.Type).init() } as NSArray
    }
    let networkingClass: AnyClass = NSClassFromString("RCTNetworking")!
    // alloc's +1 goes to init, which answers its own +1.
    let allocated = (networkingClass as AnyObject).perform(NSSelectorFromString("alloc"))!.takeUnretainedValue()
    let networking = allocated.perform(NSSelectorFromString("initWithHandlersProvider:"), with: provider)!
      .takeRetainedValue()
    let handler = connections.handlerOfNetworking(networking) as AnyObject?
    XCTAssertEqual(handler.map { NSStringFromClass(type(of: $0)) }, "RCTHTTPRequestHandler")
    XCTAssertTrue(connections.keepsSession(handler))
  }

  func testLeavesAnythingElseAlone() {
    let other = NSObject()
    XCTAssertNil(connections.handlerOfNetworking(other))
    XCTAssertNil(connections.handlerOfNetworking(nil))
    XCTAssertFalse(connections.keepsSession(other))
    XCTAssertNil(connections.sessionOfHandler(other))
    XCTAssertFalse(connections.renewSessionOf(other))
  }
}
