import CNDIMac
import Foundation

/// A farm of fake NDI cameras, for testing GS Director's NDI receive path.
///
/// NDI Test Patterns from ndi.video/tools already publishes NDI streams, and it is worth keeping
/// as a third-party interop control. It is not a test rig: it cannot burn in a stopwatch, drop a
/// frame on command, change resolution mid-stream, or send a frame with a stride shorter than its
/// own row — which is most of what the receive path has to be proved against.
///
/// NDI® is a registered trademark of Vizrt NDI AB.

struct Options {
  var count = 4
  var width = 1920
  var height = 1080
  var frameRate: Double = 30
  var namePrefix = "GS NDI"
  var controlPort: UInt16 = 8770
  var selfTest = false
  /// Receive one source instead of sending, to separate a sender's stream from the app's handling.
  var receive: String?
  var receiveLowest = false
  var receiveTally = false
  var receiveURL: String?
  var receiveExtraIPs: String?
  var seconds: Double?
  /// SpeedHQ bitrate as a percentage of the codec's default, written into an NDI config file
  /// before the library starts. 100 is the default.
  var quality: Int?
}

func usage() -> String {
  """
  Usage: gsNdiCameras [options]

    --count N            How many cameras to publish (default 4)
    --width N            Picture width (default 1920)
    --height N           Picture height (default 1080)
    --fps N              Frame rate (default 30; use 60 for the 60 fps runs)
    --name-prefix S      Sender name prefix (default "GS NDI"); cameras are "<prefix> 1"...
    --control-port N     Loopback HTTP fault port (default 8770; 0 disables)
    --seconds N          Run for N seconds and exit, instead of until interrupted
    --quality N          SpeedHQ bitrate as a percentage of default (100 = default). Measured:
                         1080p60 is 58 Mbps at 100 and 19 at 15, then floors near 13.6.
                         1080p30 floors near 12.2. SpeedHQ cannot reach 8 Mbps at 1080p.
    --self-test          Render one frame, read its marker back, and exit

  Faults, all on http://127.0.0.1:<control-port>:

    /fault?cam=1&drop=0.05      drop 5% of frames
    /fault?cam=1&burst=30       drop 30 consecutive frames
    /fault?cam=1&stall=8        send nothing for 8 seconds
    /fault?cam=1&jitter=120     randomise send timing up to 120 ms
    /fault?cam=1&fps=60         change frame rate mid-stream
    /fault?cam=1&size=1280x720  change resolution mid-stream
    /fault?cam=1&size=3840x2160 send 4K, which the app must refuse
    /fault?cam=1&fourcc=PA16    send an unhandled pixel format
    /fault?cam=1&badstride=1    stride shorter than the row
    /fault?cam=1&badrate=1      zero frame-rate denominator
    /fault?cam=1&timecode=back  timestamps that step backwards
    /fault?cam=1&metadata=malformed
    /fault?cam=1&audio=off      video only
    /fault?cam=1&channels=6     six-channel audio
    /fault?cam=1&samplerate=44100
    /fault?cam=1&kill=1         destroy the sender; revive=1 brings it back
    /fault?cam=1&rename=NEW     rename, which changes the camera's NDI identity
    /fault?reset=1              clear every fault on every camera
    /clock                      what the generator has actually sent

  Network-level impairment (loss, delay, bandwidth) is a separate tool:
  gsDirector/scripts/ndiImpair.sh, which works below NDI's own retransmission.
  """
}

