package app.teamstation.cameraman.radar

import android.bluetooth.BluetoothStatusCodes
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])

class RadarLinkTest {
    @Test
    fun `an unpaired link does not scan, and the picker scans without connecting`() {
        val radio = FakeRadio()
        val link = link(radio)
        link.start()
        assertEquals(0, radio.scans)
        assertEquals(0, radio.connects)
        assertEquals(RadarPhase.idle, link.state.value.phase)

        link.openPicker()
        assertEquals(1, radio.scans)
        assertEquals(0, radio.connects)
        link.onAdvertisement("ADFAA003519")
        assertEquals(listOf("ADFAA003519"), link.state.value.pickerNames)
        assertEquals(0, radio.connects)
        link.dismissPicker()
        assertEquals(0, radio.scans)
    }

    @Test
    fun `a saved serial connects only that name, and connecting does not connect again`() {
        val radio = FakeRadio()
        val store = MemoryStore("ADFAA003519")
        val link = link(radio, store)
        link.start()
        assertEquals(1, radio.scans)
        link.onAdvertisement("ADFAA000000")
        assertEquals(0, radio.connects)
        link.onAdvertisement("ADFAA003519")
        assertEquals(1, radio.connects)
        assertEquals(0, radio.scans)
        link.onAdvertisement("ADFAA003519")
        assertEquals(1, radio.connects)
    }

    @Test
    fun `unpair releases the gatt client and a suppressed show does not scan`() {
        val radio = FakeRadio()
        val store = MemoryStore("ADFAA003519")
        val link = link(radio, store)
        link.start()
        link.unpair()
        assertEquals(1, radio.disconnects)
        assertNull(store.read())
        assertEquals(RadarPhase.idle, link.state.value.phase)

        link.show(RadarCommand.Show("ADFAA003519", RadarPhase.connected, 0))
        link.feed(RadarCommand.Feed(50, 60, 1_000_000))
        assertEquals(0, radio.scans)
        assertTrue(link.state.value.linkSuppressed)
        assertEquals("50/60", link.state.value.speedsText)
        val json = JSONObject()
        RadarSnapshot.putInto(json, link.state.value)
        assertEquals("ADFAA003519", json.getString("radarSerial"))
        assertEquals("50/60", json.getString("radarSpeeds"))
        assertTrue(json.getBoolean("radarLinkSuppressed"))

        link.feed(RadarCommand.Feed(0, 70, 1_006_000))
        assertEquals("–/70", link.state.value.speedsText)
        link.show(RadarCommand.Show("ADFAA003519", RadarPhase.connected, 0))
        link.feed(RadarCommand.Feed(70, 0, 1_012_000))
        assertEquals("70/–", link.state.value.speedsText)
        link.unpair()
        assertFalse(link.state.value.linkSuppressed)
        val cleared = JSONObject()
        RadarSnapshot.putInto(cleared, link.state.value)
        assertTrue(cleared.isNull("radarSerial"))
        assertEquals("idle", cleared.getString("radarPhase"))
        assertTrue(cleared.isNull("radarSpeeds"))
    }

    @Test
    fun `location off and a missing permission do not scan`() {
        val radio = FakeRadio()
        val link = link(radio, MemoryStore("ADFAA003519"), locationOn = false)
        link.start()
        assertEquals(0, radio.scans)
        assertEquals(RadarPhase.locationOff, link.state.value.phase)
        val denied = link(radio, MemoryStore("ADFAA003519"), permissions = false)
        denied.start()
        assertEquals(RadarPhase.permission, denied.state.value.phase)
        val json = JSONObject()
        RadarSnapshot.putInto(json, denied.state.value)
        assertEquals("permission", json.getString("radarPhase"))
        RadarSnapshot.putInto(json, link.state.value)
        assertEquals("locationOff", json.getString("radarPhase"))
    }

