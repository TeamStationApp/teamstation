// The iPhone screen over USB, the path QuickTime uses, recorded from the Mac:
//   iosScreenRecord <device name> <out.mov> <frames.csv>
// records until SIGTERM or SIGINT. frames.csv has one line per frame: its
// index, its wall-clock time in epoch ms, and its time in the movie in ms.
// Prints "recording <w>x<h>" once the first frame is in. offlineDevice.e2e.ts
// builds it with swiftc to time Confirm Swap on the iPhone, where maestro-d
// has no recording.
import AVFoundation
import CoreMediaIO
import Foundation

let args = CommandLine.arguments
guard args.count == 4 else { FileHandle.standardError.write("usage: iosScreenRecord <name> <out.mov> <frames.csv>\n".data(using: .utf8)!); exit(2) }
var prop = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
var allow: UInt32 = 1
CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
var device: AVCaptureDevice?
for _ in 0..<15 {
  device = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: nil, position: .unspecified).devices.first { $0.localizedName == args[1] }
  if device != nil { break }
  RunLoop.current.run(until: Date().addingTimeInterval(1))
}
guard let dev = device else { print("no capture device named \(args[1])"); exit(1) }
let out = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: out)
FileManager.default.createFile(atPath: args[3], contents: nil)
let csv = FileHandle(forWritingAtPath: args[3])!

final class Sink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  var writer: AVAssetWriter?
  var input: AVAssetWriterInput?
  var first: CMTime?
  var count = 0
  var stopping = false
  let clock: CMClock
  init(clock: CMClock) { self.clock = clock }
  func captureOutput(_ o: AVCaptureOutput, didOutput sb: CMSampleBuffer, from c: AVCaptureConnection) {
    if stopping { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    let nowWall = Date().timeIntervalSince1970 * 1000
    let lag = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(clock), pts)) * 1000
    if writer == nil {
      guard let fd = CMSampleBufferGetFormatDescription(sb) else { return }
      let dim = CMVideoFormatDescriptionGetDimensions(fd)
      let w = try! AVAssetWriter(outputURL: out, fileType: .mov)
      let i = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Int(dim.width), AVVideoHeightKey: Int(dim.height), AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 16_000_000]])
      i.expectsMediaDataInRealTime = true
      w.add(i); w.startWriting(); w.startSession(atSourceTime: pts)
      writer = w; input = i; first = pts
      print("recording \(dim.width)x\(dim.height)"); fflush(stdout)
    }
    guard let i = input, i.isReadyForMoreMediaData else { return }
    if i.append(sb) {
      csv.write("\(count),\(String(format: "%.1f", nowWall - lag)),\(String(format: "%.1f", CMTimeGetSeconds(CMTimeSubtract(pts, first!)) * 1000))\n".data(using: .utf8)!)
      count += 1
    }
  }
}
let session = AVCaptureSession()
let input = try AVCaptureDeviceInput(device: dev)
session.addInput(input)
let output = AVCaptureVideoDataOutput()
output.alwaysDiscardsLateVideoFrames = false
let queue = DispatchQueue(label: "frames")
let sink = Sink(clock: session.synchronizationClock ?? CMClockGetHostTimeClock())
output.setSampleBufferDelegate(sink, queue: queue)
session.addOutput(output)
session.startRunning()
func finish() {
  queue.sync { sink.stopping = true }
  session.stopRunning()
  guard let w = sink.writer else { print("no frames"); exit(1) }
  sink.input?.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  w.finishWriting { done.signal() }
  done.wait()
  print("stopped \(sink.count) frames"); fflush(stdout)
  exit(w.status == .completed ? 0 : 1)
}
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let t = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main); t.setEventHandler(handler: finish); t.resume()
let n = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main); n.setEventHandler(handler: finish); n.resume()
dispatchMain()
