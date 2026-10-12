package app.teamstation.streamcore.record

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import java.io.File

/**
 * The phone's index of its recordings: SQLite in WAL mode, with the `recordings`, `program_anchors`
 * and `live_session` tables and columns of TS Director's `ArchiveIndex`, and the same queries over
 * them that the recording path makes.
 *
 * WAL because a heartbeat is written every five seconds while the encoder writes anchors from its
 * own thread, and a crash must leave the last of both on disk.
 */
class RecordingCatalog(file: File) : AutoCloseable {
    /** One take, as the index lists it. TS Director's `RecordingSummary`, without its cameras. */
    data class RecordingSummary(
        val id: Long,
        val startedAt: Double,
        val endedAt: Double?,
        val programFilename: String?,
        val resumeCount: Int,
        val encoding: TakeEncoding?,
        val soundChecks: List<ProgramSoundCheck>,
        val gameId: String?,
        val gameTitle: String?,
        /** The live stream this take is the local recording of: only the phone writes it. */
        val liveStreamId: String?
    ) {
        /** Every programme part's file, in order. */
        val programFilenames: List<String>
            get() = programFilename?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
    }

    /** What the app was doing when it was last alive. TS Director's `LiveSession`. */
    data class LiveSession(
        val recordingID: Long?,
        val streaming: Boolean,
        val startedAt: Double,
        val lastAlive: Double
    ) {
        /** Nothing to resume: the row should not exist in this state. */
        val isEmpty: Boolean get() = recordingID == null && !streaming
    }

    /** Where the programme was in real time, sampled as it was written. */
    data class ProgramAnchor(val part: Int, val programSeconds: Double, val wall: Double) {
        /** The wall clock this part's timeline begins at, which is what places it in an export. */
        val partStartWall: Double get() = wall - programSeconds
    }

    val database: SQLiteDatabase = SQLiteDatabase.openOrCreateDatabase(file.also { it.parentFile?.mkdirs() }, null)

    init {
        database.enableWriteAheadLogging()
        createSchema()
    }

    override fun close() = database.close()

