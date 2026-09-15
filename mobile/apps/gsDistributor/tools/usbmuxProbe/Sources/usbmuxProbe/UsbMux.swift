import Darwin
import Foundation

struct UsbMuxDevice: Sendable {
  let deviceID: Int
  let serial: String
  let connectionType: String
}

enum UsbMuxError: Error, CustomStringConvertible {
  case io(String)
  case protocolError(String)
  case refused(port: UInt16, result: Int)

  var description: String {
    switch self {
    case .io(let message):
      return message
    case .protocolError(let message):
      return "usbmuxd: \(message)"
    case .refused(let port, let result):
      return "usbmuxd refused port \(port) (result \(result)): is GS Director in the foreground with its listener up?"
    }
  }
}

/// A client for usbmuxd, the daemon every Mac runs to reach attached iPhones and iPads over the
/// cable. It speaks length-prefixed XML property lists on a Unix socket: a 16-byte little-endian
/// header `{length including header, version 1, type 8 (plist), tag}`, then the plist.
///
/// `Connect` is the useful message. Once usbmuxd answers it with `Result 0`, the same socket stops
/// speaking plists and becomes a plain byte pipe to a TCP port on the device, so an app on the
/// iPad listening on loopback is reachable from the Mac without any network.
enum UsbMux {
  static let socketPath = "/var/run/usbmuxd"

  static func devices() throws -> [UsbMuxDevice] {
    let fd = try openDaemon()
    defer { close(fd) }
    let reply = try exchange([ "MessageType": "ListDevices" ], on: fd, tag: 1)
    guard let list = reply["DeviceList"] as? [[String: Any]] else {
      throw UsbMuxError.protocolError("ListDevices reply has no DeviceList")
    }
    return list.compactMap { entry in
      guard let properties = entry["Properties"] as? [String: Any],
            let deviceID = properties["DeviceID"] as? Int else { return nil }
      return UsbMuxDevice(
        deviceID: deviceID,
        serial: properties["SerialNumber"] as? String ?? "?",
        connectionType: properties["ConnectionType"] as? String ?? "?"
      )
    }
  }

  /// Returns a socket that is a byte pipe to `port` on the device.
  static func connect(deviceID: Int, port: UInt16) throws -> Int32 {
    let fd = try openDaemon()
    do {
      // usbmuxd wants the port in network byte order, carried in a plist integer.
      let reply = try exchange(
        [ "MessageType": "Connect", "DeviceID": deviceID, "PortNumber": Int(port.bigEndian) ],
        on: fd,
        tag: 2
      )
      let result = reply["Number"] as? Int ?? -1
      guard result == 0 else { throw UsbMuxError.refused(port: port, result: result) }
      return fd
    } catch {
      close(fd)
      throw error
    }
  }

  private static func openDaemon() throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw UsbMuxError.io("socket: \(String(cString: strerror(errno)))") }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let path = Array(socketPath.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: path)
      raw[path.count] = 0
    }
    let status = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard status == 0 else {
      let reason = String(cString: strerror(errno))
      close(fd)
      throw UsbMuxError.io("connect \(socketPath): \(reason)")
    }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    return fd
  }

  private static func exchange(_ message: [String: Any], on fd: Int32, tag: UInt32) throws -> [String: Any] {
    var body = message
    body["ProgName"] = "gsDistributor"
    body["ClientVersionString"] = "gsDistributor-usbmuxProbe"
    body["kLibUSBMuxVersion"] = 3
    let payload = try PropertyListSerialization.data(fromPropertyList: body, format: .xml, options: 0)

    var packet = Data()
    for field in [ UInt32(16 + payload.count), 1, 8, tag ] {
      withUnsafeBytes(of: field.littleEndian) { packet.append(contentsOf: $0) }
    }
    packet.append(payload)
    try Socket.writeAll(fd, packet)

    let header = try Socket.readExactly(fd, count: 16)
    let length = header.withUnsafeBytes {
      UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 0, as: UInt32.self))
    }
    guard length >= 16, length < 1 << 20 else {
      throw UsbMuxError.protocolError("reply length \(length)")
    }
    let reply = try Socket.readExactly(fd, count: Int(length) - 16)
    guard let plist = try PropertyListSerialization.propertyList(from: reply, format: nil)
      as? [String: Any] else {
      throw UsbMuxError.protocolError("reply is not a dictionary")
    }
    return plist
  }
}

enum Socket {
  static func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let written = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
        if written < 0 {
          if errno == EINTR { continue }
          throw UsbMuxError.io("write: \(String(cString: strerror(errno)))")
        }
        offset += written
      }
    }
  }

  static func readExactly(_ fd: Int32, count: Int) throws -> Data {
    var data = Data(count: count)
    try data.withUnsafeMutableBytes { raw in
      var offset = 0
      while offset < count {
        let got = Darwin.read(fd, raw.baseAddress! + offset, count - offset)
        if got < 0 {
          if errno == EINTR { continue }
          throw UsbMuxError.io("read: \(String(cString: strerror(errno)))")
        }
        if got == 0 { throw UsbMuxError.io("the connection closed mid-message") }
        offset += got
      }
    }
    return data
  }
}
