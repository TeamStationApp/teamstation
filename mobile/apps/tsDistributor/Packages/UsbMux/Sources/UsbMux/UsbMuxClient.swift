import Darwin
import Foundation

/// A client for usbmuxd, the daemon every Mac runs to reach attached iPhones and iPads.
///
/// `connect` is the point of it: once usbmuxd answers `Connect` with `Result 0`, the socket stops
/// speaking usbmuxd and becomes a plain byte pipe to a TCP port on the device, so TS Director's
/// loopback listener is reachable over the cable without any network.
public struct UsbMuxClient: Sendable {
  public var socketPath: String

  public init(socketPath: String = "/var/run/usbmuxd") {
    self.socketPath = socketPath
  }

  public func devices() throws -> [UsbMuxDevice] {
    let fd = try Socket.openUnix(socketPath)
    defer { close(fd) }
    try UsbMuxWire.send([ "MessageType": "ListDevices" ], on: fd, tag: 1)
    let reply = try UsbMuxWire.receive(on: fd)
    guard let list = reply["DeviceList"] as? [[String: Any]] else {
      throw UsbMuxError.protocolError("ListDevices reply has no DeviceList")
    }
    return list.compactMap { ($0["Properties"] as? [String: Any]).flatMap(UsbMuxWire.device(from:)) }
  }

  /// A socket that is a byte pipe to `port` on the device. The caller closes it.
  public func connect(deviceID: Int, port: UInt16) throws -> Int32 {
    let fd = try Socket.openUnix(socketPath)
    do {
      // The port travels in network byte order inside a plist integer.
      try UsbMuxWire.send(
        [ "MessageType": "Connect", "DeviceID": deviceID, "PortNumber": Int(port.bigEndian) ],
        on: fd,
        tag: 2
      )
      let reply = try UsbMuxWire.receive(on: fd)
      let result = reply["Number"] as? Int ?? -1
      guard result == 0 else { throw UsbMuxError.refused(port: port, result: result) }
      return fd
    } catch {
      close(fd)
      throw error
    }
  }

  /// The name the owner gave the device, asked of lockdownd over the cable. iPadOS tells apps only
  /// the model ("iPad"), so TS Director cannot say it itself. This question needs no pairing.
  public func deviceName(deviceID: Int) throws -> String? {
    try lockdownValues(deviceID: deviceID, keys: [ "DeviceName" ])["DeviceName"]
  }

  /// What the owner calls the device and what it is ("iPad", "iPhone"), asked of lockdownd in one
  /// visit. Neither question needs pairing.
  public func identity(deviceID: Int) throws -> (name: String?, deviceClass: String?) {
    let values = try lockdownValues(deviceID: deviceID, keys: [ "DeviceName", "DeviceClass" ])
    return (values["DeviceName"], values["DeviceClass"])
  }

  private func lockdownValues(deviceID: Int, keys: [String]) throws -> [String: String] {
    let fd = try connect(deviceID: deviceID, port: LockdownWire.port)
    defer { close(fd) }
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var values: [String: String] = [:]
    for key in keys {
      try Socket.writeAll(fd, LockdownWire.packet([ "Label": "TS Distributor", "Request": "GetValue", "Key": key ]))
      values[key] = try LockdownWire.receive(on: fd)["Value"] as? String
    }
    return values
  }

  /// Devices as they are plugged in and pulled out, starting with those already attached.
  /// Ends when the consumer stops listening.
  public func events() -> AsyncThrowingStream<UsbMuxEvent, Error> {
    let path = socketPath
    return AsyncThrowingStream { continuation in
      let listening = Listening()
      continuation.onTermination = { _ in listening.cancel() }
      let thread = Thread {
        do {
          let fd = try Socket.openUnix(path)
          guard listening.adopt(fd) else { return }
          try UsbMuxWire.send([ "MessageType": "Listen" ], on: fd, tag: 1)
          let reply = try UsbMuxWire.receive(on: fd)
          guard reply["Number"] as? Int == 0 else { throw UsbMuxError.protocolError("Listen was refused") }
          while true {
            let message = try UsbMuxWire.receive(on: fd)
            switch message["MessageType"] as? String {
            case "Attached":
              if let properties = message["Properties"] as? [String: Any],
                 let device = UsbMuxWire.device(from: properties) {
                continuation.yield(.attached(device))
              }
            case "Detached":
              if let deviceID = message["DeviceID"] as? Int {
                continuation.yield(.detached(deviceID: deviceID))
              }
            default:
              break
            }
          }
        } catch {
          if listening.isCancelled {
            continuation.finish()
          } else {
            continuation.finish(throwing: error)
          }
        }
      }
      thread.name = "usbmuxd listen"
      thread.start()
    }
  }
}

/// The Listen socket, so stopping the stream can close it and unblock the reading thread.
private final class Listening: @unchecked Sendable {
  private let lock = NSLock()
  private var fd: Int32 = -1
  private var cancelled = false

  var isCancelled: Bool { lock.withLock { cancelled } }

  /// Takes ownership of `fd`, or closes it and says no when the stream already ended.
  func adopt(_ descriptor: Int32) -> Bool {
    lock.withLock {
      guard !cancelled else {
        close(descriptor)
        return false
      }
      fd = descriptor
      return true
    }
  }

  func cancel() {
    lock.withLock {
      cancelled = true
      if fd >= 0 {
        shutdown(fd, SHUT_RDWR)
        close(fd)
        fd = -1
      }
    }
  }
}
