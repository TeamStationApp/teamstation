import DistributorWire
import Foundation
import IOKit
import UsbMux

/// Finds iPads on the cable and reaches TS Director on them.
public struct DirectorLocator: Sendable {
  public enum Presence: Sendable, Equatable {
    /// TS Director answered.
    case running(Hello)
    /// The iPad is there but nothing listens on the Director's port: the app is closed or in the
    /// background.
    case notRunning
  }

  private let usbmux: UsbMuxClient
  private let port: UInt16

  public init(usbmux: UsbMuxClient = UsbMuxClient(), port: UInt16 = DistributorProtocol.port) {
    self.usbmux = usbmux
    self.port = port
  }

  /// iPads attached by cable. The same iPad may also be listed over the network; that listing is
  /// left out, since only the cable is fast.
  public func attachedDevices() throws -> [UsbMuxDevice] {
    try usbmux.devices().filter(\.isUSB)
  }

  public func events() -> AsyncThrowingStream<UsbMuxEvent, Error> {
    usbmux.events()
  }

  /// Opens a forwarder to TS Director on `device` and says hello through it. On success the caller
  /// owns the forwarder and stops it when done with the connection.
  public func open(_ device: UsbMuxDevice, macID: String) async throws -> (DirectorConnection, LoopbackForwarder, Presence) {
    // A refused Connect means nothing is listening; say so before starting a forwarder for it.
    do {
      close(try usbmux.connect(deviceID: device.deviceID, port: port))
    } catch UsbMuxError.refused {
      throw LocatorError.notRunning
    }
    let usbmux = self.usbmux
    let port = self.port
    let forwarder = LoopbackForwarder { try usbmux.connect(deviceID: device.deviceID, port: port) }
    let local = try forwarder.start()
    let connection = DirectorConnection(
      baseURL: URL(string: "http://127.0.0.1:\(local)/")!,
      macID: macID
    )
    do {
      let hello = try await connection.hello()
      return (connection, forwarder, .running(hello))
    } catch {
      forwarder.stop()
      throw error
    }
  }

  public enum LocatorError: Error, Equatable, Sendable {
    case notRunning
  }
}

/// This Mac, as the iPad knows it.
public enum MacIdentity {
  /// The hardware UUID (`IOPlatformUUID`). Read from the machine each time, never stored.
  public static var platformUUID: String {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
    defer { IOObjectRelease(service) }
    guard service != 0,
          let value = IORegistryEntryCreateCFProperty(service, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? String
    else { return "unknown-mac" }
    return value
  }
}
