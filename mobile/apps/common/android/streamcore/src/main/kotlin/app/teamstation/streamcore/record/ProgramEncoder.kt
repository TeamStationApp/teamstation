package app.teamstation.streamcore.record

import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.rtmp.FLVTag
import app.teamstation.streamcore.rtmp.HEVCDecoderConfiguration
import app.teamstation.streamcore.stream.AudioFrame
import app.teamstation.streamcore.stream.MediaCodecAacEncoder
import app.teamstation.streamcore.stream.MediaTelemetry
import app.teamstation.streamcore.stream.MediaTime
import app.teamstation.streamcore.stream.ProgramStreamer
import app.teamstation.streamcore.stream.StreamAudioEncoding
import app.teamstation.streamcore.stream.roundedHalfAwayFromZero
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.abs

/**
 * Where the programme's sound goes: the part's AAC track in production, a fake in tests, which is the
 * only way to make a writer refuse on demand. TS Director's `SoundSink`.
 */
interface SoundSink {
    val isReadyForMoreSound: Boolean

    /** One run of the mix, interleaved stereo PCM, laid where the track has got to. */
    fun appendSound(samples: ShortArray): Boolean

    fun finishSound()
}

/**
 * The programme master: one recording of the programme, as fragmented MP4 parts. A port of TS
 * Director's `ProgramEncoder`.
 *
 * Pictures reach the recording's MediaCodec encoder through its input surface, so where TS Director
 * hands `append` a pixel buffer, a host here asks [append] where on the part's timeline the next
 * picture goes, draws it into the encoder with that presentation time (or not at all, on null), and
 * hands the coded picture that comes out to [appendEncoded]. Everything that decides the master's
 * timing is TS Director's:
 *
 * - Grid placement: every picture lands in a slot of the part's frame grid, checked against host
 *   uptime with 1.5 frames of slack ([gridSlot]), so camera timing never reaches the file.
 * - [ProgrammeSoundOrigin] takes the part's start wall from the median of content wall less programme
 *   seconds over the first 1.5 s, and sound captured at a wall time goes at wall less that origin.
 *   Sound that comes before the origin has settled is held and placed once it has.
 * - Sound is laid contiguously from where the track has got to ([drainAudio]): a shortfall is
 *   covered with silence first, sound the track has passed is dropped.
 * - At Stop the hold fills from the sound actually written to the take's length or the last picture,
 *   whichever is later ([HoldFill]). The picture is held as the last coded picture lasting out the
 *   take, one sample, rather than repeated black pictures: a MediaCodec session cannot be handed a
 *   picture outside its surface.
 * - [resume] opens part N+1 timed from its first picture, and anchors go to the take every 3 s.
 * - At finish the part is read back, and what its tracks hold is recorded as the part's
 *   [ProgramSoundCheck].
 */
