import DirectorLink
import Foundation
import Testing

@Suite("Link server hang-ups", .serialized)
struct LinkServerHangUpTests {
  @Test("A client hanging up on its event stream no longer counts as connected")
  func eventStreamHangUp() async throws {
    let counts = CountLog()
    let hub = EventHub()
    let server = LinkServer(port: 0, connectionsChanged: { counts.append($0) }) { request in
      request.path.hasSuffix("/events") ? .events(hub) : .ok
    }
    let port = try await server.start()
    defer { server.stop() }
    let session = URLSession(configuration: .ephemeral)
    let listening = Task {
      let (bytes, _) = try await session.bytes(from: URL(string: "http://127.0.0.1:\(port)/v1/events")!)
      for try await _ in bytes.lines {}
    }
    for _ in 0..<100 where counts.values.last ?? 0 == 0 {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect((counts.values.last ?? 0) > 0)

    listening.cancel()
    session.invalidateAndCancel()
    for _ in 0..<150 where counts.values.last != 0 {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(counts.values.last == 0)
  }
}
