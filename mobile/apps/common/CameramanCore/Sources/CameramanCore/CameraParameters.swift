import Foundation

// The wire vocabulary a TS Cameraman phone answers over RTSP `GET_PARAMETER` / `SET_PARAMETER`
// (RFC 2326 §10.8–10.9) with `text/parameters` bodies.
//
// Names follow ONVIF Media2 / PTZ configuration names (`videoEncoder.encoding`,
// `videoEncoder.rateControl.bitrateLimit`, `videoSource.position`, `ptz.zoom`, …) so anyone who
// knows ONVIF reads the body at sight; the SOAP stack itself is not implemented. Lenses have no
// ONVIF standard and are `lens.<i>.*` descriptors plus `lens.disabled`.
//
// Everything here is pure: encode, decode, validation, and the merge of a write over a snapshot.
// The phone's `AppEnvironment` and the remote client both use it, and the tests round-trip a
// request built by Director's `RTSPRequestBuilder` through Cameraman's server parser.

// MARK: - Errors

/// Why a request was refused, carrying the RTSP status the responder should send and the first
/// offending name so a client never has to guess which line failed.
public struct CameraParameterError: Error, Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    /// A value did not parse or is out of range.
    case badRequest
    /// RFC 2326 §11.3.11: an unknown name.
    case notUnderstood
    /// RFC 7826 §17.4.20: a `SET` on a read-only name.
    case readOnly
  }

  public var kind: Kind
  public var name: String?
  public var detail: String

  public init(kind: Kind, name: String? = nil, detail: String) {
    self.kind = kind
    self.name = name
    self.detail = detail
  }

  public var statusCode: Int {
    switch kind {
    case .badRequest: 400
    case .notUnderstood: 451
    case .readOnly: 458
    }
  }

  public var reasonPhrase: String {
    switch kind {
    case .badRequest: "Bad Request"
    case .notUnderstood: "Parameter Not Understood"
    case .readOnly: "Parameter Is Read-Only"
    }
  }

  /// The body sent with the error: the name on its own line, so it is machine-readable, then the
  /// explanation.
  public var body: String {
    var lines: [String] = []
    if let name { lines.append(name) }
    lines.append(detail)
    return lines.joined(separator: "\r\n") + "\r\n"
  }
}

// MARK: - The set

/// Ordered `name: value` pairs. Ordered so a body is byte-for-byte predictable in tests and so a
/// response lists names in the order the request asked for them.
public struct CameraParameterSet: Sendable, Equatable {
  public private(set) var names: [String] = []
  private var values: [String: String] = [:]

  public init() {}

  public init(_ pairs: [(name: String, value: String)]) {
    for pair in pairs { set(pair.name, pair.value) }
  }

  public subscript(name: String) -> String? {
    values[name]
  }

  public var isEmpty: Bool { names.isEmpty }
  public var count: Int { names.count }

  public var pairs: [(name: String, value: String)] {
    names.map { (name: $0, value: values[$0] ?? "") }
  }

  /// Appends a new name or replaces an existing value in place.
  public mutating func set(_ name: String, _ value: String) {
    if values[name] == nil { names.append(name) }
    values[name] = value
  }

  /// A `text/parameters` body: one `name: value` per line, CRLF-terminated.
  public var encoded: String {
    pairs.map { "\($0.name): \($0.value)\r\n" }.joined()
  }

  /// Parses a `SET_PARAMETER` body. CRLF or LF, blank lines skipped, names and values trimmed.
  /// A line without a colon is a `400`; a repeated name is a `400`, because the client's two values
  /// cannot both be honoured and silently taking the last is how a rail snaps to the wrong stop.
  public static func decode(_ text: String) -> Result<CameraParameterSet, CameraParameterError> {
    var set = CameraParameterSet()
    for rawLine in text.components(separatedBy: "\n") {
      let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
      if line.isEmpty { continue }
      guard let separator = line.firstIndex(of: ":") else {
        return .failure(CameraParameterError(
          kind: .badRequest,
          name: line,
          detail: "expected `name: value`"
        ))
      }
      let name = line[..<separator].trimmingCharacters(in: .whitespaces)
      let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
      guard !name.isEmpty else {
        return .failure(CameraParameterError(kind: .badRequest, name: line, detail: "empty name"))
      }
      guard set[name] == nil else {
        return .failure(CameraParameterError(kind: .badRequest, name: name, detail: "repeated name"))
      }
      set.set(name, value)
    }
    return .success(set)
  }

  /// Parses a `GET_PARAMETER` body: names one per line. `*` on its own means the whole set. A line
  /// that carries a colon is tolerated and only its name is taken, since some clients send
  /// `name:` for a query.
  public static func decodeNames(_ text: String) -> [String] {
    text.components(separatedBy: "\n").compactMap { rawLine in
      var line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
      if let colon = line.firstIndex(of: ":") {
        line = line[..<colon].trimmingCharacters(in: .whitespaces)
      }
      return line.isEmpty ? nil : line
    }
  }
}