class ProgramEncoder(
    private val telemetry: MediaTelemetry,
    settings: EncodeSettings,
    private val directory: File,
    /** The clock anchors and parts are timed on: the steady wall clock in the app. */
    private val clock: DirectorClock = SteadyClock(),
    /** Host uptime in seconds, which the grid is checked against. */
    private val uptime: () -> Double = SteadyWall::elapsedRealtime,
    /** The AAC encoder each part's sound track is coded with. */
    private val audioEncoderFactory: () -> StreamAudioEncoding = { MediaCodecAacEncoder(bitrate = 192_000) }
) {
    /** Called as the programme is written: which recording, which part, where, and when. */
    fun interface AnchorSink {
        fun anchor(recordingID: Long, part: Int, programSeconds: Double, wall: Double)
    }

    /** Called once per finished part with what its sound track turned out to hold. */
    fun interface SoundCheckSink {
        fun check(recordingID: Long, check: ProgramSoundCheck)
    }

    /** One run of the mix waiting for the track, with where the wall clock says it belongs. */
    private class PendingSound(val samples: ShortArray, val target: Double, val duration: Double)

    /** One run of the mix that came while the part's origin was still being sampled, with when it was captured. */
    private class HeldSound(val samples: ShortArray, val wall: Double, val duration: Double)

    private val lock = ReentrantLock()
    private var settings = settings
    private var anchorSink: AnchorSink? = null
    private var soundCheckSink: SoundCheckSink? = null
    private var anchorRecordingID: Long? = null
    private var partRecordingID: Long? = null
    private var writer: FragmentedMp4Writer? = null
    private var aac: StreamAudioEncoding? = null
    private var isRunning = false
    private var part = 1
    private var baseTime: Double? = null
    private var lastTime: MediaTime = MediaTime.negativeInfinity
    private var hostZero: Double? = null
    private var lastAnchorSeconds = Double.NEGATIVE_INFINITY
    private var contentLagSeconds: Double? = null
    private val soundOrigin = ProgrammeSoundOrigin()
    private val pendingAudio = ArrayDeque<PendingSound>()

    /**
     * Sound the mix handed over while the part's origin was still being sampled. Placed the moment the
     * origin settles; see [placeHeldSoundLocked].
     */
    private val heldSound = ArrayDeque<HeldSound>()
    private var isDraining = false
    private var writtenFrames = 0L
    private var writtenAudioEnd = 0.0
    private var acceptedAudioCount = 0
    private var silenceQueued = 0
    private var audioAppendFailures = 0
    private var audioQueueDrops = 0
    private var audioBehindTrack = 0
    private var audioOffered = 0
    private var audioUnseeded = 0
    private var audioBeforePart = 0
    private var audioFirstTarget = -1.0
    private var startedAt: Double? = null
    private var previousPartsDuration = 0.0
    private var resumedAwaitingPicture = false
    private var lastProgramFinishDetail = ""

    /** The wall start each of this part's anchors implied, as the export will read them back. */
    private val partAnchorStarts = mutableListOf<Double>()

    /**
     * The part's file could not be written (storage full, an I/O error): nothing more goes into it,
     * and [onWriterFailure] has been told. What it already holds stays.
     */
    private var writerFailed = false
    private var failureToReport: String? = null

    /** The AAC configuration and priming a probe encoder reported for this part; see [probeAudio]. */
    private var probedAudio: Pair<ByteArray, Int>? = null

    /**
     * Told, once per part and outside the lock, when the part's file stops taking writes. The part is
     * over: the host finishes it, which keeps every fragment already written.
     */
    @Volatile
    var onWriterFailure: ((String) -> Unit)? = null

    /** Overridden by tests; otherwise the part's own sound track. */
    internal var soundSinkOverride: SoundSink? = null

    var outputFile: File? = null
        private set
    val outputFiles = mutableListOf<File>()

    val frameCount: Long get() = lock.withLock { writtenFrames }
    val running: Boolean get() = lock.withLock { isRunning }

    /** The encoding the next part is written with. A part being written keeps what it started with. */
    fun configure(encoding: EncodeSettings) {
        lock.withLock { if (!isRunning) settings = encoding }
    }

    fun setAnchorSink(sink: AnchorSink?) {
        lock.withLock { anchorSink = sink }
    }

    fun setSoundCheckSink(sink: SoundCheckSink?) {
        lock.withLock { soundCheckSink = sink }
    }

    /** Which recording the anchors belong to, or null when the programme is only being previewed. */
    fun setAnchorRecording(recordingID: Long?) {
        lock.withLock { anchorRecordingID = recordingID }
    }

    fun start(wall: Double) {
        lock.withLock {
            if (isRunning) return
            resumedAwaitingPicture = false
            part = 1
            partRecordingID = null
            outputFiles.clear()
            lastAnchorSeconds = Double.NEGATIVE_INFINITY
            contentLagSeconds = null
            previousPartsDuration = 0.0
            startedAt = wall
        }
        openPart(wall, replacingExistingFile = true)
    }

    /**
     * Picks up a take this process did not start, as part [nextPart] of the same file family. The
     * part's timeline begins with its first picture, so the span before it is measured when that
     * picture comes; a part that never gets one keeps the resume.
     */
    fun resume(startedAt: Double, nextPart: Int, wall: Double) {
        lock.withLock {
            if (isRunning) throw IllegalStateException("program writer is already running")
            part = maxOf(1, nextPart)
            outputFiles.clear()
            lastAnchorSeconds = Double.NEGATIVE_INFINITY
            contentLagSeconds = null
            previousPartsDuration = previousPartsSeconds(startedAt, wall)
            resumedAwaitingPicture = true
            this.startedAt = startedAt
        }
        // Never replace an existing file here: a name in use that no anchor mentions holds footage.
        openPart(startedAt, replacingExistingFile = false)
    }

    private fun openPart(stamp: Double, replacingExistingFile: Boolean) {
        directory.mkdirs()
        val stem = "program-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date((stamp * 1000).toLong()))
        var sequence = lock.withLock { part }
        var file = partFile(stem, sequence, directory)
        if (replacingExistingFile) {
            file.delete()
        } else {
            while (file.exists()) {
                sequence += 1
                file = partFile(stem, sequence, directory)
            }
        }
        // The file is claimed now, so a resume after a crash before the first picture steps over it.
        file.writeBytes(ByteArray(0))
        val probed = probeAudio()
        lock.withLock {
            probedAudio = probed
            writerFailed = false
            failureToReport = null
            partAnchorStarts.clear()
            part = sequence
            writer = null
            aac?.close()
            aac = null
            baseTime = null
            hostZero = null
            lastTime = MediaTime.negativeInfinity
            writtenFrames = 0
            writtenAudioEnd = 0.0
            acceptedAudioCount = 0
            resetSoundDiagnosticsLocked()
            soundOrigin.reset()
            pendingAudio.clear()
            heldSound.clear()
            isRunning = true
            outputFile = file
            outputFiles += file
        }
        telemetry.recordEncodeSessionChange(1)
    }

    /**
     * Where the next picture goes on the part's timeline, in seconds, or null when it is left out (a
     * second picture in one slot, or nothing running). [presentationTime] is the picture's own time;
     * [captureWall] when it was captured; [onClockGrid] says the time is the programme clock's own
     * frame number, trusted as it stands. Anchors and the sound's origin are taken here, where the
     * timeline is decided.
     */
    fun append(presentationTime: Double, captureWall: Double? = null, onClockGrid: Boolean = false): Double? {
        val anchor: Triple<Long, Int, Pair<Double, Double>>?
        val sink: AnchorSink?
        val time: Double
        lock.withLock {
            if (!isRunning) return null
            if (baseTime == null) {
                baseTime = presentationTime
                val started = startedAt
                if (resumedAwaitingPicture && started != null) {
                    resumedAwaitingPicture = false
                    previousPartsDuration = previousPartsSeconds(started, clock.now())
                }
            }
            val base = baseTime ?: return null
            val rate = maxOf(settings.frameRate, 1).toDouble()
            val nowHost = uptime()
            val hasTimeline = lastTime.isNumeric && lastTime >= MediaTime.zero
            val lastSlot = if (hasTimeline) (lastTime.seconds * rate).roundedHalfAwayFromZero().toLong() else -1L
            val zero = hostZero ?: (nowHost - (lastSlot + 1) / rate).also { hostZero = it }
            val hostSlot = ((nowHost - zero) * rate).roundedHalfAwayFromZero().toLong()
            val source = presentationTime - base
            val slot = gridSlot(
                sourceSeconds = if (source.isFinite()) source else null,
                rate = rate,
                hostSlot = hostSlot,
                lastSlot = lastSlot,
                onClockGrid = onClockGrid,
                continuingAfterRecovery = false
            )
            if (slot <= lastSlot) return null
            val placed = MediaTime(slot, maxOf(settings.frameRate, 1))
            time = placed.seconds
            baseTime = presentationTime - time
            lastTime = placed
            val nowWall = clock.now()
            if (captureWall != null && nowWall - captureWall >= 0 && nowWall - captureWall < 10) {
                contentLagSeconds = nowWall - captureWall
            }
            val contentWall = nowWall - (contentLagSeconds ?: 0.0)
            // A picture on the programme clock's grid that is a repeat (no capture time) says
            // nothing new about the content's age. Below 30 fps the repeats follow the freshest
            // pictures, so offering them would tilt the median toward those and put the sound early.
            if (captureWall != null || !onClockGrid) soundOrigin.offer(contentWall - time, time)
            val recording = anchorRecordingID
            anchor = if (recording != null && time - lastAnchorSeconds >= anchorIntervalSeconds) {
                lastAnchorSeconds = time
                partRecordingID = recording
                partAnchorStarts += contentWall - time
                Triple(recording, part, time to contentWall)
            } else {
                null
            }
            sink = anchorSink
            // Once the opening has settled the origin, the sound that came while it was sampled goes in.
            placeHeldSoundLocked()
        }
        // Outside the lock: the sink writes to the catalog.
        if (anchor != null) sink?.anchor(anchor.first, anchor.second, anchor.third.first, anchor.third.second)
        return time
    }

    /**
     * The coded picture for a slot [append] gave, with that slot as its presentation time. The part's
     * file starts with the first keyframe that carries the parameter sets; pictures before it are
     * left out, because nothing could decode them.
     */
    fun appendEncoded(frame: EncodedVideoFrame) {
        lock.withLock {
            if (!isRunning || writerFailed || frame.nalUnits.isEmpty()) return
            try {
                if (writer == null) {
                    if (!frame.isKeyframe || frame.parameterSets.isEmpty()) return
                    val opened = openWriter(frame.parameterSets) ?: return
                    writer = opened
                }
                if (writer?.writeVideo(ProgramStreamer.lengthPrefixed(frame.nalUnits), frame.presentationTime, frame.isKeyframe) == true) {
                    writtenFrames += 1
                }
            } catch (error: IOException) {
                failWriterLocked(error)
            }
        }
        deliverWriterFailure()
        drainAudio(limit = 2)
        syncWriter()
    }

    /**
     * Forces what the part's writer has written to storage, outside [lock]: a slow fsync under it held
     * up the render tick and the sound with it.
     */
    private fun syncWriter() {
        lock.withLock { writer }?.syncPending()
    }

    /** The part's file stopped taking writes: it is closed where it got to. Called with [lock] held. */
    private fun failWriterLocked(error: Exception) {
        if (writerFailed) return
        writerFailed = true
        writer?.abandon()
        writer = null
        val message = "program writer failed: ${error.message ?: error.javaClass.simpleName}"
        telemetry.recordError(message)
        failureToReport = message
    }

    /** Tells [onWriterFailure] of a failure [failWriterLocked] noted, outside the lock. */
    private fun deliverWriterFailure() {
        val message = lock.withLock { failureToReport.also { failureToReport = null } } ?: return
        onWriterFailure?.invoke(message)
    }

    /**
     * What this device's AAC encoder says its configuration and priming are, from a probe that has
     * encoded a few frames to the end: a codec reports both only once it has produced output, so the
     * track's own encoder, asked before its first packet, answered the defaults. Null when the probe
     * fails, and the track's encoder is asked instead.
     */
    private fun probeAudio(): Pair<ByteArray, Int>? = try {
        val probe = audioEncoderFactory()
        try {
            probe.encode(ShortArray(PROBE_FRAMES * 1024 * 2))
            probe.finish()
            probe.audioSpecificConfig.takeIf { it.isNotEmpty() }?.let { it.copyOf() to probe.primingSamples }
        } finally {
            probe.close()
        }
    } catch (error: Exception) {
        telemetry.recordError("AAC probe failed: ${error.message ?: error.javaClass.simpleName}")
        null
    }

    private fun openWriter(parameterSets: List<ByteArray>): FragmentedMp4Writer? {
        val file = outputFile ?: return null
        val record = when (settings.codec) {
            StreamCodec.HEVC -> HEVCDecoderConfiguration.record(parameterSets)
            StreamCodec.H264 -> {
                val sps = parameterSets.firstOrNull { it.isNotEmpty() && it[0].toInt() and 0x1F == 7 }
                val pps = parameterSets.firstOrNull { it.isNotEmpty() && it[0].toInt() and 0x1F == 8 }
                if (sps != null && pps != null) FLVTag.avcDecoderConfigurationRecord(sps, pps) else null
            }
        } ?: return null
        val encoder = audioEncoderFactory()
        aac = encoder
        val (config, priming) = probedAudio ?: (encoder.audioSpecificConfig to encoder.primingSamples)
        return FragmentedMp4Writer(
            file,
            FragmentedMp4Writer.VideoTrack(settings.codec, settings.width, settings.height, record),
            FragmentedMp4Writer.AudioTrack(config, primingSamples = priming),
            syncEachFragment = false
        )
    }

    /** The part's own sound track: the mix through the AAC encoder into the writer. */
    private inner class TrackSoundSink : SoundSink {
        override val isReadyForMoreSound: Boolean get() = writer != null

        override fun appendSound(samples: ShortArray): Boolean {
            val target = writer ?: return false
            val encoder = aac ?: return false
            encoder.encode(samples).forEach { target.writeAudio(it) }
            return true
        }

        override fun finishSound() {
            val target = writer ?: return
            aac?.finish()?.forEach { target.writeAudio(it) }
        }
    }

    private val trackSoundSink = TrackSoundSink()
    private val soundSink: SoundSink get() = soundSinkOverride ?: trackSoundSink

    /**
     * The recording's own mix, placed by the one origin this part settled at its opening. This only
     * decides whether a run belongs to the part and queues it with the moment it belongs at; where it
     * lands is [drainAudio]'s business.
     */
    fun append(audio: AudioFrame) {
        lock.withLock {
            if (!isRunning || baseTime == null || audio.frameCount <= 0) return
            audioOffered += 1
            // Sound that arrives while the opening is still being sampled is held, not dropped, and
            // placed once the origin settles. The phone's recording mix waits one second against a
            // 1.5 s opening, so the start of its part arrives before the origin is known; dropping it
            // left the first half second or more of every phone take coded silence.
            if (!soundOrigin.isSettled) {
                audioUnseeded += 1
                heldSound.addLast(HeldSound(audio.samples, audio.wallClock, audio.durationSeconds))
                if (heldSound.size > maximumPendingAudio) {
                    val lost = heldSound.size - maximumPendingAudio
                    audioQueueDrops += lost
                    repeat(lost) { heldSound.removeFirst() }
                }
                return
            }
            queueSoundLocked(audio.samples, audio.wallClock, audio.durationSeconds)
        }
        drainAudio(limit = 8)
        syncWriter()
    }

    /**
     * Queues the held sound once the origin has settled, in the order it arrived and ahead of anything
     * later. Called with [lock] held; the next drain writes it.
     */
    private fun placeHeldSoundLocked() {
        if (!soundOrigin.isSettled || heldSound.isEmpty()) return
        val held = heldSound.toList()
        heldSound.clear()
        for (chunk in held) queueSoundLocked(chunk.samples, chunk.wall, chunk.duration)
    }

    /**
     * Places one run captured at [wall] on the part's timeline and queues it for the track, or counts
     * it as before the part. Called with [lock] held and the origin settled.
     */
    private fun queueSoundLocked(samples: ShortArray, wall: Double, duration: Double) {
        val target = soundOrigin.timeline(wall)
        if (target == null) {
            audioBeforePart += 1
            return
        }
        if (audioFirstTarget < 0) audioFirstTarget = target
        pendingAudio.addLast(PendingSound(samples, target, duration))
        if (pendingAudio.size > maximumPendingAudio) {
            val lost = pendingAudio.size - maximumPendingAudio
            audioQueueDrops += lost
            repeat(lost) { pendingAudio.removeFirst() }
            telemetry.recordError("program sound queue overflowed, $lost buffer(s) of sound lost")
        }
    }

    /**
     * Hands sound to the track: at most [limit] appends, and the only thing that moves
     * [writtenAudioEnd]. The track's position is wherever it has got to: a shortfall against where
     * the wall clock says the head belongs is covered with silence first, and a run the track has
     * already passed is dropped. [fillUntil] pads the track with silence once nothing real waits.
     */
    internal fun drainAudio(limit: Int, fillUntil: Double? = null) {
        lock.withLock {
            if (isDraining) return
            isDraining = true
        }
        try {
            var drained = 0
            while (drained < limit) {
                lock.withLock {
                    if (!isRunning) return
                    val sink = soundSink
                    if (!sink.isReadyForMoreSound) return
                    val start = maxOf(writtenAudioEnd, 0.0)
                    val next = pendingAudio.firstOrNull()
                    val samples: ShortArray
                    val span: Double
                    val isFill: Boolean
                    if (next != null) {
                        val slack = next.duration / 2
                        when {
                            next.target > start + slack -> {
                                samples = silence
                                span = silenceChunkSeconds
                                isFill = true
                            }
                            next.target < start - slack -> {
                                pendingAudio.removeFirst()
                                audioBehindTrack += 1
                                drained += 1
                                return@withLock
                            }
                            else -> {
                                samples = next.samples
                                span = next.duration
                                isFill = false
                            }
                        }
                    } else if (fillUntil != null && start + silenceChunkSeconds / 2 < fillUntil) {
                        samples = silence
                        span = silenceChunkSeconds
                        isFill = true
                    } else {
                        return
                    }
                    val accepted = try {
                        sink.appendSound(samples)
                    } catch (error: IOException) {
                        failWriterLocked(error)
                        return
                    }
                    if (!accepted) {
                        // The head stays queued: a refusal costs latency, never position.
                        audioAppendFailures += 1
                        return
                    }
                    writtenAudioEnd += span
                    if (isFill) {
                        silenceQueued += 1
                    } else {
                        acceptedAudioCount += 1
                        pendingAudio.removeFirst()
                    }
                    drained += 1
                }
            }
        } finally {
            lock.withLock { isDraining = false }
            deliverWriterFailure()
        }
    }

    /** What the sound path did with the part's sound so far: TS Director's `soundDiagnosticsForTesting`. */
    internal class SoundDiagnostics(
        val origin: Double,
        val offered: Int,
        val unseeded: Int,
        val beforePart: Int,
        val first: Double,
        val silence: Int
    )

    internal val soundDiagnosticsForTesting: SoundDiagnostics
        get() = lock.withLock {
            SoundDiagnostics(soundOrigin.partStartWall ?: -1.0, audioOffered, audioUnseeded, audioBeforePart, audioFirstTarget, silenceQueued)
        }

    private fun resetSoundDiagnosticsLocked() {
        audioOffered = 0
        audioUnseeded = 0
        audioBeforePart = 0
        audioFirstTarget = -1.0
        audioBehindTrack = 0
        silenceQueued = 0
        audioAppendFailures = 0
        audioQueueDrops = 0
    }

    internal val writtenSoundEndForTesting: Double get() = lock.withLock { writtenAudioEnd }
    internal val writerHasPendingSyncForTesting: Boolean get() = lock.withLock { writer?.hasPendingSync ?: false }
    internal val soundOriginForTesting: Double? get() = lock.withLock { soundOrigin.partStartWall }
    internal val acceptedSoundCountForTesting: Int get() = lock.withLock { acceptedAudioCount }
    internal val audioBehindTrackForTesting: Int get() = lock.withLock { audioBehindTrack }


    private fun drainAudioUntilEmpty(seconds: Double) {
        val deadline = System.nanoTime() + (seconds * 1e9).toLong()
        while (true) {
            drainAudio(limit = 512)
            // A part whose file failed takes nothing more: there is nothing to wait for.
            if (lock.withLock { pendingAudio.isEmpty() || writerFailed } || System.nanoTime() >= deadline) return
            Thread.sleep(20)
        }
    }

    /**
     * Finishes the part out to [until] (the take's end on the wall clock): the hold fill, the sound
     * check, and the file. Answers with the part's file, or null when nothing was running. Blocks;
     * a host calls it off its main thread.
     */
    fun finish(until: Double? = null): File? {
        val (finishedRecordingID, finishedPart) = lock.withLock { partRecordingID to part }
        drainAudioUntilEmpty(2.0)
        val started = lock.withLock { startedAt }
        var heldPicture: Double? = null
        if (until != null && started != null) {
            // Out to the take's end on the wall clock, from where the part's timeline really starts:
            // a phone's first picture was captured a picture delay before Record, so a fill counted
            // from the take's start ended that much short of the take, and every ordinary take was
            // rebuilt instead of copied for ending early.
            val byTake = until - started - lock.withLock { previousPartsDuration }
            val byAnchors = lock.withLock { RecordingCatalog.partStart(partAnchorStarts.toList())?.first }?.let { until - it }
            val target = maxOf(0.0, byTake, byAnchors ?: 0.0)
            val (pictureAt, soundAt) = lock.withLock { (if (lastTime.isNumeric) lastTime.seconds else -1.0) to writtenAudioEnd }
            heldPicture = fillHold(target)
            drainAudioUntilEmpty(10.0)
            lastProgramFinishDetail = lock.withLock {
                "target %.3f picture %.3f sound %.3f->%.3f queued %d refused %d dropped %d accepted %d behind %d silence %d offered %d unseeded %d beforePart %d origin %.3f first %.3f".format(
                    Locale.US, target, pictureAt, soundAt, writtenAudioEnd, pendingAudio.size, audioAppendFailures,
                    audioQueueDrops, acceptedAudioCount, audioBehindTrack, silenceQueued, audioOffered, audioUnseeded,
                    audioBeforePart, soundOrigin.partStartWall ?: -1.0, audioFirstTarget
                )
            }
            telemetry.recordProgramFinish(lastProgramFinishDetail)
        }
        val stranded = lock.withLock { pendingAudio.size }
        if (stranded > 0) telemetry.recordError("program finish left $stranded audio buffers unwritten")

        val finished = lock.withLock {
            if (!isRunning) return null
            isRunning = false
            val current = writer
            try {
                soundSink.finishSound()
                current?.finish(heldPicture)
            } catch (error: Exception) {
                // What is already in the file stays; the part ends where it got to.
                telemetry.recordError("program finish failed: ${error.message ?: error.javaClass.simpleName}")
                current?.abandon()
            } finally {
                writer = null
                runCatching { aac?.close() }
                aac = null
                soundOrigin.reset()
                pendingAudio.clear()
                heldSound.clear()
                failureToReport = null
            }
            outputFile
        }

        // What the file holds, not what the encoder believes it wrote.
        val reading = finished?.let { file ->
            try {
                FragmentedMp4Reader.read(file)
            } catch (error: IOException) {
                telemetry.recordError(error.message ?: "could not read ${file.name}")
                null
            }
        }
        val picture = reading?.video?.endSeconds ?: -1.0
        val sound = reading?.audio?.let { track ->
            track.endSeconds?.let { it - track.mediaTime.toDouble() / track.timescale }
        } ?: -1.0
        val samples = reading?.audio?.samples?.size ?: -1
        val detail = lastProgramFinishDetail + " ends picture %.3f sound %.3f | in file %d samples".format(Locale.US, picture, sound, samples)
        telemetry.recordProgramFinish(detail)
        val check = ProgramSoundCheck(finishedPart, picture, sound, samples, detail)
        val checkSink = lock.withLock { soundCheckSink }
        if (finishedRecordingID != null) checkSink?.check(finishedRecordingID, check)
        if (check.isShort) telemetry.recordError("program master sound %.3f s short of its picture".format(Locale.US, check.shortfall))
        telemetry.recordEncodeSessionChange(-1)
        return finished
    }

    /**
     * Stops as a killed process does: nothing is finished, and the part keeps only the fragments
     * already on disk. For the tests that resume a take after a crash.
     */
    internal fun abandonForTesting() {
        lock.withLock {
            isRunning = false
            writer?.abandon()
            writer = null
        }
    }

    /**
     * The hold at Stop: the last picture held out to the take's length or the last picture, whichever
     * is later, and silence from where the sound ends to the same place. Answers with how long the
     * last picture lasts, or null when there is no picture to hold.
     */
    private fun fillHold(end: Double): Double? {
        val (last, rate) = lock.withLock { lastTime to settings.frameRate }
        val fill = HoldFill(end, if (last.isNumeric) last.seconds else null, rate, lock.withLock { writtenAudioEnd })
        val frame = 1.0 / maxOf(rate, 1)
        val pictureEnd = if (fill.pictureCount > 0) fill.pictureFrom + (fill.pictureCount - 1) * fill.pictureStep + frame else null
        appendHoldSilence(fill.soundEnd)
        if (!last.isNumeric) return null
        return maxOf(frame, (pictureEnd ?: (last.seconds + frame)) - last.seconds)
    }

    /**
     * Fills the sound track with silence out to [end], through the same drain the live path uses.
     * Bounded by a chunk count and a deadline, as TS Director's is, so a writer that stops taking
     * sound cannot wedge the stop.
     */
    private fun appendHoldSilence(end: Double) {
        // A part whose file never opened (no picture ever came) has no track to fill.
        if (end <= 0 || lock.withLock { writerFailed || (soundSinkOverride == null && writer == null) }) return
        val gap = HoldFill.silenceSeconds(end, lock.withLock { writtenAudioEnd })
        if (gap <= 0) return
        if (HoldFill.exceedsSilenceCap(gap)) {
            telemetry.recordError(
                "program sound tail asked for %.1f s of silence, capped at %.1f s".format(
                    Locale.US, gap, HoldFill.maximumSilenceChunks * silenceChunkSeconds
                )
            )
        }
        val deadline = System.nanoTime() + (holdSilenceDeadlineSeconds * 1e9).toLong()
        var remaining = HoldFill.maximumSilenceChunks
        while (remaining > 0 && System.nanoTime() < deadline) {
            val before = lock.withLock { writtenAudioEnd }
            drainAudio(limit = minOf(remaining, 256), fillUntil = end)
            val after = lock.withLock { writtenAudioEnd }
            if (after + silenceChunkSeconds / 2 >= end) return
            if (after <= before) {
                Thread.sleep(2)
                continue
            }
            remaining -= maxOf(1, ((after - before) / silenceChunkSeconds).roundedHalfAwayFromZero().toInt())
        }
    }

    /**
     * The hold at Stop, worked through: black pictures on TS Director from a frame after the last
     * picture, and silence from where the sound track ends, out to the take's length or the last
     * picture, whichever is later. A port of `ProgramEncoder.HoldFill`, which the fixtures share.
     */
    class HoldFill(requestedEnd: Double, lastPicture: Double?, frameRate: Int, writtenSoundEnd: Double) {
        val pictureFrom: Double
        val pictureStep: Double
        val pictureCount: Int
        val soundEnd: Double
        val silenceSeconds: Double
        val silenceCapped: Boolean

        init {
            val rate = maxOf(frameRate, 1)
            val last = lastPicture?.let { MediaTime.seconds(it, rate) } ?: MediaTime.negativeInfinity
            val start = pictureStart(last, rate)
            val step = pictureStep(start, requestedEnd, rate)
            val times = if (requestedEnd - start.seconds > 0.0005) pictureTimes(start, step, requestedEnd) else emptyList()
            val frame = 1.0 / rate
            val lastWritten = times.lastOrNull()?.seconds ?: (if (last.isNumeric) last.seconds else null)
            val pictureEnd = lastWritten?.let { it + frame } ?: 0.0
            pictureFrom = start.seconds
            pictureStep = step.seconds
            pictureCount = times.size
            soundEnd = soundEnd(requestedEnd, pictureEnd)
            silenceSeconds = silenceSeconds(soundEnd, writtenSoundEnd)
            silenceCapped = exceedsSilenceCap(silenceSeconds)
        }

        companion object {
            /** The longest fill written frame by frame on the grid; longer is filled at 10 fps. */
            const val gridFillSeconds = 30.0

            /** The most silence the tail will synthesise, in 21 ms chunks: about two minutes. */
            const val maximumSilenceChunks = 5_600

            fun pictureStart(lastPicture: MediaTime, frameRate: Int): MediaTime =
                if (lastPicture.isNumeric && lastPicture >= MediaTime.zero) lastPicture + MediaTime(1, maxOf(frameRate, 1)) else MediaTime.zero

            fun pictureStep(start: MediaTime, end: Double, frameRate: Int): MediaTime =
                if (end - start.seconds <= gridFillSeconds) MediaTime(1, maxOf(frameRate, 1)) else MediaTime(1, 10)

            fun pictureTimes(start: MediaTime, step: MediaTime, end: Double): List<MediaTime> {
                val times = mutableListOf<MediaTime>()
                var cursor = start
                while (cursor.seconds + 0.0005 < end) {
                    times += cursor
                    cursor += step
                }
                return times
            }

            fun soundEnd(requested: Double, pictureEnd: Double): Double = maxOf(0.0, maxOf(requested, pictureEnd))

            /** The silence to synthesise: none for less than one chunk. */
            fun silenceSeconds(end: Double, writtenSoundEnd: Double): Double {
                val gap = end - writtenSoundEnd
                return if (gap > silenceChunkSeconds) gap else 0.0
            }

            fun exceedsSilenceCap(seconds: Double): Boolean = seconds > maximumSilenceChunks * silenceChunkSeconds
        }
    }

    companion object {
        /** How often the programme records where it was in real time: once a fragment. */
        const val anchorIntervalSeconds = 3.0

        /** How many frame periods a picture's own slot may stray from real time's. */
        const val gridSlack = 1.5

        /** Eight seconds of the mix's 20 ms runs. */
        const val maximumPendingAudio = 400

        /** One chunk of synthesised silence: an AAC packet's length. */
        const val silenceChunkSeconds = 1024.0 / 48_000

        /** Longest the tail at Stop keeps trying. */
        const val holdSilenceDeadlineSeconds = 8.0

        /** How many AAC frames of silence the probe encodes before it reads the codec's configuration. */
        const val PROBE_FRAMES = 4

        private val silence = ShortArray(1024 * 2)

        /**
         * The grid slot a picture is written in, before the check that it is newer than [lastSlot].
         * A picture on the programme clock's grid takes the slot its number names; one that goes back
         * is placed by real time, after the last. Any other picture takes the slot its own time names
         * unless that is more than [gridSlack] frames from real time's slot, when real time's wins.
         */
        fun gridSlot(
            sourceSeconds: Double?,
            rate: Double,
            hostSlot: Long,
            lastSlot: Long,
            onClockGrid: Boolean,
            continuingAfterRecovery: Boolean
        ): Long {
            var slot = sourceSeconds?.let { (it * rate).roundedHalfAwayFromZero().toLong() } ?: hostSlot
            if (onClockGrid) {
                if (slot <= lastSlot) slot = maxOf(hostSlot, lastSlot + 1)
            } else if (!continuingAfterRecovery && abs(slot - hostSlot).toDouble() > gridSlack) {
                slot = hostSlot
            }
            return slot
        }

        /**
         * How much of the take came before a resumed part: from the take's start to the part's first
         * picture, or to the resume while it has none. Never negative.
         */
        fun previousPartsSeconds(takeStart: Double, partOpensAt: Double): Double = maxOf(0.0, partOpensAt - takeStart)

        fun partFile(stem: String, part: Int, directory: File): File =
            File(directory, if (part == 1) "$stem.mp4" else "$stem-$part.mp4")
    }
}
