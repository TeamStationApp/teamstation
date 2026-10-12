package app.teamstation.streamcore.rtmp

import java.io.ByteArrayOutputStream

/** AMF0 values used by RTMP connect / createStream / publish / onStatus. A port of TS Director's `AMF0`. */
sealed class AMF0 {
    data class Number(val value: Double) : AMF0()
    data class Bool(val value: Boolean) : AMF0()
    data class Str(val value: String) : AMF0()
    data class Object(val pairs: Map<String, AMF0>) : AMF0()
    data object Null : AMF0()
    data object Undefined : AMF0()
    data class EcmaArray(val pairs: Map<String, AMF0>) : AMF0()

    /** An ordered list. Enhanced RTMP's `fourCcList` in `connect` is one. */
    data class StrictArray(val items: List<AMF0>) : AMF0()

    val stringValue: String? get() = (this as? Str)?.value
    val numberValue: Double? get() = (this as? Number)?.value
    val objectValue: Map<String, AMF0>?
        get() = when (this) {
            is Object -> pairs
            is EcmaArray -> pairs
            else -> null
        }

    fun encode(): ByteArray = ByteArrayOutputStream().also { encodeInto(it) }.toByteArray()

    private fun encodeInto(out: ByteArrayOutputStream) {
        when (this) {
            is Number -> {
                out.write(0x00)
                writeUInt(out, java.lang.Double.doubleToRawLongBits(value), 8)
            }
            is Bool -> {
                out.write(0x01)
                out.write(if (value) 1 else 0)
            }
            is Str -> encodeString(value, out, typed = true)
            is Object -> {
                out.write(0x03)
                encodePairs(pairs, out)
            }
            Null -> out.write(0x05)
            Undefined -> out.write(0x06)
            is EcmaArray -> {
                out.write(0x08)
                writeUInt(out, pairs.size.toLong(), 4)
                encodePairs(pairs, out)
            }
            is StrictArray -> {
                out.write(0x0A)
                writeUInt(out, items.size.toLong(), 4)
                for (item in items) item.encodeInto(out)
            }
        }
    }

    /** A read position in bytes being decoded. */
    class Cursor(var position: Int = 0)

    companion object {
        fun encode(values: List<AMF0>): ByteArray =
            ByteArrayOutputStream().also { out -> values.forEach { it.encodeInto(out) } }.toByteArray()

        fun decodeList(data: ByteArray): List<AMF0> {
            val cursor = Cursor()
            val values = mutableListOf<AMF0>()
            while (cursor.position < data.size) {
                values += decode(data, cursor) ?: break
            }
            return values
        }

        fun decode(data: ByteArray, cursor: Cursor): AMF0? {
            if (cursor.position >= data.size) return null
            val marker = data[cursor.position].toInt() and 0xFF
            cursor.position += 1
            return when (marker) {
                0x00 -> {
                    if (cursor.position + 8 > data.size) return null
                    val bits = readUInt(data, cursor.position, 8)
                    cursor.position += 8
                    Number(java.lang.Double.longBitsToDouble(bits))
                }
                0x01 -> {
                    if (cursor.position >= data.size) return null
                    val value = data[cursor.position].toInt() != 0
                    cursor.position += 1
                    Bool(value)
                }
                0x02 -> readString(data, cursor, 2)?.let { Str(it) }
                0x03 -> readObject(data, cursor)?.let { Object(it) }
                0x05 -> Null
                0x06 -> Undefined
                0x08 -> {
                    if (cursor.position + 4 > data.size) return null
                    cursor.position += 4
                    readObject(data, cursor)?.let { EcmaArray(it) }
                }
                0x0A -> {
                    if (cursor.position + 4 > data.size) return null
                    val count = readUInt(data, cursor.position, 4).toInt()
                    cursor.position += 4
                    val items = mutableListOf<AMF0>()
                    repeat(count) { items += decode(data, cursor) ?: return null }
                    StrictArray(items)
                }
                0x0C -> readString(data, cursor, 4)?.let { Str(it) }
                else -> null
            }
        }

        private fun encodeString(value: String, out: ByteArrayOutputStream, typed: Boolean) {
            val utf8 = value.toByteArray(Charsets.UTF_8)
            if (typed) out.write(0x02)
            writeUInt(out, utf8.size.toLong(), 2)
            out.write(utf8)
        }

        /**
         * In key order, so the same object is the same bytes every time; the wire fixtures shared
         * with TS Director compare bytes.
         */
        private fun encodePairs(pairs: Map<String, AMF0>, out: ByteArrayOutputStream) {
            for (key in pairs.keys.sorted()) {
                encodeString(key, out, typed = false)
                pairs.getValue(key).encodeInto(out)
            }
            out.write(byteArrayOf(0x00, 0x00, 0x09))
        }

        private fun readString(data: ByteArray, cursor: Cursor, lengthBytes: Int): String? {
            if (cursor.position + lengthBytes > data.size) return null
            val length = readUInt(data, cursor.position, lengthBytes).toInt()
            cursor.position += lengthBytes
            if (length < 0 || cursor.position + length > data.size) return null
            val string = String(data, cursor.position, length, Charsets.UTF_8)
            cursor.position += length
            return string
        }

        private fun readObject(data: ByteArray, cursor: Cursor): Map<String, AMF0>? {
            val pairs = LinkedHashMap<String, AMF0>()
            while (true) {
                val key = readString(data, cursor, 2) ?: return null
                if (key.isEmpty()) {
                    if (cursor.position >= data.size) return null
                    if (data[cursor.position].toInt() == 0x09) cursor.position += 1
                    return pairs
                }
                pairs[key] = decode(data, cursor) ?: return null
            }
        }

        private fun writeUInt(out: ByteArrayOutputStream, value: Long, bytes: Int) {
            for (shift in (bytes - 1) downTo 0) out.write((value ushr (shift * 8)).toInt() and 0xFF)
        }

        private fun readUInt(data: ByteArray, offset: Int, bytes: Int): Long {
            var value = 0L
            for (index in 0 until bytes) value = (value shl 8) or (data[offset + index].toLong() and 0xFF)
            return value
        }
    }
}
