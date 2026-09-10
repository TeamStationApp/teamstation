import Foundation
import Observation

/// Everything the Cameraman operating screen and its Settings sheet need from the thing they
/// control.
///
/// The shared SwiftUI in `CameramanControlUI` compiles against this rather than against the phone's
/// `AppEnvironment`, so the same screen can drive a camera in the hand (the phone's own
/// `AppEnvironment` conforms directly) or one across the network (a remote model conforms over
/// RTSP `GET_PARAMETER` / `SET_PARAMETER`). Every mutating call is fire-and-forget: the view reads
/// the result back through the observable properties, exactly as it does on the phone where the
/// capture queue publishes state some milliseconds after a zoom is requested.
@MainActor
public protocol CameraControlling: AnyObject, Observable {
  /// The operator name (SDP `s=`, Bonjour instance, RTCP NAME).
  var name: String { get }
  /// The UUID that is also the SDP and RTCP CNAME.
  var cname: String { get }
  var position: CameraPosition { get }
  var mapping: ZoomMapping { get }
  var displayedZoom: Double { get }
  var deviceZoom: Double { get }
  var availableLenses: [CameraLens] { get }
  /// The formats this camera offers, for the Settings picker: the `FormatCatalogue` menu narrowed
  /// to what the device can serve. Empty until capture has configured a device, which is the normal
  /// state on a simulator.
  var formatOptions: [FormatCatalogue.Option] { get }
  var settings: StreamSettings { get }
  var thermalLevel: ThermalBadgeLevel { get }
  /// The phone's battery. Nil when it cannot be read, in which case no pill is drawn.
  var battery: BatteryStatus? { get }
  /// `rtsp://<ip>:<port><path>`, the string Settings copies.
  var streamURL: String { get }
  /// Sessions currently playing the stream.
  var clientCount: Int { get }
  /// False under `-uiTest`, so a flow sees a still pill rather than a frame mid-shimmer.
  var animatesChrome: Bool { get }
  /// Always true for a camera in the hand. A remote model drops it when the phone stops answering,
  /// and the screen dims its controls rather than dismissing itself.
  var isResponding: Bool { get }

  func setDisplayedZoom(_ displayed: Double)
  func setDeviceZoom(_ device: Double)
  func flip()
  func rename(to name: String)
  /// Done in Settings. A visit that changed nothing must send nothing and restart nothing.
  func apply(_ settings: StreamSettings)
  /// Settings "Test thermal". Overlay-only on the phone; a remote model may ignore it.
  func previewThermal(_ state: ProcessInfo.ThermalState)
}
