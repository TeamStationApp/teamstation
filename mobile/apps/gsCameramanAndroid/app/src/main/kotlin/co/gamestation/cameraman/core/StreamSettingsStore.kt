package co.gamestation.cameraman.core

import java.net.URLDecoder
import java.net.URLEncoder
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Where the operator's stream settings are kept between launches.
 *
 * Separate from [IdentityStore] because the two have different lifetimes: the identity is what binds
 * this camera to its tile and must outlive everything it can, while settings are ordinary
 * preferences that should go away with the app.
 */
interface SettingsStore {
    fun string(key: String): String?
    fun setString(value: String, key: String)
}

class InMemorySettingsStore(values: Map<String, String> = emptyMap()) : SettingsStore {
    private val lock = ReentrantLock()
    private val values = values.toMutableMap()

    override fun string(key: String): String? = lock.withLock { values[key] }

    override fun setString(value: String, key: String) {
        lock.withLock { values[key] = value }
    }
}

/**
 * Reads and writes the whole [StreamSettings] as one value.
 *
 * One value rather than a key per field, so a setting added later cannot be half-saved: whatever is
 * stored either decodes into a complete set or is ignored.
 *
 * Every field is read with a default, and that is the load-bearing part. [load] treats a decode
 * failure as "never configured" and the caller then falls back to defaults, so a strict decoder
 * would silently reset every operator setting the first time a field was added.
 *
 * The format is percent-encoded `key=value` pairs rather than JSON, for one reason: `org.json` is an
 * Android stub that returns empty values in a JVM unit-test process, and `core` is the package that
 * has no Android dependencies so that exactly this kind of rule can be tested without a device. A
 * store whose own tests could not run would be the wrong trade for a familiar syntax.
 */
class StreamSettingsStore(private val store: SettingsStore) {

    /** What the operator last chose, or null when this camera has never been configured. */
    fun load(): StreamSettings? {
        val text = store.string(settingsKey) ?: return null
        return runCatching { decode(text) }.getOrNull()
    }

    fun save(settings: StreamSettings) {
        runCatching { store.setString(encode(settings), settingsKey) }
    }

    companion object {
        const val settingsKey = "co.gamestation.cameraman.streamSettings"

        fun encode(settings: StreamSettings): String = listOf(
            "width" to settings.width.toString(),
            "height" to settings.height.toString(),
            "frameRate" to settings.frameRate.toString(),
            "codec" to settings.codec.rawValue,
            "bitrate" to settings.bitrate.toString(),
            "bitrateFloor" to settings.bitrateFloor.toString(),
            "adaptiveBitrate" to settings.adaptiveBitrate.toString(),
            "port" to settings.port.toString(),
            "path" to settings.path,
            "audioEnabled" to settings.audioEnabled.toString(),
            "videoEnabled" to settings.videoEnabled.toString(),
            "audioSampleRate" to settings.audioSampleRate.toString(),
            "disabledLensIDs" to settings.disabledLensIDs.joinToString(","),
            "cameraPosition" to settings.cameraPosition.rawValue,
            "displayedZoom" to settings.displayedZoom.toString()
        ).joinToString("&") { (key, value) -> "$key=${escape(value)}" }

        /** Throws on anything that is not a set of pairs, which [load] reads as "never configured". */
        fun decode(text: String): StreamSettings {
            require(text.isNotEmpty()) { "empty" }
            val values = HashMap<String, String>()
            for (pair in text.split("&")) {
                val separator = pair.indexOf('=')
                require(separator > 0) { "not a key=value pair: $pair" }
                values[pair.substring(0, separator)] = unescape(pair.substring(separator + 1))
            }
            require(values.isNotEmpty()) { "no fields" }

            val defaults = StreamSettings()
            val bitrate = values["bitrate"]?.toIntOrNull() ?: defaults.bitrate
            return StreamSettings(
                width = values["width"]?.toIntOrNull() ?: defaults.width,
                height = values["height"]?.toIntOrNull() ?: defaults.height,
                frameRate = values["frameRate"]?.toDoubleOrNull() ?: defaults.frameRate,
                codec = values["codec"]?.let { StreamCodec.fromRawValue(it) } ?: defaults.codec,
                bitrate = bitrate,
                // Saved before the floor was a setting, when it was always half the ceiling.
                bitrateFloor = values["bitrateFloor"]?.toIntOrNull()
                    ?: StreamSettings.defaultBitrateFloor(bitrate),
                adaptiveBitrate = values["adaptiveBitrate"]?.toBooleanStrictOrNull()
                    ?: defaults.adaptiveBitrate,
                port = values["port"]?.toIntOrNull()
                    ?.takeUnless { it == StreamSettings.retiredPort }
                    ?: defaults.port,
                path = values["path"]?.takeIf { it.isNotEmpty() } ?: defaults.path,
                audioEnabled = values["audioEnabled"]?.toBooleanStrictOrNull()
                    ?: defaults.audioEnabled,
                videoEnabled = values["videoEnabled"]?.toBooleanStrictOrNull()
                    ?: defaults.videoEnabled,
                audioSampleRate = values["audioSampleRate"]?.toIntOrNull()
                    ?: defaults.audioSampleRate,
                disabledLensIDs = values["disabledLensIDs"]
                    ?.split(",")
                    ?.filter { it.isNotEmpty() }
                    ?.toSet()
                    ?: defaults.disabledLensIDs,
                cameraPosition = values["cameraPosition"]
                    ?.let { CameraPosition.fromRawValue(it) }
                    ?: defaults.cameraPosition,
                displayedZoom = values["displayedZoom"]?.toDoubleOrNull() ?: defaults.displayedZoom
            )
        }

        private fun escape(value: String): String = URLEncoder.encode(value, "UTF-8")

        private fun unescape(value: String): String =
            runCatching { URLDecoder.decode(value, "UTF-8") }.getOrDefault(value)
    }
}
