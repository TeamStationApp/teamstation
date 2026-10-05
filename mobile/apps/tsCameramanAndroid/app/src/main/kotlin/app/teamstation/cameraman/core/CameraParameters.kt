package app.teamstation.cameraman.core

import app.teamstation.cameraman.capture.FormatCatalogue
import java.net.URI
import java.util.Locale
import kotlin.math.abs

// The wire vocabulary a TS Cameraman phone answers over RTSP `GET_PARAMETER` / `SET_PARAMETER`
// (RFC 2326 §10.8–10.9) with `text/parameters` bodies.
//
// A port of the iOS build's `CameraParameters.swift`, name for name and rule for rule, because the
// client on the other end is one implementation — TS Director's `RemoteCameraControl` — and it must
// not be able to tell which platform a camera is running on. Names follow ONVIF Media2 / PTZ
// configuration names (`videoEncoder.encoding`, `videoEncoder.rateControl.bitrateLimit`,
// `videoSource.position`, `ptz.zoom`, …) so anyone who knows ONVIF reads the body at sight; the
// SOAP stack itself is not implemented. Lenses have no ONVIF standard and are `lens.<i>.*`
// descriptors plus `lens.disabled`.
//
// Everything here is pure: encode, decode, validation, and the merge of a write over a snapshot. It
// has no Android dependency, so the whole vocabulary is tested on the JVM.

/** The outcome of a parameter operation: a value, or the refusal the responder should send. */
sealed interface ParameterOutcome<out T> {
    data class Success<T>(val value: T) : ParameterOutcome<T>
    data class Failure(val error: CameraParameterError) : ParameterOutcome<Nothing>

    /** The value, or null on a failure. For tests and for callers that only care about success. */
    fun getOrNull(): T? = (this as? Success<T>)?.value

    /** The error, or null on success. */
    fun errorOrNull(): CameraParameterError? = (this as? Failure)?.error
}

/**
 * Why a request was refused, carrying the RTSP status the responder should send and the first
 * offending name so a client never has to guess which line failed.
 */
data class CameraParameterError(
    val kind: Kind,
    val name: String? = null,
    val detail: String
) {
    enum class Kind {
        /** A value did not parse or is out of range. */
        BAD_REQUEST,
        /** RFC 2326 §11.3.11: an unknown name. */
        NOT_UNDERSTOOD,
        /** RFC 7826 §17.4.20: a `SET` on a read-only name. */
        READ_ONLY
    }

    val statusCode: Int
        get() = when (kind) {
            Kind.BAD_REQUEST -> 400
            Kind.NOT_UNDERSTOOD -> 451
            Kind.READ_ONLY -> 458
        }

    val reasonPhrase: String
        get() = when (kind) {
            Kind.BAD_REQUEST -> "Bad Request"
            Kind.NOT_UNDERSTOOD -> "Parameter Not Understood"
            Kind.READ_ONLY -> "Parameter Is Read-Only"
        }

    /**
     * The body sent with the error: the name on its own line, so it is machine-readable, then the
     * explanation.
     */
    val body: String
        get() {
            val lines = ArrayList<String>()
            name?.let { lines.add(it) }
            lines.add(detail)
            return lines.joinToString("\r\n") + "\r\n"
        }
}

/**
 * Ordered `name: value` pairs. Ordered so a body is byte-for-byte predictable in tests and so a
 * response lists names in the order the request asked for them.
 */
class CameraParameterSet() {
    private val order = ArrayList<String>()
    private val values = HashMap<String, String>()

    constructor(pairs: List<Pair<String, String>>) : this() {
        for ((name, value) in pairs) set(name, value)
    }

    val names: List<String> get() = order

    operator fun get(name: String): String? = values[name]

    val isEmpty: Boolean get() = order.isEmpty()
    val count: Int get() = order.size

    val pairs: List<Pair<String, String>>
        get() = order.map { it to (values[it] ?: "") }

    /** Appends a new name or replaces an existing value in place. */
    fun set(name: String, value: String) {
        if (!values.containsKey(name)) order.add(name)
        values[name] = value
    }

    /** A `text/parameters` body: one `name: value` per line, CRLF-terminated. */
    val encoded: String
        get() = pairs.joinToString("") { (name, value) -> "$name: $value\r\n" }

    override fun equals(other: Any?): Boolean = other is CameraParameterSet && other.pairs == pairs

    override fun hashCode(): Int = pairs.hashCode()

    override fun toString(): String = "CameraParameterSet($pairs)"

