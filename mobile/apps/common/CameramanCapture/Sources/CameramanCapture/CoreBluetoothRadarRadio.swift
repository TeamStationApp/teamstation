import CoreBluetooth
import Foundation

/// `RadarRadio` on CoreBluetooth: one central on the main queue, connected to at most one TAG One.
///
/// Only the delegate plumbing lives here; what to scan for, when to connect and what the bytes
/// mean is decided in `RadarSession` and `RadarFleet`. Creating it brings the central up, which is
/// what asks for the Bluetooth permission, so the owners create one only once the radar is on.
@MainActor
public final class CoreBluetoothRadarRadio: NSObject, RadarRadio {
  public weak var listener: RadarRadioListener?
  public private(set) var power: RadarPower = .unknown

  private var central: CBCentralManager?
  private var discovered: [String: CBPeripheral] = [:]
  private var peripheral: CBPeripheral?
  private var writeCharacteristic: CBCharacteristic?
  private var didReport = false

  override public init() {
    super.init()
    central = CBCentralManager(delegate: self, queue: .main)
  }

  public func startScan() {
    guard central?.state == .poweredOn else { return }
    central?.scanForPeripherals(withServices: nil, options: [
      CBCentralManagerScanOptionAllowDuplicatesKey: false
    ])
  }

  public func stopScan() {
    central?.stopScan()
  }

  public func connect(_ name: String) {
    guard let target = discovered[name.uppercased()] else { return }
    peripheral = target
    target.delegate = self
    central?.connect(target, options: nil)
  }

  public func disconnect() {
    if let peripheral {
      central?.cancelPeripheralConnection(peripheral)
    }
    peripheral = nil
    writeCharacteristic = nil
    didReport = false
  }

  public func write(_ bytes: [UInt8]) {
    guard let peripheral, let writeCharacteristic else { return }
    peripheral.writeValue(Data(bytes), for: writeCharacteristic, type: .withoutResponse)
  }
}

extension CoreBluetoothRadarRadio: CBCentralManagerDelegate {
  // The central and its peripherals call back on the main queue, so each callback is on the
  // main actor in fact; `assumeIsolated` says so. CoreBluetooth's objects are not Sendable, so the
  // few that cross are marked `nonisolated(unsafe)`: they never leave the main queue.
  nonisolated public func centralManagerDidUpdateState(_ central: CBCentralManager) {
    let state = central.state
    MainActor.assumeIsolated {
      power = state == .poweredOn ? .on : (state == .unknown ? .unknown : .off)
      listener?.radioPowerChanged(power)
    }
  }

  nonisolated public func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let name = peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
    guard let name, RadarName.isTag(name) else { return }
    nonisolated(unsafe) let found = peripheral
    MainActor.assumeIsolated {
      discovered[name.uppercased()] = found
      listener?.radioDiscovered(name)
    }
  }

  nonisolated public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    MainActor.assumeIsolated {
      listener?.radioConnected()
    }
    peripheral.discoverServices(nil)
  }

  nonisolated public func centralManager(
    _ central: CBCentralManager,
    didFailToConnect peripheral: CBPeripheral,
    error: Error?
  ) {
    MainActor.assumeIsolated { dropped() }
  }

  nonisolated public func centralManager(
    _ central: CBCentralManager,
    didDisconnectPeripheral peripheral: CBPeripheral,
    error: Error?
  ) {
    MainActor.assumeIsolated { dropped() }
  }

  private func dropped() {
    peripheral = nil
    writeCharacteristic = nil
    didReport = false
    listener?.radioDisconnected()
  }
}

extension CoreBluetoothRadarRadio: CBPeripheralDelegate {
  nonisolated public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    for service in peripheral.services ?? [] {
      peripheral.discoverCharacteristics(nil, for: service)
    }
  }

  nonisolated public func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    var command: CBCharacteristic?
    for characteristic in service.characteristics ?? [] {
      let id = characteristic.uuid.uuidString
      if RadarWire.isCommandWrite(id) {
        command = characteristic
      }
      if characteristic.properties.contains(.notify), RadarWire.shouldNotify(id) {
        peripheral.setNotifyValue(true, for: characteristic)
      }
    }
    nonisolated(unsafe) let found = command
    MainActor.assumeIsolated {
      if let found {
        writeCharacteristic = found
      }
      if writeCharacteristic != nil, !didReport {
        didReport = true
        listener?.radioReady()
      }
    }
  }

  nonisolated public func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard let value = characteristic.value else { return }
    let bytes = [UInt8](value)
    MainActor.assumeIsolated {
      listener?.radioReceived(bytes)
    }
  }
}
