// Records a USB-connected iPhone's screen on this Mac, as QuickTime does:
// CoreMediaIO's screen-capture devices are allowed for this process, the
// phone's muxed device (named as the phone is) feeds an AVCaptureSession, and
// the screen goes into a QuickTime movie until SIGINT or SIGTERM, which
// finishes the file. For e2e evidence of a screen that changes faster than the
// phone's driver can read it (e2e/rigs/app/screenRecording.ts).
//
//   swift e2e/rigs/app/recordIosScreen.swift "<phone name>" out.mov
//
// Prints one JSON line on stdout once the movie has its first frame:
// {"recording": <ms since 1970 when the recording started>}; and
// {"finished": true} once the file is complete. Errors go to stderr, with a
// non-zero exit.
import AVFoundation
import CoreMediaIO
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("recordIosScreen: \(message)\n".data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
if args.count != 3 { fail("usage: recordIosScreen.swift <phone name> <out.mov>") }
let name = args[1]
let out = URL(fileURLWithPath: args[2])

var address = CMIOObjectPropertyAddress(
  mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
  mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
  mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
var allow: UInt32 = 1
let status = CMIOObjectSetPropertyData(
  CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil,
  UInt32(MemoryLayout<UInt32>.size), &allow)
if status != 0 { fail("could not allow screen-capture devices (\(status))") }

// The phone's device appears a moment after screen capture is allowed; the
// main run loop has to run for it to.
var device: AVCaptureDevice?
let deadline = Date().addingTimeInterval(20)
while device == nil && Date() < deadline {
  RunLoop.main.run(until: Date().addingTimeInterval(0.5))
  device = AVCaptureDevice.DiscoverySession(
    deviceTypes: [.external], mediaType: .muxed, position: .unspecified
  ).devices.first { $0.localizedName == name }
}
guard let device else { fail("no screen-capture device named \(name)") }

let session = AVCaptureSession()
do {
  let input = try AVCaptureDeviceInput(device: device)
  guard session.canAddInput(input) else { fail("cannot capture \(name)") }
  session.addInput(input)
} catch {
  fail("cannot open \(name): \(error)")
}
let output = AVCaptureMovieFileOutput()
guard session.canAddOutput(output) else { fail("cannot record \(name)") }
session.addOutput(output)

final class Recorder: NSObject, AVCaptureFileOutputRecordingDelegate {
  func fileOutput(
    _ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL,
    from connections: [AVCaptureConnection]
  ) {
    print("{\"recording\": \(Int(Date().timeIntervalSince1970 * 1000))}")
  }

  func fileOutput(
    _ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL,
    from connections: [AVCaptureConnection], error: Error?
  ) {
    // A recording stopped on request still reports an "error" whose
    // AVErrorRecordingSuccessfullyFinishedKey is true.
    let finished =
      error == nil
      || ((error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool ?? false)
    if !finished { fail("recording failed: \(error!)") }
    print("{\"finished\": true}")
    exit(0)
  }
}

let recorder = Recorder()
try? FileManager.default.removeItem(at: out)
session.startRunning()
output.startRecording(to: out, recordingDelegate: recorder)

for sig in [SIGINT, SIGTERM] {
  signal(sig, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  source.setEventHandler { output.stopRecording() }
  source.resume()
  // Kept for the life of the process.
  _ = Unmanaged.passRetained(source)
}
RunLoop.main.run()