    companion object {
        /**
         * Parses a `SET_PARAMETER` body. CRLF or LF, blank lines skipped, names and values trimmed.
         * A line without a colon is a `400`; a repeated name is a `400`, because the client's two
         * values cannot both be honoured and silently taking the last is how a rail snaps to the
         * wrong stop.
         */
        fun decode(text: String): ParameterOutcome<CameraParameterSet> {
            val set = CameraParameterSet()
            for (rawLine in text.split("\n")) {
                val line = rawLine.trim()
                if (line.isEmpty()) continue
                val separator = line.indexOf(':')
                if (separator < 0) {
                    return ParameterOutcome.Failure(
                        CameraParameterError(
                            CameraParameterError.Kind.BAD_REQUEST,
                            line,
                            "expected `name: value`"
                        )
                    )
                }
                val name = line.substring(0, separator).trim()
                val value = line.substring(separator + 1).trim()
                if (name.isEmpty()) {
                    return ParameterOutcome.Failure(
                        CameraParameterError(CameraParameterError.Kind.BAD_REQUEST, line, "empty name")
                    )
                }
                if (set[name] != null) {
                    return ParameterOutcome.Failure(
                        CameraParameterError(CameraParameterError.Kind.BAD_REQUEST, name, "repeated name")
                    )
                }
                set.set(name, value)
            }
            return ParameterOutcome.Success(set)
        }

        /**
         * Parses a `GET_PARAMETER` body: names one per line. `*` on its own means the whole set. A
         * line that carries a colon is tolerated and only its name is taken, since some clients send
         * `name:` for a query.
         */
        fun decodeNames(text: String): List<String> =
            text.split("\n").mapNotNull { rawLine ->
                var line = rawLine.trim()
                val colon = line.indexOf(':')
                if (colon >= 0) line = line.substring(0, colon).trim()
                line.ifEmpty { null }
            }
    }
}

/** The name table. Everything not listed as writable is read-only. */
object CameraParameterName {
    const val deviceName = "device.name"
    const val deviceCNAME = "device.cname"
    const val deviceModel = "device.model"
    const val systemThermal = "system.thermal"
    const val systemStatus = "system.status"
    /** Percent 0…100, or empty when the phone cannot read its battery (an emulator). */
    const val systemBattery = "system.battery"
    const val systemBatteryCharging = "system.battery.charging"
    const val sourcePosition = "videoSource.position"
    const val sourceDeviceType = "videoSource.deviceType"
    const val zoomMinimumDevice = "videoSource.zoom.minimumDevice"
    const val zoomMaximumDevice = "videoSource.zoom.maximumDevice"
    const val zoomDisplayMultiplier = "videoSource.zoom.displayMultiplier"
    const val zoomSwitchOverDevice = "videoSource.zoom.switchOverDevice"
    /** Device zoom where the phone's software zoom begins; empty when it has none. */
    const val zoomSoftwareStartDevice = "videoSource.zoom.softwareStartDevice"
    const val ptzZoom = "ptz.zoom"
    const val ptzZoomDevice = "ptz.zoom.device"
    const val encoding = "videoEncoder.encoding"
    const val width = "videoEncoder.resolution.width"
    const val height = "videoEncoder.resolution.height"
    const val frameRate = "videoEncoder.rateControl.frameRateLimit"
    const val bitrateKbps = "videoEncoder.rateControl.bitrateLimit"

    /**
     * The lowest rate adaptation may reach, in kbps, never above `bitrateLimit`. A phone that
     * predates it adapts down to half of `bitrateLimit`, and is read as reporting that.
     */
    const val bitrateFloorKbps = "videoEncoder.rateControl.bitrateFloor"

    /** Whether the phone lowers its rate, never below `bitrateFloor`, while a link backs up. */
    const val adaptiveBitrate = "videoEncoder.rateControl.adaptive"

    /** The rate the encoder is running at, in kbps: `bitrateLimit`, or less while adapting. */
    const val currentBitrateKbps = "videoEncoder.rateControl.currentBitrate"
    const val formatCount = "videoEncoder.formats"
    const val audioEnabled = "audioEncoder.enabled"
    const val audioSampleRate = "audioEncoder.sampleRate"
    const val lensCount = "lens.count"
    const val lensDisabled = "lens.disabled"
    const val streamURL = "stream.url"
    const val streamClients = "stream.clients"

    /**
     * Test only: frames per second to deliver to the encoder, `0` for every frame. See
     * [FrameDeliveryThrottle]. Off at every launch.
     */
    const val testDeliveredFrameRate = "test.deliveredFrameRate"

    /**
     * Test only: `low:high:periodSeconds`, a delivered rate swinging between the two, or empty for
     * none. Wins over `test.deliveredFrameRate` while set.
     */
    const val testDeliveredFrameRateSwing = "test.deliveredFrameRateSwing"

    /**
     * Frames per second actually reaching the encoder over the last two seconds, throttled or not;
     * empty until two have.
     */
    const val testDeliveredFrameRateActual = "test.deliveredFrameRate.actual"

    const val wildcard = "*"

    fun format(index: Int, field: String): String = "format.$index.$field"
    fun lens(index: Int, field: String): String = "lens.$index.$field"

    val writable: Set<String> = setOf(
        deviceName, sourcePosition, ptzZoom, encoding, width, height, frameRate, bitrateKbps,
        bitrateFloorKbps, adaptiveBitrate, audioEnabled, lensDisabled,
        testDeliveredFrameRate, testDeliveredFrameRateSwing
    )