// MARK: - Names

/// The name table. Everything not listed as writable is read-only.
public enum CameraParameterName {
  public static let deviceName = "device.name"
  public static let deviceCNAME = "device.cname"
  public static let deviceModel = "device.model"
  public static let systemThermal = "system.thermal"
  public static let systemStatus = "system.status"
  /// Percent 0…100, or empty when the phone cannot read its battery (a simulator).
  public static let systemBattery = "system.battery"
  public static let systemBatteryCharging = "system.battery.charging"
  public static let sourcePosition = "videoSource.position"
  public static let sourceDeviceType = "videoSource.deviceType"
  public static let zoomMinimumDevice = "videoSource.zoom.minimumDevice"
  public static let zoomMaximumDevice = "videoSource.zoom.maximumDevice"
  public static let zoomDisplayMultiplier = "videoSource.zoom.displayMultiplier"
  public static let zoomSwitchOverDevice = "videoSource.zoom.switchOverDevice"
  /// Device zoom where the phone's software zoom begins; empty when it has none.
  public static let zoomSoftwareStartDevice = "videoSource.zoom.softwareStartDevice"
  public static let ptzZoom = "ptz.zoom"
  public static let ptzZoomDevice = "ptz.zoom.device"
  public static let encoding = "videoEncoder.encoding"
  public static let width = "videoEncoder.resolution.width"
  public static let height = "videoEncoder.resolution.height"
  public static let frameRate = "videoEncoder.rateControl.frameRateLimit"
  public static let bitrateKbps = "videoEncoder.rateControl.bitrateLimit"
  /// The lowest rate adaptation may reach, in kbps, never above `bitrateLimit`. A phone that predates
  /// it adapts down to half of `bitrateLimit`, and is read as reporting that.
  public static let bitrateFloorKbps = "videoEncoder.rateControl.bitrateFloor"
  /// Whether the phone lowers its rate, never below `bitrateFloor`, while a link backs up.
  public static let adaptiveBitrate = "videoEncoder.rateControl.adaptive"
  /// The rate the encoder is running at, in kbps: `bitrateLimit`, or less while adapting.
  public static let currentBitrateKbps = "videoEncoder.rateControl.currentBitrate"
  public static let formatCount = "videoEncoder.formats"
  public static let audioEnabled = "audioEncoder.enabled"
  public static let audioSampleRate = "audioEncoder.sampleRate"
  /// Whether a connected external display carries the encoder's picture with no overlays.
  public static let videoOutputHDMIClean = "videoOutput.hdmi.clean"
  public static let lensCount = "lens.count"
  public static let lensDisabled = "lens.disabled"
  public static let streamURL = "stream.url"
  public static let streamClients = "stream.clients"
  /// Test only: frames per second to deliver to the encoder, `0` for every frame. See
  /// `FrameDeliveryThrottle`. Off at every launch.
  public static let testDeliveredFrameRate = "test.deliveredFrameRate"
  /// Test only: `low:high:periodSeconds`, a delivered rate swinging between the two, or empty for
  /// none. Wins over `test.deliveredFrameRate` while set.
  public static let testDeliveredFrameRateSwing = "test.deliveredFrameRateSwing"
  /// Frames per second actually reaching the encoder over the last two seconds, throttled or not;
  /// empty until two have.
  public static let testDeliveredFrameRateActual = "test.deliveredFrameRate.actual"

  public static let wildcard = "*"

  public static func format(_ index: Int, _ field: String) -> String { "format.\(index).\(field)" }
  public static func lens(_ index: Int, _ field: String) -> String { "lens.\(index).\(field)" }

  public static let writable: Set<String> = [
    deviceName, sourcePosition, ptzZoom, encoding, width, height, frameRate, bitrateKbps,
    bitrateFloorKbps, adaptiveBitrate, audioEnabled, videoOutputHDMIClean, lensDisabled,
    testDeliveredFrameRate, testDeliveredFrameRateSwing
  ]

  /// The fixed names, in the order the full set is emitted. Indexed `format.<i>.*` and `lens.<i>.*`
  /// names are recognised by shape.
  public static let fixed: [String] = [
    deviceName, deviceCNAME, deviceModel, systemThermal, systemStatus, systemBattery,
    systemBatteryCharging,
    sourcePosition, sourceDeviceType,
    zoomMinimumDevice, zoomMaximumDevice, zoomDisplayMultiplier, zoomSwitchOverDevice,
    zoomSoftwareStartDevice,
    ptzZoom, ptzZoomDevice,
    encoding, width, height, frameRate, bitrateKbps, bitrateFloorKbps, adaptiveBitrate, currentBitrateKbps,
    formatCount,
    audioEnabled, audioSampleRate,
    videoOutputHDMIClean,
    lensCount, lensDisabled,
    streamURL, streamClients,
    testDeliveredFrameRate, testDeliveredFrameRateSwing, testDeliveredFrameRateActual
  ]

