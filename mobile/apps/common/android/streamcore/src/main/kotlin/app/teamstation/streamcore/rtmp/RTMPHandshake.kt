package app.teamstation.streamcore.rtmp

import kotlin.random.Random

/** The RTMP handshake's three packets. A port of TS Director's `RTMPHandshake`. */
object RTMPHandshake {
    const val packetSize = 1536

    /** C0 (version 3) and C1: the time, four zero bytes, then random bytes to fill the packet. */
    fun c0c1(time: Int = 0, random: Random = Random.Default): ByteArray {
        val packet = ByteArray(1 + packetSize)
        packet[0] = 0x03
        packet[1] = (time ushr 24).toByte()
        packet[2] = (time ushr 16).toByte()
        packet[3] = (time ushr 8).toByte()
        packet[4] = time.toByte()
        val tail = random.nextBytes(packetSize - 8)
        tail.copyInto(packet, destinationOffset = 9)
        return packet
    }

    /** C2 echoes S1. */
    fun c2(fromS1: ByteArray): ByteArray = fromS1.copyOf(minOf(fromS1.size, packetSize))

    /** The server's S0, S1 and S2 once all of them have arrived, or null while they have not. */
    fun splitServerHello(data: ByteArray): Triple<Byte, ByteArray, ByteArray>? {
        val needed = 1 + packetSize * 2
        if (data.size < needed) return null
        return Triple(
            data[0],
            data.copyOfRange(1, 1 + packetSize),
            data.copyOfRange(1 + packetSize, needed)
        )
    }
}