    @Test
    fun `a battery byte leads the readout and switching the radar off drops the link`() {
        val radio = FakeRadio()
        val link = link(radio, MemoryStore("ADFAA003519"), later = { _, _ -> })
        link.start()
        link.onAdvertisement("ADFAA003519")
        link.onConnected()
        link.onNotification(byteArrayOf(19))
        link.onNotification(
            byteArrayOf(
                0x80.toByte(), 0x0c, 0x13, 0x26, 0x08, 0x24, 0x14, 0x50, 0x58,
                0xf8.toByte(), 0xbf.toByte(), 0x00, 0x00, 0x03
            )
        )
        assertEquals("⚡19% 42/–", link.state.value.readoutText)
        link.setEnabled(false)
        assertEquals(RadarPhase.idle, link.state.value.phase)
        assertNull(link.state.value.readoutText)
        assertEquals(0, radio.scans)
        assertFalse(link.state.value.enabled)
    }

    @Test
    fun `a busy write is sent again and does not advance the handshake`() {
        val pending = ArrayDeque<() -> Unit>()
        val radio = FakeRadio()
        radio.writeStatus = 201
        val link = link(radio, MemoryStore("ADFAA003519"), later = { _, block -> pending.add(block) })
        link.start()
        link.onAdvertisement("ADFAA003519")
        link.onConnected()
        assertEquals(0, radio.written.size)
        assertEquals(1, pending.size)
        pending.removeFirst().invoke()
        assertEquals(1, radio.written.size)
        val first = radio.written[0]
        assertTrue(first.contentEquals(RadarProtocol.cmdVersion()))
        radio.writeStatus = 0
        pending.removeFirst().invoke()
        assertEquals(2, radio.written.size)
        assertTrue(radio.written[1].contentEquals(first))
    }

    @Test
    fun `pairing saves the serial, a failed write drops the link, and a reading updates the board`() {
        val pending = ArrayDeque<() -> Unit>()
        var bluetooth = true
        val radio = FakeRadio()
        val store = MemoryStore(null)
        val link = RadarLink(store, radio, { bluetooth }, { true }, { true }, {}, { _, block ->
            pending.add(block)
        })
        link.onDisconnected()
        link.setStep(2)
        assertEquals(2, link.state.value.connectingStep)
        link.openPicker()
        link.onAdvertisement("ADFAA003519")
        link.pair("nope")
        assertNull(store.read())
        link.pair("ADFAA003519")
        assertEquals("ADFAA003519", store.read())
        assertEquals(RadarPhase.connecting, link.state.value.phase)

        link.onAdvertisement("ADFAA003519")
        link.onConnected()
        val speed = byteArrayOf(
            0x80.toByte(), 0x0c, 0x13, 0x26, 0x08, 0x24, 0x14, 0x50, 0x58,
            0xf8.toByte(), 0xbf.toByte(), 0x00, 0x00, 0x03
        )
        link.onNotification(speed)
        assertEquals("42/–", link.state.value.speedsText)
        link.onNotification(byteArrayOf(0x64))

        radio.writeStatus = 8
        pending.removeFirst().invoke()
        assertEquals(RadarPhase.connecting, link.state.value.phase)
        bluetooth = false
        pending.removeFirst().invoke()
        assertEquals(RadarPhase.bluetoothOff, link.state.value.phase)

        link.show(RadarCommand.Show("ADFAA003519", RadarPhase.bluetoothOff, 0))
        link.show(RadarCommand.Show("ADFAA003519", RadarPhase.locationOff, 0))
        link.show(RadarCommand.Show("ADFAA003519", RadarPhase.permission, 0))
        link.show(RadarCommand.Show("ADFAA003519", RadarPhase.idle, 0))
        link.setStep(1)
        assertEquals(0, link.state.value.connectingStep)
        link.onNotification(speed)
        assertNull(link.state.value.speedsText)
    }

    @Test
    fun `a dropped gatt waits out the backoff and then scans for the saved serial`() {
        val pending = ArrayDeque<() -> Unit>()
        val radio = FakeRadio()
        val link = link(radio, MemoryStore("ADFAA003519"), later = { _, block -> pending.add(block) })
        link.start()
        link.onAdvertisement("ADFAA003519")
        link.onDisconnected()
        assertEquals(RadarPhase.connecting, link.state.value.phase)
        assertEquals(0, radio.scans)
        pending.removeFirst().invoke()
        assertEquals(1, radio.scans)
    }