    /**
     * The fixed names, in the order the full set is emitted. Indexed `format.<i>.*` and `lens.<i>.*`
     * names are recognised by shape.
     */
    val fixed: List<String> = listOf(
        deviceName, deviceCNAME, deviceModel, systemThermal, systemStatus, systemBattery,
        systemBatteryCharging,
        sourcePosition, sourceDeviceType,
        zoomMinimumDevice, zoomMaximumDevice, zoomDisplayMultiplier, zoomSwitchOverDevice,
        zoomSoftwareStartDevice,
        ptzZoom, ptzZoomDevice,
        encoding, width, height, frameRate, bitrateKbps, bitrateFloorKbps, adaptiveBitrate,
        currentBitrateKbps, formatCount,
        audioEnabled, audioSampleRate,
        lensCount, lensDisabled,
        streamURL, streamClients,
        testDeliveredFrameRate, testDeliveredFrameRateSwing, testDeliveredFrameRateActual
    )

    internal val formatFields = listOf("width", "height", "frameRate", "multiLens")
    internal val lensFields =
        listOf("id", "position", "deviceType", "title", "displayedZoom", "focalLengthMM", "native")

    fun isKnown(name: String): Boolean {
        if (name in fixed) return true
        return indexedField(name, "format", formatFields) != null ||
            indexedField(name, "lens", lensFields) != null
    }

    fun isReadOnly(name: String): Boolean = name !in writable

    private fun indexedField(name: String, prefix: String, fields: List<String>): Pair<Int, String>? {
        val parts = name.split(".")
        if (parts.size != 3 || parts[0] != prefix) return null
        val index = parts[1].toIntOrNull() ?: return null
        if (index < 0 || parts[2] !in fields) return null
        return index to parts[2]
    }
}

/**
 * Everything the phone reports, as one value. The phone builds it from `AppEnvironment`; a remote
 * client rebuilds it from a `GET_PARAMETER *` body.
 */
data class CameraSnapshot(
    val name: String,
    val cname: String,
    val model: String,
    /** `ProcessLoad.thermalStateName`: `nominal` / `fair` / `serious` / `critical`. */
    val thermalName: String,
    val status: String,
    /** Null when the phone cannot read it. */
    val battery: BatteryStatus? = null,
    val position: CameraPosition,
    val deviceType: String,
    val mapping: ZoomMapping,
    val deviceZoom: Double,
    val settings: StreamSettings,
    val formats: List<FormatCatalogue.Option>,
    val lenses: List<CameraLens>,
    val streamURL: String,
    val clientCount: Int,
    /**
     * What the encoder is running at, which is below `settings.bitrate` while adapting. Null from a
     * phone that predates adaptation, which always runs at `settings.bitrate`.
     */
    val currentBitrate: Int? = null,
    /** The test throttle's setting. Off from a phone that predates it. */
    val frameDelivery: FrameDelivery = FrameDelivery.off,
    /** Frames per second reaching the encoder. Null until measured, and from a phone that predates it. */
    val deliveredFrameRate: Double? = null
) {
    val displayedZoom: Double get() = mapping.displayedZoom(deviceZoom)
}

/**
 * What a `SET_PARAMETER` asked for, typed. Only the fields named in the request are non-null, so
 * the phone applies exactly what was sent and nothing it was not asked to touch.
 */
data class CameraParameterWrite(
    val name: String? = null,
    val position: CameraPosition? = null,
    /** Displayed units, not yet clamped: clamping needs the mapping, which is the snapshot's. */
    val displayedZoom: Double? = null,
    val codec: StreamCodec? = null,
    val width: Int? = null,
    val height: Int? = null,
    val frameRate: Double? = null,
    /** Bits per second, converted from the wire's kbps. */
    val bitrate: Int? = null,
    /** Bits per second, converted from the wire's kbps. */
    val bitrateFloor: Int? = null,
    val adaptiveBitrate: Boolean? = null,
    val audioEnabled: Boolean? = null,
    val disabledLensIDs: Set<String>? = null,
    /** Frames per second for the test throttle, 0 for off. */
    val deliveredFrameRate: Double? = null,
    /** The test throttle's swing as canonical `low:high:period` text, or empty to clear it. */
    val deliveredFrameRateSwing: String? = null,
    /** The names in the request, in order, so the reply can echo exactly those. */
    val requestedNames: List<String> = emptyList()
) {
    val isEmpty: Boolean
        get() = name == null && position == null && displayedZoom == null && codec == null &&
            width == null && height == null && frameRate == null && bitrate == null &&
            bitrateFloor == null && adaptiveBitrate == null && audioEnabled == null &&
            disabledLensIDs == null && !touchesFrameDelivery

    /**
     * True when the request names the test throttle. Never a settings change: the throttle leaves
     * the format, the session and the saved settings alone.
     */
    val touchesFrameDelivery: Boolean
        get() = deliveredFrameRate != null || deliveredFrameRateSwing != null

    /**
     * True when anything in [StreamSettings] is named, i.e. the phone should run one
     * `applySettings()` after the merge.
     */
    val touchesSettings: Boolean
        get() = codec != null || width != null || height != null || frameRate != null ||
            bitrate != null || bitrateFloor != null || adaptiveBitrate != null ||
            audioEnabled != null || disabledLensIDs != null
}

