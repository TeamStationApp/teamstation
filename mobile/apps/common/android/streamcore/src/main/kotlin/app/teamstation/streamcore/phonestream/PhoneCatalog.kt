package app.teamstation.streamcore.phonestream

import android.content.ContentValues
import android.database.Cursor
import app.teamstation.streamcore.record.RecordingCatalog
import java.io.File

/** One take a phone recorded: the local, higher-quality copy of one live stream. */
data class PhoneRecording(
    val recordingID: Long,
    val liveStreamId: String,
    val gameId: String,
    val angleName: String,
    /** Seconds since 1970 on the steady wall clock. */
    val startedAt: Double,
    /** Null while a part is being written, or after a kill that nothing has closed yet. */
    val endedAt: Double? = null,
    /** How many programme files the take has: one per part. */
    val parts: Int = 0,
    /** The server's upload, once one has been opened. Kept so a killed upload resumes. */
    val uploadId: String? = null,
    /** What the upload was titled, so a resumed upload says the same. */
    val uploadTitle: String? = null,
    /** When the server said the upload was ready. */
    val uploadedAt: Double? = null,
    val videoId: String? = null,
    /** A part stopped because the phone ran out of space while the stream carried on. */
    val stoppedForLowStorage: Boolean = false,
    /** The stream published at a moment no part was recording. */
    val publishedOutsideParts: Boolean = false,
    /**
     * What to add to this phone's clock to read the server's, measured while the take was recorded
     * ([ServerClock]). A phone's clock wanders by several parts in a million, so an upload hours later
     * places the take by this one rather than by a reading taken then.
     */
    val serverClockOffset: Double? = null
) {
    val isUploaded: Boolean get() = uploadedAt != null

    /** An upload was opened and has not landed: running, or cut off and waiting to resume. */
    val hasPendingUpload: Boolean get() = uploadId != null && uploadedAt == null

    /**
     * Whether the recording covers every moment the stream published, so the server may hide the
     * stream's live copy whatever its coverage test says: no part stopped for low storage, and no
     * publish outside a part.
     */
    val coversWholeStream: Boolean get() = !stoppedForLowStorage && !publishedOutsideParts
}

/**
 * The phone's own facts about its takes, beside [RecordingCatalog]'s rows in the same database: which
 * angle and stream each take is of, and how its upload is going.
 *
 * The catalog's `recordings` row carries the game and the live stream as TS Director's would; this
 * table carries what only a phone has.
 */
class PhoneCatalog(val index: RecordingCatalog) {
    private val database = index.database

