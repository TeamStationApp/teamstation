package co.gamestation.cameraman.encode

import java.util.Locale

/**
 * Builds the MPEG-4 `AudioSpecificConfig` that the SDP carries as `config=` and that a decoder
 * needs before it can interpret a single AAC packet.
 *
 * Pure bit assembly, kept apart from the encoder so it can be checked against known-good values and
 * round-tripped through GS Producer's parser without an audio session.
 */
object AudioSpecificConfigBuilder {
    /** Sample-rate indices from ISO/IEC 14496-3 Table 1.16, in order. */
    val sampleRateIndices = listOf(
        96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050,
        16_000, 12_000, 11_025, 8_000, 7_350
    )

    /** AAC-LC, audio object type 2. */
    const val aacLCObjectType = 2

    /**
     * Returns null for a rate or channel count AAC cannot express, rather than emitting a config
     * that decodes to the wrong sample rate.
     */
    fun aacLC(sampleRate: Int, channelCount: Int): ByteArray? {
        val frequencyIndex = sampleRateIndices.indexOf(sampleRate)
        if (frequencyIndex < 0) return null
        // Channel configurations 1…7 are the standard layouts. 0 means "described elsewhere", which
        // nothing in this pipeline produces.
        if (channelCount !in 1..7) return null

        // 5 bits object type, 4 bits frequency index, 4 bits channel configuration, then the three
        // GASpecificConfig flags — frameLengthFlag, dependsOnCoreCoder, extensionFlag — all zero.
        var bits = aacLCObjectType shl 11
        bits = bits or (frequencyIndex shl 7)
        bits = bits or (channelCount shl 3)

        return byteArrayOf(((bits shr 8) and 0xFF).toByte(), (bits and 0xFF).toByte())
    }

    /** The hex spelling SDP uses in `config=`. Lower case, no separators. */
    fun hex(data: ByteArray): String =
        data.joinToString("") { String.format(Locale.US, "%02x", it) }
}