object CameraParameters {
    const val contentType = "text/parameters"
    const val controlVersion = "params/1"
    const val minimumBitrateKbps = 1_000
    const val maximumBitrateKbps = StreamSettings.maximumBitrate / 1000

    // MARK: - Encode

    /** The whole set, in table order. */
    fun encode(snapshot: CameraSnapshot): CameraParameterSet {
        val set = CameraParameterSet()
        val s = snapshot.settings
        set.set(CameraParameterName.deviceName, snapshot.name)
        set.set(CameraParameterName.deviceCNAME, snapshot.cname)
        set.set(CameraParameterName.deviceModel, snapshot.model)
        set.set(CameraParameterName.systemThermal, snapshot.thermalName)
        set.set(CameraParameterName.systemStatus, snapshot.status)
        set.set(CameraParameterName.systemBattery, snapshot.battery?.percent?.toString() ?: "")
        set.set(CameraParameterName.systemBatteryCharging, bool(snapshot.battery?.isCharging ?: false))
        set.set(CameraParameterName.sourcePosition, snapshot.position.rawValue)
        set.set(CameraParameterName.sourceDeviceType, snapshot.deviceType)
        set.set(CameraParameterName.zoomMinimumDevice, number(snapshot.mapping.minimumDeviceZoom))
        set.set(CameraParameterName.zoomMaximumDevice, number(snapshot.mapping.maximumDeviceZoom))
        set.set(CameraParameterName.zoomDisplayMultiplier, number(snapshot.mapping.displayMultiplier))
        set.set(
            CameraParameterName.zoomSwitchOverDevice,
            snapshot.mapping.switchOverDeviceZooms.joinToString(",") { number(it) }
        )
        set.set(
            CameraParameterName.zoomSoftwareStartDevice,
            snapshot.mapping.softwareZoomStartDeviceZoom?.let { number(it) } ?: ""
        )
        set.set(CameraParameterName.ptzZoom, number(snapshot.displayedZoom))
        set.set(CameraParameterName.ptzZoomDevice, number(snapshot.deviceZoom))
        set.set(CameraParameterName.encoding, s.codec.sdpEncodingName)
        set.set(CameraParameterName.width, s.width.toString())
        set.set(CameraParameterName.height, s.height.toString())
        set.set(CameraParameterName.frameRate, number(s.frameRate))
        set.set(CameraParameterName.bitrateKbps, (s.bitrate / 1000).toString())
        set.set(CameraParameterName.bitrateFloorKbps, (s.bitrateFloor / 1000).toString())
        set.set(CameraParameterName.adaptiveBitrate, bool(s.adaptiveBitrate))
        set.set(
            CameraParameterName.currentBitrateKbps,
            ((snapshot.currentBitrate ?: s.bitrate) / 1000).toString()
        )
        set.set(CameraParameterName.formatCount, snapshot.formats.size.toString())
        snapshot.formats.forEachIndexed { index, format ->
            set.set(CameraParameterName.format(index, "width"), format.width.toString())
            set.set(CameraParameterName.format(index, "height"), format.height.toString())
            set.set(CameraParameterName.format(index, "frameRate"), number(format.frameRate))
            set.set(CameraParameterName.format(index, "multiLens"), bool(format.supportsMultiLensSwitching))
        }
        set.set(CameraParameterName.audioEnabled, bool(s.audioEnabled))
        set.set(CameraParameterName.audioSampleRate, s.audioSampleRate.toString())
        set.set(CameraParameterName.lensCount, snapshot.lenses.size.toString())
        snapshot.lenses.forEachIndexed { index, lens ->
            set.set(CameraParameterName.lens(index, "id"), lens.id)
            set.set(CameraParameterName.lens(index, "position"), lens.position.rawValue)
            // Camera2 has no device-type vocabulary; the physical camera id is what it knows a lens
            // by, and it is the same string the iOS build carries as `uniqueDeviceID`.
            set.set(CameraParameterName.lens(index, "deviceType"), lens.physicalCameraID)
            set.set(CameraParameterName.lens(index, "title"), lens.title)
            set.set(CameraParameterName.lens(index, "displayedZoom"), number(lens.displayedZoom))
            set.set(CameraParameterName.lens(index, "focalLengthMM"), lens.focalLengthMM?.toString() ?: "")
            // Camera2 publishes no secondary native crops, so no Android lens is one. See
            // `CameraLens` for why the row is not invented.
            set.set(CameraParameterName.lens(index, "native"), bool(false))
        }
        set.set(CameraParameterName.lensDisabled, s.disabledLensIDs.sorted().joinToString(","))
        set.set(CameraParameterName.streamURL, snapshot.streamURL)
        set.set(CameraParameterName.streamClients, snapshot.clientCount.toString())
        set.set(CameraParameterName.testDeliveredFrameRate, number(snapshot.frameDelivery.frameRate))
        set.set(CameraParameterName.testDeliveredFrameRateSwing, snapshot.frameDelivery.swing?.text ?: "")
        set.set(
            CameraParameterName.testDeliveredFrameRateActual,
            snapshot.deliveredFrameRate?.let { number(Math.round(it * 10) / 10.0) } ?: ""
        )
        return set
    }

