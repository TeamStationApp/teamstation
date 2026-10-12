package app.teamstation.cameraman.core

import app.teamstation.streamcore.core.SettingsStore

/**
 * When the RTSP listener is up, and when the Android service is allowed to outlive the activity.
 *
 * An operator launch follows the saved choice, and a camera that has never been told to broadcast
 * stays quiet. A UI test or a loopback probe needs the listener without writing that choice, so the
 * next ordinary launch is still quiet. A recording run writes a file and must not bind the port.
 */
object BroadcastPolicy {
    const val preferenceKey = "app.teamstation.cameraman.broadcasting"

    /** How far the stop slider has to travel before it commits. Matches TS Director. */
    const val slideCommitFraction = 0.8

    fun shouldListen(
        saved: Boolean,
        isUITest: Boolean,
        selfTest: Boolean,
        recordSeconds: Double
    ): Boolean {
        if (recordSeconds > 0) return false
        if (isUITest || selfTest) return true
        return saved
    }

    /** The operator's choice is written. A harness launch is not, even when it is listening. */
    fun shouldPersist(persistSettings: Boolean, isUITest: Boolean, selfTest: Boolean): Boolean =
        persistSettings && !isUITest && !selfTest

    /**
     * The process is restarted after a kill only while a broadcast is supposed to keep going.
     * Otherwise a swipe or a home press is the end of the camera, which is the battery saving.
     */
    fun keepProcessAlive(broadcasting: Boolean): Boolean = broadcasting

    /**
     * The service holds the camera for the preview while the activity is open. Once the activity
     * is gone, only a broadcast keeps it.
     */
    fun shouldStopService(activityVisible: Boolean, broadcasting: Boolean): Boolean =
        !activityVisible && !broadcasting

    fun slideCommits(progress: Double): Boolean = progress >= slideCommitFraction
}

/**
 * Whether the activity is in the foreground. The service and the activity share a process, and a
 * fresh process — including a sticky restart with no activity — begins with this false.
 */
object ActivityPresence {
    @Volatile
    var visible: Boolean = false
}

/** The saved broadcast choice, beside the stream settings and not inside them. */
class BroadcastPreference(private val store: SettingsStore) {
    fun load(): Boolean = store.string(BroadcastPolicy.preferenceKey) == "true"

    fun save(broadcasting: Boolean) {
        store.setString(if (broadcasting) "true" else "false", BroadcastPolicy.preferenceKey)
    }
}
