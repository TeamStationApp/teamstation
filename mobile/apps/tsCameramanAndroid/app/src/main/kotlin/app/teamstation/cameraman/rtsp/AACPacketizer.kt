package app.teamstation.cameraman.rtsp

import app.teamstation.cameraman.core.EncodedAudioFrame

/**
 * RFC 3640 `mpeg4-generic` in AAC-hbr mode: a 16-bit AU-headers-length in **bits**, then one
 * 13-bit size and 3-bit index per access unit, then the units back to back.
 *
 * One access unit per packet. At 1024 samples that is 21 ms of audio per packet, well inside any
 * jitter budget, and it keeps the AU-header section a fixed two bytes.
 */
class AACPacketizer {
    /**
     * Returns null for an access unit too large for the 13-bit size field, rather than emitting a
     * packet whose length field has silently wrapped.
     */
    fun payload(frame: EncodedAudioFrame): ByteArray? {
        val count = frame.data.size
        if (count <= 0 || count >= (1 shl sizeLength)) return null

        val payload = ByteBuilder(4 + count)
        // One AU header of sizeLength + indexLength bits.
        payload.uint16(sizeLength + indexLength)
        // 13 bits of size then 3 bits of AU-index, which is zero for the first unit in a packet. The
        // two fields happen to total 16 bits, so no bit-level packing is needed.
        payload.uint16(count shl indexLength)
        payload.bytes(frame.data)
        return payload.build()
    }

    companion object {
        /**
         * The declared sizeLength/indexLength/indexDeltaLength, which the SDP has to repeat exactly
         * or the receiver reads the size field at the wrong width.
         */
        const val sizeLength = 13
        const val indexLength = 3
        const val indexDeltaLength = 3

        /** AAC's RTP clock is the sample rate itself, so the timestamp steps by 1024 per AU. */
        fun timestamp(frameIndex: Int): Long = (frameIndex.toLong() * 1024) and 0xFFFFFFFFL
    }
}
