package app.teamstation.streamcore.phonestream

/** The system property that moves the start floor. Exists in debug builds only. */
internal const val START_FLOOR_PROPERTY = "debug.ts.phone.start_floor"

/**
 * The rules this process runs by: [PhoneStorageRules.standard], with the start floor [read] gives
 * for [START_FLOOR_PROPERTY], so a test can reach a streaming-only start on a phone with room to
 * spare. The release source set has no property to read.
 */
internal fun launchStorageRules(read: (String) -> String? = ::systemProperty): PhoneStorageRules {
    val floor = read(START_FLOOR_PROPERTY)?.trim()?.toLongOrNull() ?: return PhoneStorageRules.standard
    return PhoneStorageRules.standard.copy(startFloorBytes = floor)
}

/** `SystemProperties` is not in the public SDK. */
private fun systemProperty(name: String): String? = runCatching {
    Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, name) as String
}.getOrNull()