    // MARK: - Decode (client side)

    /**
     * Rebuilds the phone's state from a full `GET_PARAMETER *` body. Null when a field the screen
     * cannot do without is missing or malformed; a partial answer is worse than none, because the
     * rail would be drawn from a mapping that is half defaults.
     */
    fun decodeSnapshot(set: CameraParameterSet): CameraSnapshot? {
        val name = set[CameraParameterName.deviceName] ?: return null
        val cname = set[CameraParameterName.deviceCNAME] ?: return null
        val position = set[CameraParameterName.sourcePosition]
            ?.let { CameraPosition.fromRawValue(it) } ?: return null
        val minimum = set[CameraParameterName.zoomMinimumDevice]?.toDoubleOrNull() ?: return null
        val maximum = set[CameraParameterName.zoomMaximumDevice]?.toDoubleOrNull() ?: return null
        val multiplier = set[CameraParameterName.zoomDisplayMultiplier]?.toDoubleOrNull() ?: return null
        val deviceZoom = set[CameraParameterName.ptzZoomDevice]?.toDoubleOrNull() ?: return null
        val codec = set[CameraParameterName.encoding]
            ?.let { StreamCodec.fromSdpEncodingName(it) } ?: return null
        val width = set[CameraParameterName.width]?.toIntOrNull() ?: return null
        val height = set[CameraParameterName.height]?.toIntOrNull() ?: return null
        val frameRate = set[CameraParameterName.frameRate]?.toDoubleOrNull() ?: return null
        val bitrateKbps = set[CameraParameterName.bitrateKbps]?.toIntOrNull() ?: return null

        val switchOvers = (set[CameraParameterName.zoomSwitchOverDevice] ?: "")
            .split(",")
            .mapNotNull { it.trim().toDoubleOrNull() }
        val mapping = ZoomMapping(
            minimumDeviceZoom = minimum,
            maximumDeviceZoom = maximum,
            displayMultiplier = multiplier,
            switchOverDeviceZooms = switchOvers,
            softwareZoomStartDeviceZoom = set[CameraParameterName.zoomSoftwareStartDevice]?.toDoubleOrNull()
        )

        val formats = ArrayList<FormatCatalogue.Option>()
        val formatCount = set[CameraParameterName.formatCount]?.toIntOrNull() ?: 0
        for (index in 0 until maxOf(formatCount, 0)) {
            val w = set[CameraParameterName.format(index, "width")]?.toIntOrNull() ?: continue
            val h = set[CameraParameterName.format(index, "height")]?.toIntOrNull() ?: continue
            val fps = set[CameraParameterName.format(index, "frameRate")]?.toDoubleOrNull() ?: continue
            formats.add(
                FormatCatalogue.Option(
                    width = w,
                    height = h,
                    frameRate = fps,
                    supportsMultiLensSwitching =
                        parseBool(set[CameraParameterName.format(index, "multiLens")]) ?: true
                )
            )
        }

        val lenses = ArrayList<CameraLens>()
        val lensCount = set[CameraParameterName.lensCount]?.toIntOrNull() ?: 0
        for (index in 0 until maxOf(lensCount, 0)) {
            val id = set[CameraParameterName.lens(index, "id")] ?: continue
            val lensPosition = set[CameraParameterName.lens(index, "position")]
                ?.let { CameraPosition.fromRawValue(it) } ?: continue
            val displayed = set[CameraParameterName.lens(index, "displayedZoom")]?.toDoubleOrNull()
                ?: continue
            lenses.add(
                CameraLens(
                    id = id,
                    position = lensPosition,
                    physicalCameraID = set[CameraParameterName.lens(index, "deviceType")] ?: id,
                    focalLengthMM = set[CameraParameterName.lens(index, "focalLengthMM")]?.toIntOrNull(),
                    displayedZoom = displayed,
                    deviceZoom = mapping.deviceZoom(displayed)
                )
            )
        }

        val streamURL = set[CameraParameterName.streamURL] ?: ""
        val (port, path) = portAndPath(streamURL)
        val settings = StreamSettings(
            width = width,
            height = height,
            frameRate = frameRate,
            codec = codec,
            bitrate = bitrateKbps * 1000,
            // Absent from a phone that predates the setting, which adapts down to half the rate.
            bitrateFloor = set[CameraParameterName.bitrateFloorKbps]?.toIntOrNull()?.let { it * 1000 }
                ?: StreamSettings.defaultBitrateFloor(bitrateKbps * 1000),
            // Absent from a phone that predates adaptation, which never adapts.
            adaptiveBitrate = parseBool(set[CameraParameterName.adaptiveBitrate]) ?: false,
            port = port ?: StreamSettings.defaultPort,
            path = path ?: StreamSettings.canonicalPath,
            audioEnabled = parseBool(set[CameraParameterName.audioEnabled]) ?: true,
            videoEnabled = true,
            audioSampleRate = set[CameraParameterName.audioSampleRate]?.toIntOrNull() ?: 48_000,
            disabledLensIDs = idSet(set[CameraParameterName.lensDisabled]),
            cameraPosition = position,
            displayedZoom = mapping.displayedZoom(deviceZoom)
        )

        return CameraSnapshot(
            name = name,
            cname = cname,
            model = set[CameraParameterName.deviceModel] ?: "",
            thermalName = set[CameraParameterName.systemThermal] ?: "nominal",
            status = set[CameraParameterName.systemStatus] ?: "",
            battery = set[CameraParameterName.systemBattery]?.toIntOrNull()?.let {
                BatteryStatus.of(
                    it,
                    parseBool(set[CameraParameterName.systemBatteryCharging]) ?: false
                )
            },
            position = position,
            deviceType = set[CameraParameterName.sourceDeviceType] ?: "",
            mapping = mapping,
            deviceZoom = deviceZoom,
            settings = settings,
            formats = formats,
            lenses = lenses,
            streamURL = streamURL,
            clientCount = set[CameraParameterName.streamClients]?.toIntOrNull() ?: 0,
            currentBitrate = set[CameraParameterName.currentBitrateKbps]?.toIntOrNull()?.let { it * 1000 },
            frameDelivery = FrameDelivery(
                frameRate = set[CameraParameterName.testDeliveredFrameRate]?.toDoubleOrNull() ?: 0.0,
                swing = set[CameraParameterName.testDeliveredFrameRateSwing]?.let { FrameRateSwing.parse(it) }
            ),
            deliveredFrameRate = set[CameraParameterName.testDeliveredFrameRateActual]?.toDoubleOrNull()
        )
    }

