import Foundation

/// What a device is called where people read it: "iPhone 13 Pro", "iPad Pro".
///
/// TeamStation lists every camera on a game with the device it runs on, so an operator looking at
/// another phone's list can tell which angle is which. The system gives a model identifier
/// (`iPhone14,2`), which nobody reads; this turns it into the name on the box.
///
/// iPhones are named exactly. iPads are named by family, because an iPad's camera is told apart by
/// what it is for, and the generation adds nothing an operator acts on. An identifier this table has
/// not met yet is named by its family ("iPhone", "iPad"), and anything else is passed through.
public enum DeviceModelName {
  /// This device's name. On a simulator, the simulated device's.
  public static var current: String {
    name(for: currentIdentifier)
  }

  /// The model identifier: the hardware's, or on a simulator the one it simulates, which the
  /// simulator puts in `SIMULATOR_MODEL_IDENTIFIER` because its hardware is the Mac's.
  public static var currentIdentifier: String {
    identifier(
      machine: machine(),
      environment: ProcessInfo.processInfo.environment
    )
  }

  static func identifier(machine: String, environment: [String: String]) -> String {
    if let simulated = environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty {
      return simulated
    }
    return machine
  }

  /// The name for a model identifier.
  public static func name(for identifier: String) -> String {
    if let exact = phones[identifier] { return exact }
    if let family = pads.first(where: { $0.value.contains(identifier) })?.key { return family }
    if identifier.hasPrefix("iPhone") { return "iPhone" }
    if identifier.hasPrefix("iPad") { return "iPad" }
    return identifier
  }

  private static func machine() -> String {
    var system = utsname()
    uname(&system)
    return withUnsafeBytes(of: &system.machine) { raw in
      String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
    }
  }

  /// Every iPhone that runs iOS 18 or later.
  static let phones: [String: String] = [
    "iPhone11,2": "iPhone XS",
    "iPhone11,4": "iPhone XS Max",
    "iPhone11,6": "iPhone XS Max",
    "iPhone11,8": "iPhone XR",
    "iPhone12,1": "iPhone 11",
    "iPhone12,3": "iPhone 11 Pro",
    "iPhone12,5": "iPhone 11 Pro Max",
    "iPhone12,8": "iPhone SE",
    "iPhone13,1": "iPhone 12 mini",
    "iPhone13,2": "iPhone 12",
    "iPhone13,3": "iPhone 12 Pro",
    "iPhone13,4": "iPhone 12 Pro Max",
    "iPhone14,2": "iPhone 13 Pro",
    "iPhone14,3": "iPhone 13 Pro Max",
    "iPhone14,4": "iPhone 13 mini",
    "iPhone14,5": "iPhone 13",
    "iPhone14,6": "iPhone SE",
    "iPhone14,7": "iPhone 14",
    "iPhone14,8": "iPhone 14 Plus",
    "iPhone15,2": "iPhone 14 Pro",
    "iPhone15,3": "iPhone 14 Pro Max",
    "iPhone15,4": "iPhone 15",
    "iPhone15,5": "iPhone 15 Plus",
    "iPhone16,1": "iPhone 15 Pro",
    "iPhone16,2": "iPhone 15 Pro Max",
    "iPhone17,1": "iPhone 16 Pro",
    "iPhone17,2": "iPhone 16 Pro Max",
    "iPhone17,3": "iPhone 16",
    "iPhone17,4": "iPhone 16 Plus",
    "iPhone17,5": "iPhone 16e",
    "iPhone18,1": "iPhone 17 Pro",
    "iPhone18,2": "iPhone 17 Pro Max",
    "iPhone18,3": "iPhone 17",
    "iPhone18,4": "iPhone Air"
  ]

  /// Every iPad that runs iOS 18 or later, by family.
  static let pads: [String: Set<String>] = [
    "iPad Pro": [
      "iPad8,1", "iPad8,2", "iPad8,3", "iPad8,4", "iPad8,5", "iPad8,6", "iPad8,7", "iPad8,8",
      "iPad8,9", "iPad8,10", "iPad8,11", "iPad8,12",
      "iPad13,4", "iPad13,5", "iPad13,6", "iPad13,7", "iPad13,8", "iPad13,9", "iPad13,10",
      "iPad13,11",
      "iPad14,3", "iPad14,4", "iPad14,5", "iPad14,6",
      "iPad16,3", "iPad16,4", "iPad16,5", "iPad16,6",
      "iPad17,1", "iPad17,2", "iPad17,3", "iPad17,4"
    ],
    "iPad Air": [
      "iPad11,3", "iPad11,4", "iPad13,1", "iPad13,2", "iPad13,16", "iPad13,17",
      "iPad14,8", "iPad14,9", "iPad14,10", "iPad14,11",
      "iPad15,3", "iPad15,4", "iPad15,5", "iPad15,6"
    ],
    "iPad mini": [
      "iPad11,1", "iPad11,2", "iPad14,1", "iPad14,2", "iPad16,1", "iPad16,2"
    ],
    "iPad": [
      "iPad7,11", "iPad7,12", "iPad11,6", "iPad11,7", "iPad12,1", "iPad12,2", "iPad13,18",
      "iPad13,19", "iPad15,7", "iPad15,8"
    ]
  ]
}
