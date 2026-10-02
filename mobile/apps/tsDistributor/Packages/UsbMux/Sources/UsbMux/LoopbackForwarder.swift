import Darwin
import Foundation

/// Makes a port on the iPad answer on a port of this Mac's loopback, so URLSession can speak
/// HTTP to TS Director with keep-alive, ranged downloads and several connections at once.
///
/// Every accepted connection asks `connector` for its own pipe to the device, and bytes are copied
/// both ways until either side closes. It binds 127.0.0.1 only. It adds no protection of its own:
/// usbmuxd's socket is open to every process on the Mac, so anything here could reach the iPad
/// without it.
public final class LoopbackForwarder: @unchecked Sendable {
  public typealias Connector = @Sendable () throws -> Int32

  private let connector: Connector
  private let lock = NSLock()
  private var listening: Int32 = -1

  public init(connector: @escaping Connector) {
    self.connector = connector
  }

  /// Starts accepting and returns the loopback port.
  public func start() throws -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw UsbMuxError.io("socket: \(String(cString: strerror(errno)))") }
    var reuse: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr.s_addr = INADDR_LOOPBACK.bigEndian
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0, listen(fd, 16) == 0 else {
      let reason = String(cString: strerror(errno))
      close(fd)
      throw UsbMuxError.io("listen: \(reason)")
    }
    var actual = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &actual) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
    }
    lock.withLock { listening = fd }

    let connector = self.connector
    let thread = Thread {
      while true {
        let client = accept(fd, nil, nil)
        if client < 0 {
          if errno == EINTR { continue }
          return
        }
        Socket.noSigPipe(client)
        DispatchQueue.global(qos: .userInitiated).async {
          guard let remote = try? connector() else {
            close(client)
            return
          }
          Socket.noSigPipe(remote)
          Self.splice(client, remote)
        }
      }
    }
    thread.name = "loopback forwarder"
    thread.start()
    return UInt16(bigEndian: actual.sin_port)
  }

  public func stop() {
    lock.withLock {
      if listening >= 0 {
        shutdown(listening, SHUT_RDWR)
        close(listening)
        listening = -1
      }
    }
  }

  /// Copies each way on its own thread, and closes both once both directions have finished.
  static func splice(_ first: Int32, _ second: Int32) {
    let group = DispatchGroup()
    for (from, to) in [ (first, second), (second, first) ] {
      group.enter()
      Thread {
        pump(from: from, to: to)
        shutdown(to, SHUT_WR)
        group.leave()
      }.start()
    }
    group.notify(queue: .global()) {
      close(first)
      close(second)
    }
  }

  private static func pump(from: Int32, to: Int32) {
    let size = 1 << 20
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16)
    defer { buffer.deallocate() }
    while true {
      let got = read(from, buffer, size)
      if got < 0, errno == EINTR { continue }
      if got <= 0 { return }
      var offset = 0
      while offset < got {
        let sent = write(to, buffer + offset, got - offset)
        if sent < 0, errno == EINTR { continue }
        if sent <= 0 { return }
        offset += sent
      }
    }
  }
}
