package co.gamestation.cameraman.encode

import android.media.MediaFormat
import co.gamestation.cameraman.core.StreamCodec
import java.util.Locale

/**
 * Pulls the decoder configuration out of MediaCodec's output format.
 *
 * These have to be sent two ways at once: in the SDP so a client can decode the very first frame it
 * receives, and in-band before every keyframe so a client that joined mid-stream, or one whose
 * decoder was reset, recovers without a new `DESCRIBE`.
 *
 * MediaCodec publishes them as `csd-0` / `csd-1` byte buffers in Annex-B, and how they are divided
 * up is codec-specific rather than uniform: AVC puts SPS in `csd-0` and PPS in `csd-1`, while HEVC
 * packs VPS, SPS and PPS into `csd-0` together. Splitting on start codes rather than trusting the
 * buffer boundaries is what makes both come out in the order the SDP needs.
 */
object ParameterSets {
    fun extract(format: MediaFormat, codec: StreamCodec): List<ByteArray> = when (codec) {
        StreamCodec.H264 -> h264(format)
        StreamCodec.HEVC -> hevc(format)
    }

    /** SPS then PPS, which is the order `sprop-parameter-sets` requires. */
    fun h264(format: MediaFormat): List<ByteArray> = csdUnits(format)

    /**
     * VPS, SPS then PPS — the order `CMVideoFormatDescriptionCreateFromHEVCParameterSets` expects on
     * the receiving side, which is what GS Producer builds its decoder from. That is also the order
     * MediaCodec packs them into `csd-0`, so nothing has to be reordered; it does have to be split.
     */
    fun hevc(format: MediaFormat): List<ByteArray> = csdUnits(format)

    private fun csdUnits(format: MediaFormat): List<ByteArray> {
        val units = ArrayList<ByteArray>()
        for (index in 0..2) {
            val key = "csd-$index"
            if (!format.containsKey(key)) continue
            val buffer = format.getByteBuffer(key) ?: continue
            val bytes = ByteArray(buffer.remaining())
            buffer.duplicate().get(bytes)
            units.addAll(NALUnitConversion.elementaryUnitsFromAnnexB(bytes))
        }
        return units
    }

    /**
     * The `profile-level-id` for H.264's `fmtp` line: profile_idc, the constraint byte and level_idc
     * from the SPS, as six hex digits.
     */
    fun h264ProfileLevelID(sps: ByteArray): String? {
        // Byte 0 is the NAL header, so the three bytes of interest start at 1.
        if (sps.size < 4) return null
        return String.format(
            Locale.US,
            "%02X%02X%02X",
            sps[1].toInt() and 0xFF,
            sps[2].toInt() and 0xFF,
            sps[3].toInt() and 0xFF
        )
    }
}