    @Test
    fun `six paced writes reach live and the keepalive sends version again`() {
        val pending = ArrayDeque<() -> Unit>()
        val radio = FakeRadio()
        val link = link(radio, MemoryStore("ADFAA003519"), later = { _, block -> pending.add(block) })
        link.start()
        link.onAdvertisement("ADFAA003519")
        link.onConnected()
        repeat(6) { pending.removeFirst().invoke() }
        assertEquals(6, radio.written.size)
        pending.removeFirst().invoke()
        assertTrue(radio.written.last().contentEquals(RadarProtocol.cmdVersion()))
    }

    @Test
    fun `a gatt status of 201 is the busy retry and any other code is unchanged`() {
        assertEquals(0, writeStatus(BluetoothStatusCodes.SUCCESS))
        assertEquals(201, writeStatus(BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY))
        assertEquals(133, writeStatus(133))
    }

    @Test
    fun `control urls reject a missing field, a bad phase, and an unknown action`() {
        assertNull(RadarControl.parse("radar-feed", mapOf("pitch" to "1", "exit" to "2")))
        assertNull(RadarControl.parse("radar-feed", mapOf("pitch" to "x", "exit" to "1", "now" to "1")))
        assertNull(RadarControl.parse("radar-feed", mapOf("pitch" to "1", "exit" to "x", "now" to "1")))
        assertNull(RadarControl.parse("radar-show", mapOf("serial" to "ADFAA003519", "phase" to "nope")))
        assertNull(RadarControl.parse("radar-show", mapOf("serial" to "nope", "phase" to "idle")))
        val shown = RadarControl.parse("radar-show", mapOf("serial" to "ADFAA003519", "phase" to "idle"))
        assertEquals(0, (shown as RadarCommand.Show).step)
        assertNull(RadarControl.parse("other", emptyMap()))
    }

    @Test
    fun `android radar radio forwards every call`() {
        var scans = 0
        var stops = 0
        var connects = 0
        var disconnects = 0
        var subscribes = 0
        var writes = 0
        var listeners = 0
        val radio = AndroidRadarRadio(
            startScanFn = { scans += 1 },
            stopScanFn = { stops += 1 },
            connectFn = { connects += 1 },
            disconnectFn = { disconnects += 1 },
            subscribeFn = { subscribes += 1 },
            writeFn = { writes += 1; 0 },
            listenerFn = { listeners += 1 }
        )
        radio.startScan { }
        radio.stopScan()
        radio.connect("ADFAA003519")
        radio.disconnect()
        radio.subscribe(SPEED_NOTIFY_UUID)
        assertEquals(0, radio.write(byteArrayOf(1)))
        radio.setListener(null)
        assertEquals(1, scans)
        assertEquals(1, stops)
        assertEquals(1, connects)
        assertEquals(1, disconnects)
        assertEquals(1, subscribes)
        assertEquals(1, writes)
        assertEquals(1, listeners)
    }

    private fun link(
        radio: FakeRadio,
        store: MemoryStore = MemoryStore(null),
        bluetooth: Boolean = true,
        locationOn: Boolean = true,
        permissions: Boolean = true,
        later: (Long, () -> Unit) -> Unit = { _, _ -> }
    ) = RadarLink(store, radio, { bluetooth }, { locationOn }, { permissions }, {}, later)

    private class MemoryStore(var serial: String?) : RadarPairingStore {
        override fun read(): String? = serial
        override fun write(serial: String?) {
            this.serial = serial
        }
    }

    private class FakeRadio : RadarRadio {
        var scans = 0
        var connects = 0
        var disconnects = 0
        var writeStatus = 0
        val written = mutableListOf<ByteArray>()
        override fun startScan(onName: (String) -> Unit) {
            scans += 1
        }
        override fun stopScan() {
            scans = 0
        }
        override fun connect(name: String) {
            connects += 1
        }
        override fun disconnect() {
            disconnects += 1
        }
        override fun subscribe(uuid: String) = Unit
        override fun write(bytes: ByteArray): Int {
            written.add(bytes.copyOf())
            return writeStatus
        }
        override fun setListener(listener: RadarRadioListener?) = Unit
    }
}
