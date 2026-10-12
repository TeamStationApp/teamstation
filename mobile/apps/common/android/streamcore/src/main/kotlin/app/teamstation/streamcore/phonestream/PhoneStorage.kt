package app.teamstation.streamcore.phonestream

import android.content.Context
import java.io.File

/**
 * Where a phone keeps its recordings and their catalog: app-private `files/phoneStream/`, which no
 * other app reads and which goes with the app. A two-hour take is gigabytes, and it is on its way to
 * the server anyway.
 */
class PhoneStorage(val root: File) {
    val program: File get() = File(root, "Program")
    val prepared: File get() = File(root, "Prepared")
    val index: File get() = File(root, "index.sqlite")

    /** Where one take's export is written before it is sent. */
    fun export(recordingID: Long): File = File(File(prepared, recordingID.toString()), "programme.mp4")

    fun prepare() {
        for (directory in listOf(root, program, prepared)) directory.mkdirs()
    }

    /** Free space on the volume the recordings are on. */
    fun freeBytes(): Long = root.usableSpace

    companion object {
        fun standard(context: Context): PhoneStorage = PhoneStorage(File(context.filesDir, "phoneStream"))
    }
}

/**
 * When a phone may record, by the space it has left.
 *
 * A recording does not start with under 2 GB free: that is under an hour at 6 Mbps, and a game is
 * longer. A part that is running finishes cleanly when free space falls below 500 MB, which leaves
 * room for its export and for the phone itself; the stream carries on.
 */
data class PhoneStorageRules(val startFloorBytes: Long = 2_000_000_000L, val stopFloorBytes: Long = 500_000_000L) {
    fun canStart(freeBytes: Long): Boolean = freeBytes >= startFloorBytes
    fun mustStop(freeBytes: Long): Boolean = freeBytes < stopFloorBytes

    companion object {
        val standard = PhoneStorageRules()
    }
}

/**
 * The phone's retention: a recording is the higher-quality copy of what the stream published, so it
 * is never deleted before the server has it. One whose upload has been ready for seven days goes on
 * a sweep, files and rows; nothing else is ever swept.
 *
 * TS Director's `RetentionPolicy` reclaims camera archive segments, which a phone never writes, so
 * the phone's rule is its own.
 */
class PhoneRetentionPolicy(val keepUploadedSeconds: Double = defaultKeepUploadedSeconds) {
    /** The recordings to delete at [now]: uploaded, ready for at least the keep, and not [protecting]. */
    fun expired(recordings: List<PhoneRecording>, now: Double, protecting: Set<Long> = emptySet()): List<PhoneRecording> =
        recordings.filter { recording ->
            val uploadedAt = recording.uploadedAt ?: return@filter false
            recording.recordingID !in protecting && now - uploadedAt >= keepUploadedSeconds
        }

    /** Deletes what [expired] names, files and rows. Answers how many went. */
    fun sweep(catalog: PhoneCatalog, storage: PhoneStorage, now: Double, protecting: Set<Long> = emptySet()): Int {
        val doomed = expired(catalog.recordings(), now, protecting)
        for (recording in doomed) catalog.delete(recording.recordingID, storage)
        return doomed.size
    }

    companion object {
        const val defaultKeepUploadedSeconds = 7 * 24 * 3_600.0
    }
}
