package app.teamstation.app.stream

import app.teamstation.streamcore.phonestream.PhoneCapabilities
import app.teamstation.streamcore.phonestream.PhoneInterruptedSession
import app.teamstation.streamcore.phonestream.PhoneLens
import app.teamstation.streamcore.phonestream.PhoneRadarState
import app.teamstation.streamcore.phonestream.PhoneRecording
import app.teamstation.streamcore.phonestream.PhoneStreamRequest
import app.teamstation.streamcore.phonestream.PhoneStreamStatus
import app.teamstation.streamcore.phonestream.PhoneUploadProgress
import app.teamstation.streamcore.phonestream.PhoneZoomScale

/**
 * The engine's values as the plain maps and lists `NativePhoneStream.ts` describes, which the module
 * hands to `Arguments.makeNativeMap`. A missing optional is left out rather than sent as null. Times
 * go to JavaScript in milliseconds since 1970.
 */
object PhoneStreamMaps {
    fun capabilities(capabilities: PhoneCapabilities): Map<String, Any?> =
        mapOf(
            "supported" to capabilities.supported,
            "deviceModel" to capabilities.deviceModel,
            "canRecordLocally" to capabilities.canRecordLocally
        )

    fun status(status: PhoneStreamStatus): Map<String, Any?> =
        present(
            "phase" to status.phase,
            "retryInSeconds" to status.retryInSeconds,
            "bitrateKbps" to status.bitrateKbps.toDouble(),
            "displayedZoom" to status.displayedZoom,
            "lensLabel" to status.lensLabel,
            "batteryPercent" to status.batteryPercent?.toDouble(),
            "charging" to status.charging,
            "thermal" to status.thermal,
            "recordingSeconds" to status.recordingSeconds,
            "isRecording" to status.isRecording,
            "error" to status.error?.rawValue
        )

    fun radar(state: PhoneRadarState): Map<String, Any?> =
        mapOf(
            "enabled" to state.enabled,
            "scanning" to state.scanning,
            "bluetooth" to state.bluetooth,
            "devices" to state.devices.map { device ->
                present(
                    "serial" to device.serial,
                    "connection" to device.connection.name,
                    "batteryPercent" to device.batteryPercent?.toDouble(),
                    "pitchMph" to device.pitchMph?.toDouble(),
                    "exitMph" to device.exitMph?.toDouble(),
                    "readingAt" to device.readingAt?.toDouble()
                )
            },
            "nearby" to state.nearby
        )

    fun upload(upload: PhoneUploadProgress): Map<String, Any?> =
        present(
            "liveStreamId" to upload.liveStreamId,
            "state" to upload.state.rawValue,
            "fraction" to upload.fraction,
            "bytesSent" to upload.bytesSent.toDouble(),
            "bytesTotal" to upload.bytesTotal.toDouble(),
            "step" to upload.step,
            "videoId" to upload.videoId,
            "message" to upload.message
        )

    /** A take, with where its upload stands when one runs in this process: a screen opened part-way through starts from that. */
    fun recording(recording: PhoneRecording, running: Boolean, progress: PhoneUploadProgress? = null): Map<String, Any?> =
        present(
            "liveStreamId" to recording.liveStreamId,
            "gameId" to recording.gameId,
            "angleName" to recording.angleName,
            "startedAt" to recording.startedAt * 1_000,
            "endedAt" to recording.endedAt?.let { it * 1_000 },
            "parts" to recording.parts,
            "uploadId" to recording.uploadId,
            "uploadTitle" to recording.uploadTitle,
            "uploadedAt" to recording.uploadedAt?.let { it * 1_000 },
            "videoId" to recording.videoId,
            "stoppedForLowStorage" to recording.stoppedForLowStorage,
            "publishedOutsideParts" to recording.publishedOutsideParts,
            "uploadRunning" to running,
            "uploadProgress" to progress?.takeIf { running }?.let(::upload)
        )

    fun zoomScale(scale: PhoneZoomScale): Map<String, Any?> =
        present(
            "presets" to scale.presets,
            "switchOvers" to scale.switchOvers,
            "digitalFrom" to scale.digitalFrom,
            "minimum" to scale.minimum,
            "maximum" to scale.maximum,
            "current" to scale.current
        )

    fun lens(lens: PhoneLens): Map<String, Any?> =
        present(
            "id" to lens.lens.id,
            "position" to lens.lens.position.rawValue,
            "title" to lens.lens.title,
            "subtitle" to lens.lens.subtitle,
            "displayedZoom" to lens.lens.displayedZoom,
            "focalLengthMM" to lens.lens.focalLengthMM?.toDouble(),
            "enabled" to lens.enabled,
            "canDisable" to lens.canDisable
        )

    fun interrupted(session: PhoneInterruptedSession): Map<String, Any?> =
        mapOf(
            "liveStreamId" to session.liveStreamId,
            "gameId" to session.gameId,
            "angleName" to session.angleName,
            "streaming" to session.streaming,
            "downtimeSeconds" to session.downtime
        )

    /** The redial's context from JavaScript's `request`; null without an address to ask. */
    fun request(values: Map<String, Any?>, fallbackModel: String): PhoneStreamRequest? {
        val apiBase = (values["apiBase"] as? String)?.takeIf { it.isNotBlank() } ?: return null
        return PhoneStreamRequest(
            apiBase = apiBase,
            token = values["token"] as? String ?: "",
            deviceId = values["deviceId"] as? String ?: "",
            deviceModel = (values["deviceModel"] as? String)?.takeIf { it.isNotBlank() } ?: fallbackModel
        )
    }

    /** Surface rotation (`Surface.ROTATION_*`, 0 to 3) in degrees. */
    fun rotationDegrees(rotation: Int): Int = (rotation.coerceIn(0, 3)) * 90

    private fun present(vararg entries: Pair<String, Any?>): Map<String, Any?> =
        entries.filter { it.second != null }.toMap()
}
