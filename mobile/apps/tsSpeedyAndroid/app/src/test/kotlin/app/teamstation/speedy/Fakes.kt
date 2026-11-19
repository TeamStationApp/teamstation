package app.teamstation.speedy

import app.teamstation.speedy.core.Cancellable
import app.teamstation.speedy.core.PhrasePlayer
import app.teamstation.speedy.core.RadarStatus
import app.teamstation.speedy.core.Scheduler
import app.teamstation.speedy.core.SpeedyRadar
import app.teamstation.streamcore.radar.RadarFleetStore
import app.teamstation.streamcore.radar.RadarRadio
import app.teamstation.streamcore.radar.RadarRadioListener

/** A scheduler driven by hand: [advance] runs what has come due, in order. */
class StepScheduler : Scheduler {
    private class Timer(val due: Long, val work: () -> Unit) {
        var cancelled = false
    }

    var now = 0L
        private set
    private val timers = mutableListOf<Timer>()

    override fun after(delayMs: Long, work: () -> Unit): Cancellable {
        val timer = Timer(now + delayMs, work)
        timers += timer
        return Cancellable { timer.cancelled = true }
    }

    fun advance(byMs: Long) {
        now += byMs
        while (true) {
            val next = timers.filter { !it.cancelled && it.due <= now }.minByOrNull { it.due } ?: break
            next.cancelled = true
            next.work()
        }
    }

    val pending: Int get() = timers.count { !it.cancelled }
}

class RecordingPlayer : PhrasePlayer {
    val played = mutableListOf<List<String>>()
    var stops = 0
    override fun play(clips: List<String>) {
        played += clips
    }
    override fun stop() {
        stops++
    }
}

class FakeSpeedyRadar : SpeedyRadar {
    override var status = RadarStatus()
        set(value) {
            field = value
            onChange?.invoke()
        }
    override var onChange: (() -> Unit)? = null
    override var onSpeeds: ((Int, Int) -> Unit)? = null
    val calls = mutableListOf<String>()
    override fun start() { calls += "start" }
    override fun refresh() { calls += "refresh" }
    override fun startPairing() { calls += "startPairing" }
    override fun stopPairing() { calls += "stopPairing" }
    override fun pair(name: String) { calls += "pair $name" }
    override fun unpair() { calls += "unpair" }
    fun reading(pitch: Int, exit: Int) = onSpeeds?.invoke(pitch, exit)
}

class MemoryFleetStore(var serials: List<String> = emptyList(), var enabled: Boolean = true) : RadarFleetStore {
    override fun readSerials() = serials
    override fun writeSerials(serials: List<String>) {
        this.serials = serials
    }
    override fun readEnabled() = enabled
    override fun writeEnabled(enabled: Boolean) {
        this.enabled = enabled
    }
}

/** A radio the tests drive by hand: advertisements, the link and the radar's bytes. */
class FakeRadarRadio : RadarRadio {
    var radioListener: RadarRadioListener? = null
    var onName: ((String) -> Unit)? = null
    val connects = mutableListOf<String>()
    var scanning = false
    override fun startScan(onName: (String) -> Unit) {
        scanning = true
        this.onName = onName
    }
    override fun stopScan() {
        scanning = false
    }
    override fun connect(name: String) {
        connects += name
    }
    override fun disconnect() = Unit
    override fun subscribe(uuid: String) = Unit
    override fun write(bytes: ByteArray): Int = 0
    override fun setListener(listener: RadarRadioListener?) {
        radioListener = listener
    }
}

/** A speed packet as the TAG One sends it: negative primary speed a pitch, extra the other side. */
fun radarSpeedPacket(signedCms: Int, extraCms: Int = 0): ByteArray {
    val body = byteArrayOf(
        0x13, 0, 0, 0, 0, 0, 0,
        (signedCms shr 8).toByte(), signedCms.toByte(),
        (extraCms shr 8).toByte(), extraCms.toByte(),
        0
    )
    return byteArrayOf(0x80.toByte(), body.size.toByte()) + body
}

/** A canonical 24 kHz mono 16-bit WAV. */
fun wavBytes(samples: ShortArray, rate: Int = 24_000, channels: Int = 1, bits: Int = 16, codec: Int = 1): ByteArray {
    val buffer = java.nio.ByteBuffer.allocate(44 + samples.size * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
    buffer.put("RIFF".toByteArray()).putInt(36 + samples.size * 2).put("WAVEfmt ".toByteArray())
    buffer.putInt(16).putShort(codec.toShort()).putShort(channels.toShort()).putInt(rate).putInt(rate * 2)
    buffer.putShort(2).putShort(bits.toShort()).put("data".toByteArray()).putInt(samples.size * 2)
    samples.forEach { buffer.putShort(it) }
    return buffer.array()
}
