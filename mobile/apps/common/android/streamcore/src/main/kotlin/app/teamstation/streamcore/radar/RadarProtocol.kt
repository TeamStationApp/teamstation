package app.teamstation.streamcore.radar

/** 1 mph = 44.704 cm/s. Radar magnitudes are cm/s. */
const val CMS_PER_MPH = 44.704

val TAG_NAME = Regex("^ADFA", RegexOption.IGNORE_CASE)

const val SPEED_NOTIFY_UUID = "6e40ff03-b5a3-f393-e0a9-5461674f6e65"
const val COMMAND_WRITE_UUID = "6e40ff02-b5a3-f393-e0a9-5461674f6e65"
const val SECOND_NOTIFY_UUID = "da2e7828-fbce-4e01-ae9e-261174997c48"
const val BATTERY_LEVEL_UUID = "00002a19-0000-1000-8000-00805f9b34fb"

data class Speeds(val pitchMph: Int, val exitMph: Int)

sealed class RadarFrame {
    data object Heartbeat : RadarFrame()
    data class Speed(val signedCms: Int, val extraCms: Int) : RadarFrame()
    data class Reply(val cmd: Char, val text: String) : RadarFrame()
}

object RadarProtocol {
    fun cmsToMph(cms: Int): Int {
        if (cms == 0) return 0
        return kotlin.math.floor(kotlin.math.abs(cms) / CMS_PER_MPH + 0.5).toInt()
    }

    /**
     * Primary int16 is inbound when negative. Extra uint16 is outbound when nonzero.
     * Pitch & Hit maps inbound to pitch and outbound to exit.
     */
    fun pitchExit(signedCms: Int, extraCms: Int): Speeds {
        val primary = cmsToMph(signedCms)
        val extra = cmsToMph(extraCms)
        if (extra == 0) {
            return if (signedCms < 0) Speeds(primary, 0) else Speeds(0, primary)
        }
        if (signedCms >= 0) return Speeds(extra, primary)
        return Speeds(primary, extra)
    }

    fun parseRadar(value: ByteArray): RadarFrame? {
        if (value.isEmpty()) return null
        if ((value[0].toInt() and 0xff) == 0x64 && value.size <= 2) return RadarFrame.Heartbeat
        if (value.size < 2) return null
        val kind = value[0].toInt() and 0xff
        val len = value[1].toInt() and 0xff
        val end = minOf(value.size, 2 + len)
        val body = value.copyOfRange(2, end)
        if (kind == 0x80 && body.size >= 10 && (body[0].toInt() and 0xff) == 0x13) {
            val extra = if (body.size >= 12) readUInt16BE(body, 9) else 0
            return RadarFrame.Speed(readInt16BE(body, 7), extra)
        }
        if ((kind == 0x90 || kind == 0x80) && body.isNotEmpty()) {
            val cmdByte = body[0].toInt() and 0xff
            val cmd = if (cmdByte in 32..126) cmdByte.toChar() else return null
            val text = body.copyOfRange(1, body.size).toString(Charsets.UTF_8).replace("\u0000", "")
            return RadarFrame.Reply(cmd, text)
        }
        return null
    }

    fun isSigUuid(uuid: String): Boolean {
        val u = uuid.replace("-", "").lowercase()
        if (u.length <= 4) return true
        return u.endsWith("00001000800000805f9b34fb")
    }

    /** Battery Level is the one standard characteristic the radio subscribes to. */
    fun shouldSubscribe(uuid: String): Boolean {
        if (uuid.equals(BATTERY_LEVEL_UUID, ignoreCase = true)) return true
        return !isSigUuid(uuid)
    }

    /** A one-byte notification is the Battery Level characteristic: 0…100 percent. */
    fun batteryPercent(value: ByteArray): Int? {
        if (value.size != 1) return null
        val percent = value[0].toInt() and 0xff
        if (percent > 100) return null
        return percent
    }

    fun cmdVersion(): ByteArray = wrapCmd(byteArrayOf('e'.code.toByte()))

    fun cmdSetTime(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int): ByteArray {
        return wrapCmd(
            byteArrayOf(
                'f'.code.toByte(),
                bcdByte(year),
                bcdByte(month),
                bcdByte(day),
                bcdByte(hour),
                bcdByte(minute),
                bcdByte(second)
            )
        )
    }

    fun cmdPause(): ByteArray = wrapCmd(byteArrayOf('p'.code.toByte(), 0x00, 0x01))

    fun cmdConfigB(): ByteArray = wrapCmd(byteArrayOf('b'.code.toByte(), 0x00, 0x09, 0x00, 0x66))

    fun cmdEnableBoth(): ByteArray = wrapCmd(byteArrayOf('p'.code.toByte(), 0x01, 0x03))

    private fun readInt16BE(buf: ByteArray, offset: Int): Int {
        val hi = buf[offset].toInt()
        val lo = buf[offset + 1].toInt() and 0xff
        return (hi shl 8) or lo
    }

    private fun readUInt16BE(buf: ByteArray, offset: Int): Int {
        val hi = buf[offset].toInt() and 0xff
        val lo = buf[offset + 1].toInt() and 0xff
        return (hi shl 8) or lo
    }

    private fun bcdByte(n: Int): Byte {
        val v = ((n % 100) + 100) % 100
        return (((v / 10) shl 4) or (v % 10)).toByte()
    }

    private fun wrapCmd(body: ByteArray): ByteArray {
        val out = ByteArray(2 + body.size)
        out[0] = 0x80.toByte()
        out[1] = body.size.toByte()
        body.copyInto(out, 2)
        return out
    }
}
