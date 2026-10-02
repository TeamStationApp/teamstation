package app.teamstation.cameraman.encode

/**
 * NAL-unit layout conversion.
 *
 * This is where the two platforms genuinely differ. VideoToolbox hands back AVCC-style samples —
 * each NAL preceded by a big-endian length — so the iOS build's job is to strip the prefixes.
 * MediaCodec hands back Annex-B, with `00 00 00 01` or `00 00 01` start codes, so the job here is
 * to split on start codes instead. RTP wants elementary units with neither, and both paths converge
 * on the same `EncodedVideoFrame`, which is why every packetizer is identical across the two builds.
 *
 * Pure byte manipulation, deliberately separate from the encoder, so it is testable without
 * MediaCodec.
 */
object NALUnitConversion {
    /**
     * Splits an Annex-B buffer into elementary NAL units.
     *
     * Returns an empty list for a buffer with no start code at all rather than treating the whole
     * thing as one unit, because a buffer that is not Annex-B is not a buffer this understands and
     * guessing produces visible corruption.
     */
    fun elementaryUnitsFromAnnexB(data: ByteArray): List<ByteArray> {
        val units = ArrayList<ByteArray>()
        var index = 0
        var unitStart = -1

        while (index < data.size) {
            val codeLength = startCodeLength(data, index)
            if (codeLength == 0) {
                index += 1
                continue
            }
            if (unitStart >= 0 && index > unitStart) {
                units.add(data.copyOfRange(unitStart, index))
            }
            index += codeLength
            unitStart = index
        }

        if (unitStart in 0 until data.size) {
            units.add(data.copyOfRange(unitStart, data.size))
        }
        return units.filter { it.isNotEmpty() }
    }

    /** 3- or 4-byte start code at [index], or 0 if there is none. */
    private fun startCodeLength(data: ByteArray, index: Int): Int {
        if (index + 3 < data.size &&
            data[index] == 0.toByte() && data[index + 1] == 0.toByte() &&
            data[index + 2] == 0.toByte() && data[index + 3] == 1.toByte()
        ) {
            return 4
        }
        if (index + 2 < data.size &&
            data[index] == 0.toByte() && data[index + 1] == 0.toByte() &&
            data[index + 2] == 1.toByte()
        ) {
            return 3
        }
        return 0
    }

    /**
     * Splits a length-prefixed buffer into elementary NAL units.
     *
     * MediaCodec never produces this layout, but TS Director's decoder consumes it and the
     * round-trip tests rebuild it, so the conversion has to exist and has to be right. Returns null
     * on a malformed buffer rather than a partial list, because a truncated final unit decodes into
     * visible corruption and is better dropped than sent.
     */
    fun elementaryUnitsFromAVCC(data: ByteArray, lengthSize: Int = 4): List<ByteArray>? {
        if (lengthSize !in 1..4) return null
        val units = ArrayList<ByteArray>()
        var offset = 0

        while (offset < data.size) {
            if (offset + lengthSize > data.size) return null
            var length = 0
            for (index in 0 until lengthSize) {
                length = (length shl 8) or (data[offset + index].toInt() and 0xFF)
            }
            offset += lengthSize
            if (length <= 0 || offset + length > data.size) return null
            units.add(data.copyOfRange(offset, offset + length))
            offset += length
        }
        return units
    }

    /** The inverse, which the round-trip tests use. */
    fun avccFromElementaryUnits(units: List<ByteArray>, lengthSize: Int = 4): ByteArray {
        val result = java.io.ByteArrayOutputStream()
        for (unit in units) {
            val length = unit.size
            for (shift in (lengthSize - 1) * 8 downTo 0 step 8) {
                result.write((length shr shift) and 0xFF)
            }
            result.write(unit, 0, unit.size)
        }
        return result.toByteArray()
    }

    /** Annex-B, for writing an elementary stream to disk that ffmpeg and ffprobe can read. */
    fun annexBFromElementaryUnits(units: List<ByteArray>): ByteArray {
        val result = java.io.ByteArrayOutputStream()
        for (unit in units) {
            result.write(byteArrayOf(0x00, 0x00, 0x00, 0x01), 0, 4)
            result.write(unit, 0, unit.size)
        }
        return result.toByteArray()
    }
}
