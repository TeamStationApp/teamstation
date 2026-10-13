package app.teamstation.streamcore.phonestream

import app.teamstation.streamcore.gl.ProgrammeDraw
import app.teamstation.streamcore.gl.ProgrammeTicker
import app.teamstation.streamcore.record.ProgramEncoder
import app.teamstation.streamcore.stream.AudioFrame
import app.teamstation.streamcore.stream.ProgramStreamer
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.floor
import kotlin.math.roundToLong

/** Where the programme's recording pictures and sound go: [ProgramEncoder], or a fake in a test. */
interface ProgrammeRecordingTarget {
    val running: Boolean

    /**
     * Where a picture for programme frame time [presentationTime] goes on the part's timeline, in
     * seconds, or null when it is left out. [captureWall] is when a new picture was captured.
     */
    fun place(presentationTime: Double, captureWall: Double?): Double?

    fun append(audio: AudioFrame)
}

/** Where the programme's stream pictures and sound go: [ProgramStreamer], or a fake in a test. */
interface ProgrammeStreamTarget {
    val running: Boolean

    /** Whether the stream takes a picture now: its pacing and its cap on pictures in the encoder. */
    fun admit(presentationTime: Double): Boolean

    fun append(audio: AudioFrame)
}

/** [ProgramEncoder] as the programme's recording: pictures on the programme clock's grid. */
class ProgramEncoderTarget(val encoder: ProgramEncoder) : ProgrammeRecordingTarget {
    override val running: Boolean get() = encoder.running
    override fun place(presentationTime: Double, captureWall: Double?): Double? =
        encoder.append(presentationTime, captureWall, onClockGrid = true)

    override fun append(audio: AudioFrame) = encoder.append(audio)
}

/**
 * The phone's programme: one camera on TS Director's programme clock.
 *
 * One tick drives both outputs, as Director's router does. The clock ticks at 30 fps; on each tick
 * the picture queue ([ProgrammePictureQueue]) gives the newest picture whose moment (capture time
 * plus [pictureDelaySeconds]) has come, or the last one again, and that picture goes to the
 * recording on its grid slot and to the stream. So a picture sits on the programme by when it was
 * captured, as the sound does, whatever rate the camera delivers at. The renderer holds the last
 * [heldPictures] camera pictures on the GPU for the tick to choose among.
 *
 * Frames a late tick skipped are written to the recording as repeats, up to a quarter of a second of
 * them, so the recording's grid has no holes. A picture is drawn into an encoder's input surface, so
 * a tick answers which encoders draw it and with what presentation time:
 *
 * - the recording's, at the slot [ProgramEncoder] placed it in, a fresh MediaCodec session per part;
 * - the stream's, at its capture time on the stream's own epoch ([streamWall] maps it back), never
 *   at or before the last.
 */
