import CameramanRTSP
import Foundation
import Testing

@Suite("RTSP server status")
struct RTSPServerStatusTests {
  @Test("A fresh status encodes the soak counters as zeros")
  func defaultStatusEncodesSoakFields() throws {
    let data = try JSONEncoder().encode(RTSPServer.Status())
    let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    #expect(json?["acceptedClients"] as? Int == 0)
    #expect(json?["closedClients"] as? Int == 0)
    #expect(json?["sendQueuePendingBytes"] as? Int == 0)
    #expect(json?["sendQueueFlushes"] as? Int == 0)
    #expect(json?["clientCount"] as? Int == 0)
    #expect(json?["isListening"] as? Bool == false)
  }

  @Test("A disconnect reason survives a round trip")
  func disconnectReasonRoundTrips() throws {
    var status = RTSPServer.Status()
    status.lastDisconnectReason = "TEARDOWN"
    status.listenerState = "ready"
    status.acceptedClients = 4
    status.closedClients = 3
    status.clientCount = 1
    let data = try JSONEncoder().encode(status)
    let decoded = try JSONDecoder().decode(RTSPServer.Status.self, from: data)
    #expect(decoded.lastDisconnectReason == "TEARDOWN")
    #expect(decoded.listenerState == "ready")
    #expect(decoded.acceptedClients == 4)
    #expect(decoded.closedClients == 3)
    #expect(decoded.clientCount == 1)
  }
}
