import Foundation

public enum RTMPHandshake {
  public static let packetSize = 1536

  public static func c0c1(time: UInt32 = 0) -> Data {
    var packet = Data([ 0x03 ])
    var timestamp = time.bigEndian
    withUnsafeBytes(of: &timestamp) { packet.append(contentsOf: $0) }
    packet.append(contentsOf: [ 0, 0, 0, 0 ])
    var random = [UInt8](repeating: 0, count: packetSize - 8)
    for index in random.indices { random[index] = UInt8.random(in: 0 ... 255) }
    packet.append(contentsOf: random)
    return packet
  }

  public static func c2(fromS1 s1: Data) -> Data {
    Data(s1.prefix(packetSize))
  }

  public static func splitServerHello(_ data: Data) -> (s0: UInt8, s1: Data, s2: Data)? {
    let needed = 1 + packetSize * 2
    guard data.count >= needed else { return nil }
    return (data[0], Data(data[1 ..< (1 + packetSize)]), Data(data[(1 + packetSize) ..< needed]))
  }
}