class PhoneProgramme(
    private val recording: ProgrammeRecordingTarget,
    private val stream: ProgrammeStreamTarget,
    /** The steady wall second a sensor timestamp was captured at. */
    private val captureWall: (Long) -> Double,
    /** Host uptime in seconds, the clock the ticks are counted on. */
    private val uptime: () -> Double,
    /** The steady wall clock, which pictures are judged due on. */
    private val wall: () -> Double = uptime,
    override val frameRate: Int = PhoneStreamProfile.frameRate,
    /** How long after capture a picture goes on the programme. */
    val pictureDelaySeconds: Double = PhoneStreamProfile.pictureDelaySeconds,
    override val heldPictures: Int = PhoneStreamProfile.heldPictures
) : ProgrammeTicker {
    /** What one tick sent, for a test to read. */
    data class TickOutput(
        val recordingFrames: List<Long> = emptyList(),
        val streamFrame: Long? = null,
        val draws: List<ProgrammeDraw> = emptyList()
    )

    private val lock = ReentrantLock()
    private var zero: Double? = null
    private var lastFrame = -1L
    private var lastRecordedSequence: Long? = null
    private var lastStreamSeconds = Double.NEGATIVE_INFINITY
    private val pictures = ProgrammePictureQueue(pictureDelaySeconds)
    private var lastOffered: Long? = null

    /** The wall second the stream's presentation times count from. */
    @Volatile
    var streamEpoch: Double = 0.0
        private set

    var ticks = 0L
        private set
    var recordingFramesSent = 0L
        private set
    var streamFramesSent = 0L
        private set

    /** Starts the clock counting from the next tick, and the stream's times from [wall]. */
    fun start(wall: Double) {
        lock.withLock {
            zero = null
            lastFrame = -1
            lastRecordedSequence = null
            pictures.reset()
            lastOffered = null
            lastStreamSeconds = Double.NEGATIVE_INFINITY
            streamEpoch = wall
        }
    }

    /** The wall second a stream picture drawn at [presentationSeconds] was captured. */
    fun streamWall(presentationSeconds: Double): Double = streamEpoch + presentationSeconds

    /** Pictures dropped for arriving after their moment, and never shown for a newer one due on the same tick. */
    val latePictures: Long get() = lock.withLock { pictures.latePictures }
    val skippedPictures: Long get() = lock.withLock { pictures.skippedPictures }

    override fun pictureArrived(captureNanos: Long): Set<Long> = lock.withLock {
        offer(captureNanos)
        pictures.wanted
    }

    private fun offer(captureNanos: Long) {
        if (captureNanos == lastOffered) return
        lastOffered = captureNanos
        pictures.add(captureNanos, captureWall(captureNanos))
    }

    override fun tick(latestCaptureNanos: Long?, attached: Set<String>): List<ProgrammeDraw> =
        tick(uptime(), latestCaptureNanos, attached)?.draws ?: emptyList()

    /**
     * One tick at host uptime [now] and steady wall [wallNow]. Answers what it sent, null when no
     * tick was due. [latestCapture] is the sensor timestamp of the newest picture the renderer holds,
     * null before the first, queued here if [pictureArrived] has not seen it; [attached] the
     * encoders it can draw into, and only those are given a picture.
     */
    fun tick(
        now: Double,
        latestCapture: Long?,
        attached: Set<String> = allKeys,
        wallNow: Double = wall()
    ): TickOutput? = lock.withLock {
        val start = zero ?: now.also { zero = it }
        val frame = floor((now - start) * frameRate + 1e-9).toLong()
        if (frame <= lastFrame) return null
        val missed = if (lastFrame < 0) 0 else frame - lastFrame - 1
        lastFrame = frame
        ticks += 1
        latestCapture?.let { offer(it) }
        val entry = pictures.pick(wallNow, 1.0 / frameRate) ?: return TickOutput()
        val capture = entry.captureWall
        val held = entry.captureNanos
        val draws = mutableListOf<ProgrammeDraw>()
        val recorded = mutableListOf<Long>()
        if (RECORDING_KEY in attached && recording.running) {
            val fresh = entry.sequence != lastRecordedSequence
            lastRecordedSequence = entry.sequence
            val repeats = minOf(missed, (frameRate / 4).toLong())
            for (skipped in frame - repeats until frame) {
                recording.place(skipped.toDouble() / frameRate, null)?.let {
                    draws += ProgrammeDraw(RECORDING_KEY, nanos(it), held)
                    recorded += skipped
                }
            }
            recording.place(frame.toDouble() / frameRate, if (fresh) capture else null)?.let {
                draws += ProgrammeDraw(RECORDING_KEY, nanos(it), held)
                recorded += frame
            }
        }
        var streamFrame: Long? = null
        if (STREAM_KEY in attached && stream.running && stream.admit(frame.toDouble() / frameRate)) {
            // At its capture time, but never at or before the picture before: a repeat goes a frame on.
            val seconds = maxOf(capture - streamEpoch, lastStreamSeconds + 1.0 / frameRate)
            lastStreamSeconds = seconds
            draws += ProgrammeDraw(STREAM_KEY, nanos(seconds), held)
            streamFrame = frame
        }
        recordingFramesSent += recorded.size
        if (streamFrame != null) streamFramesSent += 1
        TickOutput(recorded, streamFrame, draws)
    }

    companion object {
        /** The encoder surfaces the renderer draws, by the key each is attached under. */
        const val RECORDING_KEY = "recording"
        const val STREAM_KEY = "stream"
        val allKeys = setOf(RECORDING_KEY, STREAM_KEY)

        fun nanos(seconds: Double): Long = (seconds * 1e9).roundToLong()
    }
}
