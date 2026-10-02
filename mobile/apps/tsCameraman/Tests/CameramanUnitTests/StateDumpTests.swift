import CameramanCore
import CameramanTestHarness
import Foundation
import Testing

@testable import CameramanUI

@Suite("State dump soak fields")
struct StateDumpTests {
  @Test @MainActor
  func encodesProcessAndCaptureHealth() throws {
    let environment = AppEnvironment(broadcastStore: InMemorySettingsStore())
    let data = try JSONEncoder().encode(environment.stateDump)
    let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    #expect(json != nil)
    #expect(json?["physFootprintMB"] != nil)
    #expect(json?["residentSizeMB"] != nil)
    #expect(json?["availableMemoryMB"] != nil)
    #expect(json?["cpuPercent"] != nil)
    #expect(json?["thermalState"] != nil)
    #expect(json?["cpuCores"] != nil)
    #expect(json?["interrupted"] as? Bool == false)
    #expect(json?["audioPendingBytes"] as? Int == 0)
    #expect(json?["cleanHDMIEnabled"] as? Bool == true)
    // Not idle yet: with no keyframe produced there are no parameter sets for the SDP, and the
    // encoder runs until there are, client or no client.
    #expect(json?["encoderIdle"] as? Bool == false)
    let display = json?["externalDisplay"] as? [String: Any]
    #expect(display?["connected"] as? Bool == false)
    #expect(display?["framesEnqueued"] as? Int == 0)
    let server = json?["server"] as? [String: Any]
    #expect(server?["acceptedClients"] as? Int == 0)
    #expect(server?["closedClients"] as? Int == 0)
    #expect(server?["sendQueuePendingBytes"] as? Int == 0)
    #expect(server?["isListening"] as? Bool == false)
    #expect(json?["broadcasting"] as? Bool == false)
  }

  @Test @MainActor
  func encoderIdleFollowsTheLaunchOverride() {
    let overridden = AppEnvironment(launch: LaunchConfiguration(arguments: [ "-encodeWhenIdle", "true" ]))
    #expect(overridden.encoderIdle == false)
    let recording = AppEnvironment(launch: LaunchConfiguration(arguments: [ "-recordSeconds", "5" ]))
    #expect(recording.encoderIdle == false)
  }

  @Test @MainActor
  func frameCountersIncrementOffTheMainActor() async {
    let environment = AppEnvironment()
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
      DispatchQueue.global().async {
        environment.noteCapturedFrame()
        environment.noteEncodedFrame()
        cont.resume()
      }
    }
    let dump = environment.stateDump
    #expect(dump.capturedFrames == 1)
    #expect(dump.encodedFrames == 1)
  }
}
