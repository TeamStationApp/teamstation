import AVFoundation
import CameramanCore
import Foundation

/// Reads the handset's cameras into `CameraLens` rows.
///
/// Nothing here is a model table. Constituent devices, switchover zooms, field of view and
/// secondary native resolution factors are all asked of `AVCaptureDevice`, so a 13 Pro, a 15 Pro
/// and a 17 Pro each populate the settings list they actually have.
public enum LensDiscovery {
  public static func discover() -> [CameraLens] {
    var lenses: [CameraLens] = []
    if let back = preferredVirtual(for: .back) {
      lenses.append(contentsOf: catalog(from: back, position: .back))
    }
    if let front = preferredVirtual(for: .front) {
      lenses.append(contentsOf: catalog(from: front, position: .front))
    }
    return lenses.sorted {
      if $0.position != $1.position { return $0.position == .back }
      return $0.displayedZoom < $1.displayedZoom
    }
  }

  /// Widest virtual device first on the back, so every physical constituent is present. Front is
  /// the wide-angle; TrueDepth's infrared constituent is not a video lens and is not listed.
  static func preferredVirtual(for position: CameraPosition) -> AVCaptureDevice? {
    CameraSession.preferredDevice(for: position)
  }

  static func catalog(from device: AVCaptureDevice, position: CameraPosition) -> [CameraLens] {
    let multiplier = device.displayVideoZoomFactorMultiplier
    let constituents = device.constituentDevices
    if constituents.isEmpty {
      return [ physicalLens(device, position: position, displayedZoom: multiplier * device.minAvailableVideoZoomFactor, deviceZoom: device.minAvailableVideoZoomFactor) ]
        + nativeCrops(of: device, position: position, parentDisplayedZoom: multiplier * device.minAvailableVideoZoomFactor, parentDeviceZoom: device.minAvailableVideoZoomFactor, existingDisplayed: [])
    }

    let switchOvers = device.virtualDeviceSwitchOverVideoZoomFactors.map(\.doubleValue)
    var result: [CameraLens] = []
    for (index, constituent) in constituents.enumerated() {
      let deviceZoom = index == 0 ? device.minAvailableVideoZoomFactor : switchOvers[index - 1]
      let displayed = deviceZoom * multiplier
      result.append(physicalLens(constituent, position: position, displayedZoom: displayed, deviceZoom: deviceZoom))
      result.append(contentsOf: nativeCrops(
        of: constituent,
        position: position,
        parentDisplayedZoom: displayed,
        parentDeviceZoom: deviceZoom,
        existingDisplayed: result.map(\.displayedZoom)
      ))
    }
    return result
  }

  private static func physicalLens(
    _ device: AVCaptureDevice,
    position: CameraPosition,
    displayedZoom: Double,
    deviceZoom: Double
  ) -> CameraLens {
    let fov = fieldOfView(of: device)
    return CameraLens(
      id: device.uniqueID,
      position: position,
      deviceType: device.deviceType.rawValue,
      uniqueDeviceID: device.uniqueID,
      focalLengthMM: LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: fov),
      displayedZoom: displayedZoom,
      deviceZoom: deviceZoom,
      isSecondaryNative: false
    )
  }

  /// Native crops such as the 48 mm 2x on a 48 MP wide. They are not constituent devices, so they
  /// have to be read from `secondaryNativeResolutionZoomFactors` and skipped when they coincide with
  /// an already-listed physical lens.
  private static func nativeCrops(
    of device: AVCaptureDevice,
    position: CameraPosition,
    parentDisplayedZoom: Double,
    parentDeviceZoom: Double,
    existingDisplayed: [Double]
  ) -> [CameraLens] {
    let parentFOV = fieldOfView(of: device)
    return nativeFactors(of: device).compactMap { factor in
      guard factor > 1.01 else { return nil }
      let displayed = parentDisplayedZoom * factor
      if existingDisplayed.contains(where: { abs($0 - displayed) < 0.08 }) { return nil }
      let croppedFOV = LensOptics.croppedFieldOfViewDegrees(
        horizontalFieldOfViewDegrees: parentFOV,
        factor: factor
      )
      return CameraLens(
        id: "\(device.uniqueID)#native:\(ZoomMapping.label(forDisplayed: displayed))",
        position: position,
        deviceType: device.deviceType.rawValue,
        uniqueDeviceID: device.uniqueID,
        focalLengthMM: croppedFOV.flatMap {
          LensOptics.equivalentFocalLengthMM(horizontalFieldOfViewDegrees: $0)
        },
        displayedZoom: displayed,
        deviceZoom: parentDeviceZoom * factor,
        isSecondaryNative: true
      )
    }
  }

  private static func nativeFactors(of device: AVCaptureDevice) -> [Double] {
    var factors: [Double] = []
    for format in device.formats {
      for value in format.secondaryNativeResolutionZoomFactors {
        let factor = Double(value)
        if !factors.contains(where: { abs($0 - factor) < 0.05 }) {
          factors.append(factor)
        }
      }
    }
    return factors.sorted()
  }

  /// Widest field of view the device reports. A 16:9 format is a crop of the sensor and reads
  /// a longer equivalent focal length (26 mm for a lens Apple labels 24 mm). Taking the max
  /// matches the 4:3 optics Blackmagic and the Camera app print.
  static func fieldOfView(of device: AVCaptureDevice) -> Double {
    var widest: Double = 0
    for format in device.formats {
      let fov = Double(format.videoFieldOfView)
      if fov > widest { widest = fov }
      let corrected = Double(format.geometricDistortionCorrectedVideoFieldOfView)
      if corrected > widest { widest = corrected }
    }
    return widest
  }
}