  static let formatFields = [ "width", "height", "frameRate", "multiLens" ]
  static let lensFields = [ "id", "position", "deviceType", "title", "displayedZoom", "focalLengthMM", "native" ]

  public static func isKnown(_ name: String) -> Bool {
    if fixed.contains(name) { return true }
    return indexedField(name, prefix: "format", fields: formatFields) != nil
      || indexedField(name, prefix: "lens", fields: lensFields) != nil
  }

  public static func isReadOnly(_ name: String) -> Bool {
    !writable.contains(name)
  }

  private static func indexedField(_ name: String, prefix: String, fields: [String]) -> (Int, String)? {
    let parts = name.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[0] == prefix, let index = Int(parts[1]), index >= 0,
          fields.contains(String(parts[2]))
    else { return nil }
    return (index, String(parts[2]))
  }
}

// MARK: - Snapshot

/// Everything the phone reports, as one value. The phone builds it from `AppEnvironment`; the
/// remote client rebuilds it from a `GET_PARAMETER *` body; the Node fake keeps one in memory.
public struct CameraSnapshot: Sendable, Equatable {
  public var name: String
  public var cname: String
  public var model: String
  /// `ProcessLoad.thermalStateName`: `nominal` / `fair` / `serious` / `critical`.
  public var thermalName: String
  public var status: String
  /// Nil when the phone cannot read it.
  public var battery: BatteryStatus?
  public var position: CameraPosition
  public var deviceType: String
  public var mapping: ZoomMapping
  public var deviceZoom: Double
  public var settings: StreamSettings
  public var formats: [FormatCatalogue.Option]
  public var lenses: [CameraLens]
  public var streamURL: String
  public var clientCount: Int
  /// What the encoder is running at, which is below `settings.bitrate` while adapting. Nil from a
  /// phone that predates adaptation, which always runs at `settings.bitrate`.
  public var currentBitrate: Int?
  /// The test throttle's setting. Off from a phone that predates it.
  public var frameDelivery: FrameDelivery
  /// Frames per second reaching the encoder. Nil until measured, and from a phone that predates it.
  public var deliveredFrameRate: Double?

  public init(
    name: String,
    cname: String,
    model: String,
    thermalName: String,
    status: String,
    battery: BatteryStatus? = nil,
    position: CameraPosition,
    deviceType: String,
    mapping: ZoomMapping,
    deviceZoom: Double,
    settings: StreamSettings,
    formats: [FormatCatalogue.Option],
    lenses: [CameraLens],
    streamURL: String,
    clientCount: Int,
    currentBitrate: Int? = nil,
    frameDelivery: FrameDelivery = .off,
    deliveredFrameRate: Double? = nil
  ) {
    self.name = name
    self.cname = cname
    self.model = model
    self.thermalName = thermalName
    self.status = status
    self.battery = battery
    self.position = position
    self.deviceType = deviceType
    self.mapping = mapping
    self.deviceZoom = deviceZoom
    self.settings = settings
    self.formats = formats
    self.lenses = lenses
    self.streamURL = streamURL
    self.clientCount = clientCount
    self.currentBitrate = currentBitrate
    self.frameDelivery = frameDelivery
    self.deliveredFrameRate = deliveredFrameRate
  }

  public var displayedZoom: Double { mapping.displayedZoom(forDevice: deviceZoom) }
}

// MARK: - Writes

/// What a `SET_PARAMETER` asked for, typed. Only the fields named in the request are non-nil, so
/// the phone applies exactly what was sent and nothing it was not asked to touch.
public struct CameraParameterWrite: Sendable, Equatable {
  public var name: String?
  public var position: CameraPosition?
  /// Displayed units, not yet clamped: clamping needs the mapping, which is the snapshot's.
  public var displayedZoom: Double?
  public var codec: StreamCodec?
  public var width: Int?
  public var height: Int?
  public var frameRate: Double?
  /// Bits per second, converted from the wire's kbps.
  public var bitrate: Int?
  /// Bits per second, converted from the wire's kbps.
  public var bitrateFloor: Int?
  public var adaptiveBitrate: Bool?
  public var audioEnabled: Bool?
  public var cleanHDMIEnabled: Bool?
  public var disabledLensIDs: Set<String>?
  /// Frames per second for the test throttle, 0 for off.
  public var deliveredFrameRate: Double?
  /// The test throttle's swing as canonical `low:high:period` text, or empty to clear it.
  public var deliveredFrameRateSwing: String?
  /// The names in the request, in order, so the reply can echo exactly those.
  public var requestedNames: [String] = []

  public init() {}