    private fun createSchema() {
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS recordings (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              started_at REAL NOT NULL,
              ended_at REAL,
              program_filename TEXT
            );
            """.trimIndent()
        )
        // Added one at a time, as ArchiveIndex added them, so a catalog from an earlier build takes
        // each one it lacks.
        for (column in listOf(
            "program_filename TEXT",
            "resume_count INTEGER NOT NULL DEFAULT 0",
            "last_resumed_at REAL",
            "selections_json TEXT",
            "encoding_json TEXT",
            "sound_checks_json TEXT",
            "game_id TEXT",
            "game_title TEXT",
            "server_clock_offset_ms INTEGER",
            "live_stream_id TEXT"
        )) {
            runCatching { database.execSQL("ALTER TABLE recordings ADD COLUMN $column;") }
        }
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS program_anchors (
              recording_id INTEGER NOT NULL,
              part INTEGER NOT NULL,
              program_seconds REAL NOT NULL,
              wall REAL NOT NULL
            );
            """.trimIndent()
        )
        database.execSQL(
            "CREATE INDEX IF NOT EXISTS program_anchors_lookup ON program_anchors(recording_id, part, program_seconds);"
        )
        database.execSQL(
            """
            CREATE TABLE IF NOT EXISTS live_session (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              recording_id INTEGER,
              streaming INTEGER NOT NULL DEFAULT 0,
              started_at REAL NOT NULL,
              last_alive REAL NOT NULL
            );
            """.trimIndent()
        )
    }

    /** The columns of a table, in order: what the schema test compares with ArchiveIndex. */
    fun columns(table: String): List<String> =
        database.rawQuery("PRAGMA table_info($table);", null).use { cursor ->
            buildList { while (cursor.moveToNext()) add(cursor.getString(1)) }
        }

    val journalMode: String
        get() = database.rawQuery("PRAGMA journal_mode;", null).use { it.moveToFirst(); it.getString(0) }

    // MARK: - Recordings

    fun beginRecording(wall: Double): Long =
        database.insertOrThrow("recordings", null, ContentValues().apply { put("started_at", wall) })

    fun endRecording(id: Long, wall: Double) = update(id, ContentValues().apply { put("ended_at", wall) })

    /** Names the live stream a take is the local recording of, or clears it with null. */
    fun setLiveStreamId(streamId: String?, id: Long) =
        update(id, ContentValues().apply { if (streamId == null) putNull("live_stream_id") else put("live_stream_id", streamId) })

    fun setProgramFilename(filename: String, id: Long) = update(id, ContentValues().apply { put("program_filename", filename) })

    /** The game a take is of; written only over no game, or over [replacing]. */
    fun setGame(id: Long, gameId: String, title: String, replacing: String? = null) {
        database.execSQL(
            "UPDATE recordings SET game_id = ?, game_title = ? WHERE id = ? AND (game_id IS NULL OR game_id = '' OR game_id = ?);",
            arrayOf<Any?>(gameId, title, id, replacing)
        )
    }

    fun noteResumed(id: Long, wall: Double) {
        database.execSQL(
            "UPDATE recordings SET resume_count = resume_count + 1, last_resumed_at = ? WHERE id = ?;",
            arrayOf<Any>(wall, id)
        )
    }

    fun saveSelections(json: String, id: Long) = update(id, ContentValues().apply { put("selections_json", json) })

    fun selections(id: Long): String? =
        single("SELECT selections_json FROM recordings WHERE id = ?;", id) { it.stringOrNull(0)?.takeIf(String::isNotEmpty) }

    fun saveEncoding(encoding: TakeEncoding, id: Long) = update(id, ContentValues().apply { put("encoding_json", encoding.toJson()) })

    fun encoding(id: Long): TakeEncoding? =
        single("SELECT encoding_json FROM recordings WHERE id = ?;", id) { TakeEncoding.fromJson(it.stringOrNull(0)) }

    /** Records one part's verdict, replacing any earlier verdict for the same part. */
    fun recordSoundCheck(check: ProgramSoundCheck, id: Long) {
        val checks = (soundChecks(id).filter { it.part != check.part } + check).sortedBy { it.part }
        update(id, ContentValues().apply { put("sound_checks_json", ProgramSoundCheck.listToJson(checks)) })
    }

    fun soundChecks(id: Long): List<ProgramSoundCheck> =
        single("SELECT sound_checks_json FROM recordings WHERE id = ?;", id) { ProgramSoundCheck.listFromJson(it.stringOrNull(0)) }
            ?: emptyList()

    fun openRecordingIDs(): Set<Long> =
        database.rawQuery("SELECT id FROM recordings WHERE ended_at IS NULL;", null).use { cursor ->
            buildSet { while (cursor.moveToNext()) add(cursor.getLong(0)) }
        }

    fun recordings(): List<RecordingSummary> =
        database.rawQuery(
            """
            SELECT id, started_at, ended_at, program_filename, resume_count, encoding_json,
              sound_checks_json, game_id, game_title, live_stream_id
            FROM recordings ORDER BY started_at DESC;
            """.trimIndent(),
            null
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(
                        RecordingSummary(
                            id = cursor.getLong(0),
                            startedAt = cursor.getDouble(1),
                            endedAt = if (cursor.isNull(2)) null else cursor.getDouble(2),
                            programFilename = cursor.stringOrNull(3)?.takeIf(String::isNotEmpty),
                            resumeCount = cursor.getInt(4),
                            encoding = TakeEncoding.fromJson(cursor.stringOrNull(5)),
                            soundChecks = ProgramSoundCheck.listFromJson(cursor.stringOrNull(6)),
                            gameId = cursor.stringOrNull(7)?.takeIf(String::isNotEmpty),
                            gameTitle = cursor.stringOrNull(8)?.takeIf(String::isNotEmpty),
                            liveStreamId = cursor.stringOrNull(9)?.takeIf(String::isNotEmpty)
                        )
                    )
                }
            }
        }

    fun recording(id: Long): RecordingSummary? = recordings().firstOrNull { it.id == id }

    // MARK: - Programme anchors

    fun insertProgramAnchor(recordingID: Long, part: Int, programSeconds: Double, wall: Double): Long =
        database.insertOrThrow(
            "program_anchors",
            null,
            ContentValues().apply {
                put("recording_id", recordingID)
                put("part", part)
                put("program_seconds", programSeconds)
                put("wall", wall)
            }
        )

    fun programAnchors(recordingID: Long): List<ProgramAnchor> =
        database.rawQuery(
            "SELECT part, program_seconds, wall FROM program_anchors WHERE recording_id = ? ORDER BY part ASC, program_seconds ASC;",
            arrayOf(recordingID.toString())
        ).use { cursor ->
            buildList { while (cursor.moveToNext()) add(ProgramAnchor(cursor.getInt(0), cursor.getDouble(1), cursor.getDouble(2))) }
        }

    /** Where each programme part's timeline begins on the wall clock. */
    fun programPartStarts(recordingID: Long): Map<Int, Double> = partStarts(programAnchors(recordingID))

    /** One past the highest part this take has anchored, or one when it has anchored nothing. */
    fun nextProgramPart(recordingID: Long): Int =
        single("SELECT MAX(part) FROM program_anchors WHERE recording_id = ?;", recordingID) {
            if (it.isNull(0)) null else it.getInt(0) + 1
        } ?: 1

    // MARK: - The live session

    /** Opens the live session, or updates the half named by whichever argument is given. */
    fun openLiveSession(recordingID: Long? = null, streaming: Boolean? = null, wall: Double) {
        val existing = liveSession()
        val recording = recordingID ?: existing?.recordingID
        val isStreaming = streaming ?: existing?.streaming ?: false
        val started = existing?.startedAt ?: wall
        database.execSQL(
            "INSERT OR REPLACE INTO live_session (id, recording_id, streaming, started_at, last_alive) VALUES (1, ?, ?, ?, ?);",
            arrayOf<Any?>(recording, if (isStreaming) 1 else 0, started, wall)
        )
    }

    /** Clears one half of the live session, and deletes the row once both are off (or neither is named). */
    fun closeLiveSession(recording: Boolean = false, streaming: Boolean = false) {
        val existing = liveSession() ?: return
        val next = existing.copy(
            recordingID = if (recording) null else existing.recordingID,
            streaming = if (streaming) false else existing.streaming
        )
        if ((!recording && !streaming) || next.isEmpty) {
            database.execSQL("DELETE FROM live_session;")
            return
        }
        database.execSQL(
            "UPDATE live_session SET recording_id = ?, streaming = ? WHERE id = 1;",
            arrayOf<Any?>(next.recordingID, if (next.streaming) 1 else 0)
        )
    }

    /** Moves the heartbeat forward, never backwards. */
    fun heartbeat(wall: Double) {
        database.execSQL("UPDATE live_session SET last_alive = ? WHERE id = 1 AND last_alive < ?;", arrayOf<Any>(wall, wall))
    }

    fun liveSession(): LiveSession? =
        database.rawQuery("SELECT recording_id, streaming, started_at, last_alive FROM live_session WHERE id = 1;", null).use { cursor ->
            if (!cursor.moveToFirst()) return null
            LiveSession(
                recordingID = if (cursor.isNull(0)) null else cursor.getLong(0),
                streaming = cursor.getInt(1) == 1,
                startedAt = cursor.getDouble(2),
                lastAlive = cursor.getDouble(3)
            )
        }

    /**
     * The take the live session names, if it is still open. A session naming a take that has since
     * been closed is stale, so its pointer is cleared rather than allowed to resume a finished take.
     */
    fun liveRecording(): RecordingSummary? {
        val id = liveSession()?.recordingID ?: return null
        val summary = recording(id)
        if (summary == null || summary.endedAt != null) {
            closeLiveSession(recording = true)
            return null
        }
        return summary
    }

    private fun update(id: Long, values: ContentValues) {
        database.update("recordings", values, "id = ?", arrayOf(id.toString()))
    }

    private fun <T> single(sql: String, id: Long, read: (Cursor) -> T?): T? =
        database.rawQuery(sql, arrayOf(id.toString())).use { if (it.moveToFirst()) read(it) else null }

    private fun Cursor.stringOrNull(index: Int): String? = if (isNull(index)) null else getString(index)

    companion object {
        /** How far apart anchors may be and still agree about where their part starts. */
        const val anchorAgreementSeconds = 0.25

        /** Where each part's timeline begins: where its earliest anchors agree. */
        fun partStarts(anchors: List<ProgramAnchor>): Map<Int, Double> =
            anchors.groupBy { it.part }.mapNotNull { (part, list) ->
                partStart(list.map { it.partStartWall })?.let { part to it.first }
            }.toMap()

        /**
         * Where one part starts, from the start each of its anchors implies, and how many agree: the
         * median of the anchors within [anchorAgreementSeconds] of the earliest tenth.
         */
        fun partStart(implied: List<Double>): Pair<Double, Int>? {
            if (implied.isEmpty()) return null
            val sorted = implied.sorted()
            val floor = sorted[sorted.size / 10]
            val agreeing = sorted.filter { it <= floor + anchorAgreementSeconds }
            val middle = agreeing.size / 2
            val median = if (agreeing.size % 2 == 1) agreeing[middle] else (agreeing[middle - 1] + agreeing[middle]) / 2
            return median to agreeing.size
        }
    }
}
