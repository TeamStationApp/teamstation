package app.teamstation.streamcore.upload

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import java.io.File
import java.io.RandomAccessFile

/**
 * Sending one recording to TeamStation. A port of TS Director's `UploadService`, written for the
 * network a ball field has:
 *
 * - It asks before it sends: the server says which parts it has, so an upload that was cut off
 *   resumes from what was `received` instead of starting again.
 * - It reads one part at a time, seeking to it; the file is never held in memory.
 * - It retries a step, not the upload: each request, the opening and the finish included, is tried
 *   four times with waits of 1, 2 and 4 s.
 * - Once the bytes are in, it finishes and then polls every 5 s, for up to 15 minutes, while the
 *   server assembles the video.
 */
class UploadService(
    private val client: UploadClient,
    private val tries: Int = 4,
    /** Waits, in milliseconds; tests record them. */
    private val sleep: suspend (Long) -> Unit = { delay(it) },
    private val pollMillis: Long = 5_000,
    private val pollLimitMillis: Long = 900_000
) {
    data class Progress(
        val sent: Int,
        val parts: Int,
        val bytesSent: Long,
        val bytesTotal: Long,
        /** What the server is doing once the bytes are all there: `assembling`, `probing`, … */
        val step: String? = null
    ) {
        val fraction: Double get() = if (bytesTotal <= 0) 0.0 else bytesSent.toDouble() / bytesTotal
    }

    sealed class UploadError(message: String) : Exception(message) {
        data class CannotRead(val what: String) : UploadError("cannot read $what")

        /** Every retry used up on one step; what is already in stays on the server. */
        data class GaveUp(val step: String, val because: String) : UploadError("gave up $step: $because")
    }

    /**
     * Sends [file], and answers with the video it became. [startedAt] is when the recording began,
     * seconds since 1970. [uploadId] resumes an upload already opened. [liveStreamId] and
     * [wholeStream] say which live stream the recording is the local copy of.
     *
     * [onOpened] is told the upload's id as soon as the server has opened it (or as given), before a
     * byte is sent: a caller that keeps it can resume a killed upload from the parts the server
     * already has, rather than open a second one.
     */
    suspend fun send(
        file: File,
        gameId: String,
        title: String,
        kind: String,
        startedAt: Double,
        uploadId: String? = null,
        liveStreamId: String? = null,
        wholeStream: Boolean? = null,
        onOpened: (String) -> Unit = {},
        onProgress: (Progress) -> Unit = {}
    ): String {
        val size = file.length()
        if (!file.isFile || size <= 0) throw UploadError.CannotRead("${file.name} is empty or missing")

        val opened = if (uploadId != null) {
            val state = withRetries("opening the upload") { client.uploadState(uploadId) }
            UploadClient.Opened(uploadId, state.partSize, state.parts, state.received)
        } else {
            withRetries("opening the upload") {
                client.openUpload(gameId, title, kind, file.name, size, startedAt, liveStreamId, wholeStream)
            }
        }

        onOpened(opened.uploadId)
        val have = opened.received.toMutableSet()
        onProgress(Progress(have.size, opened.parts, minOf(size, have.size.toLong() * opened.partSize), size))
        RandomAccessFile(file, "r").use { handle ->
            for (index in 0 until opened.parts) {
                if (index in have) continue
                val start = index.toLong() * opened.partSize
                val length = minOf(opened.partSize.toLong(), size - start).toInt()
                if (length <= 0) throw UploadError.CannotRead("part $index of ${file.name} is short on this phone")
                val bytes = ByteArray(length)
                handle.seek(start)
                handle.readFully(bytes)
                withRetries("part $index") { client.sendPart(opened.uploadId, index, bytes) }
                have += index
                onProgress(Progress(have.size, opened.parts, minOf(size, have.size.toLong() * opened.partSize), size))
            }
        }
        return finish(opened.uploadId, opened.parts, size, onProgress)
    }

    /** Turns the parts into a video, and follows the server while it does. */
    private suspend fun finish(uploadId: String, parts: Int, bytes: Long, onProgress: (Progress) -> Unit): String {
        val told = withRetries("finishing the upload") { client.finishUpload(uploadId) }
        // Already done: asking twice gets the same video, not a second one.
        told.videoId?.let { return it }
        onProgress(Progress(parts, parts, bytes, bytes, told.step ?: "assembling"))
        var waited = 0L
        var last = "assembling"
        while (waited < pollLimitMillis) {
            sleep(pollMillis)
            waited += pollMillis
            val state = runCatching { client.uploadState(uploadId) }.getOrNull() ?: continue
            when (state.state) {
                "ready" -> state.videoId?.let { return it }
                "failed", "abandoned" -> throw UploadError.GaveUp("finishing the upload", state.message ?: state.state)
                else -> {
                    last = state.step ?: state.state
                    onProgress(Progress(parts, parts, bytes, bytes, last))
                }
            }
        }
        throw UploadError.GaveUp("finishing the upload", "still $last")
    }

    /** One step, tried again with a growing wait: 1, 2 and 4 s between four tries. */
    private suspend fun <T> withRetries(step: String, work: suspend () -> T): T {
        var wait = 1_000L
        var last = ""
        for (attempt in 1..tries) {
            try {
                return work()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                last = error.message ?: error.javaClass.simpleName
                if (attempt == tries) break
                sleep(wait)
                wait = minOf(wait * 2, 8_000)
            }
        }
        throw UploadError.GaveUp(step, last)
    }
}
