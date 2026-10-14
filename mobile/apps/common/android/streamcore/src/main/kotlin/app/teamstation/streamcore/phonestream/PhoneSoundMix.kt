package app.teamstation.streamcore.phonestream

import app.teamstation.streamcore.stream.AudioFrame
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * The phone's sound bus: the microphone laid on a timeline by capture time, read out as 20 ms runs
 * of Director's stereo mix by each output at its own delay. TS Director's `AudioMixer` with one
 * contributor.
 *
 * - Sound is placed by when it was captured, steered the way Director's `SourceSoundTimeline`
 *   steers a camera's sound. Within a run each buffer follows on from the last by sample count, so
 *   the jitter in the capture times never reaches the timeline, and the capture times only steer:
 *   the median of the last [medianBuffers] errors between where a buffer's capture time says it
 *   belongs and where the run has got to. Once the first window is full the run moves to that
 *   median in one step, replacing the first buffer's guess; after that a median over
 *   [ignoreSeconds] moves the run one sample per buffer, about a millisecond a second, which takes
 *   up the microphone clock's drift without a click. A buffer more than [stepSeconds] off is
 *   placed where its capture time says at once, across a gap of silence or back over what was
 *   written.
 * - Each output reads runs out contiguously, [Output.delaySeconds] behind the steady wall clock,
 *   whether or not the microphone spoke: silence where nothing was captured, or while muted. So
 *   both outputs carry sound from their first picture, and the encoders never see a gap.
 * - The mono microphone is carried as the stereo mix Director's bus makes, both channels the same.
 */