  public var isEmpty: Bool {
    name == nil && position == nil && displayedZoom == nil && codec == nil && width == nil
      && height == nil && frameRate == nil && bitrate == nil && bitrateFloor == nil && adaptiveBitrate == nil
      && audioEnabled == nil && cleanHDMIEnabled == nil && disabledLensIDs == nil
      && !touchesFrameDelivery
  }

  /// True when the request names the test throttle. Never a settings change: the throttle leaves
  /// the format, the session and the saved settings alone.
  public var touchesFrameDelivery: Bool {
    deliveredFrameRate != nil || deliveredFrameRateSwing != nil
  }

  /// True when anything in `StreamSettings` is named, i.e. the phone should run one
  /// `applySettings()` after the merge.
  public var touchesSettings: Bool {
    codec != nil || width != nil || height != nil || frameRate != nil || bitrate != nil || bitrateFloor != nil
      || adaptiveBitrate != nil || audioEnabled != nil || cleanHDMIEnabled != nil || disabledLensIDs != nil
  }
}

// MARK: - Encode / decode / validate

public enum CameraParameters {
  public static let contentType = "text/parameters"
  public static let controlVersion = "params/1"
  public static let minimumBitrateKbps = 1_000
  public static let maximumBitrateKbps = StreamSettings.maximumBitrate / 1000

  // MARK: Encode

  /// The whole set, in table order.
  public static func encode(_ snapshot: CameraSnapshot) -> CameraParameterSet {
    var set = CameraParameterSet()
    let s = snapshot.settings
    set.set(CameraParameterName.deviceName, snapshot.name)
    set.set(CameraParameterName.deviceCNAME, snapshot.cname)
    set.set(CameraParameterName.deviceModel, snapshot.model)
    set.set(CameraParameterName.systemThermal, snapshot.thermalName)
    set.set(CameraParameterName.systemStatus, snapshot.status)
    set.set(CameraParameterName.systemBattery, snapshot.battery.map { String($0.percent) } ?? "")
    set.set(CameraParameterName.systemBatteryCharging, bool(snapshot.battery?.isCharging ?? false))
    set.set(CameraParameterName.sourcePosition, snapshot.position.rawValue)
    set.set(CameraParameterName.sourceDeviceType, snapshot.deviceType)
    set.set(CameraParameterName.zoomMinimumDevice, number(snapshot.mapping.minimumDeviceZoom))
    set.set(CameraParameterName.zoomMaximumDevice, number(snapshot.mapping.maximumDeviceZoom))
    set.set(CameraParameterName.zoomDisplayMultiplier, number(snapshot.mapping.displayMultiplier))
    set.set(
      CameraParameterName.zoomSwitchOverDevice,
      snapshot.mapping.switchOverDeviceZooms.map(number).joined(separator: ",")
    )
    set.set(CameraParameterName.zoomSoftwareStartDevice, snapshot.mapping.softwareZoomStartDeviceZoom.map(number) ?? "")
    set.set(CameraParameterName.ptzZoom, number(snapshot.displayedZoom))
    set.set(CameraParameterName.ptzZoomDevice, number(snapshot.deviceZoom))
    set.set(CameraParameterName.encoding, s.codec.sdpEncodingName)
    set.set(CameraParameterName.width, String(s.width))
    set.set(CameraParameterName.height, String(s.height))
    set.set(CameraParameterName.frameRate, number(s.frameRate))
    set.set(CameraParameterName.bitrateKbps, String(s.bitrate / 1000))
    set.set(CameraParameterName.bitrateFloorKbps, String(s.bitrateFloor / 1000))
    set.set(CameraParameterName.adaptiveBitrate, bool(s.adaptiveBitrate))
    set.set(CameraParameterName.currentBitrateKbps, String((snapshot.currentBitrate ?? s.bitrate) / 1000))
    set.set(CameraParameterName.formatCount, String(snapshot.formats.count))
    for (index, format) in snapshot.formats.enumerated() {
      set.set(CameraParameterName.format(index, "width"), String(format.width))
      set.set(CameraParameterName.format(index, "height"), String(format.height))
      set.set(CameraParameterName.format(index, "frameRate"), number(format.frameRate))
      set.set(CameraParameterName.format(index, "multiLens"), bool(format.supportsMultiLensSwitching))
    }
    set.set(CameraParameterName.audioEnabled, bool(s.audioEnabled))
    set.set(CameraParameterName.audioSampleRate, String(s.audioSampleRate))
    set.set(CameraParameterName.videoOutputHDMIClean, bool(s.cleanHDMIEnabled))
    set.set(CameraParameterName.lensCount, String(snapshot.lenses.count))
    for (index, lens) in snapshot.lenses.enumerated() {
      set.set(CameraParameterName.lens(index, "id"), lens.id)
      set.set(CameraParameterName.lens(index, "position"), lens.position.rawValue)
      set.set(CameraParameterName.lens(index, "deviceType"), lens.deviceType)
      set.set(CameraParameterName.lens(index, "title"), lens.title)
      set.set(CameraParameterName.lens(index, "displayedZoom"), number(lens.displayedZoom))
      set.set(CameraParameterName.lens(index, "focalLengthMM"), lens.focalLengthMM.map(String.init) ?? "")
      set.set(CameraParameterName.lens(index, "native"), bool(lens.isSecondaryNative))
    }
    set.set(CameraParameterName.lensDisabled, s.disabledLensIDs.sorted().joined(separator: ","))
    set.set(CameraParameterName.streamURL, snapshot.streamURL)
    set.set(CameraParameterName.streamClients, String(snapshot.clientCount))
    set.set(CameraParameterName.testDeliveredFrameRate, number(snapshot.frameDelivery.frameRate))
    set.set(CameraParameterName.testDeliveredFrameRateSwing, snapshot.frameDelivery.swing?.text ?? "")
    set.set(
      CameraParameterName.testDeliveredFrameRateActual,
      snapshot.deliveredFrameRate.map { number(($0 * 10).rounded() / 10) } ?? ""
    )
    return set
  }

