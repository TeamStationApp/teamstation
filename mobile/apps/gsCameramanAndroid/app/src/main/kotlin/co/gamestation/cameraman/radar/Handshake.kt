package co.gamestation.cameraman.radar

internal sealed class HandshakeEffect {
    data class Subscribe(val uuids: List<String>) : HandshakeEffect()
    data class Write(val bytes: ByteArray) : HandshakeEffect()
    data class Wait(val ms: Long) : HandshakeEffect()
    data object Live : HandshakeEffect()
    data object Dropped : HandshakeEffect()
}

/**
 * Subscribe, then six paced commands, then a version keepalive every 25 seconds.
 * GATT status 201 repeats the current write and does not move the pace timer.
 */
internal class Handshake(
    private val clock: () -> ByteArray = { RadarProtocol.cmdSetTime(2026, 1, 1, 0, 0, 0) }
) {
    private var step = -1
    private var live = false
    private var sinceKeepaliveMs = 0L
    private var currentWrite: ByteArray? = null

    fun start(): HandshakeEffect {
        step = -1
        live = false
        sinceKeepaliveMs = 0L
        currentWrite = null
        return HandshakeEffect.Subscribe(
            listOf(SPEED_NOTIFY_UUID, SECOND_NOTIFY_UUID, BATTERY_LEVEL_UUID)
        )
    }

    fun onSubscribed(): HandshakeEffect = HandshakeEffect.Wait(PACE_MS)

    fun onPaceElapsed(): HandshakeEffect = advance()

    fun onWriteFinished(status: Int): HandshakeEffect {
        if (status == 201) {
            val again = currentWrite ?: return HandshakeEffect.Dropped
            return HandshakeEffect.Write(again)
        }
        if (status != 0) return drop()
        if (live) return HandshakeEffect.Live
        if (step >= 5) {
            live = true
            sinceKeepaliveMs = 0L
            currentWrite = null
            return HandshakeEffect.Live
        }
        return HandshakeEffect.Wait(PACE_MS)
    }

    fun onTick(elapsedMs: Long): HandshakeEffect {
        if (!live) return HandshakeEffect.Wait(PACE_MS)
        sinceKeepaliveMs += elapsedMs
        if (sinceKeepaliveMs < KEEPALIVE_MS) return HandshakeEffect.Live
        sinceKeepaliveMs = 0L
        val bytes = RadarProtocol.cmdVersion()
        currentWrite = bytes
        return HandshakeEffect.Write(bytes)
    }

    fun onDisconnected(): HandshakeEffect = drop()

    private fun advance(): HandshakeEffect {
        step += 1
        val command = commandAt(step) ?: run {
            live = true
            sinceKeepaliveMs = 0L
            currentWrite = null
            return HandshakeEffect.Live
        }
        currentWrite = command
        return HandshakeEffect.Write(command)
    }

    private fun commandAt(index: Int): ByteArray? = when (index) {
        0 -> RadarProtocol.cmdVersion()
        1 -> clock()
        2 -> RadarProtocol.cmdVersion()
        3 -> RadarProtocol.cmdPause()
        4 -> RadarProtocol.cmdConfigB()
        5 -> RadarProtocol.cmdEnableBoth()
        else -> null
    }

    private fun drop(): HandshakeEffect {
        live = false
        currentWrite = null
        return HandshakeEffect.Dropped
    }

    companion object {
        const val PACE_MS = 1_000L
        const val KEEPALIVE_MS = 25_000L
    }
}