func parseOptions(_ argv: [String]) -> Options {
  var options = Options()
  var index = 0
  while index < argv.count {
    let argument = argv[index]
    func value() -> String? {
      index += 1
      return index < argv.count ? argv[index] : nil
    }
    switch argument {
    case "--help", "-h":
      print(usage())
      exit(0)
    case "--count": options.count = value().flatMap(Int.init) ?? options.count
    case "--width": options.width = value().flatMap(Int.init) ?? options.width
    case "--height": options.height = value().flatMap(Int.init) ?? options.height
    case "--fps": options.frameRate = value().flatMap(Double.init) ?? options.frameRate
    case "--name-prefix": options.namePrefix = value() ?? options.namePrefix
    case "--control-port": options.controlPort = value().flatMap(UInt16.init) ?? options.controlPort
    case "--seconds": options.seconds = value().flatMap(Double.init)
    case "--self-test": options.selfTest = true
    case "--receive": options.receive = value()
    case "--receive-lowest": options.receiveLowest = true
    case "--receive-tally": options.receiveTally = true
    case "--receive-url": options.receiveURL = value()
    case "--extra-ips": options.receiveExtraIPs = value()
    case "--quality": options.quality = value().flatMap(Int.init)
    default:
      FileHandle.standardError.write(Data("unknown argument: \(argument)\n".utf8))
      print(usage())
      exit(2)
    }
    index += 1
  }
  return options
}

/// Renders frames and reads their markers back.
///
/// This runs before anything is blamed on the app. If the generator's own picture does not carry
/// the frame number it claims, every downstream assertion built on that marker is meaningless, and
/// a failure here is far cheaper to read than the same failure discovered inside a decoded archive.
func runSelfTest(_ options: Options) -> Int32 {
  guard let pattern = TestPattern(
    width: options.width,
    height: options.height,
    frameRate: options.frameRate,
    name: "SELF TEST",
    paletteIndex: 0
  ) else {
    print("self-test FAILED: could not create a \(options.width)x\(options.height) context")
    return 1
  }
  defer { pattern.release() }

  var failures = 0

  // The marker has to read back as the frame number it was drawn for, or every assertion made
  // downstream against a decoded archive is meaningless.
  for id: UInt64 in [ 0, 1, 29, 30, 12_345, 1_048_575 ] {
    pattern.render(frameID: id, seconds: Double(id) / options.frameRate)
    let read = FrameMarker.read(bgra: pattern.pixels, bytesPerRow: options.width * 4)
    if read == Int(id) {
      print("  frame \(id): marker reads \(read!) ✓")
    } else {
      print("  frame \(id): marker reads \(read.map(String.init) ?? "nothing") ✗")
      failures += 1
    }
  }

  // How long a frame takes to draw. The generator being the bottleneck looks exactly like the app
  // being the bottleneck when seen from the app's side, so it is measured here rather than
  // guessed at there.
  let benchFrames = 120
  let renderStarted = Date()
  for id in 0 ..< benchFrames {
    pattern.render(frameID: UInt64(id), seconds: Double(id) / options.frameRate)
  }
  let perFrame = Date().timeIntervalSince(renderStarted) / Double(benchFrames) * 1_000
  let interval = 1_000 / options.frameRate
  print(String(
    format: "  render: %.2f ms/frame of %.1f ms available at %g fps — %@",
    perFrame, interval, options.frameRate, perFrame < interval ? "ok" : "TOO SLOW"
  ))
  if perFrame >= interval { failures += 1 }

  // And whether the schedule holds, on a thread of the priority the camera loops use. This is the
  // check that would have caught the frame period being 87 ms while every other number looked
  // healthy.
  let samples = 60
  final class PaceResult: @unchecked Sendable {
    var total = 0.0
    var worst = 0.0
  }
  let result = PaceResult()
  let paceThread = Thread {
    var pacer = FramePacer()
    for _ in 0 ..< samples {
      let slept = pacer.wait(interval: 1 / options.frameRate) * 1_000
      result.total += slept
      result.worst = max(result.worst, slept)
    }
  }
  paceThread.qualityOfService = .userInitiated
  paceThread.start()
  while !paceThread.isFinished { usleep(20_000) }
  let paceMean = result.total / Double(samples)
  print(String(
    format: "  pacing: mean %.2f ms, worst %.2f ms for a %.2f ms interval — %@",
    paceMean, result.worst, interval, paceMean < interval * 1.1 ? "ok" : "TOO SLOW"
  ))
  if paceMean >= interval * 1.1 { failures += 1 }

  guard NDIlib_initialize() else {
    print("self-test FAILED: NDIlib_initialize returned false")
    return 1
  }
  print("  NDI: \(String(cString: NDIlib_version()))")
  NDIlib_destroy()

  if failures == 0 {
    print("self-test PASSED")
    return 0
  }
  print("self-test FAILED: \(failures) check(s)")
  return 1
}