  // MARK: Decode (client side)

  /// Rebuilds the phone's state from a full `GET_PARAMETER *` body. Nil when a field the screen
  /// cannot do without is missing or malformed; a partial answer is worse than none, because the
  /// rail would be drawn from a mapping that is half defaults.
  public static func decodeSnapshot(_ set: CameraParameterSet) -> CameraSnapshot? {
    guard let name = set[CameraParameterName.deviceName],
          let cname = set[CameraParameterName.deviceCNAME],
          let positionRaw = set[CameraParameterName.sourcePosition],
          let position = CameraPosition(rawValue: positionRaw),
          let minimum = set[CameraParameterName.zoomMinimumDevice].flatMap(Double.init),
          let maximum = set[CameraParameterName.zoomMaximumDevice].flatMap(Double.init),
          let multiplier = set[CameraParameterName.zoomDisplayMultiplier].flatMap(Double.init),
          let deviceZoom = set[CameraParameterName.ptzZoomDevice].flatMap(Double.init),
          let encoding = set[CameraParameterName.encoding],
          let codec = StreamCodec(sdpEncodingName: encoding),
          let width = set[CameraParameterName.width].flatMap(Int.init),
          let height = set[CameraParameterName.height].flatMap(Int.init),
          let frameRate = set[CameraParameterName.frameRate].flatMap(Double.init),
          let bitrateKbps = set[CameraParameterName.bitrateKbps].flatMap(Int.init)
    else { return nil }

    let switchOvers = (set[CameraParameterName.zoomSwitchOverDevice] ?? "")
      .split(separator: ",")
      .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    let mapping = ZoomMapping(
      minimumDeviceZoom: minimum,
      maximumDeviceZoom: maximum,
      displayMultiplier: multiplier,
      switchOverDeviceZooms: switchOvers,
      softwareZoomStartDeviceZoom: set[CameraParameterName.zoomSoftwareStartDevice].flatMap(Double.init)
    )

    var formats: [FormatCatalogue.Option] = []
    let formatCount = set[CameraParameterName.formatCount].flatMap(Int.init) ?? 0
    for index in 0 ..< max(formatCount, 0) {
      guard let w = set[CameraParameterName.format(index, "width")].flatMap(Int.init),
            let h = set[CameraParameterName.format(index, "height")].flatMap(Int.init),
            let fps = set[CameraParameterName.format(index, "frameRate")].flatMap(Double.init)
      else { continue }
      formats.append(FormatCatalogue.Option(
        width: w,
        height: h,
        frameRate: fps,
        supportsMultiLensSwitching: parseBool(set[CameraParameterName.format(index, "multiLens")]) ?? true
      ))
    }

    var lenses: [CameraLens] = []
    let lensCount = set[CameraParameterName.lensCount].flatMap(Int.init) ?? 0
    for index in 0 ..< max(lensCount, 0) {
      guard let id = set[CameraParameterName.lens(index, "id")],
            let lensPosition = set[CameraParameterName.lens(index, "position")].flatMap(CameraPosition.init(rawValue:)),
            let displayed = set[CameraParameterName.lens(index, "displayedZoom")].flatMap(Double.init)
      else { continue }
      lenses.append(CameraLens(
        id: id,
        position: lensPosition,
        deviceType: set[CameraParameterName.lens(index, "deviceType")] ?? "",
        uniqueDeviceID: id,
        focalLengthMM: set[CameraParameterName.lens(index, "focalLengthMM")].flatMap(Int.init),
        displayedZoom: displayed,
        deviceZoom: mapping.deviceZoom(forDisplayed: displayed),
        isSecondaryNative: parseBool(set[CameraParameterName.lens(index, "native")]) ?? false
      ))
    }

    let streamURL = set[CameraParameterName.streamURL] ?? ""
    let (port, path) = portAndPath(fromURL: streamURL)
    let settings = StreamSettings(
      width: width,
      height: height,
      frameRate: frameRate,
      codec: codec,
      bitrate: bitrateKbps * 1000,
      // Absent from a phone that predates the setting, which adapts down to half the rate: nil
      // decodes to that default.
      bitrateFloor: set[CameraParameterName.bitrateFloorKbps].flatMap(Int.init).map { $0 * 1000 },
      // Absent from a phone that predates adaptation, which never adapts.
      adaptiveBitrate: parseBool(set[CameraParameterName.adaptiveBitrate]) ?? false,
      port: port ?? StreamSettings.defaultPort,
      path: path ?? StreamSettings.canonicalPath,
      audioEnabled: parseBool(set[CameraParameterName.audioEnabled]) ?? true,
      videoEnabled: true,
      audioSampleRate: set[CameraParameterName.audioSampleRate].flatMap(Int.init) ?? 48_000,
      disabledLensIDs: idSet(set[CameraParameterName.lensDisabled]),
      cameraPosition: position,
      displayedZoom: mapping.displayedZoom(forDevice: deviceZoom),
      // Absent from a phone that predates the name; those phones mirror, which the toggle also
      // reads as "on" until it is told otherwise.
      cleanHDMIEnabled: parseBool(set[CameraParameterName.videoOutputHDMIClean]) ?? true
    )

    return CameraSnapshot(
      name: name,
      cname: cname,
      model: set[CameraParameterName.deviceModel] ?? "",
      thermalName: set[CameraParameterName.systemThermal] ?? "nominal",
      status: set[CameraParameterName.systemStatus] ?? "",
      battery: set[CameraParameterName.systemBattery].flatMap(Int.init).map {
        BatteryStatus(
          percent: $0,
          isCharging: parseBool(set[CameraParameterName.systemBatteryCharging]) ?? false
        )
      },
      position: position,
      deviceType: set[CameraParameterName.sourceDeviceType] ?? "",
      mapping: mapping,
      deviceZoom: deviceZoom,
      settings: settings,
      formats: formats,
      lenses: lenses,
      streamURL: streamURL,
      clientCount: set[CameraParameterName.streamClients].flatMap(Int.init) ?? 0,
      currentBitrate: set[CameraParameterName.currentBitrateKbps].flatMap(Int.init).map { $0 * 1000 },
      frameDelivery: FrameDelivery(
        frameRate: set[CameraParameterName.testDeliveredFrameRate].flatMap(Double.init) ?? 0,
        swing: set[CameraParameterName.testDeliveredFrameRateSwing].flatMap(FrameRateSwing.init(text:))
      ),
      deliveredFrameRate: set[CameraParameterName.testDeliveredFrameRateActual].flatMap(Double.init)
    )
  }

