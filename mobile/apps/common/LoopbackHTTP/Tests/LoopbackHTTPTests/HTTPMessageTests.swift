import Foundation
import LoopbackHTTP
import Testing

@Suite("HTTP messages")
struct HTTPMessageTests {
  @Test("A request is parsed once all of it has arrived, and pipelined ones one at a time")
  func parsesAndPipelines() throws {
    let first = "PUT /v1/settings?x=1 HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nX-Distributor-Mac: M1\r\n\r\nhello"
    let second = "GET /v1/files/archives/cam%20a/seg-1.mp4 HTTP/1.1\r\nRange: bytes=0-9\r\n\r\n"

    #expect(try HTTPParser.parse(Data(first.utf8.prefix(20))) == nil)

    var buffer = Data((first + second).utf8)
    let one = try #require(try HTTPParser.parse(buffer))
    #expect(one.request.method == "PUT")
    #expect(one.request.path == "/v1/settings")
    #expect(one.request.query["x"] == "1")
    #expect(one.request.header("X-Distributor-Mac") == "M1")
    #expect(one.request.body == Data("hello".utf8))

    buffer = Data(buffer.dropFirst(one.consumed))
    let two = try #require(try HTTPParser.parse(buffer))
    #expect(two.request.method == "GET")
    #expect(two.request.path == "/v1/files/archives/cam a/seg-1.mp4")
    #expect(two.request.header("range") == "bytes=0-9")
    #expect(two.consumed == buffer.count)
  }

  @Test("A body is not handed over until all of it has arrived")
  func waitsForBody() throws {
    let partial = "POST /v1/jobs HTTP/1.1\r\nContent-Length: 10\r\n\r\n12345"
    #expect(try HTTPParser.parse(Data(partial.utf8)) == nil)
  }

  @Test("Nonsense and oversized requests are refused")
  func refusals() {
    #expect(throws: HTTPParser.Failure.malformed) {
      try HTTPParser.parse(Data("HELLO\r\n\r\n".utf8))
    }
    #expect(throws: HTTPParser.Failure.malformed) {
      try HTTPParser.parse(Data("GET / HTTP/1.1\r\nContent-Length: nope\r\n\r\n".utf8))
    }
    #expect(throws: HTTPParser.Failure.bodyTooLarge) {
      try HTTPParser.parse(Data("POST / HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n".utf8))
    }
    #expect(throws: HTTPParser.Failure.headTooLarge) {
      try HTTPParser.parse(Data(repeating: 0x41, count: HTTPParser.maximumHeadBytes + 1))
    }
  }
}

@Suite("Byte ranges")
struct ByteRangeTests {
  @Test("Single ranges in all three forms, clamped to the file")
  func ranges() {
    #expect(ByteRange.parse(nil, size: 100) == .whole)
    #expect(ByteRange.parse("bytes=0-9", size: 100) == .partial(0...9))
    #expect(ByteRange.parse("bytes=90-", size: 100) == .partial(90...99))
    #expect(ByteRange.parse("bytes=-10", size: 100) == .partial(90...99))
    #expect(ByteRange.parse("bytes=50-500", size: 100) == .partial(50...99))
  }

  @Test("A range past the end cannot be served; a malformed one means the whole file")
  func edges() {
    #expect(ByteRange.parse("bytes=100-", size: 100) == .unsatisfiable)
    #expect(ByteRange.parse("bytes=-5", size: 0) == .unsatisfiable)
    #expect(ByteRange.parse("bytes=9-0", size: 100) == .whole)
    #expect(ByteRange.parse("bytes=0-1,5-6", size: 100) == .whole)
    #expect(ByteRange.parse("items=0-1", size: 100) == .whole)
  }
}
