package app.teamstation.streamcore.rtmp

import java.io.ByteArrayOutputStream

enum class RTMPMessageType(val rawValue: Int) {
    SET_CHUNK_SIZE(1),
    ABORT(2),
    ACKNOWLEDGEMENT(3),
    USER_CONTROL(4),
    WINDOW_ACK_SIZE(5),
    SET_PEER_BANDWIDTH(6),
    AUDIO(8),
    VIDEO(9),
    AMF3_DATA(15),
    AMF3_COMMAND(17),
    AMF0_DATA(18),
    AMF0_COMMAND(20);

    companion object {
        fun of(rawValue: Int): RTMPMessageType? = entries.firstOrNull { it.rawValue == rawValue }
    }
}

/** One RTMP message. [timestamp] and [streamID] are unsigned 32-bit values held in a Long. */
class RTMPMessage(
    val streamID: Long,
    val type: RTMPMessageType,
    val timestamp: Long,
    val payload: ByteArray
) {
    override fun equals(other: Any?): Boolean =
        other is RTMPMessage && streamID == other.streamID && type == other.type &&
            timestamp == other.timestamp && payload.contentEquals(other.payload)

    override fun hashCode(): Int =
        ((streamID.hashCode() * 31 + type.hashCode()) * 31 + timestamp.hashCode()) * 31 +
            payload.contentHashCode()

    override fun toString(): String = "RTMPMessage($type, stream $streamID, t $timestamp, ${payload.size} bytes)"
}

/** Splits a message into chunks. A port of TS Director's `RTMPChunk`. */
object RTMPChunk {
    const val defaultSize = 128

    fun encode(message: RTMPMessage, chunkStreamID: Int, chunkSize: Int): ByteArray {
        val out = ByteArrayOutputStream(message.payload.size + 18)
        val payload = message.payload
        val size = maxOf(chunkSize, 1)
        val extended = message.timestamp >= 0xFFFFFF
        var offset = 0
        var first = true
        while (offset < payload.size || first) {
            val remaining = payload.size - offset
            val take = minOf(size, maxOf(remaining, 0))
            if (first) {
                appendBasicHeader(0, chunkStreamID, out)
                appendUInt24(message.timestamp, out)
                appendUInt24(payload.size.toLong(), out)
                out.write(message.type.rawValue)
                // The message stream ID is the one little-endian field in the header.
                for (shift in 0..3) out.write((message.streamID ushr (shift * 8)).toInt() and 0xFF)
                if (extended) appendUInt32(message.timestamp, out)
                first = false
            } else {
                appendBasicHeader(3, chunkStreamID, out)
                if (extended) appendUInt32(message.timestamp, out)
            }
            if (take > 0) {
                out.write(payload, offset, take)
                offset += take
            }
            if (remaining == 0) break
        }
        return out.toByteArray()
    }

    private fun appendBasicHeader(fmt: Int, chunkStreamID: Int, out: ByteArrayOutputStream) {
        when {
            chunkStreamID < 64 -> out.write((fmt shl 6) or chunkStreamID)
            chunkStreamID < 320 -> {
                out.write(fmt shl 6)
                out.write(chunkStreamID - 64)
            }
            else -> {
                out.write((fmt shl 6) or 1)
                val value = chunkStreamID - 64
                out.write(value and 0xFF)
                out.write((value ushr 8) and 0xFF)
            }
        }
    }

    private fun appendUInt24(value: Long, out: ByteArrayOutputStream) {
        val clipped = minOf(value, 0xFFFFFFL)
        out.write(((clipped ushr 16) and 0xFF).toInt())
        out.write(((clipped ushr 8) and 0xFF).toInt())
        out.write((clipped and 0xFF).toInt())
    }

    private fun appendUInt32(value: Long, out: ByteArrayOutputStream) {
        for (shift in 3 downTo 0) out.write(((value ushr (shift * 8)) and 0xFF).toInt())
    }
}

/** Reassembles inbound RTMP chunks into complete messages. A port of TS Director's `RTMPChunkReader`. */
class RTMPChunkReader {
    private class StreamState {
        var timestamp = 0L
        var length = 0
        var type = 0
        var streamID = 0L
        var remaining = 0
        var payload = ByteArrayOutputStream()
    }

    var chunkSize = RTMPChunk.defaultSize
        private set
    private var buffer = ByteArray(0)
    private val streams = HashMap<Int, StreamState>()

    fun setChunkSize(size: Int) {
        chunkSize = maxOf(1, size)
    }