  // MARK: GET

  /// Answers a `GET_PARAMETER` body against a snapshot. `*` is everything; otherwise the named
  /// parameters in request order. An unknown name is a `451` and nothing is returned, so a client
  /// never has to guess which half took.
  public static func respondToGet(
    body: String,
    snapshot: CameraSnapshot
  ) -> Result<CameraParameterSet, CameraParameterError> {
    let names = CameraParameterSet.decodeNames(body)
    let everything = encode(snapshot)
    if names == [ CameraParameterName.wildcard ] { return .success(everything) }
    var subset = CameraParameterSet()
    for name in names {
      guard name != CameraParameterName.wildcard, let value = everything[name] else {
        return .failure(CameraParameterError(kind: .notUnderstood, name: name, detail: "unknown parameter"))
      }
      subset.set(name, value)
    }
    return .success(subset)
  }

  // MARK: SET

  /// Parses and validates a `SET_PARAMETER` body against the current snapshot. All or nothing: the
  /// first offending line is reported and no field is applied.
  public static func parseSet(
    body: String,
    snapshot: CameraSnapshot
  ) -> Result<CameraParameterWrite, CameraParameterError> {
    let set: CameraParameterSet
    switch CameraParameterSet.decode(body) {
    case .success(let decoded): set = decoded
    case .failure(let error): return .failure(error)
    }

    var write = CameraParameterWrite()
    write.requestedNames = set.names

    for (name, value) in set.pairs {
      guard CameraParameterName.isKnown(name) else {
        return .failure(CameraParameterError(kind: .notUnderstood, name: name, detail: "unknown parameter"))
      }
      guard !CameraParameterName.isReadOnly(name) else {
        return .failure(CameraParameterError(kind: .readOnly, name: name, detail: "read-only parameter"))
      }
      func bad(_ detail: String) -> CameraParameterError {
        CameraParameterError(kind: .badRequest, name: name, detail: detail)
      }

      switch name {
      case CameraParameterName.deviceName:
        write.name = value

      case CameraParameterName.sourcePosition:
        guard let position = CameraPosition(rawValue: value) else {
          return .failure(bad("expected back or front"))
        }
        write.position = position

      case CameraParameterName.ptzZoom:
        guard let zoom = Double(value), zoom.isFinite, zoom > 0 else {
          return .failure(bad("expected a positive number"))
        }
        write.displayedZoom = zoom

      case CameraParameterName.encoding:
        guard let codec = StreamCodec(sdpEncodingName: value) else {
          return .failure(bad("expected H264 or H265"))
        }
        write.codec = codec

      case CameraParameterName.width:
        guard let width = Int(value), width > 0 else { return .failure(bad("expected a positive integer")) }
        write.width = width

      case CameraParameterName.height:
        guard let height = Int(value), height > 0 else { return .failure(bad("expected a positive integer")) }
        write.height = height

      case CameraParameterName.frameRate:
        guard let rate = Double(value), rate.isFinite, rate > 0 else {
          return .failure(bad("expected a positive number"))
        }
        write.frameRate = rate

      case CameraParameterName.bitrateKbps:
        guard let kbps = Int(value) else { return .failure(bad("expected an integer in kbps")) }
        guard (minimumBitrateKbps ... maximumBitrateKbps).contains(kbps) else {
          return .failure(bad("expected \(minimumBitrateKbps)…\(maximumBitrateKbps) kbps"))
        }
        write.bitrate = kbps * 1000

      case CameraParameterName.bitrateFloorKbps:
        guard let kbps = Int(value) else { return .failure(bad("expected an integer in kbps")) }
        guard (minimumBitrateKbps ... maximumBitrateKbps).contains(kbps) else {
          return .failure(bad("expected \(minimumBitrateKbps)…\(maximumBitrateKbps) kbps"))
        }
        write.bitrateFloor = kbps * 1000

      case CameraParameterName.adaptiveBitrate:
        guard let enabled = parseBool(value) else { return .failure(bad("expected true or false")) }
        write.adaptiveBitrate = enabled

      case CameraParameterName.audioEnabled:
        guard let enabled = parseBool(value) else { return .failure(bad("expected true or false")) }
        write.audioEnabled = enabled

      case CameraParameterName.videoOutputHDMIClean:
        guard let enabled = parseBool(value) else { return .failure(bad("expected true or false")) }
        write.cleanHDMIEnabled = enabled

      case CameraParameterName.lensDisabled:
        let ids = idSet(value)
        let known = Set(snapshot.lenses.map(\.id))
        if let unknown = ids.sorted().first(where: { !known.contains($0) }), !known.isEmpty {
          return .failure(bad("unknown lens id \(unknown)"))
        }
        let selection = LensSelection(disabledIDs: ids).normalized(in: snapshot.lenses)
        for position in CameraPosition.allCases
        where snapshot.lenses.contains(where: { $0.position == position })
          && !selection.hasEnabledLens(at: position, in: snapshot.lenses) {
          return .failure(bad("would disable the last \(position.rawValue) lens"))
        }
        write.disabledLensIDs = ids

      case CameraParameterName.testDeliveredFrameRate:
        guard let rate = Double(value), rate == 0 || FrameDelivery.accepts(rate: rate) else {
          return .failure(bad(
            "expected 0 for off, or \(number(FrameDelivery.minimumRate))…\(number(FrameDelivery.maximumRate)) frames per second"
          ))
        }
        write.deliveredFrameRate = rate

      case CameraParameterName.testDeliveredFrameRateSwing:
        if value.isEmpty {
          write.deliveredFrameRateSwing = ""
        } else if let swing = FrameRateSwing(text: value) {
          write.deliveredFrameRateSwing = swing.text
        } else {
          return .failure(bad("expected low:high:periodSeconds with low ≤ high, or empty for none"))
        }

      default:
        return .failure(CameraParameterError(kind: .readOnly, name: name, detail: "read-only parameter"))
      }
    }

    // A format is only valid as a whole: width, height and rate together must name something the
    // camera offers. Fields not in the request keep their current values.
    if write.width != nil || write.height != nil || write.frameRate != nil, !snapshot.formats.isEmpty {
      let width = write.width ?? snapshot.settings.width
      let height = write.height ?? snapshot.settings.height
      let rate = write.frameRate ?? snapshot.settings.frameRate
      let offered = snapshot.formats.contains {
        $0.width == width && $0.height == height && abs($0.frameRate - rate) < 0.01
      }
      guard offered else {
        let name = write.frameRate != nil ? CameraParameterName.frameRate
          : write.height != nil ? CameraParameterName.height : CameraParameterName.width
        return .failure(CameraParameterError(
          kind: .badRequest,
          name: name,
          detail: "\(width)x\(height)@\(number(rate)) is not an offered format"
        ))
      }
    }

    // A named floor is judged against the rate it will sit under, which is the request's own rate
    // when it names one: raising both in one request is fine even if the new floor is above the old
    // rate. A request that names only the rate is never refused for the floor, which comes down
    // with it, so a client that predates the floor can still lower the rate.
    if let floor = write.bitrateFloor {
      let ceiling = settings(applying: write, to: snapshot.settings).bitrate
      guard floor <= ceiling else {
        return .failure(CameraParameterError(
          kind: .badRequest,
          name: CameraParameterName.bitrateFloorKbps,
          detail: "\(floor / 1000) kbps is above the \(ceiling / 1000) kbps bitrateLimit"
        ))
      }
    }

    return .success(write)
  }