    init {
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS phone_recordings (
              recording_id INTEGER PRIMARY KEY,
              live_stream_id TEXT NOT NULL,
              game_id TEXT NOT NULL,
              angle_name TEXT NOT NULL,
              upload_id TEXT,
              upload_title TEXT,
              uploaded_at REAL,
              video_id TEXT,
              low_storage_stop INTEGER NOT NULL DEFAULT 0,
              published_outside_parts INTEGER NOT NULL DEFAULT 0,
              server_clock_offset REAL
            );
            """.trimIndent()
        )
        // A catalog made before the take kept its clock offset.
        val columns = database.rawQuery("PRAGMA table_info(phone_recordings);", null).use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getString(1)) }
        }
        if ("server_clock_offset" !in columns) {
            database.execSQL("ALTER TABLE phone_recordings ADD COLUMN server_clock_offset REAL;")
        }
        // The stream this phone is on the air with, while it is: what a relaunch after a kill puts
        // back. The live session says whether, and for how long the app was away; this says which.
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS phone_live (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              live_stream_id TEXT NOT NULL,
              game_id TEXT NOT NULL,
              angle_name TEXT NOT NULL
            );
            """.trimIndent()
        )
    }

    /** The stream on the air, as [setLive] wrote it. */
    data class LiveContext(val liveStreamId: String, val gameId: String, val angleName: String)

    fun setLive(context: LiveContext) {
        database.execSQL(
            "INSERT OR REPLACE INTO phone_live (id, live_stream_id, game_id, angle_name) VALUES (1, ?, ?, ?);",
            arrayOf<Any>(context.liveStreamId, context.gameId, context.angleName)
        )
    }

    fun live(): LiveContext? =
        database.rawQuery("SELECT live_stream_id, game_id, angle_name FROM phone_live WHERE id = 1;", null).use { cursor ->
            if (!cursor.moveToFirst()) null else LiveContext(cursor.getString(0), cursor.getString(1), cursor.getString(2))
        }

    fun clearLive() = database.execSQL("DELETE FROM phone_live;")

    /** Files a new take under its stream, on both rows. */
    fun add(recordingID: Long, liveStreamId: String, gameId: String, angleName: String) {
        index.setLiveStreamId(liveStreamId, recordingID)
        index.setGame(recordingID, gameId, angleName)
        database.execSQL(
            "INSERT OR REPLACE INTO phone_recordings (recording_id, live_stream_id, game_id, angle_name) VALUES (?, ?, ?, ?);",
            arrayOf<Any>(recordingID, liveStreamId, gameId, angleName)
        )
    }

    /** Every take filed under a live stream, newest first. */
    fun recordings(): List<PhoneRecording> {
        val summaries = index.recordings().associateBy { it.id }
        return database.rawQuery(
            """
            SELECT recording_id, live_stream_id, game_id, angle_name, upload_id, upload_title,
              uploaded_at, video_id, low_storage_stop, published_outside_parts, server_clock_offset
            FROM phone_recordings;
            """.trimIndent(),
            null
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val summary = summaries[cursor.getLong(0)] ?: continue
                    add(
                        PhoneRecording(
                            recordingID = summary.id,
                            liveStreamId = cursor.getString(1),
                            gameId = cursor.getString(2),
                            angleName = cursor.getString(3),
                            startedAt = summary.startedAt,
                            endedAt = summary.endedAt,
                            parts = summary.programFilenames.size,
                            uploadId = cursor.text(4),
                            uploadTitle = cursor.text(5),
                            uploadedAt = if (cursor.isNull(6)) null else cursor.getDouble(6),
                            videoId = cursor.text(7),
                            stoppedForLowStorage = cursor.getInt(8) != 0,
                            publishedOutsideParts = cursor.getInt(9) != 0,
                            serverClockOffset = if (cursor.isNull(10)) null else cursor.getDouble(10)
                        )
                    )
                }
            }
        }.sortedByDescending { it.startedAt }
    }

    fun recording(id: Long): PhoneRecording? = recordings().firstOrNull { it.recordingID == id }

    /**
     * The take of [liveStreamId] that has not been uploaded, if there is one: the one a later Record
     * on that stream continues. Once uploaded, the server revokes the stream and the next take on the
     * angle has a new one.
     */
    fun current(liveStreamId: String): PhoneRecording? = recordings().firstOrNull { it.liveStreamId == liveStreamId && !it.isUploaded }

    fun setUpload(uploadId: String?, title: String?, recordingID: Long) = update(
        recordingID,
        ContentValues().apply {
            if (uploadId == null) putNull("upload_id") else put("upload_id", uploadId)
            if (title == null) putNull("upload_title") else put("upload_title", title)
        }
    )

    fun markUploaded(recordingID: Long, videoId: String, wall: Double) = update(
        recordingID,
        ContentValues().apply {
            put("uploaded_at", wall)
            put("video_id", videoId)
        }
    )

    /** Keeps the first clock offset measured for a take; see [PhoneRecording.serverClockOffset]. */
    fun setServerClockOffset(offset: Double, recordingID: Long) {
        database.execSQL(
            "UPDATE phone_recordings SET server_clock_offset = ? WHERE recording_id = ? AND server_clock_offset IS NULL;",
            arrayOf<Any>(offset, recordingID)
        )
    }

    fun markStoppedForLowStorage(recordingID: Long) = update(recordingID, ContentValues().apply { put("low_storage_stop", 1) })

    fun markPublishedOutsideParts(recordingID: Long) =
        update(recordingID, ContentValues().apply { put("published_outside_parts", 1) })

    /**
     * Opens a stopped take again, so a part added to it is part of the take: its end is written again
     * when that part stops, and a kill before then leaves it open for the resume to find.
     */
    fun reopen(recordingID: Long) {
        database.execSQL("UPDATE recordings SET ended_at = NULL WHERE id = ?;", arrayOf<Any>(recordingID))
    }

    /**
     * Closes a take the app never got to close, at the last moment its programme said it reached:
     * the latest anchor, or its start when it has none.
     */
    fun closeAtLastAnchor(recordingID: Long) {
        val summary = index.recording(recordingID) ?: return
        val last = index.programAnchors(recordingID).maxOfOrNull { it.wall }
        index.endRecording(recordingID, maxOf(summary.startedAt, last ?: summary.startedAt))
    }

    /** The take's files (every part and its export) and every row of it. */
    fun delete(recordingID: Long, storage: PhoneStorage) {
        index.recording(recordingID)?.programFilenames?.forEach { File(storage.program, it).delete() }
        storage.export(recordingID).parentFile?.deleteRecursively()
        database.execSQL("DELETE FROM program_anchors WHERE recording_id = ?;", arrayOf<Any>(recordingID))
        database.execSQL("DELETE FROM recordings WHERE id = ?;", arrayOf<Any>(recordingID))
        database.execSQL("DELETE FROM phone_recordings WHERE recording_id = ?;", arrayOf<Any>(recordingID))
    }

    private fun update(recordingID: Long, values: ContentValues) {
        database.update("phone_recordings", values, "recording_id = ?", arrayOf(recordingID.toString()))
    }

    private fun Cursor.text(column: Int): String? = if (isNull(column)) null else getString(column).takeIf { it.isNotEmpty() }
}
