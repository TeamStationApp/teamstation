// The iPhone screen over USB, the path QuickTime uses, recorded from the Mac:
//   iosScreenRecord <device name>
// opens the phone's screen capture and prints "ready <w>x<h>" once frames
// come. Opening it moves the phone's USB to another configuration, which
// drops every connection to the phone open at that moment (the UI driver's
// among them), so it is opened once, before the driver connects, and kept
// open until stdin closes, SIGTERM or SIGINT. On stdin:
//   start <out.mov> <frames.csv>  records from the next frame ("recording")
//   stop                          ends that movie ("stopped <frames>")
// frames.csv has one line per frame: its index, its wall-clock time in epoch
// ms (its capture time on this Mac's clock), and its time in the movie in ms.
// offlineDevice.e2e.ts builds it with swiftc to time Confirm Swap on the
// iPhone, where maestro-d has no recording.
import AVFoundation
import CoreMediaIO
import Foundation

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("usage: iosScreenRecord <device name>\n".data(using: .utf8)!)
  exit(2)
}
var prop = CMIOObjectPropertyAddress(
  mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
  mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
  mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
var allow: UInt32 = 1
CMIOObjectSetPropertyData(
  CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
var device: AVCaptureDevice?
for _ in 0..<20 {
  device = AVCaptureDevice.DiscoverySession(
    deviceTypes: [.external], mediaType: nil, position: .unspecified
  ).devices.first { $0.localizedName == args[1] }
  if device != nil { break }
  RunLoop.current.run(until: Date().addingTimeInterval(1))
}
guard let dev = device else {
  print("no capture device named \(args[1])")
  exit(1)
}

func say(_ line: String) {
  print(line)
  fflush(stdout)
}

/** One movie being written: from `start` to `stop`. */
final class Movie {
  let writer: AVAssetWriter
  let input: AVAssetWriterInput
  let csv: FileHandle
  var first: CMTime?
  var count = 0
  init(movie: String, frames: String, width: Int32, height: Int32) throws {
    let url = URL(fileURLWithPath: movie)
    try? FileManager.default.removeItem(at: url)
    FileManager.default.createFile(atPath: frames, contents: nil)
    csv = FileHandle(forWritingAtPath: frames)!
    writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    input = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: Int(width),
        AVVideoHeightKey: Int(height),
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 16_000_000],
      ])
    input.expectsMediaDataInRealTime = true
    writer.add(input)
    writer.startWriting()
  }
}

final class Sink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let clock: CMClock
  var size: (Int32, Int32)?
  var movie: Movie?
  init(clock: CMClock) { self.clock = clock }
  func captureOutput(
    _ o: AVCaptureOutput, didOutput sb: CMSampleBuffer, from c: AVCaptureConnection
  ) {
    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    let nowWall = Date().timeIntervalSince1970 * 1000
    let lag = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(clock), pts)) * 1000
    if size == nil, let fd = CMSampleBufferGetFormatDescription(sb) {
      let dim = CMVideoFormatDescriptionGetDimensions(fd)
      size = (dim.width, dim.height)
      say("ready \(dim.width)x\(dim.height)")
    }
    guard let m = movie else { return }
    if m.first == nil {
      m.writer.startSession(atSourceTime: pts)
      m.first = pts
      say("recording")
    }
    guard m.input.isReadyForMoreMediaData, m.input.append(sb) else { return }
    let at = CMTimeGetSeconds(CMTimeSubtract(pts, m.first!)) * 1000
    m.csv.write(
      "\(m.count),\(String(format: "%.1f", nowWall - lag)),\(String(format: "%.1f", at))\n"
        .data(using: .utf8)!)
    m.count += 1
  }
}

let session = AVCaptureSession()
session.addInput(try AVCaptureDeviceInput(device: dev))
let output = AVCaptureVideoDataOutput()
output.alwaysDiscardsLateVideoFrames = false
let queue = DispatchQueue(label: "frames")
let sink = Sink(clock: session.synchronizationClock ?? CMClockGetHostTimeClock())
output.setSampleBufferDelegate(sink, queue: queue)
session.addOutput(output)
session.startRunning()

/** Ends the movie being written, if there is one, and says how many frames. */
func stopMovie() {
  var ending: Movie?
  queue.sync {
    ending = sink.movie
    sink.movie = nil
  }
  guard let m = ending else { return }
  m.input.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  m.writer.finishWriting { done.signal() }
  done.wait()
  say("stopped \(m.count)")
}

func finish() {
  stopMovie()
  session.stopRunning()
  exit(0)
}

Thread {
  while let line = readLine() {
    let words = line.split(separator: " ", maxSplits: 2).map(String.init)
    if words.first == "start", words.count == 3 {
      var size: (Int32, Int32)?
      queue.sync { size = sink.size }
      guard let (w, h) = size else {
        say("error no frames yet")
        continue
      }
      do {
        let m = try Movie(movie: words[1], frames: words[2], width: w, height: h)
        queue.sync { sink.movie = m }
      } catch {
        say("error \(error)")
      }
    } else if words.first == "stop" {
      stopMovie()
    }
  }
  DispatchQueue.main.async { finish() }
}.start()
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let t = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
t.setEventHandler(handler: finish)
t.resume()
let n = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
n.setEventHandler(handler: finish)
n.resume()
dispatchMain()
