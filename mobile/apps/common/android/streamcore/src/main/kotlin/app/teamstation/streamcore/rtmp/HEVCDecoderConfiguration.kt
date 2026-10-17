package app.teamstation.streamcore.rtmp

import java.io.ByteArrayOutputStream

/**
 * Builds the HEVCDecoderConfigurationRecord (ISO/IEC 14496-15 §8.3.3.1, the `hvcC` box body) that
 * Enhanced RTMP's SequenceStart carries for `hvc1`, and that the recording's `hvc1` sample entry
 * holds. A port of TS Director's `HEVCDecoderConfiguration`.
 *
 * Everything in the record's header is read from the SPS, the way FFmpeg's `hvcc.c` fills it. The
 * fields a publisher cannot know without parsing the VUI are written as "unknown", which the
 * specification allows.
 */
object HEVCDecoderConfiguration {
    const val vpsType = 32
    const val spsType = 33
    const val ppsType = 34

    /** The NAL unit type of an HEVC NAL unit: six bits after the forbidden zero bit. */
    fun nalType(nal: ByteArray): Int? = nal.firstOrNull()?.let { (it.toInt() ushr 1) and 0x3F }

    /**
     * The record for parameter sets in any order, each a bare NAL unit. Null when there is no VPS,
     * SPS and PPS, or the SPS cannot be read. [lengthSize] is the size of the length prefix in front
     * of each NAL unit in the coded frames.
     */
    fun record(parameterSets: List<ByteArray>, lengthSize: Int = 4): ByteArray? {
        val vps = parameterSets.filter { nalType(it) == vpsType }
        val sps = parameterSets.filter { nalType(it) == spsType }
        val pps = parameterSets.filter { nalType(it) == ppsType }
        val first = sps.firstOrNull() ?: return null
        if (vps.isEmpty() || pps.isEmpty() || lengthSize !in 1..4 || lengthSize == 3) return null
        val info = SPSInfo.read(first) ?: return null

        val out = ByteArrayOutputStream()
        out.write(1)
        out.write((info.profileSpace shl 6) or (info.tierFlag shl 5) or info.profileIDC)
        info.compatibilityFlags.forEach { out.write(it) }
        info.constraintFlags.forEach { out.write(it) }
        out.write(info.levelIDC)
        // reserved '1111' + min_spatial_segmentation_idc (0: unknown).
        out.write(0xF0)
        out.write(0x00)
        // reserved '111111' + parallelismType (0: unknown).
        out.write(0xFC)
        out.write(0xFC or (info.chromaFormatIDC and 0x03))
        out.write(0xF8 or (info.bitDepthLumaMinus8 and 0x07))
        out.write(0xF8 or (info.bitDepthChromaMinus8 and 0x07))
        // avgFrameRate (0: unknown).
        out.write(0x00)
        out.write(0x00)
        // constantFrameRate (0: unknown), numTemporalLayers, temporalIdNested, lengthSizeMinusOne.
        val temporalLayers = (info.maxSubLayersMinus1 + 1) and 0x07
        out.write((temporalLayers shl 3) or ((info.temporalIDNesting and 1) shl 2) or (lengthSize - 1))
        out.write(3)
        for ((type, units) in listOf(vpsType to vps, spsType to sps, ppsType to pps)) {
            // array_completeness 1: every parameter set of this type is here, none arrives in band.
            out.write(0x80 or type)
            out.write((units.size ushr 8) and 0xFF)
            out.write(units.size and 0xFF)
            for (unit in units) {
                out.write((unit.size ushr 8) and 0xFF)
                out.write(unit.size and 0xFF)
                out.write(unit)
            }
        }
        return out.toByteArray()
    }

    /** The picture size an SPS declares, after its conformance window, for a sample entry. */
    fun pictureSize(sps: ByteArray): Pair<Int, Int>? = SPSInfo.read(sps)?.let { it.width to it.height }