    // MARK: - GET

    /**
     * Answers a `GET_PARAMETER` body against a snapshot. `*` is everything; otherwise the named
     * parameters in request order. An unknown name is a `451` and nothing is returned, so a client
     * never has to guess which half took.
     */
    fun respondToGet(body: String, snapshot: CameraSnapshot): ParameterOutcome<CameraParameterSet> {
        val names = CameraParameterSet.decodeNames(body)
        val everything = encode(snapshot)
        if (names == listOf(CameraParameterName.wildcard)) return ParameterOutcome.Success(everything)
        val subset = CameraParameterSet()
        for (name in names) {
            val value = if (name == CameraParameterName.wildcard) null else everything[name]
            if (value == null) {
                return ParameterOutcome.Failure(
                    CameraParameterError(
                        CameraParameterError.Kind.NOT_UNDERSTOOD,
                        name,
                        "unknown parameter"
                    )
                )
            }
            subset.set(name, value)
        }
        return ParameterOutcome.Success(subset)
    }

    // MARK: - SET

    /**
     * Parses and validates a `SET_PARAMETER` body against the current snapshot. All or nothing: the
     * first offending line is reported and no field is applied.
     */
    fun parseSet(body: String, snapshot: CameraSnapshot): ParameterOutcome<CameraParameterWrite> {
        val set = when (val decoded = CameraParameterSet.decode(body)) {
            is ParameterOutcome.Success -> decoded.value
            is ParameterOutcome.Failure -> return decoded
        }

        var write = CameraParameterWrite(requestedNames = set.names)

        for ((name, value) in set.pairs) {
            if (!CameraParameterName.isKnown(name)) {
                return ParameterOutcome.Failure(
                    CameraParameterError(CameraParameterError.Kind.NOT_UNDERSTOOD, name, "unknown parameter")
                )
            }
            if (CameraParameterName.isReadOnly(name)) {
                return ParameterOutcome.Failure(
                    CameraParameterError(CameraParameterError.Kind.READ_ONLY, name, "read-only parameter")
                )
            }
            fun bad(detail: String): ParameterOutcome.Failure =
                ParameterOutcome.Failure(CameraParameterError(CameraParameterError.Kind.BAD_REQUEST, name, detail))

            when (name) {
                CameraParameterName.deviceName -> write = write.copy(name = value)

                CameraParameterName.sourcePosition -> {
                    val position = CameraPosition.fromRawValue(value) ?: return bad("expected back or front")
                    write = write.copy(position = position)
                }

                CameraParameterName.ptzZoom -> {
                    val zoom = value.toDoubleOrNull()
                    if (zoom == null || !zoom.isFinite() || zoom <= 0) return bad("expected a positive number")
                    write = write.copy(displayedZoom = zoom)
                }

                CameraParameterName.encoding -> {
                    val codec = StreamCodec.fromSdpEncodingName(value) ?: return bad("expected H264 or H265")
                    write = write.copy(codec = codec)
                }

                CameraParameterName.width -> {
                    val width = value.toIntOrNull()
                    if (width == null || width <= 0) return bad("expected a positive integer")
                    write = write.copy(width = width)
                }

                CameraParameterName.height -> {
                    val height = value.toIntOrNull()
                    if (height == null || height <= 0) return bad("expected a positive integer")
                    write = write.copy(height = height)
                }

                CameraParameterName.frameRate -> {
                    val rate = value.toDoubleOrNull()
                    if (rate == null || !rate.isFinite() || rate <= 0) return bad("expected a positive number")
                    write = write.copy(frameRate = rate)
                }

                CameraParameterName.bitrateKbps -> {
                    val kbps = value.toIntOrNull() ?: return bad("expected an integer in kbps")
                    if (kbps !in minimumBitrateKbps..maximumBitrateKbps) {
                        return bad("expected $minimumBitrateKbps…$maximumBitrateKbps kbps")
                    }
                    write = write.copy(bitrate = kbps * 1000)
                }

                CameraParameterName.bitrateFloorKbps -> {
                    val kbps = value.toIntOrNull() ?: return bad("expected an integer in kbps")
                    if (kbps !in minimumBitrateKbps..maximumBitrateKbps) {
                        return bad("expected $minimumBitrateKbps…$maximumBitrateKbps kbps")
                    }
                    write = write.copy(bitrateFloor = kbps * 1000)
                }

                CameraParameterName.adaptiveBitrate -> {
                    val enabled = parseBool(value) ?: return bad("expected true or false")
                    write = write.copy(adaptiveBitrate = enabled)
                }

                CameraParameterName.audioEnabled -> {
                    val enabled = parseBool(value) ?: return bad("expected true or false")
                    write = write.copy(audioEnabled = enabled)
                }

                CameraParameterName.lensDisabled -> {
                    val ids = idSet(value)
                    val known = snapshot.lenses.map { it.id }.toSet()
                    if (known.isNotEmpty()) {
                        val unknown = ids.sorted().firstOrNull { it !in known }
                        if (unknown != null) return bad("unknown lens id $unknown")
                    }
                    val selection = LensSelection(ids)
                    for (position in CameraPosition.entries) {
                        if (snapshot.lenses.any { it.position == position } &&
                            !selection.hasEnabledLens(position, snapshot.lenses)
                        ) {
                            return bad("would disable the last ${position.rawValue} lens")
                        }
                    }
                    write = write.copy(disabledLensIDs = ids)
                }

                CameraParameterName.testDeliveredFrameRate -> {
                    val rate = value.toDoubleOrNull()
                    if (rate == null || (rate != 0.0 && !FrameDelivery.accepts(rate))) {
                        return bad(
                            "expected 0 for off, or ${number(FrameDelivery.minimumRate)}…" +
                                "${number(FrameDelivery.maximumRate)} frames per second"
                        )
                    }
                    write = write.copy(deliveredFrameRate = rate)
                }

                CameraParameterName.testDeliveredFrameRateSwing -> {
                    val swing = if (value.isEmpty()) "" else FrameRateSwing.parse(value)?.text
                        ?: return bad("expected low:high:periodSeconds with low ≤ high, or empty for none")
                    write = write.copy(deliveredFrameRateSwing = swing)
                }

                else -> return ParameterOutcome.Failure(
                    CameraParameterError(CameraParameterError.Kind.READ_ONLY, name, "read-only parameter")
                )
            }
        }

        // A format is only valid as a whole: width, height and rate together must name something
        // the camera offers. Fields not in the request keep their current values.
        if ((write.width != null || write.height != null || write.frameRate != null) &&
            snapshot.formats.isNotEmpty()
        ) {
            val width = write.width ?: snapshot.settings.width
            val height = write.height ?: snapshot.settings.height
            val rate = write.frameRate ?: snapshot.settings.frameRate
            val offered = snapshot.formats.any {
                it.width == width && it.height == height && abs(it.frameRate - rate) < 0.01
            }
            if (!offered) {
                val name = when {
                    write.frameRate != null -> CameraParameterName.frameRate
                    write.height != null -> CameraParameterName.height
                    else -> CameraParameterName.width
                }
                return ParameterOutcome.Failure(
                    CameraParameterError(
                        CameraParameterError.Kind.BAD_REQUEST,
                        name,
                        "${width}x$height@${number(rate)} is not an offered format"
                    )
                )
            }
        }

        // A named floor is judged against the rate it will sit under, which is the request's own
        // rate when it names one: raising both in one request is fine even if the new floor is
        // above the old rate. A request that names only the rate is never refused for the floor,
        // which comes down with it, so a client that predates the floor can still lower the rate.
        val floor = write.bitrateFloor
        if (floor != null) {
            val ceiling = settings(write, snapshot.settings).bitrate
            if (floor > ceiling) {
                return ParameterOutcome.Failure(
                    CameraParameterError(
                        CameraParameterError.Kind.BAD_REQUEST,
                        CameraParameterName.bitrateFloorKbps,
                        "${floor / 1000} kbps is above the ${ceiling / 1000} kbps bitrateLimit"
                    )
                )
            }
        }

        return ParameterOutcome.Success(write)
    }

