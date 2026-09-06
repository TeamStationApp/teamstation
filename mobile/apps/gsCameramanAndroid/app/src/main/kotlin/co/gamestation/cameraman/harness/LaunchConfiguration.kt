package co.gamestation.cameraman.harness

import android.content.Intent
import co.gamestation.cameraman.core.StreamCodec
import co.gamestation.cameraman.core.StreamSettings

/**
 * Launch arguments and environment overrides, so a test run can put the app in a known state
 * without tapping through the UI.
 *
 * Mirrors GS Producer's harness, including the rule that every key is validated: a typo in a launch
 * argument that is silently ignored produces a green run that proved nothing.
 *
 * The keys are the iOS build's keys, so one script drives both. Where they arrive from differs —
 * iOS takes `-key value` off the process arguments and Android takes intent extras, because
 * `adb shell am start --es key value` is the only channel a launcher has:
 *
 * ```
 * adb shell am start -n co.gamestation.cameraman/.MainActivity \
 *   --es uiTest true --es codec hevc --ei rtspPort 8554
 * ```
 */
data class LaunchConfiguration(
    val isUITest: Boolean = false,
    val useSyntheticCamera: Boolean = false,
    val showDebugHUD: Boolean = false,
    /**
     * Runs the capability measurement instead of the camera. It makes every camera and format
     * active in turn, so it is never on by default.
     */
    val measureCapabilities: Boolean = false,
    /**
     * Records this many seconds of the encoder's output to an Annex-B file so it can be pulled off
     * the device and put through ffprobe. Zero means no recording.
     */
    val recordSeconds: Double = 0.0,
    /** Connects to the app's own listener and reports whether it answers. */
    val selfTest: Boolean = false,
    /** NSD advertising, on by default. Off isolates the listener from the advertisement. */
    val advertise: Boolean = true,
    val settings: StreamSettings = StreamSettings.default,
    val cameraName: String? = null,
    /** Pins the identity so a flow can assert an exact CNAME instead of whatever is stored. */
    val identityUUID: String? = null,
    val unknownKeys: List<String> = emptyList()
) {
    companion object {
        val knownKeys = listOf(
            "uiTest",
            "syntheticCamera",
            "rtspPort",
            "rtspPath",
            "codec",
            "bitrateMbps",
            "width",
            "height",
            "frameRate",
            "audioEnabled",
            "cameraName",
            "identityUUID",
            "debugHUD",
            "measureCapabilities",
            "recordSeconds",
            "selfTest",
            "advertise"
        )

        fun from(intent: Intent?): LaunchConfiguration {
            val extras = intent?.extras ?: return LaunchConfiguration()
            val values = HashMap<String, String>()
            for (key in extras.keySet()) {
                // `am start` can pass a value as a string, an int or a boolean depending on which
                // flag was typed, and a harness that only read strings would silently ignore
                // `--ei rtspPort 8554`.
                val value = extras.get(key) ?: continue
                values[key] = value.toString()
            }
            return from(values)
        }

        fun from(values: Map<String, String>): LaunchConfiguration {
            val unknown = values.keys.filterNot { knownKeys.contains(it) }.sorted()

            var settings = StreamSettings.default.copy()
            values["rtspPort"]?.toIntOrNull()?.let { settings.port = it }
            values["rtspPath"]?.let { settings.path = it }
            values["codec"]?.let { StreamCodec.fromRawValue(it) }?.let { settings.selectCodec(it) }
            values["bitrateMbps"]?.toDoubleOrNull()?.let {
                settings.bitrate = (it * 1_000_000).toInt()
            }
            values["width"]?.toIntOrNull()?.let { settings.width = it }
            values["height"]?.toIntOrNull()?.let { settings.height = it }
            values["frameRate"]?.toDoubleOrNull()?.let { settings.frameRate = it }
            bool(values["audioEnabled"])?.let { settings.audioEnabled = it }

            val isUITest = bool(values["uiTest"]) ?: false
            return LaunchConfiguration(
                isUITest = isUITest,
                useSyntheticCamera = bool(values["syntheticCamera"]) ?: false,
                showDebugHUD = bool(values["debugHUD"]) ?: isUITest,
                measureCapabilities = bool(values["measureCapabilities"]) ?: false,
                recordSeconds = values["recordSeconds"]?.toDoubleOrNull() ?: 0.0,
                selfTest = bool(values["selfTest"]) ?: false,
                advertise = bool(values["advertise"]) ?: true,
                settings = settings,
                cameraName = values["cameraName"],
                identityUUID = values["identityUUID"],
                unknownKeys = unknown
            )
        }

        fun bool(value: String?): Boolean? = when (value?.lowercase()) {
            null -> null
            "1", "true", "yes" -> true
            "0", "false", "no" -> false
            else -> null
        }
    }
}
