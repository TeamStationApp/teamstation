package app.teamstation.speedy.core

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * The samples of one of TS Speedy's clips. Only the format the clips are made in is accepted: PCM,
 * 16-bit, mono, 24 kHz. Anything else throws with the clip's name, so a bad file fails loudly
 * rather than playing as noise.
 */
object Wav {
    const val RATE = 24_000

    class Failure(message: String) : Exception(message)

    fun samples(bytes: ByteArray, name: String): ShortArray {
        if (bytes.size < 12 || ascii(bytes, 0) != "RIFF" || ascii(bytes, 8) != "WAVE") {
            throw Failure("$name: not a RIFF WAVE file")
        }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        var formatSeen = false
        var offset = 12
        while (offset + 8 <= bytes.size) {
            val id = ascii(bytes, offset)
            val size = buffer.getInt(offset + 4)
            val body = offset + 8
            if (size < 0 || body + size > bytes.size) throw Failure("$name: truncated")
            if (id == "fmt ") {
                if (size < 16) throw Failure("$name: truncated")
                val codec = buffer.getShort(body).toInt()
                val channels = buffer.getShort(body + 2).toInt()
                val rate = buffer.getInt(body + 4)
                val bits = buffer.getShort(body + 14).toInt()
                if (codec != 1) throw Failure("$name: codec $codec, not PCM")
                if (channels != 1) throw Failure("$name: $channels channels, not mono")
                if (rate != RATE) throw Failure("$name: $rate Hz, not $RATE")
                if (bits != 16) throw Failure("$name: $bits-bit, not 16")
                formatSeen = true
            } else if (id == "data") {
                if (!formatSeen) throw Failure("$name: data before fmt")
                return ShortArray(size / 2) { buffer.getShort(body + it * 2) }
            }
            offset = body + size + (size and 1)
        }
        throw Failure("$name: truncated")
    }

    /** RMS level in dBFS; minus infinity for silence. */
    fun levelDb(samples: ShortArray): Double {
        if (samples.isEmpty()) return Double.NEGATIVE_INFINITY
        val sum = samples.fold(0.0) { acc, s -> acc + s.toDouble() * s.toDouble() }
        val rms = Math.sqrt(sum / samples.size)
        return if (rms == 0.0) Double.NEGATIVE_INFINITY else 20 * Math.log10(rms / 32768)
    }

    private fun ascii(bytes: ByteArray, at: Int) = String(bytes, at, 4, Charsets.US_ASCII)
}
