package co.gamestation.cameraman.harness

import java.net.URI
import java.net.URLDecoder

/**
 * Commands a test can send the running app.
 *
 * The camera controls are gestures — a pinch that has to land on the right zoom, a menu that has to
 * be tapped — and asserting on them through the gesture alone conflates "the app got the zoom
 * wrong" with "the tap landed 8 points off". This channel drives the same state directly, so a
 * gesture flow and a state flow can fail independently and say different things.
 */
sealed interface ControlCommand {
    data object DumpState : ControlCommand
    data object FlipCamera : ControlCommand
    data class SetZoom(val displayed: Double) : ControlCommand
    data class SetFormat(val width: Int, val height: Int, val fps: Int) : ControlCommand
    data class SetBitrate(val mbps: Double) : ControlCommand
    data class SetCodec(val codec: String) : ControlCommand
    data class SetName(val name: String) : ControlCommand
    data class SetAudio(val on: Boolean) : ControlCommand

    /**
     * Forces the capture rotation. A measurement tool, not an operator control: it is how the rule
     * in `CameraSession.captureRotation` was established, and how the next handset that disagrees
     * gets measured instead of argued about.
     */
    data class SetRotation(val degrees: Int?) : ControlCommand

    /** The lenses to turn off, by id. An empty list turns them all back on. */
    data class SetLenses(val disabled: List<String>) : ControlCommand

    /** Blanks the encoded picture without stopping capture. */
    data class SetVideo(val on: Boolean) : ControlCommand

    /**
     * Holds outgoing frames back to imitate a congested link. All three in milliseconds; all zero
     * restores immediate delivery.
     */
    data class SetSendDelay(
        val milliseconds: Double,
        val jitter: Double,
        val burst: Double
    ) : ControlCommand

    /**
     * Holds outgoing audio back on its own, leaving the picture alone: a camera whose sound falls
     * behind its picture, which a throttled phone does and a congested link cannot imitate because
     * both streams share one connection.
     */
    data class SetAudioDelay(
        val milliseconds: Double,
        val jitter: Double,
        val burst: Double
    ) : ControlCommand
    data object ForceKeyframe : ControlCommand
    data object Clients : ControlCommand
    data object Reset : ControlCommand
}

object ControlChannel {
    const val scheme = "gscameraman"

    /**
     * Parses `gscameraman://test/<command>?<query>`.
     *
     * `java.net.URI` rather than `android.net.Uri`, which is a stub in a JVM unit-test process and
     * would hand every parsing test a null it then read as "unrecognised command" — a suite that
     * passes by agreeing with itself about nothing.
     *
     * Anything unrecognised returns null rather than being ignored, so a typo in a flow fails where
     * it was typed instead of three assertions later.
     */
    fun command(url: String): ControlCommand? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != scheme) return null

        val action = (uri.path ?: "").trim('/').lowercase()
        val query = parseQuery(uri.rawQuery)

        return when (action) {
            "dump-state" -> ControlCommand.DumpState
            "flip-camera" -> ControlCommand.FlipCamera
            "force-keyframe" -> ControlCommand.ForceKeyframe
            "clients" -> ControlCommand.Clients
            "reset" -> ControlCommand.Reset

            "set-zoom" -> query["displayed"]?.toDoubleOrNull()?.let { ControlCommand.SetZoom(it) }

            "set-format" -> {
                val width = query["width"]?.toIntOrNull()
                val height = query["height"]?.toIntOrNull()
                if (width == null || height == null) {
                    null
                } else {
                    // A format request without a rate means "whatever this size normally runs at",
                    // and 30 is what every size on this hardware normally runs at.
                    ControlCommand.SetFormat(width, height, query["fps"]?.toIntOrNull() ?: 30)
                }
            }

            "set-bitrate" -> query["mbps"]?.toDoubleOrNull()?.let { ControlCommand.SetBitrate(it) }

            "set-codec" -> query["codec"]
                ?.takeIf { it.isNotEmpty() }
                ?.let { ControlCommand.SetCodec(it.lowercase()) }

            // An empty name is a real request — it is how a flow checks the fallback name appears.
            "set-name" -> ControlCommand.SetName(query["name"] ?: "")

            "set-audio" -> query["on"]?.let { ControlCommand.SetAudio(isTruthy(it)) }

            // An empty or absent value clears the override and puts the derived rule back in charge.
            "set-rotation" -> ControlCommand.SetRotation(query["degrees"]?.toIntOrNull())

            "set-lenses" -> ControlCommand.SetLenses(
                (query["disabled"] ?: "")
                    .split(",")
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
            )

            "set-video" -> query["on"]?.let { ControlCommand.SetVideo(isTruthy(it)) }

            // Every field optional so a flow can set only what it is exercising; omitted means zero.
            "set-send-delay" -> ControlCommand.SetSendDelay(
                milliseconds = query["ms"]?.toDoubleOrNull() ?: 0.0,
                jitter = query["jitter"]?.toDoubleOrNull() ?: 0.0,
                burst = query["burst"]?.toDoubleOrNull() ?: 0.0
            )

            "set-audio-delay" -> ControlCommand.SetAudioDelay(
                milliseconds = query["ms"]?.toDoubleOrNull() ?: 0.0,
                jitter = query["jitter"]?.toDoubleOrNull() ?: 0.0,
                burst = query["burst"]?.toDoubleOrNull() ?: 0.0
            )

            else -> null
        }
    }

    private fun parseQuery(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrEmpty()) return emptyMap()
        val result = LinkedHashMap<String, String>()
        for (pair in rawQuery.split("&")) {
            if (pair.isEmpty()) continue
            val separator = pair.indexOf('=')
            // A bare key is a present-but-empty value, which is how `set-name?name=` clears a name.
            val name = if (separator < 0) pair else pair.substring(0, separator)
            val value = if (separator < 0) "" else pair.substring(separator + 1)
            result[decode(name)] = decode(value)
        }
        return result
    }

    private fun decode(value: String): String =
        runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)

    /**
     * `1`, `true` and `yes` all appear in hand-written flows, and a flow that silently reads `yes`
     * as false is a bad way to spend an afternoon.
     */
    private fun isTruthy(value: String): Boolean =
        value.lowercase() in listOf("1", "true", "yes", "on")
}
