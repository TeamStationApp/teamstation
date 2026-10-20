/// Canonical account identities, shared by the native API and persisted-account readers.
public enum TeamStationUserID {
  private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)

  public static func canonical(_ text: String) -> String? {
    let bytes = Array(text.utf8)
    guard bytes.count == 26, text.hasPrefix("usr_") else { return nil }
    var value: UInt128 = 0
    for byte in bytes.dropFirst(4) {
      guard let digit = alphabet.firstIndex(of: byte) else { return nil }
      let multiplied = value.multipliedReportingOverflow(by: 58)
      let added = multiplied.partialValue.addingReportingOverflow(UInt128(digit))
      guard !multiplied.overflow, !added.overflow else { return nil }
      value = added.partialValue
    }
    return value > 0 && encode(value) == text ? text : nil
  }

  /// Only stored pre-migration values take this path. Current API replies must be canonical.
  public static func fromLegacyDecimal(_ text: String) -> String? {
    guard let first = text.utf8.first, (49...57).contains(first),
          text.utf8.allSatisfy({ (48...57).contains($0) }),
          let value = UInt64(text), value <= 9_007_199_254_740_991
    else { return nil }
    return encode(UInt128(value))
  }

  public static func upgradingStored(_ text: String) -> String? {
    canonical(text) ?? fromLegacyDecimal(text)
  }

  private static func encode(_ input: UInt128) -> String {
    var value = input
    var digits = [UInt8]()
    while value > 0 {
      digits.append(alphabet[Int(value % 58)])
      value /= 58
    }
    return "usr_" + String(repeating: "1", count: 22 - digits.count)
      + String(decoding: digits.reversed(), as: UTF8.self)
  }
}
