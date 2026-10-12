package app.teamstation.streamcore.encode

/**
 * Builds the 7-byte ADTS header that wraps a bare AAC access unit into a self-describing frame.
 *
 * The RTP path never uses this — `mpeg4-generic` carries bare access units and a client that gets
 * ADTS-wrapped frames decodes seven bytes of header as audio. It exists so the encoder's real output
 * can be written to a file and decoded by ffprobe, which needs each frame to describe its own rate
 * and channel layout.
 */
object ADTSHeader {
    const val headerCount = 7

    /**
     * Returns null for a rate or channel count ADTS cannot express, rather than emitting a header
     * that decodes at the wrong sample rate.
     */
    fun wrap(accessUnit: ByteArray, sampleRate: Int, channelCount: Int): ByteArray? {
        val header = make(accessUnit.size, sampleRate, channelCount) ?: return null
        return header + accessUnit
    }

    fun make(payloadCount: Int, sampleRate: Int, channelCount: Int): ByteArray? {
        val frequencyIndex = AudioSpecificConfigBuilder.sampleRateIndices.indexOf(sampleRate)
        if (frequencyIndex < 0) return null
        if (channelCount !in 1..7) return null

        // The 13-bit length field covers the header as well as the payload.
        val frameLength = payloadCount + headerCount
        if (payloadCount <= 0 || frameLength >= (1 shl 13)) return null

        // The profile field is the audio object type minus one, so AAC-LC (2) is written as 1.
        val profile = AudioSpecificConfigBuilder.aacLCObjectType - 1

        val header = ByteArray(headerCount)
        header[0] = 0xFF.toByte()
        // Syncword's low 4 bits, then MPEG-4, layer 00, and protection-absent so no CRC follows.
        header[1] = 0xF1.toByte()
        header[2] = (((profile shl 6) or (frequencyIndex shl 2) or (channelCount shr 2)) and 0xFF).toByte()
        header[3] = ((((channelCount and 0x3) shl 6) or ((frameLength shr 11) and 0x03)) and 0xFF).toByte()
        header[4] = ((frameLength shr 3) and 0xFF).toByte()
        // Frame length's low 3 bits, then the top 5 of a buffer-fullness of 0x7FF, meaning VBR.
        header[5] = ((((frameLength and 0x07) shl 5) or 0x1F) and 0xFF).toByte()
        // Buffer fullness's low 6 bits, then one access unit per frame, written as 0.
        header[6] = 0xFC.toByte()

        return header
    }
}