  /// The stream settings after a write, with the codec change carrying its default bitrate across
  /// exactly as the Settings picker does. Zoom and position are not settings; they are applied by
  /// the capture session.
  public static func settings(applying write: CameraParameterWrite, to current: StreamSettings) -> StreamSettings {
    var next = current
    if let codec = write.codec { next.setCodec(codec) }
    if let width = write.width { next.width = width }
    if let height = write.height { next.height = height }
    if let rate = write.frameRate { next.frameRate = rate }
    // After `setCodec`, so an explicit rate in the same request wins over the codec default, and
    // the floor after the rate, so an explicit floor wins over the one the rate carried.
    if let bitrate = write.bitrate { next.setBitrate(bitrate) }
    if let floor = write.bitrateFloor { next.bitrateFloor = floor }
    next.clampFloorToCeiling()
    if let adaptive = write.adaptiveBitrate { next.adaptiveBitrate = adaptive }
    if let audio = write.audioEnabled { next.audioEnabled = audio }
    if let clean = write.cleanHDMIEnabled { next.cleanHDMIEnabled = clean }
    if let disabled = write.disabledLensIDs { next.disabledLensIDs = disabled }
    return next
  }

  /// The test throttle after a write. Fields not in the request keep their current values.
  public static func frameDelivery(applying write: CameraParameterWrite, to current: FrameDelivery) -> FrameDelivery {
    var next = current
    if let rate = write.deliveredFrameRate { next.frameRate = rate }
    if let swing = write.deliveredFrameRateSwing { next.swing = FrameRateSwing(text: swing) }
    return next
  }

