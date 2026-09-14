import Darwin
import Foundation

// Measures how fast bytes cross the USB-C cable from GS Director to this Mac, through usbmuxd.
//
//   usbmuxProbe list
//   usbmuxProbe get <path> [--port 8765] [--serial <udid>]
//   usbmuxProbe throughput [--port 8765] [--bytes 128000000] [--parallel 1] [--rounds 4] [--serial <udid>]
//
// With `-uiTest true`, the Director's test harness answers `/throughput?bytes=N` on port 8765 with
// N zero bytes (at most 128 MB), each 64 KB send chained on the previous one's completion, so
// the rate is what the cable and the app's listener actually drain.

let command = CommandLine.arguments.dropFirst().first ?? "list"
let arguments = Array(CommandLine.arguments.dropFirst(2))

func option(_ name: String, default value: String) -> String {
  guard let index = arguments.firstIndex(of: "--\(name)"), index + 1 < arguments.count else {
    return value
  }
  return arguments[index + 1]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("✗ \(message)\n".utf8))
  exit(1)
}

func pickDevice() throws -> UsbMuxDevice {
  let usb = try UsbMux.devices().filter { $0.connectionType == "USB" }
  let serial = option("serial", default: "")
  if !serial.isEmpty {
    guard let device = usb.first(where: { $0.serial == serial }) else {
      fail("no device with serial \(serial) is attached over USB")
    }
    return device
  }
  guard usb.count == 1, let device = usb.first else {
    fail(usb.isEmpty ? "no device is attached over USB" : "several devices are attached over USB; pass --serial")
  }
  return device
}

do {
  switch command {
  case "list":
    for device in try UsbMux.devices() {
      print("\(device.deviceID)\t\(device.connectionType)\t\(device.serial)")
    }

  case "get":
    guard let path = arguments.first(where: { $0.hasPrefix("/") }) else {
      fail("usage: usbmuxProbe get <path>")
    }
    let port = UInt16(option("port", default: "8765")) ?? 8765
    let device = try pickDevice()
    let socket = try UsbMux.connect(deviceID: device.deviceID, port: port)
    let response = try HTTPProbe.fetch(path: path, on: socket, keepBody: true)
    print(response.status)
    print(String(decoding: response.body, as: UTF8.self))

  case "throughput":
    let port = UInt16(option("port", default: "8765")) ?? 8765
    let bytes = Int(option("bytes", default: "128000000")) ?? 128_000_000
    let parallel = max(1, Int(option("parallel", default: "1")) ?? 1)
    let rounds = max(1, Int(option("rounds", default: "4")) ?? 4)
    let device = try pickDevice()
    print("device \(device.serial) (usbmux id \(device.deviceID)), port \(port): \(parallel) connection(s) × \(rounds) round(s) × \(bytes) bytes")
    var rates: [Double] = []
    for round in 1...rounds {
      let result = try ThroughputRound.run(
        deviceID: device.deviceID,
        port: port,
        bytes: bytes,
        connections: parallel
      )
      let megabytes = Double(result.bytes) / 1_000_000
      let rate = megabytes / result.seconds
      rates.append(rate)
      print(String(format: "round %d: %.0f MB in %.3f s = %.0f MB/s", round, megabytes, result.seconds, rate))
    }
    let sorted = rates.sorted()
    print(String(format: "median %.0f MB/s, min %.0f, max %.0f", sorted[sorted.count / 2], sorted.first!, sorted.last!))

  case "fetch":
    // One real file (or any route) from GS Director's link server, counted and timed.
    guard let path = arguments.first(where: { $0.hasPrefix("/") }) else {
      fail("usage: usbmuxProbe fetch <path> [--port 8770]")
    }
    let port = UInt16(option("port", default: "8770")) ?? 8770
    let device = try pickDevice()
    let socket = try UsbMux.connect(deviceID: device.deviceID, port: port)
    let start = DispatchTime.now().uptimeNanoseconds
    let response = try HTTPProbe.fetch(path: path, on: socket, keepBody: false)
    let seconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000_000
    let megabytes = Double(response.bodyBytes) / 1_000_000
    print(String(format: "%@: %.1f MB in %.3f s = %.0f MB/s", response.status, megabytes, seconds, megabytes / seconds))

  default:
    fail("unknown command \(command); use list, get, fetch or throughput")
  }
} catch {
  fail("\(error)")
}

