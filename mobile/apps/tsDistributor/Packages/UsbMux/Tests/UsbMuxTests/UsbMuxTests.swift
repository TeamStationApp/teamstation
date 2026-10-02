import Darwin
import Foundation
import Testing
@testable import UsbMux

@Suite("usbmuxd framing")
struct UsbMuxWireTests {
  @Test("A message is a 16-byte little-endian header and an XML plist")
  func framing() throws {
    let packet = try UsbMuxWire.packet([ "MessageType": "Connect", "DeviceID": 7, "PortNumber": 0x3222 ], tag: 5)
    let fields = (0..<4).map { index in
      packet.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: index * 4, as: UInt32.self)) }
    }
    #expect(fields[0] == UInt32(packet.count))
    #expect(fields[1] == 1)
    #expect(fields[2] == 8)
    #expect(fields[3] == 5)
    let length = try UsbMuxWire.payloadLength(header: packet.prefix(16))
    let body = try UsbMuxWire.dictionary(packet.dropFirst(16).prefix(length))
    #expect(body["MessageType"] as? String == "Connect")
    #expect(body["DeviceID"] as? Int == 7)
    #expect(body["kLibUSBMuxVersion"] as? Int == 3)
  }

  @Test("Nonsense lengths are refused")
  func badLengths() {
    var header = Data(count: 16)
    #expect(throws: UsbMuxError.self) { try UsbMuxWire.payloadLength(header: header) }
    header.withUnsafeMutableBytes { $0.storeBytes(of: UInt32(1 << 21).littleEndian, as: UInt32.self) }
    #expect(throws: UsbMuxError.self) { try UsbMuxWire.payloadLength(header: header) }
  }
}

/// A stand-in usbmuxd on a Unix socket: two devices, TS Director listening on 8770 only, and
/// an echo on the far side of a successful Connect.
final class FakeUsbMuxd: @unchecked Sendable {
  let path: String
  private let fd: Int32

  init() throws {
    path = "/tmp/tsd-mux-\(UInt32.random(in: 0...UInt32.max)).sock"
    unlink(path)
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard bound == 0, listen(fd, 8) == 0 else { throw UsbMuxError.io("fake usbmuxd could not listen") }
    let listener = fd
    Thread {
      while true {
        let client = accept(listener, nil, nil)
        guard client >= 0 else { return }
        Thread { FakeUsbMuxd.serve(client) }.start()
      }
    }.start()
  }

  func stop() {
    shutdown(fd, SHUT_RDWR)
    close(fd)
    unlink(path)
  }

  private static var devices: [[String: Any]] { [
    [ "DeviceID": 396, "MessageType": "Attached",
      "Properties": [ "DeviceID": 396, "SerialNumber": "11111111-1111111111111111", "ConnectionType": "USB" ] ],
    [ "DeviceID": 12, "MessageType": "Attached",
      "Properties": [ "DeviceID": 12, "SerialNumber": "33333333-3333333333333333", "ConnectionType": "Network" ] ]
  ] }

  private static func serve(_ client: Int32) {
    defer { close(client) }
    guard let request = try? UsbMuxWire.receive(on: client) else { return }
    switch request["MessageType"] as? String {
    case "ListDevices":
      try? UsbMuxWire.send([ "DeviceList": devices ], on: client, tag: 1)
    case "Connect":
      let port = UInt16(bigEndian: UInt16(truncatingIfNeeded: request["PortNumber"] as? Int ?? 0))
      guard port == 8770 || port == LockdownWire.port else {
        try? UsbMuxWire.send([ "MessageType": "Result", "Number": 3 ], on: client, tag: 2)
        return
      }
      try? UsbMuxWire.send([ "MessageType": "Result", "Number": 0 ], on: client, tag: 2)
      if port == LockdownWire.port {
        // lockdownd: answers GetValue for the name and the class, as an iPad does without pairing,
        // one question after another on the same connection.
        let values = [ "DeviceName": "Bench iPad", "DeviceClass": "iPad" ]
        while let question = try? LockdownWire.receive(on: client),
              question["Request"] as? String == "GetValue",
              let key = question["Key"] as? String, let value = values[key],
              let answer = try? LockdownWire.packet([ "Key": key, "Value": value, "Request": "GetValue" ]) {
          try? Socket.writeAll(client, answer)
        }
        return
      }
      var buffer = [UInt8](repeating: 0, count: 1 << 16)
      while true {
        let got = read(client, &buffer, buffer.count)
        if got <= 0 { return }
        _ = buffer.withUnsafeBufferPointer { write(client, $0.baseAddress!, got) }
      }
    case "Listen":
      try? UsbMuxWire.send([ "MessageType": "Result", "Number": 0 ], on: client, tag: 1)
      try? UsbMuxWire.send(devices[0], on: client, tag: 0)
      try? UsbMuxWire.send([ "MessageType": "Detached", "DeviceID": 396 ], on: client, tag: 0)
      var byte: UInt8 = 0
      _ = read(client, &byte, 1)
    default:
      return
    }
  }
}