    /**
     * The stream settings after a write, with the codec change carrying its default bitrate across
     * exactly as the Settings picker does. Zoom and position are not settings; they are applied by
     * the capture session.
     */
    fun settings(applying: CameraParameterWrite, to: StreamSettings): StreamSettings {
        val next = to.copy()
        applying.codec?.let { next.selectCodec(it) }
        applying.width?.let { next.width = it }
        applying.height?.let { next.height = it }
        applying.frameRate?.let { next.frameRate = it }
        // After `selectCodec`, so an explicit rate in the same request wins over the codec default,
        // and the floor after the rate, so an explicit floor wins over the one the rate carried.
        applying.bitrate?.let { next.selectBitrate(it) }
        applying.bitrateFloor?.let { next.bitrateFloor = it }
        next.clampFloorToCeiling()
        applying.adaptiveBitrate?.let { next.adaptiveBitrate = it }
        applying.audioEnabled?.let { next.audioEnabled = it }
        applying.disabledLensIDs?.let { next.disabledLensIDs = it }
        return next
    }

    /** The test throttle after a write. Fields not in the request keep their current values. */
    fun frameDelivery(applying: CameraParameterWrite, to: FrameDelivery): FrameDelivery {
        var next = to
        applying.deliveredFrameRate?.let { next = next.copy(frameRate = it) }
        applying.deliveredFrameRateSwing?.let { next = next.copy(swing = FrameRateSwing.parse(it)) }
        return next
    }

