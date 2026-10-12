package app.teamstation.streamcore.record

import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * The programme recording of one take, from its row in the catalog to its last part's file. A port
 * of TS Director's `RecordingSession`.
 *
 * It opens the take's row with the encoding it is recorded with, starts the programme master
 * ([ProgramEncoder]) and keeps the take's anchors and sound checks on the row. A take interrupted by
 * a crash or a kill is picked up as its next part ([resume]). At Stop the master is finished out to
 * the take's end with the hold fill, and every part's file is listed on the row. It also keeps the
 * live session's heartbeat, which is how the next launch knows how long the app was away.
 *
 * Its methods are called from one thread, the host's; the heartbeat beats on its own.
 */
class RecordingSession(
    val catalog: RecordingCatalog,
    val encoder: ProgramEncoder,
    private val clock: DirectorClock,
    private val heartbeatSeconds: Double = defaultHeartbeatSeconds,
    /** Tells the host's programme clock the master's frame rate before the master starts. */
    private val setRecordingRate: (Int) -> Unit = {}
) {
    /** The open take, while one is recording. */
    var recordingID: Long? = null
        private set

    /** When the open take started: the take's own start, kept across a resume. */
    var startedAt: Double? = null
        private set

    private var heartbeat: ScheduledExecutorService? = null

    init {
        encoder.setAnchorSink { recording, part, seconds, wall ->
            runCatching { catalog.insertProgramAnchor(recording, part, seconds, wall) }
        }
        encoder.setSoundCheckSink { recording, check -> runCatching { catalog.recordSoundCheck(check, recording) } }
    }

    val isRecording: Boolean get() = recordingID != null

    /** Opens the take's row, keeps its encoding, and points the master's anchors at it. */
    fun open(now: Double, settings: RecordingSettings): Long {
        val id = catalog.beginRecording(now)
        recordingID = id
        runCatching { catalog.saveEncoding(settings.takeEncoding, id) }
        encoder.setAnchorRecording(id)
        startedAt = now
        return id
    }

    /** Starts the programme master for the open take, and lists its file on the take's row. */
    fun startProgramme(now: Double, settings: RecordingSettings) {
        encoder.configure(settings.programme)
        setRecordingRate(settings.programme.frameRate)
        encoder.start(now)
        val id = recordingID ?: return
        encoder.outputFile?.name?.let { runCatching { catalog.setProgramFilename(it, id) } }
    }

    /**
     * Picks up a take that was rolling when the app stopped, as its next part, with the take's own
     * programme settings. Answers how many times the take has now been resumed.
     */
    fun resume(take: LiveSessionResume.Take, now: Double, settings: RecordingSettings): Int {
        adopt(take)
        return resumeProgramme(take, now, settings)
    }

    /** The first half of [resume]: the take is the open one again, before anything is written. */
    fun adopt(take: LiveSessionResume.Take) {
        recordingID = take.recordingID
        startedAt = take.startedAt
    }

    /** The second half of [resume]: the take's anchors, its resume count, and its next part. */
    fun resumeProgramme(take: LiveSessionResume.Take, now: Double, settings: RecordingSettings): Int {
        encoder.setAnchorRecording(take.recordingID)
        runCatching { catalog.noteResumed(take.recordingID, now) }
        val resumeCount = catalog.recording(take.recordingID)?.resumeCount ?: 1
        val programme = catalog.encoding(take.recordingID)?.programme ?: settings.programme
        encoder.configure(programme)
        setRecordingRate(programme.frameRate)
        encoder.resume(take.startedAt, take.nextProgramPart, now)
        val opened = encoder.outputFile?.name
        if (opened != null) {
            val names = programFilenames(take.recordingID)
            if (opened !in names) runCatching { catalog.setProgramFilename((names + opened).joinToString(","), take.recordingID) }
        }
        return resumeCount
    }

    /** Nothing the master writes after this belongs to the take. */
    fun detachAnchors() = encoder.setAnchorRecording(null)

    /** Finishes the master out to [until] with the hold fill, and answers with its file. Blocks. */
    fun finishProgramme(until: Double): File? = encoder.finish(until)

    /** Closes the take's row at [endedAt], listing every part's file in order. */
    fun close(endedAt: Double) {
        recordingID?.let { id ->
            val recorded = programFilenames(id)
            val written = encoder.outputFiles.map { it.name }.filter { it.isNotEmpty() }
            val names = recorded + written.filter { it !in recorded }
            if (names.isNotEmpty()) runCatching { catalog.setProgramFilename(names.joinToString(","), id) }
            runCatching { catalog.endRecording(id, endedAt) }
        }
        recordingID = null
        encoder.setAnchorRecording(null)
        startedAt = null
    }

    private fun programFilenames(id: Long): List<String> = catalog.recording(id)?.programFilenames ?: emptyList()

    // MARK: - The live session

    /**
     * Opens or updates the row that says what this app is doing, and starts the heartbeat. [isLive]
     * is asked on each beat, from the heartbeat's thread; a beat with nothing live closes the session.
     */
    fun beginLiveSession(recording: Long? = null, streaming: Boolean? = null, isLive: () -> Boolean) {
        runCatching { catalog.openLiveSession(recording, streaming, clock.now()) }
        if (heartbeat != null) return
        val executor = Executors.newSingleThreadScheduledExecutor { Thread(it, "live-session").apply { isDaemon = true } }
        val millis = (heartbeatSeconds * 1000).toLong()
        executor.scheduleWithFixedDelay({ runCatching { beatLiveSession(isLive()) } }, millis, millis, TimeUnit.MILLISECONDS)
        heartbeat = executor
    }

    /** One heartbeat. With nothing live any more, the session is closed instead. */
    fun beatLiveSession(isLive: Boolean) {
        if (!isLive) {
            endLiveSession(stillLive = false)
            return
        }
        runCatching { catalog.heartbeat(clock.now()) }
    }

    /** Clears one half of the live session (or all of it), and stops the heartbeat once nothing is live. */
    fun endLiveSession(recording: Boolean = false, streaming: Boolean = false, stillLive: Boolean) {
        runCatching {
            if (recording || streaming) catalog.closeLiveSession(recording, streaming) else catalog.closeLiveSession()
        }
        if (!stillLive) stopHeartbeat()
    }

    fun stopHeartbeat() {
        heartbeat?.shutdown()
        heartbeat = null
    }

    val isBeating: Boolean get() = heartbeat != null

    companion object {
        /** Every five seconds: the downtime reading is never meaningfully wrong. */
        const val defaultHeartbeatSeconds = 5.0
    }
}
