import CameramanCore
import DirectorRTSP
import Foundation
import Observation

/// Cameraman's operating screen, driven from another device.
///
/// Conforms to `CameraControlling` over the wire: it polls `GET_PARAMETER *` once a second
/// (which doubles as the keepalive), decodes the reply with `CameraParameters`, and turns each
/// command into a `SET_PARAMETER`. RTSP 1.0 has no server-to-client push, so polling is the only
/// way to see a change made on the phone itself.
///
/// Writes are coalesced where a finger produces a stream of them: zoom is sent at most every
/// 100 ms with the latest value winning; everything else goes immediately. A value just written
/// is shown locally until a later poll confirms it, so the rail never snaps back mid-drag.
@Observable
@MainActor
public final class RemoteCameraControl: CameraControlling {
  public static let pollInterval: Duration = .seconds(1)
  public static let zoomCoalesceInterval: Duration = .milliseconds(100)
  /// Polls a phone may miss before the screen says it is not answering.
  public static let missedPollsBeforeNotResponding = 2
  /// How long a locally-written value outranks what a poll says, so a poll that raced the write
  /// does not undo it on screen.
  static let localOverrideSeconds: TimeInterval = 1.5

  public private(set) var name = ""
  public private(set) var cname = ""
  public private(set) var position: CameraPosition = .back
  public private(set) var mapping = ZoomMapping(maximumDeviceZoom: 1)
  public private(set) var displayedZoom: Double = 1
  public private(set) var deviceZoom: Double = 1
  public private(set) var availableLenses: [CameraLens] = []
  public private(set) var formatOptions: [FormatCatalogue.Option] = []
  public private(set) var settings = StreamSettings()
  public private(set) var thermalLevel: ThermalBadgeLevel = .cool
  public private(set) var battery: BatteryStatus?
  public private(set) var streamURL = ""
  public private(set) var clientCount = 0
  public let animatesChrome: Bool
  /// False after two missed polls; true again on the next answer.
  public private(set) var isResponding = true
  /// The phone's last refusal (`458 Parameter Is Read-Only: device.cname`), for the screen and
  /// for dump-state. A refusal never drops the connection.
  public private(set) var lastError: String?
  /// Whether the first poll has landed, so a screen can hold its chrome until there is a mapping.
  public private(set) var hasSnapshot = false
  public private(set) var polls = 0
  public private(set) var writes = 0

  @ObservationIgnored private let transport: any ParameterTransport
  @ObservationIgnored private let pollInterval: Duration
  @ObservationIgnored private let zoomCoalesceInterval: Duration
  @ObservationIgnored private var pollTask: Task<Void, Never>?
  @ObservationIgnored private var zoomTask: Task<Void, Never>?
  @ObservationIgnored private var pendingZoom: Double?
  @ObservationIgnored private var missedPolls = 0
  @ObservationIgnored private var zoomWrittenAt: Date?
  @ObservationIgnored private var positionWrittenAt: Date?
  @ObservationIgnored private var nameWrittenAt: Date?
  @ObservationIgnored private var settingsWrittenAt: Date?
  /// False for a phone that predates the bitrate floor, which answers a `SET` naming it with 451
  /// and applies nothing else in the request. Its floor is left off the wire rather than costing
  /// the operator every other change made in the same visit to Settings.
  @ObservationIgnored private var phoneReportsBitrateFloor = true

  public init(
    transport: any ParameterTransport,
    animatesChrome: Bool = true,
    pollInterval: Duration = RemoteCameraControl.pollInterval,
    zoomCoalesceInterval: Duration = RemoteCameraControl.zoomCoalesceInterval
  ) {
    self.transport = transport
    self.animatesChrome = animatesChrome
    self.pollInterval = pollInterval
    self.zoomCoalesceInterval = zoomCoalesceInterval
  }

  public var transportState: ParameterTransportState { transport.state }

  // MARK: - Lifecycle