@Suite("usbmuxd client", .serialized)
struct UsbMuxClientTests {
  @Test("Devices are listed with their serials and how they are attached")
  func listsDevices() throws {
    let daemon = try FakeUsbMuxd()
    defer { daemon.stop() }
    let devices = try UsbMuxClient(socketPath: daemon.path).devices()
    #expect(devices.count == 2)
    #expect(devices.first { $0.isUSB }?.serial == "11111111-1111111111111111")
    #expect(devices.first { !$0.isUSB }?.deviceID == 12)
  }

  @Test("Connect gives a byte pipe to the port, and a port nothing listens on is refused")
  func connects() throws {
    let daemon = try FakeUsbMuxd()
    defer { daemon.stop() }
    let client = UsbMuxClient(socketPath: daemon.path)
    let fd = try client.connect(deviceID: 396, port: 8770)
    defer { close(fd) }
    try Socket.writeAll(fd, Data("ping".utf8))
    #expect(try Socket.readExactly(fd, count: 4) == Data("ping".utf8))

    #expect(throws: UsbMuxError.refused(port: 8765, result: 3)) {
      _ = try client.connect(deviceID: 396, port: 8765)
    }
  }

  @Test("The iPad's own name comes from lockdownd over the cable")
  func deviceName() throws {
    let daemon = try FakeUsbMuxd()
    defer { daemon.stop() }
    #expect(try UsbMuxClient(socketPath: daemon.path).deviceName(deviceID: 396) == "Bench iPad")
  }

  @Test("The name and whether it is an iPad come from lockdownd in one visit")
  func identity() throws {
    let daemon = try FakeUsbMuxd()
    defer { daemon.stop() }
    let identity = try UsbMuxClient(socketPath: daemon.path).identity(deviceID: 396)
    #expect(identity.name == "Bench iPad")
    #expect(identity.deviceClass == "iPad")
  }

  @Test("Plugging in and pulling out arrive as events")
  func listens() async throws {
    let daemon = try FakeUsbMuxd()
    defer { daemon.stop() }
    var events = UsbMuxClient(socketPath: daemon.path).events().makeAsyncIterator()
    let first = try await events.next()
    let second = try await events.next()
    #expect(first == .attached(UsbMuxDevice(deviceID: 396, serial: "11111111-1111111111111111", connectionType: "USB")))
    #expect(second == .detached(deviceID: 396))
  }
}

@Suite("Loopback forwarder", .serialized)
struct LoopbackForwarderTests {
  /// An echo server on loopback, standing in for the iPad's far end.
  private func echoServer() throws -> (port: UInt16, stop: @Sendable () -> Void) {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = INADDR_LOOPBACK.bigEndian
    _ = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    listen(fd, 8)
    var actual = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &actual) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
    }
    Thread {
      while true {
        let client = accept(fd, nil, nil)
        guard client >= 0 else { return }
        Thread {
          var buffer = [UInt8](repeating: 0, count: 1 << 16)
          while true {
            let got = read(client, &buffer, buffer.count)
            if got <= 0 { break }
            var offset = 0
            while offset < got {
              let sent = buffer.withUnsafeBufferPointer { write(client, $0.baseAddress! + offset, got - offset) }
              if sent <= 0 { break }
              offset += sent
            }
          }
          close(client)
        }.start()
      }
    }.start()
    return (UInt16(bigEndian: actual.sin_port), { shutdown(fd, SHUT_RDWR); close(fd) })
  }

  private static func connectTCP(_ port: UInt16) throws -> Int32 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr.s_addr = INADDR_LOOPBACK.bigEndian
    let status = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard status == 0 else {
      close(fd)
      throw UsbMuxError.io("connect \(port)")
    }
    return fd
  }

  @Test("Bytes cross the forwarder both ways, unchanged, 32 MB of them")
  func forwardsExactly() throws {
    let echo = try echoServer()
    defer { echo.stop() }
    let forwarder = LoopbackForwarder { try Self.connectTCP(echo.port) }
    let port = try forwarder.start()
    defer { forwarder.stop() }

    let size = 32 << 20
    let payload = Data((0..<size).map { UInt8(truncatingIfNeeded: $0 &* 131 &+ $0 >> 11) })
    let fd = try Self.connectTCP(port)
    defer { close(fd) }
    Thread { try? Socket.writeAll(fd, payload) }.start()
    let received = try Socket.readExactly(fd, count: size)
    #expect(received == payload)
  }

  @Test("A connection the device refuses is closed rather than left hanging")
  func refusedConnectionCloses() throws {
    let forwarder = LoopbackForwarder { throw UsbMuxError.refused(port: 8770, result: 3) }
    let port = try forwarder.start()
    defer { forwarder.stop() }
    let fd = try Self.connectTCP(port)
    defer { close(fd) }
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var byte: UInt8 = 0
    #expect(read(fd, &byte, 1) == 0)
  }
}
