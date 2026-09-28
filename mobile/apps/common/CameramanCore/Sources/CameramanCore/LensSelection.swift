import Foundation

/// Which of the discovered lenses the operator has left on, and which capture device that implies.
///
/// Disabled IDs rather than enabled ones, so a lens that appears for the first time (a new handset,
/// a newly attached camera) is on until someone turns it off. The empty set is "use everything",
/// which is the behaviour before this setting existed.
///
/// Only physical lenses are chosen. A native crop (the 48 mm 2x, the 17 Pro's 8x) is a zoom stop on
/// its lens, not a lens of its own, so it is on exactly when that lens is. Settings saved when crops
/// had their own toggles are read through `normalized(in:)`: a crop left on keeps its lens on.
public struct LensSelection: Sendable, Equatable {
  public var disabledIDs: Set<String>

  public init(disabledIDs: Set<String> = []) {
    self.disabledIDs = disabledIDs
  }

  public func isEnabled(_ lens: CameraLens) -> Bool {
    !disabledIDs.contains(lens.id)
  }

  public func enabled(in catalog: [CameraLens]) -> [CameraLens] {
    catalog.filter(isEnabled)
  }

  /// The lenses an operator chooses between: the physical cameras, without their native crops.
  public static func physical(in catalog: [CameraLens]) -> [CameraLens] {
    catalog.filter { !$0.isSecondaryNative }
  }

  /// A physical lens's native crops: the same camera, read out at a native zoom factor.
  public static func crops(of lens: CameraLens, in catalog: [CameraLens]) -> [CameraLens] {
    catalog.filter { $0.isSecondaryNative && $0.uniqueDeviceID == lens.uniqueDeviceID && $0.id != lens.id }
  }

  /// Each physical lens and its crops on or off together. A lens counts as on when it, or any crop
  /// of it, is on, so an older selection of only the 8x crop reads as the telephoto.
  public func normalized(in catalog: [CameraLens]) -> LensSelection {
    var ids = disabledIDs
    for lens in Self.physical(in: catalog) {
      let crops = Self.crops(of: lens, in: catalog)
      let isOn = isEnabled(lens) || crops.contains(where: isEnabled)
      let group = Set([ lens.id ] + crops.map(\.id))
      if isOn { ids.subtract(group) } else { ids.formUnion(group) }
    }
    return LensSelection(disabledIDs: ids)
  }

  /// Turning off the last remaining lens would leave capture with nothing to open.
  public func canDisable(_ lens: CameraLens, in catalog: [CameraLens]) -> Bool {
    let current = normalized(in: catalog)
    return Self.physical(in: catalog).contains { $0.id != lens.id && current.isEnabled($0) }
  }

  /// Turns a physical lens, and its crops with it, on or off.
  public func toggling(_ lens: CameraLens, to enabled: Bool, in catalog: [CameraLens]) -> LensSelection {
    var ids = normalized(in: catalog).disabledIDs
    let group = Set([ lens.id ] + Self.crops(of: lens, in: catalog).map(\.id))
    if enabled {
      ids.subtract(group)
    } else {
      guard canDisable(lens, in: catalog) else { return self }
      ids.formUnion(group)
    }
    return LensSelection(disabledIDs: ids)
  }

  public func hasEnabledLens(at position: CameraPosition, in catalog: [CameraLens]) -> Bool {
    catalog.contains { $0.position == position && isEnabled($0) }
  }

  /// Device types to try, widest-virtual-first when every physical lens at this position is on,
  /// otherwise the virtual or physical device that covers only what remains.
  ///
  /// A single enabled lens becomes that physical camera, so an external glass on the wide cannot
  /// be abandoned for the ultra-wide or telephoto when focus hunts. Two neighbouring lenses pick
  /// Dual Wide or Dual. There is no UW+tele virtual device; that combination still opens Triple.
  public func preferredDeviceTypes(for position: CameraPosition, in catalog: [CameraLens]) -> [String] {
    if position == .front {
      if catalog.isEmpty || hasEnabledLens(at: .front, in: catalog) {
        return Self.frontDefaultPreference
      }
      return []
    }

    let physical = catalog.filter { $0.position == .back && !$0.isSecondaryNative }
    if physical.isEmpty { return Self.backDefaultPreference }

    let enabledTypes = Set(
      catalog.filter { $0.position == .back && isEnabled($0) }.map(\.deviceType)
    )
    if enabledTypes.isEmpty { return [] }

    let allPhysicalOn = Set(physical.map(\.deviceType)).isSubset(of: enabledTypes)
    if allPhysicalOn { return Self.backDefaultPreference }

    let uw = enabledTypes.contains(CameraDeviceTypeName.ultraWide)
    let wide = enabledTypes.contains(CameraDeviceTypeName.wideAngle)
    let tele = enabledTypes.contains(CameraDeviceTypeName.telephoto)

    switch (uw, wide, tele) {
    case (true, true, true):
      return Self.backDefaultPreference
    case (true, true, false):
      return [
        CameraDeviceTypeName.dualWide,
        CameraDeviceTypeName.wideAngle,
        CameraDeviceTypeName.ultraWide
      ]
    case (false, true, true):
      return [
        CameraDeviceTypeName.dual,
        CameraDeviceTypeName.wideAngle,
        CameraDeviceTypeName.telephoto
      ]
    case (true, false, true):
      return [
        CameraDeviceTypeName.triple,
        CameraDeviceTypeName.ultraWide,
        CameraDeviceTypeName.telephoto
      ]
    case (true, false, false):
      return [ CameraDeviceTypeName.ultraWide ]
    case (false, true, false):
      return [ CameraDeviceTypeName.wideAngle ]
    case (false, false, true):
      return [ CameraDeviceTypeName.telephoto ]
    case (false, false, false):
      return Array(enabledTypes)
    }
  }

  public static let backDefaultPreference = [
    CameraDeviceTypeName.triple,
    CameraDeviceTypeName.dualWide,
    CameraDeviceTypeName.dual,
    CameraDeviceTypeName.wideAngle
  ]

  public static let frontDefaultPreference = [
    CameraDeviceTypeName.wideAngle
  ]
}
