import Foundation
import XCTest
@testable import TeamStationObservability

private let instant = Date(timeIntervalSince1970: 1767268800)
private let eventID = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
private func sampleLog(_ kind: LogKind = .started, at: Date = instant, id: UUID = eventID) -> LogRecord {
  LogRecord(app: .director, kind: kind, at: at, id: id)!
}
private final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var value = instant
  func now() -> Date { lock.withLock { value } }
  func advance(_ seconds: Double) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}
private actor Transport {
  var status = 200
  var fail = false
  var sent: [Data] = []
  func set(_ status: Int, fail: Bool = false) { self.status = status; self.fail = fail }
  func send(_ data: Data) throws -> Int {
    sent.append(data)
    if fail { throw URLError(.notConnectedToInternet) }
    return status
  }
}

final class LogRecordTests: XCTestCase {
  func testCanonicalContract() throws {
    var golden = ""
    for app in LogApp.allCases {
      for kind in LogKind.allCases {
        let row = LogRecord(app: app, kind: kind, at: instant, id: eventID)!
        let line = try row.jsonLine()
        golden += line
        XCTAssertTrue(line.hasPrefix("{\"D\":\"2026-01-01T12:00:00.000Z\","))
        XCTAssertEqual(line.filter { $0 == "\n" }.count, 1)
        XCTAssertEqual(try JSONDecoder().decode(LogRecord.self, from: Data(line.utf8)), row)
        XCTAssertEqual(row.validated, row)
        XCTAssertLessThan(line.utf8.count, 4096)
      }
    }
    if let path = ProcessInfo.processInfo.environment["OBSERVABILITY_GOLDEN_PATH"] {
      try golden.write(toFile: path, atomically: true, encoding: .utf8)
    }
    let line = try sampleLog().jsonLine()
    XCTAssertEqual(line, "{\"D\":\"2026-01-01T12:00:00.000Z\",\"A\":\"TS dir\",\"E\":\"service_started\",\"I\":\"00000000-0000-4000-8000-000000000001\",\"L\":\"info\",\"P\":{},\"R\":1}\n")
  }

  func testSafeTypedProperties() throws {
    for op in LogOperation.allCases {
      for error in LogError.allCases {
        let row = LogRecord(app: .cameraman, kind: .error, at: instant, operation: op, error: error, milliseconds: 12, count: 4)!
        XCTAssertEqual(row.validated, row)
        XCTAssertEqual(row.L, "error")
      }
    }
    XCTAssertNotNil(LogRecord(app: .director, kind: .recordingStarted, video: "vid_demo"))
    for ms in [-1, 15001, .nan, .infinity] { XCTAssertNil(LogRecord(app: .director, kind: .started, milliseconds: ms)) }
    for n in [-1, 1_000_000_001] { XCTAssertNil(LogRecord(app: .director, kind: .started, count: n)) }
    XCTAssertNil(LogRecord(app: .director, kind: .started, video: "vid_demo"))
    XCTAssertNil(LogRecord(app: .director, kind: .recordingStarted, operation: .record))
    XCTAssertNil(LogRecord(app: .director, kind: .recordingStarted, count: 1))
    XCTAssertNil(LogRecord(app: .director, kind: .recordingStarted, video: "chat/private?token=secret"))
    XCTAssertNil(LogRecord(app: .director, kind: .started, at: Date(timeIntervalSince1970: .infinity)))
  }

  func testDecodedRecordsAreRevalidated() throws {
    let line = try sampleLog().jsonLine()
    for changed in [line.replacingOccurrences(of: "\"R\":1", with: "\"R\":2"),
                    line.replacingOccurrences(of: "\"info\"", with: "\"fatal\""),
                    line.replacingOccurrences(of: eventID.uuidString.lowercased(), with: "secret"),
                    line.replacingOccurrences(of: "2026-01-01T12:00:00.000Z", with: "invalid")] {
      let row = try JSONDecoder().decode(LogRecord.self, from: Data(changed.utf8))
      XCTAssertNil(row.validated)
      if row.D == "invalid" { XCTAssertEqual(row.date, Date.distantPast) }
    }
    let extra = line.replacingOccurrences(of: "\"P\":{}", with: "\"P\":{\"chat\":\"private canary\"}")
    XCTAssertFalse(try JSONDecoder().decode(LogRecord.self, from: Data(extra.utf8)).jsonLine().contains("canary"))
  }
}

final class LogQueueTests: XCTestCase, @unchecked Sendable {
  var folder: URL!
  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws { try FileManager.default.removeItem(at: folder) }