  public func start() {
    guard pollTask == nil else { return }
    transport.start()
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.poll()
        guard let self else { return }
        try? await Task.sleep(for: self.pollInterval)
      }
    }
  }

  public func stop() {
    pollTask?.cancel()
    pollTask = nil
    zoomTask?.cancel()
    zoomTask = nil
    transport.stop()
  }

  /// One `GET_PARAMETER *`. Public so a test can drive it without waiting on the timer.
  public func poll() async {
    let reply: ParameterReply
    do {
      reply = try await transport.get("\(CameraParameterName.wildcard)\r\n")
    } catch {
      notePollMissed("\(error)")
      return
    }
    guard reply.isSuccess else {
      notePollMissed("\(reply.statusCode) \(reply.reasonPhrase)")
      return
    }
    guard case .success(let set) = CameraParameterSet.decode(reply.body),
          let snapshot = CameraParameters.decodeSnapshot(set)
    else {
      notePollMissed("unreadable parameter body")
      return
    }
    polls += 1
    missedPolls = 0
    isResponding = true
    phoneReportsBitrateFloor = set[CameraParameterName.bitrateFloorKbps] != nil
    apply(snapshot)
  }

  private func notePollMissed(_ reason: String) {
    missedPolls += 1
    if missedPolls >= Self.missedPollsBeforeNotResponding {
      isResponding = false
    }
    lastError = reason
  }

  private func apply(_ snapshot: CameraSnapshot) {
    let now = Date()
    func overridden(_ writtenAt: Date?) -> Bool {
      guard let writtenAt else { return false }
      return now.timeIntervalSince(writtenAt) < Self.localOverrideSeconds
    }

    hasSnapshot = true
    cname = snapshot.cname
    if !overridden(nameWrittenAt) { name = snapshot.name }
    mapping = snapshot.mapping
    if !overridden(positionWrittenAt) { position = snapshot.position }
    if pendingZoom == nil, !overridden(zoomWrittenAt) {
      deviceZoom = snapshot.deviceZoom
      displayedZoom = snapshot.displayedZoom
    }
    availableLenses = snapshot.lenses
    formatOptions = snapshot.formats
    if !overridden(settingsWrittenAt) { settings = snapshot.settings }
    thermalLevel = ThermalBadgeLevel(telemetryName: snapshot.thermalName)
    battery = snapshot.battery
    streamURL = snapshot.streamURL
    clientCount = snapshot.clientCount
  }

  // MARK: - CameraControlling

  public func setDisplayedZoom(_ displayed: Double) {
    let clamped = mapping.clampDisplayedZoom(displayed)
    displayedZoom = clamped
    deviceZoom = mapping.deviceZoom(forDisplayed: clamped)
    pendingZoom = clamped
    guard zoomTask == nil else { return }
    zoomTask = Task { [weak self] in
      guard let self else { return }
      try? await Task.sleep(for: zoomCoalesceInterval)
      await flushZoom()
    }
  }

  public func setDeviceZoom(_ device: Double) {
    setDisplayedZoom(mapping.displayedZoom(forDevice: mapping.clampDeviceZoom(device)))
  }

  /// Sends the latest zoom. Public so a test can flush without waiting out the coalescing timer.
  public func flushZoom() async {
    zoomTask = nil
    guard let zoom = pendingZoom else { return }
    pendingZoom = nil
    zoomWrittenAt = Date()
    await write([ (CameraParameterName.ptzZoom, CameraParameters.number(zoom)) ])
  }

  public func flip() {
    let target: CameraPosition = position == .back ? .front : .back
    position = target
    positionWrittenAt = Date()
    Task { await write([ (CameraParameterName.sourcePosition, target.rawValue) ]) }
  }

  public func rename(to name: String) {
    let normalised = DeviceIdentity.normalized(name: name, uuid: cname)
    self.name = normalised
    nameWrittenAt = Date()
    Task { await write([ (CameraParameterName.deviceName, name) ]) }
  }

  /// Done in Settings: only the fields that differ from the phone's last snapshot go, as one
  /// request, so the phone reconfigures once. A visit that changed nothing sends nothing.
  public func apply(_ next: StreamSettings) {
    let lines = Self.settingsLines(from: settings, to: next, includingFloor: phoneReportsBitrateFloor)
    guard !lines.isEmpty else { return }
    settings = next
    settingsWrittenAt = Date()
    Task { await write(lines) }
  }

  /// The phone's Settings preview stays on the phone; the remote pill shows the real state only.
  public func previewThermal(_ state: ProcessInfo.ThermalState) {}

  /// `name: value` lines for what changed between two settings, in table order. `includingFloor`
  /// is false for a phone that does not know the floor's name.
  nonisolated public static func settingsLines(
    from current: StreamSettings,
    to next: StreamSettings,
    includingFloor: Bool = true
  ) -> [(String, String)] {
    var lines: [(String, String)] = []
    if next.codec != current.codec {
      lines.append((CameraParameterName.encoding, next.codec.sdpEncodingName))
    }
    if next.width != current.width { lines.append((CameraParameterName.width, String(next.width))) }
    if next.height != current.height { lines.append((CameraParameterName.height, String(next.height))) }
    if next.frameRate != current.frameRate {
      lines.append((CameraParameterName.frameRate, CameraParameters.number(next.frameRate)))
    }
    // After the codec line, so an explicit rate wins over the codec default on the phone too.
    if next.bitrate != current.bitrate {
      lines.append((CameraParameterName.bitrateKbps, String(next.bitrate / 1000)))
    }
    // After the rate, which the phone judges it against, and which on the phone moves a default
    // floor with it; the explicit value here then lands on top.
    if includingFloor, next.bitrateFloor != current.bitrateFloor {
      lines.append((CameraParameterName.bitrateFloorKbps, String(next.bitrateFloor / 1000)))
    }
    if next.adaptiveBitrate != current.adaptiveBitrate {
      lines.append((CameraParameterName.adaptiveBitrate, next.adaptiveBitrate ? "true" : "false"))
    }
    if next.audioEnabled != current.audioEnabled {
      lines.append((CameraParameterName.audioEnabled, next.audioEnabled ? "true" : "false"))
    }
    if next.cleanHDMIEnabled != current.cleanHDMIEnabled {
      lines.append((CameraParameterName.videoOutputHDMIClean, next.cleanHDMIEnabled ? "true" : "false"))
    }
    if next.disabledLensIDs != current.disabledLensIDs {
      lines.append((CameraParameterName.lensDisabled, next.disabledLensIDs.sorted().joined(separator: ",")))
    }
    return lines
  }

  private func write(_ lines: [(String, String)]) async {
    let body = lines.map { "\($0.0): \($0.1)\r\n" }.joined()
    writes += 1
    do {
      let reply = try await transport.set(body)
      if reply.isSuccess {
        lastError = nil
        if case .success(let echo) = CameraParameterSet.decode(reply.body) {
          applyEcho(echo)
        }
      } else {
        let offending = reply.body.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        lastError = "\(reply.statusCode) \(reply.reasonPhrase): \(offending)"
      }
    } catch {
      lastError = "\(error)"
    }
  }

  /// The phone echoes values as applied — clamped zoom, the codec's carried bitrate — so the
  /// screen shows what actually took rather than what was asked for.
  private func applyEcho(_ echo: CameraParameterSet) {
    if let zoom = echo[CameraParameterName.ptzZoom].flatMap(Double.init), pendingZoom == nil {
      displayedZoom = mapping.clampDisplayedZoom(zoom)
      deviceZoom = mapping.deviceZoom(forDisplayed: displayedZoom)
    }
    if let raw = echo[CameraParameterName.sourcePosition], let echoed = CameraPosition(rawValue: raw) {
      position = echoed
    }
    if let echoed = echo[CameraParameterName.deviceName] { name = echoed }
    if let kbps = echo[CameraParameterName.bitrateKbps].flatMap(Int.init) { settings.setBitrate(kbps * 1000) }
    if let kbps = echo[CameraParameterName.bitrateFloorKbps].flatMap(Int.init) { settings.bitrateFloor = kbps * 1000 }
    settings.clampFloorToCeiling()
    if let adaptive = echo[CameraParameterName.adaptiveBitrate] { settings.adaptiveBitrate = adaptive == "true" }
    if let encoding = echo[CameraParameterName.encoding], let codec = StreamCodec(sdpEncodingName: encoding) {
      settings.codec = codec
    }
  }
}
