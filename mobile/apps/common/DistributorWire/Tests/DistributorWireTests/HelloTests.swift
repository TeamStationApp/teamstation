import DistributorWire
import Foundation
import Testing

@Suite("Hello")
struct HelloTests {
  @Test("A Director from before streaming was reported still reads, as not streaming")
  func olderDirector() throws {
    let json = #"{"deviceName":"iPad","directorID":"7BFE2295-3E8A-49C7-80A6-2685C8001716","directorVersion":"1.0 (1)","isRecording":false,"protocolVersion":1,"sessionID":"B4848886-DB4F-414A-ACC0-4B51B1603CF2"}"#
    let hello = try JSONDecoder().decode(Hello.self, from: Data(json.utf8))
    #expect(hello.isStreaming == false)
    #expect(hello.isRecording == false)
    #expect(hello.deviceName == "iPad")
  }

  @Test("Streaming goes over the wire and comes back")
  func roundTrip() throws {
    let sent = Hello(deviceName: "iPad", directorVersion: "1.0 (1)", directorID: UUID(), isRecording: false, isStreaming: true, sessionID: UUID())
    let received = try JSONDecoder().decode(Hello.self, from: JSONEncoder().encode(sent))
    #expect(received == sent)
  }
}