    /** The SPS fields the record repeats. */
    internal data class SPSInfo(
        val maxSubLayersMinus1: Int,
        val temporalIDNesting: Int,
        val profileSpace: Int,
        val tierFlag: Int,
        val profileIDC: Int,
        val compatibilityFlags: List<Int>,
        val constraintFlags: List<Int>,
        val levelIDC: Int,
        val chromaFormatIDC: Int,
        val bitDepthLumaMinus8: Int,
        val bitDepthChromaMinus8: Int,
        val width: Int,
        val height: Int
    ) {
        companion object {
            fun read(sps: ByteArray): SPSInfo? {
                // The two-byte NAL header is not part of the RBSP.
                if (sps.size <= 2) return null
                val reader = BitReader(rbsp(sps.copyOfRange(2, sps.size)))
                if (!reader.skip(4)) return null
                val maxSubLayersMinus1 = reader.read(3) ?: return null
                val nesting = reader.read(1) ?: return null
                val profileSpace = reader.read(2) ?: return null
                val tier = reader.read(1) ?: return null
                val profile = reader.read(5) ?: return null
                val compatibility = List(4) { reader.read(8) ?: return null }
                val constraints = List(6) { reader.read(8) ?: return null }
                val level = reader.read(8) ?: return null

                // Sub-layer profile and level, which the record does not carry but which sit in
                // front of the fields it does.
                val profilePresent = mutableListOf<Boolean>()
                val levelPresent = mutableListOf<Boolean>()
                repeat(maxSubLayersMinus1) {
                    val profileFlag = reader.read(1) ?: return null
                    val levelFlag = reader.read(1) ?: return null
                    profilePresent += profileFlag == 1
                    levelPresent += levelFlag == 1
                }
                if (maxSubLayersMinus1 > 0 && !reader.skip(2 * (8 - maxSubLayersMinus1))) return null
                for (index in 0 until maxSubLayersMinus1) {
                    if (profilePresent[index] && !reader.skip(88)) return null
                    if (levelPresent[index] && !reader.skip(8)) return null
                }

                reader.readExpGolomb() ?: return null
                val chroma = reader.readExpGolomb() ?: return null
                if (chroma == 3L && !reader.skip(1)) return null
                var width = reader.readExpGolomb() ?: return null
                var height = reader.readExpGolomb() ?: return null
                val conformanceWindow = reader.read(1) ?: return null
                if (conformanceWindow == 1) {
                    val offsets = List(4) { reader.readExpGolomb() ?: return null }
                    // Offsets count chroma samples: two luma samples across, and two down in 4:2:0.
                    val subWidth = if (chroma == 1L || chroma == 2L) 2 else 1
                    val subHeight = if (chroma == 1L) 2 else 1
                    width -= subWidth * (offsets[0] + offsets[1])
                    height -= subHeight * (offsets[2] + offsets[3])
                }
                val lumaDepth = reader.readExpGolomb() ?: return null
                val chromaDepth = reader.readExpGolomb() ?: return null
                return SPSInfo(
                    maxSubLayersMinus1 = maxSubLayersMinus1,
                    temporalIDNesting = nesting,
                    profileSpace = profileSpace,
                    tierFlag = tier,
                    profileIDC = profile,
                    compatibilityFlags = compatibility,
                    constraintFlags = constraints,
                    levelIDC = level,
                    chromaFormatIDC = minOf(chroma, 3L).toInt(),
                    bitDepthLumaMinus8 = minOf(lumaDepth, 7L).toInt(),
                    bitDepthChromaMinus8 = minOf(chromaDepth, 7L).toInt(),
                    width = width.toInt(),
                    height = height.toInt()
                )
            }
        }
    }

    /** Drops the emulation prevention byte from every `00 00 03`. */
    internal fun rbsp(bytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(bytes.size)
        var zeros = 0
        for (byte in bytes) {
            val value = byte.toInt() and 0xFF
            if (zeros >= 2 && value == 0x03) {
                zeros = 0
                continue
            }
            out.write(value)
            zeros = if (value == 0) zeros + 1 else 0
        }
        return out.toByteArray()
    }

    internal class BitReader(private val bytes: ByteArray) {
        private var position = 0

        fun read(count: Int): Int? {
            if (count > 31 || position + count > bytes.size * 8) return null
            var value = 0
            repeat(count) {
                val bit = ((bytes[position ushr 3].toInt() and 0xFF) ushr (7 - (position and 7))) and 1
                value = (value shl 1) or bit
                position += 1
            }
            return value
        }

        fun skip(count: Int): Boolean {
            if (position + count > bytes.size * 8) return false
            position += count
            return true
        }

        /** ue(v): leading zeros, a one, then that many bits. */
        fun readExpGolomb(): Long? {
            var zeros = 0
            while (true) {
                val bit = read(1) ?: return null
                if (bit == 1) break
                zeros += 1
                if (zeros > 31) return null
            }
            val tail = if (zeros == 0) 0 else (read(zeros) ?: return null)
            return (1L shl zeros) - 1 + tail
        }
    }
}
