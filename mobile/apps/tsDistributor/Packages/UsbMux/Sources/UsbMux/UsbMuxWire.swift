import Darwin
import Foundation

public enum UsbMuxError: Error, Equatable, CustomStringConvertible, Sendable {
  case io(String)
  case protocolError(String)
  case refused(port: UInt16, result: Int)

  public var description: String {
    switch self {
    case .io(let message):
      message
    case .protocolError(let message):
      "usbmuxd: \(message)"
    case .refused(let port, let result):
      "usbmuxd refused port \(port) (result \(result)): TS Director is not listening there"
    }
  }
}

public struct UsbMuxDevice: Sendable, Equatable, Hashable {
  /// usbmuxd's handle for this attachment. It changes when the cable is replugged.
  public var deviceID: Int
  /// The device's UDID, which does not.
  public var serial: String
  /// `USB` or `Network`; the same iPad can be listed once each way.
  public var connectionType: String

  public init(deviceID: Int, serial: String, connectionType: String) {
    self.deviceID = deviceID
    self.serial = serial
    self.connectionType = connectionType
  }

  public var isUSB: Bool { connectionType == "USB" }
}

public enum UsbMuxEvent: Sendable, Equatable {
  case attached(UsbMuxDevice)
  case detached(deviceID: Int)
}

/// usbmuxd's framing: a 16-byte little-endian header `{length including header, version 1,
/// type 8 (plist), tag}`, then an XML property list.
enum UsbMuxWire {
  static let headerSize = 16

  static func packet(_ message: [String: Any], tag: UInt32) throws -> Data {
    var body = message
    body["ProgName"] = "TS Distributor"
    body["ClientVersionString"] = "tsDistributor"
    body["kLibUSBMuxVersion"] = 3
    let payload = try PropertyListSerialization.data(fromPropertyList: body, format: .xml, options: 0)
    var data = Data()
    for field in [ UInt32(headerSize + payload.count), 1, 8, tag ] {
      withUnsafeBytes(of: field.littleEndian) { data.append(contentsOf: $0) }
    }
    data.append(payload)
    return data
  }

  static func payloadLength(header: Data) throws -> Int {
    guard header.count == headerSize else { throw UsbMuxError.protocolError("short header") }
    let length = header.withUnsafeBytes {
      UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: 0, as: UInt32.self))
    }
    guard length >= UInt32(headerSize), length < 1 << 20 else {
      throw UsbMuxError.protocolError("message length \(length)")
    }
    return Int(length) - headerSize
  }

  static func dictionary(_ payload: Data) throws -> [String: Any] {
    guard let plist = try PropertyListSerialization.propertyList(from: payload, format: nil) as? [String: Any]
    else { throw UsbMuxError.protocolError("message is not a dictionary") }
    return plist
  }

  static func device(from properties: [String: Any]) -> UsbMuxDevice? {
    guard let deviceID = properties["DeviceID"] as? Int else { return nil }
    return UsbMuxDevice(
      deviceID: deviceID,
      serial: properties["SerialNumber"] as? String ?? "?",
      connectionType: properties["ConnectionType"] as? String ?? "?"
    )
  }

  static func send(_ message: [String: Any], on fd: Int32, tag: UInt32) throws {
    try Socket.writeAll(fd, packet(message, tag: tag))
  }

  static func receive(on fd: Int32) throws -> [String: Any] {
    let length = try payloadLength(header: Socket.readExactly(fd, count: headerSize))
    return try dictionary(Socket.readExactly(fd, count: length))
  }
}

/// lockdownd's framing, once usbmuxd has connected to it: a 4-byte big-endian length, then an XML
/// property list.
enum LockdownWire {
  static let port: UInt16 = 62078

  static func packet(_ message: [String: Any]) throws -> Data {
    let payload = try PropertyListSerialization.data(fromPropertyList: message, format: .xml, options: 0)
    var data = Data()
    withUnsafeBytes(of: UInt32(payload.count).bigEndian) { data.append(contentsOf: $0) }
    data.append(payload)
    return data
  }

  static func receive(on fd: Int32) throws -> [String: Any] {
    let header = try Socket.readExactly(fd, count: 4)
    let length = header.withUnsafeBytes { UInt32(bigEndian: $0.loadUnaligned(as: UInt32.self)) }
    guard length > 0, length < 1 << 20 else { throw UsbMuxError.protocolError("lockdownd message length \(length)") }
    return try UsbMuxWire.dictionary(Socket.readExactly(fd, count: Int(length)))
  }
}

enum Socket {
  static func openUnix(_ path: String) throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw UsbMuxError.io("socket: \(String(cString: strerror(errno)))") }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
      close(fd)
      throw UsbMuxError.io("socket path too long: \(path)")
    }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let status = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard status == 0 else {
      let reason = String(cString: strerror(errno))
      close(fd)
      throw UsbMuxError.io("connect \(path): \(reason)")
    }
    noSigPipe(fd)
    return fd
  }

  static func noSigPipe(_ fd: Int32) {
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  }

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
        if got == 0 { throw UsbMuxError.io("usbmuxd closed the connection") }
        offset += got
      }
    }
    return data
  }
}
