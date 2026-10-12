package app.teamstation.streamcore.phonestream

import app.teamstation.streamcore.core.CameraLens

/** What the streaming screen draws, four times a second. */
data class PhoneStreamStatus(
    /** The stream: `idle`, `connecting`, `live` or `retrying`. */
    val phase: String = "idle",
    /** While `retrying`, how long until the next redial. */
    val retryInSeconds: Double? = null,
    /** What the stream's encoder has been told, 0 while not streaming. */
    val bitrateKbps: Int = 0,
    val displayedZoom: Double = 1.0,
    val lensLabel: String = "1x",
    /** Null when the system does not know. */
    val batteryPercent: Int? = null,
    val charging: Boolean = false,
    /** `cool`, `fair`, `warm` or `hot`: Cameraman's four levels. */
    val thermal: String = "cool",
    /** How long the take has been recording, counted from its start, 0 while not recording. */
    val recordingSeconds: Double = 0.0,
    val isRecording: Boolean = false,
    val error: PhoneStreamError? = null
)

/** What went wrong, as a code the screen words for itself. */
enum class PhoneStreamError(val rawValue: String) {
    /** The server ended this camera (410): the pill reads "Stream ended", and the recording goes on. */
    STREAM_ENDED("streamEnded"),

    /** A part finished because free space fell below 500 MB; the stream goes on. */
    RECORDING_STOPPED_LOW_STORAGE("recordingStoppedLowStorage"),

    /** Recording would not start with under 2 GB free. */
    INSUFFICIENT_STORAGE("insufficientStorage"),

    /**
     * The camera stopped on its own (another app took it, or it failed) and is being opened again:
     * Record is refused, and a recording pauses until it is back.
     */
    CAMERA_UNAVAILABLE("cameraUnavailable"),

    /**
     * The take of this stream is being uploaded, or its upload was cut off and will resume: no part
     * may be added after the export being sent was made.
     */
    UPLOAD_IN_PROGRESS("uploadInProgress"),

    /** The stream could not be put on the air, and will not be retried. */
    STREAM_FAILED("streamFailed"),

    /** The recording's writer could not start. */
    RECORDING_FAILED("recordingFailed"),

    /** `startRecording` before `open`, or a second `startRecording`. */
    NOT_READY("notReady"),

    /** No take of that stream is on this phone. */
    NO_RECORDING("noRecording"),

    /** The stream is being recorded right now; stop it first. */
    STILL_RECORDING("stillRecording")
}

/** A [PhoneStreamError] thrown: what the bridge rejects a call with, by [code]'s raw value. */
class PhoneStreamException(val code: PhoneStreamError, message: String = code.rawValue) : Exception(message)

/** How one upload is going. */
data class PhoneUploadProgress(
    val liveStreamId: String,
    val state: State,
    /** 0…1 of the bytes, while uploading. */
    val fraction: Double = 0.0,
    val bytesSent: Long = 0,
    val bytesTotal: Long = 0,
    /** The server's step once the bytes are in: `assembling`, `remuxing`, …. */
    val step: String? = null,
    val videoId: String? = null,
    val message: String? = null
) {
    enum class State(val rawValue: String) {
        EXPORTING("exporting"),
        UPLOADING("uploading"),
        PROCESSING("processing"),
        UPLOADED("uploaded"),
        FAILED("failed")
    }
}

/** Everything the engine tells its host: the bridge's `onStatus`, `onRadar` and `onUpload`. */
sealed interface PhoneStreamEvent {
    data class Status(val status: PhoneStreamStatus) : PhoneStreamEvent
    data class Radar(val radar: PhoneRadarState) : PhoneStreamEvent
    data class Upload(val upload: PhoneUploadProgress) : PhoneStreamEvent
}

/**
 * What the engine's redial needs to ask the server for this device's stream again: the address, the
 * session's token, and this device's install id and model.
 */
data class PhoneStreamRequest(
    val apiBase: String,
    val token: String,
    val deviceId: String,
    val deviceModel: String = DeviceModelName.current
) {
    /** The server's origin: the clients add `/api/v1` themselves, so a base given with it is taken back. */
    val serverURL: String get() = serverURL(apiBase)

    companion object {
        fun serverURL(apiBase: String): String {
            var text = apiBase.trimEnd('/')
            if (text.endsWith("/api/v1")) text = text.removeSuffix("/api/v1")
            return text
        }
    }
}

/** A take that was rolling when the app stopped, which reopening the streaming screen picks up. */
data class PhoneInterruptedSession(
    val liveStreamId: String,
    val gameId: String,
    val angleName: String,
    /** The take that continues, null when only the stream was on the air. */
    val recordingID: Long?,
    /** Whether the stream was on the air too. */
    val streaming: Boolean,
    /** How long the app was away, in seconds. */
    val downtime: Double
)

/**
 * The zoom rail the overlay draws: its pills, where the lenses hand over, and where the camera's own
 * range ends and digital zoom begins, all in displayed units.
 */
data class PhoneZoomScale(
    val presets: List<Double>,
    val switchOvers: List<Double>,
    /** Where digital zoom starts, null when the camera has none. */
    val digitalFrom: Double?,
    val minimum: Double,
    val maximum: Double,
    val current: Double
)

/** One lens of the Lenses card, and whether the operator may turn it off. */
data class PhoneLens(val lens: CameraLens, val enabled: Boolean, val canDisable: Boolean)