    fun push(data: ByteArray): List<RTMPMessage> {
        buffer += data
        val messages = mutableListOf<RTMPMessage>()
        while (true) messages += nextMessage() ?: break
        return messages
    }

    private fun nextMessage(): RTMPMessage? {
        while (buffer.isNotEmpty()) {
            val first = buffer[0].toInt() and 0xFF
            val fmt = first ushr 6
            var headerSize = 1
            val csid: Int
            when (first and 0x3F) {
                0 -> {
                    if (buffer.size < 2) return null
                    csid = byte(1) + 64
                    headerSize = 2
                }
                1 -> {
                    if (buffer.size < 3) return null
                    csid = (byte(1) or (byte(2) shl 8)) + 64
                    headerSize = 3
                }
                else -> csid = first and 0x3F
            }

            val known = streams[csid]
            val state = known ?: StreamState()
            var cursor = headerSize
            fun need(count: Int) = buffer.size >= cursor + count

            // Header fields are read into locals and only stored once the whole chunk is here, so a
            // chunk that arrives in pieces is parsed again from its start.
            var timestamp = state.timestamp
            var length = state.length
            var type = state.type
            var streamID = state.streamID
            var restart = state.remaining == 0
            when (fmt) {
                0 -> {
                    if (!need(11)) return null
                    val short = uint24(cursor)
                    length = uint24(cursor + 3).toInt()
                    type = byte(cursor + 6)
                    streamID = uint32LE(cursor + 7)
                    cursor += 11
                    timestamp = short
                    if (short == 0xFFFFFFL) {
                        if (!need(4)) return null
                        timestamp = uint32BE(cursor)
                        cursor += 4
                    }
                    restart = true
                }
                1 -> {
                    if (!need(7)) return null
                    var delta = uint24(cursor)
                    length = uint24(cursor + 3).toInt()
                    type = byte(cursor + 6)
                    cursor += 7
                    if (delta == 0xFFFFFFL) {
                        if (!need(4)) return null
                        delta = uint32BE(cursor)
                        cursor += 4
                    }
                    timestamp = (timestamp + delta) and 0xFFFFFFFFL
                }
                2 -> {
                    if (!need(3)) return null
                    var delta = uint24(cursor)
                    cursor += 3
                    if (delta == 0xFFFFFFL) {
                        if (!need(4)) return null
                        delta = uint32BE(cursor)
                        cursor += 4
                    }
                    timestamp = (timestamp + delta) and 0xFFFFFFFFL
                }
                else -> {
                    if (timestamp >= 0xFFFFFF) {
                        if (!need(4)) return null
                        timestamp = uint32BE(cursor)
                        cursor += 4
                    }
                }
            }
            val remaining = if (restart) length else state.remaining
            val take = minOf(chunkSize, remaining)
            if (buffer.size < cursor + take) return null

            state.timestamp = timestamp
            state.length = length
            state.type = type
            state.streamID = streamID
            if (restart) state.payload.reset()
            if (take > 0) state.payload.write(buffer, cursor, take)
            state.remaining = remaining - take
            buffer = buffer.copyOfRange(cursor + take, buffer.size)
            streams[csid] = state

            val messageType = RTMPMessageType.of(state.type)
            if (state.remaining == 0 && messageType != null) {
                val payload = state.payload.toByteArray()
                if (messageType == RTMPMessageType.SET_CHUNK_SIZE && payload.size >= 4) {
                    val size = ((payload[0].toLong() and 0xFF) shl 24) or ((payload[1].toLong() and 0xFF) shl 16) or
                        ((payload[2].toLong() and 0xFF) shl 8) or (payload[3].toLong() and 0xFF)
                    if (size in 1..Int.MAX_VALUE) chunkSize = size.toInt()
                }
                return RTMPMessage(state.streamID, messageType, state.timestamp, payload)
            }
        }
        return null
    }

    private fun byte(offset: Int): Int = buffer[offset].toInt() and 0xFF

    private fun uint24(offset: Int): Long =
        (byte(offset).toLong() shl 16) or (byte(offset + 1).toLong() shl 8) or byte(offset + 2).toLong()

    private fun uint32BE(offset: Int): Long =
        (byte(offset).toLong() shl 24) or (byte(offset + 1).toLong() shl 16) or
            (byte(offset + 2).toLong() shl 8) or byte(offset + 3).toLong()

    private fun uint32LE(offset: Int): Long =
        byte(offset).toLong() or (byte(offset + 1).toLong() shl 8) or
            (byte(offset + 2).toLong() shl 16) or (byte(offset + 3).toLong() shl 24)
}
