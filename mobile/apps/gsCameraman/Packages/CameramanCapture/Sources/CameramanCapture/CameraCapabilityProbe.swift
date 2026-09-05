import AVFoundation
import CameramanCore
import Foundation
import UIKit

/// The measured capability set of this handset's cameras.
///
/// Everything in here is measured rather than assumed. Whether a given format keeps multi-lens
/// switching cannot be read off a format object — it has to be made active and the device's
/// switchover factors read back — so this type exists to do that once and write it down.
public struct CameraCapabilityReport: Codable, Sendable {
  public struct FormatEntry: Codable, Sendable {
    public var width: Int
    public var height: Int
    public var minFrameRate: Double
    public var maxFrameRate: Double
    /// `virtualDeviceSwitchOverVideoZoomFactors` observed while this format was active.
    public var switchOverZoomFactors: [Double]
    public var keepsMultiLensSwitching: Bool
    public var minAvailableZoom: Double
    public var maxAvailableZoom: Double
    /// `systemRecommendedVideoZoomRange`. `maxAvailableZoom` is the digital-upscaling ceiling and
    /// runs to 189x on this hardware, which is not a range any operator should be given; this is
    /// Apple's own answer for what to put on a zoom control.
    public var recommendedMinZoom: Double?
    public var recommendedMaxZoom: Double?
    public var isBinned: Bool
    public var supportsVideoHDR: Bool
  }

  public struct DeviceEntry: Codable, Sendable {
    public var deviceType: String
    public var position: String
    public var localizedName: String
    public var constituentDeviceTypes: [String]
    public var displayZoomMultiplier: Double
    public var switchOverZoomFactors: [Double]
    public var minAvailableZoom: Double
    public var maxAvailableZoom: Double
    public var supportsConstituentSwitchingBehavior: Bool
    public var formats: [FormatEntry]
  }

  public var generatedAt: String
  public var modelIdentifier: String
  public var systemVersion: String
  public var devices: [DeviceEntry]
  public var portBindings: [String: String]

  public func jsonString() -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .prettyPrinted, .sortedKeys ]
    guard let data = try? encoder.encode(self),
          let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
  }
}

/// Runs the measurement. Needs camera permission and a real device; on a simulator it reports no
/// cameras, which is itself a useful fact rather than a failure.
@MainActor
public struct CameraCapabilityProbe {
  public init() {}

  public func run() async -> CameraCapabilityReport {
    var devices: [CameraCapabilityReport.DeviceEntry] = []
    for device in Self.candidateDevices() {
      devices.append(await measure(device))
    }

    return CameraCapabilityReport(
      generatedAt: ISO8601DateFormatter().string(from: Date()),
      modelIdentifier: Self.modelIdentifier(),
      systemVersion: UIDevice.current.systemVersion,
      devices: devices,
      portBindings: await PortProbe.report(ports: [
        StreamSettings.defaultPort,
        StreamSettings.fallbackPort
      ])
    )
  }

  /// Back preference order runs widest-virtual-first so the app gets the most lenses it can, then
  /// degrades. Front is a single lens on every supported handset, so digital zoom only.
  static func candidateDevices() -> [AVCaptureDevice] {
    let types: [AVCaptureDevice.DeviceType] = [
      .builtInTripleCamera,
      .builtInDualWideCamera,
      .builtInDualCamera,
      .builtInWideAngleCamera,
      .builtInUltraWideCamera,
      .builtInTelephotoCamera
    ]
    let session = AVCaptureDevice.DiscoverySession(
      deviceTypes: types,
      mediaType: .video,
      position: .unspecified
    )
    return session.devices
  }

  private func measure(_ device: AVCaptureDevice) async -> CameraCapabilityReport.DeviceEntry {
    // The switchover factors reflect the *active* format, so the measurement needs a configured
    // session rather than a bare device.
    let session = AVCaptureSession()
    session.beginConfiguration()
    session.sessionPreset = .inputPriority
    if let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) {
      session.addInput(input)
    }
    session.commitConfiguration()
    session.startRunning()
    defer { session.stopRunning() }

    var formats: [CameraCapabilityReport.FormatEntry] = []
    for format in device.formats {
      guard let range = format.videoSupportedFrameRateRanges.first else { continue }
      let applied = apply(format: format, to: device)
      let switchOvers = device.virtualDeviceSwitchOverVideoZoomFactors.map(\.doubleValue)
      formats.append(CameraCapabilityReport.FormatEntry(
        width: Int(CMVideoFormatDescriptionGetDimensions(format.formatDescription).width),
        height: Int(CMVideoFormatDescriptionGetDimensions(format.formatDescription).height),
        minFrameRate: range.minFrameRate,
        maxFrameRate: format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? range.maxFrameRate,
        switchOverZoomFactors: applied ? switchOvers : [],
        keepsMultiLensSwitching: applied ? !switchOvers.isEmpty : false,
        minAvailableZoom: device.minAvailableVideoZoomFactor,
        maxAvailableZoom: device.maxAvailableVideoZoomFactor,
        recommendedMinZoom: format.systemRecommendedVideoZoomRange.map { Double($0.lowerBound) },
        recommendedMaxZoom: format.systemRecommendedVideoZoomRange.map { Double($0.upperBound) },
        isBinned: format.isVideoBinned,
        supportsVideoHDR: format.isVideoHDRSupported
      ))
    }

    return CameraCapabilityReport.DeviceEntry(
      deviceType: device.deviceType.rawValue,
      position: Self.name(for: device.position),
      localizedName: device.localizedName,
      constituentDeviceTypes: device.constituentDevices.map(\.deviceType.rawValue),
      displayZoomMultiplier: device.displayVideoZoomFactorMultiplier,
      switchOverZoomFactors: device.virtualDeviceSwitchOverVideoZoomFactors.map(\.doubleValue),
      minAvailableZoom: device.minAvailableVideoZoomFactor,
      maxAvailableZoom: device.maxAvailableVideoZoomFactor,
      // There is no `isSupported` flag for this; the behaviour itself reports `.unsupported` on a
      // device that cannot switch constituents.
      supportsConstituentSwitchingBehavior:
        device.primaryConstituentDeviceSwitchingBehavior != .unsupported,
      formats: formats
    )
  }

  private func apply(format: AVCaptureDevice.Format, to device: AVCaptureDevice) -> Bool {
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      device.activeFormat = format
      return true
    } catch {
      return false
    }
  }

  static func name(for position: AVCaptureDevice.Position) -> String {
    switch position {
    case .back: "back"
    case .front: "front"
    case .unspecified: "unspecified"
    @unknown default: "unknown"
    }
  }

  public static func modelIdentifier() -> String {
    var systemInfo = utsname()
    uname(&systemInfo)
    let identifier = withUnsafeBytes(of: &systemInfo.machine) { buffer in
      buffer.prefix(while: { $0 != 0 }).map { CChar($0) }
    }
    return String(cString: identifier + [ 0 ])
  }
}