class PhoneSoundMix(
    private val sampleRate: Int = PhoneStreamProfile.audioSampleRate,
    private val runSeconds: Double = 0.02,
    capacitySeconds: Double = 8.0,
    /** Errors whose median is under this leave the run where it is: Director's 4 ms. */
    ignoreSeconds: Double = 0.004,
    /** A buffer further off than this is placed by its capture time at once. */
    stepSeconds: Double = 0.1,
    /** How many buffers' errors the median is taken over: a second of the microphone's 20 ms reads. */
    private val medianBuffers: Int = 50
) {
    /** One reader of the bus: the stream's mix, or the recording's. */
    class Output(val delaySeconds: Double, val sink: (AudioFrame) -> Unit) {
        internal var cursor: Long? = null
    }

    private val lock = ReentrantLock()
    private val capacity = (capacitySeconds * sampleRate).toInt()
    private val ring = ShortArray(capacity)
    private val runFrames = (runSeconds * sampleRate).roundToLong()
    private val outputs = mutableListOf<Output>()
    private var epoch = 0.0
    private var writeEnd: Long? = null
    private var validFrom = Long.MAX_VALUE
    private var started = false
    private val ignoreFrames = (ignoreSeconds * sampleRate).roundToLong()
    private val stepFrames = (stepSeconds * sampleRate).roundToLong()
    private val errors = ArrayDeque<Long>()
    private var settled = false

    @Volatile
    var soundEnabled: Boolean = true

    /** Buffers placed back on the timeline after a jump, for a test or a log line. */
    var reanchors = 0
        private set

    /** Samples the run was moved by to follow the capture times, for a test or a log line. */
    var steeredFrames = 0L
        private set

    /** The median error the run last steered by, in seconds: positive when the capture times say later. */
    @Volatile
    var steeringErrorSeconds = 0.0
        private set

    fun add(output: Output) = lock.withLock { outputs += output }

    /** Starts the timeline at [wall]: every output reads from its own delay before now. */
    fun start(wall: Double) = lock.withLock {
        epoch = wall
        writeEnd = null
        errors.clear()
        settled = false
        validFrom = Long.MAX_VALUE
        started = true
        for (output in outputs) output.cursor = index(wall - output.delaySeconds)
    }

    fun stop() = lock.withLock {
        started = false
        for (output in outputs) output.cursor = null
    }

    /** Mono 16-bit sound whose first sample was captured at [captureWall]. */
    fun write(samples: ShortArray, captureWall: Double) {
        if (samples.isEmpty()) return
        lock.withLock {
            if (!started) return
            var at = index(captureWall)
            val end = writeEnd
            if (end != null) {
                val error = at - end
                if (abs(error) > stepFrames) {
                    reanchors += 1
                    errors.clear()
                    silence(end, at)
                } else {
                    at = end + steer(error)
                    if (at > end) {
                        // One sample nudged in repeats the last; a step in is silence.
                        if (at - end == 1L) ring[slot(end)] = ring[slot(end - 1)] else silence(end, at)
                    }
                }
            }
            for ((offset, sample) in samples.withIndex()) ring[slot(at + offset)] = sample
            validFrom = minOf(validFrom, at)
            writeEnd = maxOf(end ?: Long.MIN_VALUE, at + samples.size)
            validFrom = maxOf(validFrom, writeEnd!! - capacity)
        }
    }

    /** How far to move the run for a buffer [error] samples from where it has got to. */
    private fun steer(error: Long): Long {
        errors.addLast(error)
        while (errors.size > medianBuffers) errors.removeFirst()
        if (errors.size < medianBuffers && !settled) return 0
        val sorted = errors.sorted()
        val median = sorted[sorted.size / 2]
        steeringErrorSeconds = median.toDouble() / sampleRate
        val move = when {
            !settled -> median.takeIf { abs(it) > ignoreFrames } ?: 0L
            median > ignoreFrames -> 1L
            median < -ignoreFrames -> -1L
            else -> 0L
        }
        settled = true
        if (move != 0L) {
            steeredFrames += abs(move)
            // The errors so far were measured against the run before it moved.
            val shifted = errors.map { it - move }
            errors.clear()
            errors.addAll(shifted)
        }
        return move
    }

    /** A gap the microphone left is silence, not whatever the ring held before. */
    private fun silence(from: Long, until: Long) {
        var cursor = from
        while (cursor < until) {
            ring[slot(cursor)] = 0
            cursor += 1
        }
    }

    /**
     * Sends every output the runs its delay has let through by [wall]. Each output is fed on its
     * own: one whose sink throws loses that run, and the others still get theirs.
     */
    fun pump(wall: Double) {
        val due = lock.withLock {
            if (!started) return
            outputs.flatMap { output -> runsFor(output, index(wall - output.delaySeconds)).map { output to it } }
        }
        for ((output, frame) in due) {
            try {
                output.sink(frame)
            } catch (error: RuntimeException) {
                android.util.Log.w("PhoneSoundMix", "an output refused its sound", error)
            }
        }
    }

    /** Sends [output] every run up to [wall], whatever its delay: the end of a recording's part. */
    fun flush(output: Output, wall: Double) {
        val due = lock.withLock {
            if (!started) return
            runsFor(output, index(wall) + runFrames - 1)
        }
        for (frame in due) output.sink(frame)
    }

    private fun runsFor(output: Output, through: Long): List<AudioFrame> {
        var cursor = output.cursor ?: return emptyList()
        // A reader that fell more than the ring behind starts again at what the ring still holds.
        if (through - cursor > capacity) cursor = through - runFrames
        val runs = mutableListOf<AudioFrame>()
        while (cursor + runFrames <= through) {
            runs += AudioFrame(read(cursor), epoch + cursor.toDouble() / sampleRate, channels = 2, sampleRate = sampleRate)
            cursor += runFrames
        }
        output.cursor = cursor
        return runs
    }

    private fun read(from: Long): ShortArray {
        val stereo = ShortArray((runFrames * 2).toInt())
        if (!soundEnabled) return stereo
        val end = writeEnd ?: return stereo
        for (frame in 0 until runFrames.toInt()) {
            val position = from + frame
            if (position < validFrom || position >= end) continue
            val sample = ring[slot(position)]
            stereo[frame * 2] = sample
            stereo[frame * 2 + 1] = sample
        }
        return stereo
    }

    private fun index(wall: Double): Long = ((wall - epoch) * sampleRate).roundToLong()

    private fun slot(position: Long): Int = Math.floorMod(position, capacity.toLong()).toInt()
}