let options = parseOptions(Array(CommandLine.arguments.dropFirst()))

/// Writes an NDI configuration file and points the library at it, before anything initialises it.
///
/// The SDK documentation says the codec quality setting is Advanced-SDK only. Measured here, the
/// free SDK honours it: one 1080p60 camera went from 58.4 Mbps at the default to 18.8 at 15. It
/// does not go arbitrarily low — below about 8 the bitrate floors near 13.6 Mbps at 1080p60 and
/// 12.2 at 1080p30, which is SpeedHQ's floor for this content rather than the setting being
/// ignored. An 8 Mbps 1080p stream is an NDI|HX operating point, and NDI|HX cannot be sent with
/// the free SDK at all.
func applyQuality(_ quality: Int) {
  let directory = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("gs-ndi-config")
  try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  let json = "{ \"ndi\": { \"codec\": { \"shq\": { \"quality\": \(quality), \"mode\": \"4:2:0\" } } } }"
  try? json.write(
    to: directory.appendingPathComponent("ndi-config.v1.json"),
    atomically: true,
    encoding: .utf8
  )
  setenv("NDI_CONFIG_DIR", directory.path, 1)
  print("SpeedHQ quality \(quality)% via \(directory.path)")
}

if let quality = options.quality { applyQuality(quality) }

if let fragment = options.receive {
  exit(runReceive(
    nameFragment: fragment,
    seconds: options.seconds ?? 10,
    lowest: options.receiveLowest,
    tally: options.receiveTally,
    url: options.receiveURL,
    extraIPs: options.receiveExtraIPs
  ))
}

if options.selfTest {
  exit(runSelfTest(options))
}

guard NDIlib_initialize() else {
  FileHandle.standardError.write(Data("NDIlib_initialize failed\n".utf8))
  exit(1)
}

let cameras = (0 ..< options.count).map { index in
  FakeCamera(
    index: index,
    name: "\(options.namePrefix) \(index + 1)",
    width: options.width,
    height: options.height,
    frameRate: options.frameRate
  )
}

for camera in cameras { camera.start() }
print("Publishing \(cameras.count) NDI cameras at \(options.width)x\(options.height) @ \(options.frameRate) fps")
for camera in cameras { print("  \(camera.name)") }

var control: ControlServer?
if options.controlPort != 0 {
  control = ControlServer(port: options.controlPort, cameras: cameras)
  do {
    try control?.start()
    print("Fault control on http://127.0.0.1:\(options.controlPort)")
  } catch {
    FileHandle.standardError.write(Data("control server failed: \(error)\n".utf8))
  }
}

// A signal handler rather than a trap: senders have to be destroyed for the sources to leave
// discovery promptly, and a killed process leaves them advertised until they time out — which
// looks exactly like the bug the reconnect tests are trying to find.
let shutdown: @convention(c) (Int32) -> Void = { _ in
  Shutdown.request()
}
signal(SIGINT, shutdown)
signal(SIGTERM, shutdown)

enum Shutdown {
  nonisolated(unsafe) static var requested = false
  static func request() { requested = true }
}

let deadline = options.seconds.map { Date().addingTimeInterval($0) }
while !Shutdown.requested {
  if let deadline, Date() >= deadline { break }
  Thread.sleep(forTimeInterval: 0.2)
}

print("Stopping")
control?.stop()
for camera in cameras { camera.stop() }
NDIlib_destroy()
