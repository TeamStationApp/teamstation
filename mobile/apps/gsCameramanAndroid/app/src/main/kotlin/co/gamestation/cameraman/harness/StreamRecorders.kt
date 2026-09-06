package co.gamestation.cameraman.harness

import co.gamestation.cameraman.core.EncodedAudioFrame
import co.gamestation.cameraman.core.EncodedVideoFrame
import co.gamestation.cameraman.encode.ADTSHeader
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.max

/**
 * Writes the encoder's output to an Annex-B file in the app's files directory, so the real
 * hardware-encoded bytes can be pulled off the device with `adb` and put through ffprobe.
 *
 * This exists because "the encoder is configured correctly" and "the encoder produces a decodable
 * stream" are different claims, and only the second one matters. A MediaCodec that accepts every
 * key you set and emits an undecodable stream reports no error anywhere.
 */
class ElementaryStreamRecorder(directory: File, filename: String) {
    data class Summary(
        var path: String,
        var frames: Int = 0,
        var keyframes: Int = 0,
        var bytes: Int = 0,
        var parameterSetBytes: Int = 0,
        var firstPresentationTime: Double = 0.0,
        var lastPresentationTime: Double = 0.0
    ) {
        val duration: Double get() = max(0.0, lastPresentationTime - firstPresentationTime)

        /** Measured, so a bitrate setting the encoder quietly ignored is visible. */
        val measuredBitrate: Int
            get() = if (duration > 0) (bytes * 8 / duration).toInt() else 0
    }

    private val lock = ReentrantLock()
    private var handle: FileOutputStream?
    private val summary: Summary

    init {
        val file = File(directory, filename)
        handle = runCatching { FileOutputStream(file) }.getOrNull()
        summary = Summary(path = file.absolutePath)
    }

    fun append(frame: EncodedVideoFrame) {
        lock.withLock {
            val handle = this.handle ?: return
            // Parameter sets go in ahead of the keyframe they describe. ffprobe can start decoding
            // from any keyframe that way, which is the same property a client joining mid-stream
            // depends on.
            var written = 0
            if (frame.parameterSets.isNotEmpty()) {
                val sets = startCodePrefixed(frame.parameterSets)
                handle.write(sets)
                written += sets.size
                summary.parameterSetBytes += frame.parameterSets.sumOf { it.size }
            }
            val units = startCodePrefixed(frame.nalUnits)
            handle.write(units)
            written += units.size

            if (summary.frames == 0) summary.firstPresentationTime = frame.presentationTime
            summary.lastPresentationTime = frame.presentationTime
            summary.frames += 1
            if (frame.isKeyframe) summary.keyframes += 1
            summary.bytes += written
        }
    }

    fun finish(): Summary = lock.withLock {
        runCatching { handle?.close() }
        handle = null
        summary
    }

    private fun startCodePrefixed(units: List<ByteArray>): ByteArray {
        val stream = java.io.ByteArrayOutputStream()
        for (unit in units) {
            stream.write(byteArrayOf(0x00, 0x00, 0x00, 0x01), 0, 4)
            stream.write(unit, 0, unit.size)
        }
        return stream.toByteArray()
    }
}

/**
 * Writes the AAC encoder's output to an ADTS file, so the real hardware-encoded audio can be pulled
 * off the device and decoded by ffprobe.
 *
 * The frames are wrapped in ADTS purely so the file is self-describing; the RTP path sends the same
 * access units bare.
 */
class AudioStreamRecorder(directory: File, filename: String) {
    data class Summary(
        var path: String,
        var frames: Int = 0,
        var bytes: Int = 0,
        var sampleRate: Int = 0,
        var channelCount: Int = 0,
        var firstPresentationTime: Double = 0.0,
        var lastPresentationTime: Double = 0.0,
        /**
         * Frames the encoder produced at a rate or channel count ADTS cannot express, which would
         * otherwise be silently missing from the file.
         */
        var unwrappable: Int = 0
    ) {
        val duration: Double get() = max(0.0, lastPresentationTime - firstPresentationTime)
    }

    private val lock = ReentrantLock()
    private var handle: FileOutputStream?
    private val summary: Summary

    init {
        val file = File(directory, filename)
        handle = runCatching { FileOutputStream(file) }.getOrNull()
        summary = Summary(path = file.absolutePath)
    }

    fun append(frame: EncodedAudioFrame) {
        lock.withLock {
            val handle = this.handle ?: return
            val wrapped = ADTSHeader.wrap(frame.data, frame.sampleRate, frame.channelCount)
            if (wrapped == null) {
                summary.unwrappable += 1
                return
            }
            handle.write(wrapped)

            if (summary.frames == 0) summary.firstPresentationTime = frame.presentationTime
            summary.lastPresentationTime = frame.presentationTime
            summary.frames += 1
            summary.bytes += wrapped.size
            summary.sampleRate = frame.sampleRate
            summary.channelCount = frame.channelCount
        }
    }

    fun finish(): Summary = lock.withLock {
        runCatching { handle?.close() }
        handle = null
        summary
    }
}
