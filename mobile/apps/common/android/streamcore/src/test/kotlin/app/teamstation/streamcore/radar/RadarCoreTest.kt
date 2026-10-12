package app.teamstation.streamcore.radar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RadarCoreTest {
    @Test
    fun `cmsToMph rounds half away from zero and keeps zero`() {
        assertEquals(0, RadarProtocol.cmsToMph(0))
        assertEquals(1, RadarProtocol.cmsToMph(23))
        assertEquals(1, RadarProtocol.cmsToMph(-23))
        assertEquals(42, RadarProtocol.pitchExit(-1857, 0).pitchMph)
        assertEquals(0, RadarProtocol.pitchExit(-1857, 0).exitMph)
        val both = RadarProtocol.pitchExit(-3085, 1850)
        assertEquals(69, both.pitchMph)
        assertEquals(41, both.exitMph)
        val exitOnly = RadarProtocol.pitchExit(1857, 0)
        assertEquals(0, exitOnly.pitchMph)
        assertEquals(42, exitOnly.exitMph)
    }

    @Test
    fun `frames and uuids match the TAG One wire format`() {
        val frame = bytes(0x80, 0x0c, 0x13, 0x26, 0x08, 0x24, 0x14, 0x50, 0x58, 0xf8, 0xbf, 0x00, 0x00, 0x03)
        val speed = RadarProtocol.parseRadar(frame) as RadarFrame.Speed
        assertEquals(readPrimary(frame), speed.signedCms)
        assertTrue(RadarProtocol.parseRadar(bytes(0x64)) is RadarFrame.Heartbeat)
        assertTrue(RadarProtocol.isSigUuid("2a19"))
        assertFalse(RadarProtocol.isSigUuid(SPEED_NOTIFY_UUID))
        assertTrue(RadarProtocol.shouldSubscribe(BATTERY_LEVEL_UUID))
        assertFalse(RadarProtocol.shouldSubscribe("00002a00-0000-1000-8000-00805f9b34fb"))
        assertEquals(19, RadarProtocol.batteryPercent(byteArrayOf(19)))
        assertEquals(100, RadarProtocol.batteryPercent(byteArrayOf(0x64)))
        assertNull(RadarProtocol.batteryPercent(byteArrayOf(101)))
        assertEquals(bytes(0x80, 0x01, 0x65).toList(), RadarProtocol.cmdVersion().toList())
        assertEquals(0x26.toByte(), RadarProtocol.cmdSetTime(2026, 9, 28, 12, 0, 0)[3])
        assertEquals(bytes(0x80, 0x03, 'p'.code, 0x00, 0x01).toList(), RadarProtocol.cmdPause().toList())
        assertEquals(bytes(0x80, 0x05, 'b'.code, 0x00, 0x09, 0x00, 0x66).toList(), RadarProtocol.cmdConfigB().toList())
        assertEquals(bytes(0x80, 0x03, 'p'.code, 0x01, 0x03).toList(), RadarProtocol.cmdEnableBoth().toList())
        assertNull(RadarProtocol.parseRadar(byteArrayOf()))
        assertNull(RadarProtocol.parseRadar(bytes(0x00)))
        val short = RadarProtocol.parseRadar(
            bytes(0x80, 0x0a, 0x13, 0, 0, 0, 0, 0, 0, 0, 0xf8, 0xbf)
        )
        assertEquals(0, (short as RadarFrame.Speed).extraCms)
        val reply = RadarProtocol.parseRadar(bytes(0x90, 0x02, 'e'.code, '1'.code)) as RadarFrame.Reply
        assertEquals('e', reply.cmd)
        assertEquals("1", reply.text)
        assertNull(RadarProtocol.parseRadar(bytes(0x80, 0x01, 0x01)))
        assertNull(RadarProtocol.parseRadar(bytes(0x11, 0x01, 0x65)))
    }

    @Test
    fun `pitch and exit expire on their own`() {
        var board = SpeedBoard().receive(50, 60, 1_000_000)
        assertEquals("50/60", board.visible())
        board = board.receive(0, 0, 1_006_000)
        assertEquals("–/–", board.visible())
        board = board.receive(0, 70, 1_006_000)
        assertEquals("–/70", board.visible())
        board = board.receive(70, 0, 1_012_000)
        assertEquals("70/–", board.visible(1_016_999))
        assertEquals("–/–", board.visible(1_017_000))
        val held = SpeedBoard().receive(50, 0, 0).receive(0, 60, 100)
        assertEquals("50/60", held.visible(100))
        assertEquals(0L, held.pitch!!.atMs)
    }

    @Test
    fun `connecting dots cycle every three steps`() {
        assertEquals("connecting.", ConnectionLabel.connecting(0))
        assertEquals("connecting..", ConnectionLabel.connecting(1))
        assertEquals("connecting...", ConnectionLabel.connecting(2))
        assertEquals("connecting.", ConnectionLabel.connecting(3))
    }

    @Test
    fun `the link stays idle unless a saved serial or the picker needs a scan`() {
        val idle = LinkPolicy.action(
            serial = null,
            bluetoothOn = true,
            locationOn = true,
            permissionsGranted = true,
            pickerOpen = false,
            gatt = GattState.Down,
            suppressed = false
        )
        assertEquals(LinkAction.Idle, idle.action)

        val picker = idle.copy().let {
            LinkPolicy.action(null, true, true, true, pickerOpen = true, GattState.Down, false)
        }
        assertEquals(LinkAction.ScanPicker, picker.action)

        val connecting = LinkPolicy.action(
            "ADFA0000001", true, true, true, false, GattState.Connecting, false
        )
        assertEquals(LinkAction.Hold, connecting.action)

        val up = LinkPolicy.action(
            "ADFA0000001", true, true, true, false, GattState.Up, false
        )
        assertEquals(LinkAction.Hold, up.action)

        val seek = LinkPolicy.action(
            "ADFA0000001", true, true, true, false, GattState.Down, false
        )
        assertEquals(LinkAction.ScanSerial, seek.action)
        assertFalse(LinkPolicy.acceptsScanResult("ADFA0000001", "ADFAA000000"))
        assertTrue(LinkPolicy.acceptsScanResult("ADFA0000001", "ADFA0000001"))

        assertEquals(
            LinkPolicy.BLUETOOTH_OFF,
            LinkPolicy.action("ADFA0000001", false, true, true, false, GattState.Down, false).status
        )
        assertEquals(
            LinkPolicy.LOCATION_OFF,
            LinkPolicy.action("ADFA0000001", true, false, true, false, GattState.Down, false).status
        )
        assertEquals(
            LinkPolicy.PERMISSION,
            LinkPolicy.action("ADFA0000001", true, true, false, true, GattState.Down, false).status
        )
        assertEquals(
            LinkAction.Idle,
            LinkPolicy.action("ADFA0000001", true, true, true, false, GattState.Down, suppressed = true).action
        )
        assertEquals(1_000L, LinkPolicy.reconnectDelayMs(1))
        assertEquals(2_000L, LinkPolicy.reconnectDelayMs(2))
        assertEquals(4_000L, LinkPolicy.reconnectDelayMs(3))
        assertEquals(8_000L, LinkPolicy.reconnectDelayMs(4))
        assertEquals(8_000L, LinkPolicy.reconnectDelayMs(5))
    }

    @Test
    fun `a stored serial must look like a TAG One name`() {
        assertNull(RadarPairingRecord.serialFrom(null))
        assertNull(RadarPairingRecord.serialFrom("  "))
        assertNull(RadarPairingRecord.serialFrom("not-a-radar"))
        assertEquals("ADFA0000001", RadarPairingRecord.serialFrom(" ADFA0000001 "))
        assertEquals("ADFA0000001", RadarPairingRecord.stored("ADFA0000001"))
    }

    @Test
    fun `handshake paces six commands then keepalives, and a busy write does not advance`() {
        val handshake = Handshake { RadarProtocol.cmdSetTime(2026, 9, 28, 12, 0, 0) }
        assertTrue(handshake.start() is HandshakeEffect.Subscribe)
        assertEquals(HandshakeEffect.Wait(1_000L), handshake.onSubscribed())
        val writes = mutableListOf<ByteArray>()
        repeat(6) {
            val write = handshake.onPaceElapsed() as HandshakeEffect.Write
            writes += write.bytes
            val finished = handshake.onWriteFinished(0)
            if (it < 5) assertEquals(HandshakeEffect.Wait(1_000L), finished)
            else assertEquals(HandshakeEffect.Live, finished)
        }
        assertEquals(RadarProtocol.cmdVersion().toList(), writes[0].toList())
        assertEquals(0x26.toByte(), writes[1][3])
        assertEquals(RadarProtocol.cmdVersion().toList(), writes[2].toList())
        assertEquals(RadarProtocol.cmdPause().toList(), writes[3].toList())
        assertEquals(RadarProtocol.cmdConfigB().toList(), writes[4].toList())
        assertEquals(RadarProtocol.cmdEnableBoth().toList(), writes[5].toList())

        val busy = Handshake()
        busy.start()
        busy.onSubscribed()
        val first = (busy.onPaceElapsed() as HandshakeEffect.Write).bytes
        val retried = busy.onWriteFinished(201) as HandshakeEffect.Write
        assertEquals(first.toList(), retried.bytes.toList())
        assertEquals(HandshakeEffect.Wait(1_000L), busy.onWriteFinished(0))

        val live = Handshake()
        live.start()
        live.onSubscribed()
        repeat(6) {
            live.onPaceElapsed()
            live.onWriteFinished(0)
        }
        assertEquals(HandshakeEffect.Live, live.onTick(24_000))
        assertTrue(live.onTick(1_000) is HandshakeEffect.Write)
        assertEquals(HandshakeEffect.Dropped, live.onDisconnected())
    }

    private fun readPrimary(frame: ByteArray): Int {
        val body = frame.copyOfRange(2, frame.size)
        val hi = body[7].toInt()
        val lo = body[8].toInt() and 0xff
        return (hi shl 8) or lo
    }

    private fun bytes(vararg xs: Int): ByteArray = ByteArray(xs.size) { xs[it].toByte() }
}
