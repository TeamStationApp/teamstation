package app.teamstation.speedy.audio

import app.teamstation.speedy.core.Cancellable
import app.teamstation.speedy.core.PhrasePlayer
import app.teamstation.speedy.core.Scheduler
import app.teamstation.speedy.core.Wav

/** One phrase's sound, ready to play. */
interface Track {
    /** Plays, then calls [onDone] on the main thread once the last sample has been heard. */
    fun play(onDone: () -> Unit)
    fun stop()
}

fun interface TrackFactory {
    fun make(pcm: ShortArray): Track
}

/** The audio focus TS Speedy holds while it speaks: transient, letting others duck. */
interface Focus {
    fun gain()
    fun abandon()
}

/**
 * Plays phrases from the bundled clips.
 *
 * A phrase's clips are joined into one buffer before it is played, so its words follow each other
 * with no gap. Phrases play in the order they arrive, and focus is held only while some play.
 *
 * A phrase ends when its track says so, or, should that never come (a track stopped short, its
 * callback's thread gone), once its length and [FALLBACK_MARGIN_MS] have passed; a track the
 * system will not make at all is skipped. Either way the phrases behind it still play.
 */
class ClipPlayer(
    private val clipBytes: (String) -> ByteArray?,
    private val tracks: TrackFactory,
    private val focus: Focus,
    private val scheduler: Scheduler,
    /** Under a UI test, what each track was given to play, once it has played. */
    private val capture: SpeechCapture? = null
) : PhrasePlayer {
    private val cache = HashMap<String, ShortArray>()
    private val queue = ArrayDeque<ShortArray>()
    private var current: Track? = null
    private var generation = 0

    val waiting: Int get() = queue.size
    val playing: Boolean get() = current != null

    override fun play(clips: List<String>) {
        val pcm = runCatching { pcm(clips) }.getOrNull() ?: return
        queue.addLast(pcm)
        if (current == null) {
            focus.gain()
            next()
        }
    }

    override fun stop() {
        generation++
        queue.clear()
        current?.stop()
        if (current != null) focus.abandon()
        current = null
    }

    /** Every clip of a phrase, end to end. */
    fun pcm(clips: List<String>): ShortArray {
        val parts = clips.map { samples(it) }
        val out = ShortArray(parts.sumOf { it.size })
        if (out.isEmpty()) throw Wav.Failure("${clips.joinToString("+")}: no samples")
        var at = 0
        for (part in parts) {
            part.copyInto(out, at)
            at += part.size
        }
        return out
    }

    /** A clip's samples, read once. */
    fun samples(name: String): ShortArray = cache.getOrPut(name) {
        val bytes = clipBytes(name) ?: throw Wav.Failure("$name: not a RIFF WAVE file")
        Wav.samples(bytes, name)
    }

    private fun next() {
        val pcm = queue.removeFirstOrNull()
        if (pcm == null) {
            current = null
            focus.abandon()
            return
        }
        val generation = this.generation
        val track = runCatching { tracks.make(pcm) }.getOrNull()
        if (track == null) {
            next()
            return
        }
        current = track
        var done = false
        var fallback: Cancellable? = null
        val finish = {
            if (!done && generation == this.generation) {
                done = true
                fallback?.cancel()
                track.stop()
                capture?.append(pcm)
                next()
            }
        }
        fallback = scheduler.after(pcm.size * 1000L / Wav.RATE + FALLBACK_MARGIN_MS) { finish() }
        track.play { finish() }
    }

    companion object {
        /** How long past a phrase's length its track may take to say it is done. */
        const val FALLBACK_MARGIN_MS = 1_500L
    }
}

/**
 * Collects the samples each phrase played and writes them as a WAV, for a UI test to pull off the
 * phone (`adb exec-out run-as app.teamstation.speedy cat files/speech-capture.wav`) and listen to.
 */
class SpeechCapture(private val file: java.io.File) {
    private val samples = ArrayList<Short>()

    init {
        file.delete()
    }

    fun append(pcm: ShortArray) {
        pcm.forEach { samples += it }
        file.writeBytes(wav(samples.toShortArray()))
    }

    companion object {
        const val NAME = "speech-capture.wav"

        fun wav(samples: ShortArray): ByteArray {
            val buffer = java.nio.ByteBuffer.allocate(44 + samples.size * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
            buffer.put("RIFF".toByteArray()).putInt(36 + samples.size * 2).put("WAVEfmt ".toByteArray())
            buffer.putInt(16).putShort(1).putShort(1).putInt(Wav.RATE).putInt(Wav.RATE * 2)
            buffer.putShort(2).putShort(16).put("data".toByteArray()).putInt(samples.size * 2)
            samples.forEach { buffer.putShort(it) }
            return buffer.array()
        }
    }
}