  /// The snapshot as it will be once the write has taken: settings merged, zoom clamped to the
  /// mapping, position and name replaced. Used to echo applied values in the `SET` reply before the
  /// capture queue has published them.
  public static func snapshot(applying write: CameraParameterWrite, to current: CameraSnapshot) -> CameraSnapshot {
    var next = current
    next.settings = settings(applying: write, to: current.settings)
    if let name = write.name { next.name = DeviceIdentity.normalized(name: name, uuid: current.cname) }
    if let position = write.position { next.position = position }
    if let zoom = write.displayedZoom {
      next.deviceZoom = current.mapping.clampDeviceZoom(current.mapping.deviceZoom(forDisplayed: zoom))
    }
    next.settings.cameraPosition = next.position
    next.settings.displayedZoom = next.displayedZoom
    next.frameDelivery = frameDelivery(applying: write, to: current.frameDelivery)
    return next
  }

  /// The reply body for a successful `SET`: the requested names with their as-applied values.
  public static func echo(_ write: CameraParameterWrite, applied: CameraSnapshot) -> CameraParameterSet {
    let everything = encode(applied)
    var subset = CameraParameterSet()
    for name in write.requestedNames {
      if let value = everything[name] { subset.set(name, value) }
    }
    return subset
  }

  // MARK: Formatting

  /// `1`, `0.5`, `2.75`: integers without a decimal point, otherwise up to three places, trimmed.
  public static func number(_ value: Double) -> String {
    guard value.isFinite else { return "0" }
    if value == value.rounded(), abs(value) < 1e15 { return String(Int(value)) }
    var text = String(format: "%.3f", value)
    while text.hasSuffix("0") { text.removeLast() }
    if text.hasSuffix(".") { text.removeLast() }
    return text
  }

  static func bool(_ value: Bool) -> String { value ? "true" : "false" }

  static func parseBool(_ value: String?) -> Bool? {
    switch value?.lowercased() {
    case "true", "1", "yes", "on": true
    case "false", "0", "no", "off": false
    default: nil
    }
  }

  static func idSet(_ value: String?) -> Set<String> {
    Set((value ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
  }

  static func portAndPath(fromURL url: String) -> (Int?, String?) {
    guard let components = URLComponents(string: url) else { return (nil, nil) }
    let path = components.path.isEmpty ? nil : components.path
    return (components.port, path)
  }
}

extension StreamCodec {
  /// ONVIF `VideoEncoding` / SDP encoding name in either case: `H264`, `H265`, and `HEVC` as a
  /// courtesy.
  public init?(sdpEncodingName: String) {
    switch sdpEncodingName.uppercased() {
    case "H264": self = .h264
    case "H265", "HEVC": self = .hevc
    default: return nil
    }
  }
}
