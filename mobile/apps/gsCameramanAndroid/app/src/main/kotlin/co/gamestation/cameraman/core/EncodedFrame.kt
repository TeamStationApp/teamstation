package co.gamestation.cameraman.core

/**
 * One coded picture, as elementary NAL units with no start codes and no length prefixes.
 *
 * These types live in `core` rather than in the encoder so that `encode` and `rtsp` are siblings
 * instead of a chain. That is what lets every packetizer test run on bytes with no MediaCodec
 * present — which on the JVM unit-test source set is the only option there is.
 */
data class EncodedVideoFrame(
    val nalUnits: List<ByteArray>,
    /**
     * SPS/PPS, or VPS/SPS/PPS for HEVC. Sent in-band before every keyframe as well as in the SDP,
     * because a decoder that waits for the in-band copy shows a black tile until the next keyframe.
     */
    val parameterSets: List<ByteArray> = emptyList(),
    val isKeyframe: Boolean,
    /** Seconds on the capture clock. Converted to a 90 kHz RTP timestamp at packetization time. */
    val presentationTime: Double
) {
    val isEmpty: Boolean get() = nalUnits.isEmpty() && parameterSets.isEmpty()

    // ByteArray has identity equality, so the generated equals would compare references and every
    // round-trip assertion in the test suite would fail for the wrong reason.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is EncodedVideoFrame) return false
        return isKeyframe == other.isKeyframe &&
            presentationTime == other.presentationTime &&
            nalUnits.size == other.nalUnits.size &&
            parameterSets.size == other.parameterSets.size &&
            nalUnits.indices.all { nalUnits[it].contentEquals(other.nalUnits[it]) } &&
            parameterSets.indices.all { parameterSets[it].contentEquals(other.parameterSets[it]) }
    }

    override fun hashCode(): Int {
        var result = nalUnits.fold(0) { acc, unit -> acc * 31 + unit.contentHashCode() }
        result = result * 31 + parameterSets.fold(0) { acc, unit -> acc * 31 + unit.contentHashCode() }
        result = result * 31 + isKeyframe.hashCode()
        return result * 31 + presentationTime.hashCode()
    }
}

/** One AAC access unit, without an ADTS header — RTP `mpeg4-generic` carries raw AUs. */
data class EncodedAudioFrame(
    val data: ByteArray,
    val presentationTime: Double,
    val sampleRate: Int,
    val channelCount: Int,
    /**
     * When the first sample of this frame reached the microphone, in seconds on the boot clock the
     * camera stamps video frames with. Null when `AudioRecord` could not say. [presentationTime] is
     * the sample count and stays the RTP timeline; this is what the sender report pairs it with.
     */
    val captureTime: Double? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is EncodedAudioFrame) return false
        return data.contentEquals(other.data) &&
            presentationTime == other.presentationTime &&
            sampleRate == other.sampleRate &&
            channelCount == other.channelCount &&
            captureTime == other.captureTime
    }

    override fun hashCode(): Int {
        var result = data.contentHashCode()
        result = result * 31 + presentationTime.hashCode()
        result = result * 31 + sampleRate
        result = result * 31 + channelCount
        return result * 31 + (captureTime?.hashCode() ?: 0)
    }
}