    /**
     * The snapshot as it will be once the write has taken: settings merged, zoom clamped to the
     * mapping, position and name replaced. Used to echo applied values in the `SET` reply before
     * the capture thread has published them.
     */
    fun snapshot(applying: CameraParameterWrite, to: CameraSnapshot): CameraSnapshot {
        val settings = settings(applying, to.settings)
        val name = applying.name?.let { DeviceIdentity.normalized(it, to.cname) } ?: to.name
        val position = applying.position ?: to.position
        val deviceZoom = applying.displayedZoom
            ?.let { to.mapping.clampDeviceZoom(to.mapping.deviceZoom(it)) }
            ?: to.deviceZoom
        settings.cameraPosition = position
        settings.displayedZoom = to.mapping.displayedZoom(deviceZoom)
        return to.copy(
            name = name,
            position = position,
            deviceZoom = deviceZoom,
            settings = settings,
            frameDelivery = frameDelivery(applying, to.frameDelivery)
        )
    }

    /** The reply body for a successful `SET`: the requested names with their as-applied values. */
    fun echo(write: CameraParameterWrite, applied: CameraSnapshot): CameraParameterSet {
        val everything = encode(applied)
        val subset = CameraParameterSet()
        for (name in write.requestedNames) {
            everything[name]?.let { subset.set(name, it) }
        }
        return subset
    }

    // MARK: - Formatting

    /** `1`, `0.5`, `2.75`: integers without a decimal point, otherwise up to three places, trimmed. */
    fun number(value: Double): String {
        if (!value.isFinite()) return "0"
        if (value == Math.rint(value) && abs(value) < 1e15) return value.toLong().toString()
        var text = String.format(Locale.US, "%.3f", value)
        while (text.endsWith("0")) text = text.dropLast(1)
        if (text.endsWith(".")) text = text.dropLast(1)
        return text
    }

    internal fun bool(value: Boolean): String = if (value) "true" else "false"

    internal fun parseBool(value: String?): Boolean? = when (value?.lowercase(Locale.US)) {
        "true", "1", "yes", "on" -> true
        "false", "0", "no", "off" -> false
        else -> null
    }

    internal fun idSet(value: String?): Set<String> =
        (value ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() }.toSet()

    internal fun portAndPath(url: String): Pair<Int?, String?> {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null to null
        val port = uri.port.takeIf { it > 0 }
        val path = uri.path?.takeIf { it.isNotEmpty() }
        return port to path
    }
}

/**
 * ONVIF `VideoEncoding` / SDP encoding name in either case: `H264`, `H265`, and `HEVC` as a
 * courtesy.
 */
fun StreamCodec.Companion.fromSdpEncodingName(name: String): StreamCodec? =
    when (name.uppercase(Locale.US)) {
        "H264" -> StreamCodec.H264
        "H265", "HEVC" -> StreamCodec.HEVC
        else -> null
    }
