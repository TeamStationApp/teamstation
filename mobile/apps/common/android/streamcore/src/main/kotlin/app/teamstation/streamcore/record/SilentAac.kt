package app.teamstation.streamcore.record

import app.teamstation.streamcore.stream.StreamAudioEncoding

/**
 * One AAC packet of true silence, for the holes an export fills, and the AudioSpecificConfig that
 * describes it. A port of TS Director's `ArchiveFiller` silence.
 *
 * An AAC encoder's first packets carry its priming rather than steady state, so a packet taken from a
 * fresh encoder is not silence even when every input sample is zero: a run of packets is encoded
 * over zeros and the last kept, which is the one that repeats cleanly.
 */
object SilentAac {
    /** How many packets are encoded over zeros before one is kept. */
    const val rounds = 8

    /** The last of [rounds] packets of zeros from [encoder], or null when it made none. */
    fun packet(encoder: StreamAudioEncoding, channels: Int = 2): ByteArray? {
        encoder.reset()
        val packets = encoder.encode(ShortArray(1024 * channels * rounds)) + encoder.finish()
        encoder.close()
        return packets.lastOrNull { it.isNotEmpty() }
    }

    /**
     * AAC-LC AudioSpecificConfig: five bits of object type, four of sample-rate index, four of
     * channel configuration, then padding. An unlisted rate falls back to 48 kHz.
     */
    fun audioSpecificConfig(sampleRate: Int, channels: Int): ByteArray {
        val rates = listOf(96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350)
        val index = rates.indexOf(sampleRate).takeIf { it >= 0 } ?: 3
        val config = (2 shl 11) or (index shl 7) or (channels.coerceIn(1, 6) shl 3)
        return byteArrayOf((config ushr 8).toByte(), config.toByte())
    }
}
