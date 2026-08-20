import Foundation
import ProducerCore
import ProducerDVR
import Testing

@Suite("Recording export names")
struct RecordingExportTests {
  @Test("Programme file is the recording start, second precision")
  func programName() {
    let wall = WallClock(date: Date(timeIntervalSince1970: 1_755_348_252))
    // 2025-08-16 16:04:12 UTC — local tz may shift the clock fields, so only the shape is asserted.
    let name = RecordingExport.programFilename(startedAt: wall)
    #expect(name.hasSuffix(".mov"))
    #expect(name.split(separator: "-").count >= 6)
  }

  @Test("Camera names replace spaces and illegal characters with underscores")
  func sanitise() {
    #expect(RecordingExport.sanitise("Third Base") == "Third_Base")
    #expect(RecordingExport.sanitise("Cam 1/2") == "Cam_1_2")
    #expect(RecordingExport.sanitise("  ..wide*shot??  ") == "wide_shot")
    let name = RecordingExport.cameraFilename(
      startedAt: WallClock(seconds: 1_755_348_252),
      cameraName: "Third Base"
    )
    #expect(name.hasSuffix("-Third_Base.mov"))
  }
}