  func testPersistenceBatchingAndRestart() async throws {
    let file = folder.appendingPathComponent("queue.json")
    let transport = Transport()
    let queue = LogQueue(file: file, now: { instant }, send: { try await transport.send($0) })
    for _ in 0..<51 { await queue.enqueue(sampleLog(id: UUID())) }
    let count = await queue.count; XCTAssertEqual(count, 51)
    let restored = LogQueue(file: file, now: { instant }, send: { try await transport.send($0) })
    await restored.flush()
    let remaining = await restored.count; XCTAssertEqual(remaining, 1)
    let sent = await transport.sent
    XCTAssertEqual(String(decoding: sent[0], as: UTF8.self).split(separator: "\n").count, 50)
    await restored.flush(); await restored.flush()
    let final = await restored.count; XCTAssertEqual(final, 0)
    await restored.start(); await restored.start(); await restored.stop(); await restored.start()
    await restored.enqueue(sampleLog()); await restored.flush()
    let stoppedCount = await restored.count; XCTAssertEqual(stoppedCount, 0)
  }

  func testCapacityExpiryAndStorageFailure() async throws {
    let clock = Clock()
    let queue = LogQueue(file: folder.appendingPathComponent("sub/queue.json"), capacity: 1, now: { clock.now() }, send: { _ in 200 })
    await queue.enqueue(sampleLog()); await queue.enqueue(sampleLog())
    let dedup = await queue.count; XCTAssertEqual(dedup, 1)
    await queue.enqueue(sampleLog(id: UUID()))
    let dropped = await queue.dropped; XCTAssertEqual(dropped, 1)
    clock.advance(604801); await queue.flush()
    let expired = await queue.count; XCTAssertEqual(expired, 0)
    await queue.enqueue(sampleLog())
    let old = await queue.count; XCTAssertEqual(old, 0)
    await queue.enqueue(sampleLog(at: clock.now().addingTimeInterval(301)))
    let future = await queue.count; XCTAssertEqual(future, 0)
    let broken = LogQueue(file: folder, now: { instant }, send: { _ in 200 })
    await broken.enqueue(sampleLog())
    let failed = await broken.storageFailed; XCTAssertTrue(failed)
    let empty = LogQueue(file: folder.appendingPathComponent("empty"), capacity: -1, now: { instant }, send: { _ in 200 })
    await empty.enqueue(sampleLog())
    let emptyCount = await empty.count; XCTAssertEqual(emptyCount, 0)
  }

  func testRetryAndPermanentRefusal() async throws {
    let clock = Clock()
    let transport = Transport()
    let file = folder.appendingPathComponent("queue.json")
    let queue = LogQueue(file: file, now: { clock.now() }, send: { try await transport.send($0) })
    await queue.enqueue(sampleLog())
    for status in [429, 408, 500, 0] {
      await transport.set(status, fail: status == 0)
      await queue.flush(); await queue.flush()
      let count = await queue.count; XCTAssertEqual(count, 1)
      clock.advance(61)
    }
    let attempts = await transport.sent.count; XCTAssertEqual(attempts, 4)
    await transport.set(400); await queue.flush()
    let remaining = await queue.count; XCTAssertEqual(remaining, 0)
    let dropped = await queue.dropped; XCTAssertEqual(dropped, 1)
  }

  func testRejectsCorruptOversizedAndInvalidRestores() async throws {
    let file = folder.appendingPathComponent("queue.json")
    for data in [Data("invalid".utf8), Data(repeating: 32, count: 524289), try JSONEncoder().encode([sampleLog(at: instant.addingTimeInterval(-604801))])] {
      try data.write(to: file)
      let queue = LogQueue(file: file, now: { instant }, send: { _ in 200 })
      let count = await queue.count; XCTAssertEqual(count, 0)
    }
    try JSONEncoder().encode([sampleLog(), sampleLog(id: UUID())]).write(to: file)
    let limited = LogQueue(file: file, capacity: 1, now: { instant }, send: { _ in 200 })
    let count = await limited.count; XCTAssertEqual(count, 1)
  }
}

private final class StubProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/x-ndjson")
    let response: URLResponse = request.url!.path == "/nonhttp"
      ? URLResponse(url: request.url!, mimeType: nil, expectedContentLength: 0, textEncodingName: nil)
      : HTTPURLResponse(url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data())
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
final class LogSenderTests: XCTestCase, @unchecked Sendable {
  func testHTTPTransport() async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubProtocol.self]
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    for path in ["/events", "/nonhttp"] {
      let sender = LogQueue.sender(endpoint: URL(string: "https://example.test" + path)!, session: session)
      let status = try await sender(Data())
      XCTAssertEqual(status, path == "/events" ? 202 : 0)
    }
  }
}