enum HTTPProbe {
  struct Response {
    var status: String
    var bodyBytes: Int
    var body: Data
  }

  /// Sends one GET and reads the response to its Content-Length (or to the close). With `keepBody`
  /// false the body is counted, not kept, so a 128 MB read costs one 4 MB buffer.
  static func fetch(path: String, on fd: Int32, keepBody: Bool) throws -> Response {
    defer { close(fd) }
    let request = "GET \(path) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    try Socket.writeAll(fd, Data(request.utf8))

    let capacity = 4 << 20
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 16)
    defer { buffer.deallocate() }

    var head = Data()
    var body = Data()
    var status = ""
    var contentLength: Int?
    var bodyBytes = 0
    var headerDone = false

    while true {
      if headerDone, let contentLength, bodyBytes >= contentLength { break }
      let got = Darwin.read(fd, buffer, capacity)
      if got < 0 {
        if errno == EINTR { continue }
        throw UsbMuxError.io("read: \(String(cString: strerror(errno)))")
      }
      if got == 0 { break }
      let chunk = UnsafeRawBufferPointer(start: buffer, count: got)
      if headerDone {
        bodyBytes += got
        if keepBody { body.append(contentsOf: chunk) }
        continue
      }
      head.append(contentsOf: chunk)
      guard let end = head.range(of: Data("\r\n\r\n".utf8)) else { continue }
      headerDone = true
      let lines = String(decoding: head[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
      status = lines.first ?? ""
      for line in lines.dropFirst() {
        let parts = line.split(separator: ":", maxSplits: 1)
        if parts.count == 2, parts[0].lowercased() == "content-length" {
          contentLength = Int(parts[1].trimmingCharacters(in: .whitespaces))
        }
      }
      let rest = head[end.upperBound...]
      bodyBytes += rest.count
      if keepBody { body.append(rest) }
    }

    if let contentLength, bodyBytes < contentLength {
      throw UsbMuxError.io("short body: \(bodyBytes) of \(contentLength) bytes")
    }
    return Response(status: status, bodyBytes: bodyBytes, body: body)
  }
}

enum ThroughputRound {
  /// Opens every connection first, so the timed part is only the transfer, then pulls
  /// `/throughput` on all of them at once.
  static func run(deviceID: Int, port: UInt16, bytes: Int, connections: Int) throws -> (bytes: Int, seconds: Double) {
    let sockets = try (0..<connections).map { _ in try UsbMux.connect(deviceID: deviceID, port: port) }
    let tally = Tally()
    let start = DispatchTime.now().uptimeNanoseconds
    DispatchQueue.concurrentPerform(iterations: connections) { index in
      do {
        let response = try HTTPProbe.fetch(path: "/throughput?bytes=\(bytes)", on: sockets[index], keepBody: false)
        tally.add(response.bodyBytes)
      } catch {
        tally.fail("\(error)")
      }
    }
    let seconds = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000_000
    if let error = tally.error { throw UsbMuxError.io(error) }
    return (tally.bytes, seconds)
  }
}

final class Tally: @unchecked Sendable {
  private let lock = NSLock()
  private var total = 0
  private var firstError: String?

  var bytes: Int { lock.withLock { total } }
  var error: String? { lock.withLock { firstError } }

  func add(_ count: Int) { lock.withLock { total += count } }
  func fail(_ message: String) { lock.withLock { if firstError == nil { firstError = message } } }
}
