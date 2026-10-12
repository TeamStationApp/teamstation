package app.teamstation.streamcore.phonestream

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.os.BatteryManager
import android.os.PowerManager
import app.teamstation.streamcore.core.ThermalBadgeLevel
import app.teamstation.streamcore.radar.RadarFleet
import app.teamstation.streamcore.radar.RadarFleetStore
import app.teamstation.streamcore.radar.systemRadarRadio
import app.teamstation.streamcore.record.RecordingCatalog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.TimeUnit

/** The engine's parts that talk to Android or the server: the redial's client, the catalog, the pills, the radar. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneStreamPartsTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer().apply { start() }
    private val context: Context = RuntimeEnvironment.getApplication()

    @After
    fun tearDown() = server.shutdown()

    private fun client() = LiveStreamClient(server.url("/api/v1").toString(), "token-0000")

    @Test
    fun theRedialAsksForTheStreamThisDeviceHolds() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"id":"00000000-0000-4000-8000-000000000001","label":"Home Plate","state":"live","url":"rtmp://ingest.example.test/live/key-0000"}"""
            )
        )
        val stream = runBlocking {
            client().requestLiveStream(
                gameId = "00000000-0000-4000-8000-000000000009",
                label = "Home Plate",
                deviceId = "00000000-0000-4000-8000-0000000000aa",
                deviceModel = "Google Pixel 10",
                heldStreamId = "00000000-0000-4000-8000-000000000001"
            )
        }
        assertEquals("rtmp://ingest.example.test/live/key-0000", stream.url)
        assertEquals("Home Plate", stream.label)
        assertEquals("live", stream.state)
        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/api/v1/games/00000000-0000-4000-8000-000000000009/live-streams", request.path)
        assertEquals("Bearer token-0000", request.getHeader("authorization"))
        val body = JSONObject(request.body.readUtf8())
        assertEquals("00000000-0000-4000-8000-000000000001", body.getString("heldStreamId"))
        assertEquals("00000000-0000-4000-8000-0000000000aa", body.getString("deviceId"))
        assertEquals("Google Pixel 10", body.getString("deviceModel"))
        assertEquals("Home Plate", body.getString("label"))
        assertTrue(body.getBoolean("recordsLocally"))
    }

    @Test
    fun aStartSendsNoHeldStreamAndAnAnswerWithoutAUrlHasNone() {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"s1","url":null}"""))
        val stream = runBlocking { client().requestLiveStream("g1", "Home Plate", "d1", "Google Pixel 10") }
        assertNull(stream.url)
        assertNull(stream.label)
        assertFalse(JSONObject(server.takeRequest().body.readUtf8()).has("heldStreamId"))
    }

    @Test
    fun aGoneStreamIsEndedAndOtherFailuresSayWhy() {
        server.enqueue(MockResponse().setResponseCode(410).setBody("""{"message":"This camera was ended. Start streaming again to go live"}"""))
        server.enqueue(MockResponse().setResponseCode(410))
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"message":"You already have a camera called Home Plate on this game"}"""))
        server.enqueue(MockResponse().setResponseCode(500).setBody("oops"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("not json"))
        val errors = (1..6).map {
            try {
                runBlocking { client().requestLiveStream("g1", "Home Plate", "d1", "Google Pixel 10", "s1") }
                null
            } catch (error: LiveStreamClient.Error) {
                error
            }
        }
        val closed = java.net.ServerSocket(0).use { it.localPort }
        val offline = try {
            runBlocking { LiveStreamClient("http://127.0.0.1:$closed", "token-0000").requestLiveStream("g1", "Home Plate", "d1", "Google Pixel 10") }
            null
        } catch (error: LiveStreamClient.Error) {
            error
        }
        assertEquals("This camera was ended. Start streaming again to go live", (errors[0] as LiveStreamClient.Error.StreamEnded).message)
        assertEquals(LiveStreamClient.endedMessage, (errors[1] as LiveStreamClient.Error.StreamEnded).message)
        assertEquals(LiveStreamClient.Error.NotSignedIn, errors[2])
        assertEquals("You already have a camera called Home Plate on this game", errors[3]!!.message)
        assertEquals(409, (errors[3] as LiveStreamClient.Error.Server).status)
        assertEquals("TeamStation answered 500", errors[4]!!.message)
        assertEquals("TeamStation sent something unreadable", errors[5]!!.message)
        assertEquals(LiveStreamClient.Error.Offline, offline)
    }

    private fun catalog(): Pair<PhoneCatalog, PhoneStorage> {
        val storage = PhoneStorage(File(folder.root, "phoneStream")).apply { prepare() }
        return PhoneCatalog(RecordingCatalog(storage.index)) to storage
    }

    @Test
    fun theCatalogFilesEachTakeUnderItsStreamAndFollowsItsUpload() {
        val (catalog, storage) = catalog()
        val index = catalog.index
        assertTrue(storage.program.isDirectory)
        assertTrue(storage.freeBytes() > 0)
        val take = index.beginRecording(1_000.0)
        catalog.add(take, "s1", "g1", "Home Plate")
        index.setProgramFilename("program-a.mp4,program-a-2.mp4", take)
        val row = index.recording(take)!!
        assertEquals("s1", row.liveStreamId)
        assertEquals("g1", row.gameId)
        assertEquals("Home Plate", row.gameTitle)
        var recording = catalog.recording(take)!!
        assertEquals(2, recording.parts)
        assertEquals(1_000.0, recording.startedAt, 0.0)
        assertNull(recording.endedAt)
        assertTrue(recording.coversWholeStream)
        assertFalse(recording.hasPendingUpload)
        assertEquals(take, catalog.current("s1")!!.recordingID)
        assertNull(catalog.current("s2"))

        catalog.setUpload("u1", "Home Plate", take)
        recording = catalog.recording(take)!!
        assertTrue(recording.hasPendingUpload)
        assertEquals("u1", recording.uploadId)
        assertEquals("Home Plate", recording.uploadTitle)
        catalog.markStoppedForLowStorage(take)
        assertFalse(catalog.recording(take)!!.coversWholeStream)
        catalog.markPublishedOutsideParts(take)
        assertTrue(catalog.recording(take)!!.publishedOutsideParts)
        catalog.markUploaded(take, "v1", 2_000.0)
        recording = catalog.recording(take)!!
        assertTrue(recording.isUploaded)
        assertFalse(recording.hasPendingUpload)
        assertEquals("v1", recording.videoId)
        // Uploaded, the stream's next take is a new one.
        assertNull(catalog.current("s1"))
        catalog.setUpload(null, null, take)
        assertNull(catalog.recording(take)!!.uploadId)

        // A take a kill left open closes at its last anchor, or at its start with none.
        val open = index.beginRecording(3_000.0)
        catalog.add(open, "s2", "g1", "First Base")
        index.insertProgramAnchor(open, 1, 3.0, 3_004.0)
        index.insertProgramAnchor(open, 1, 6.0, 3_007.0)
        catalog.closeAtLastAnchor(open)
        assertEquals(3_007.0, index.recording(open)!!.endedAt!!, 0.0)
        catalog.reopen(open)
        assertNull(index.recording(open)!!.endedAt)
        val bare = index.beginRecording(4_000.0)
        catalog.closeAtLastAnchor(bare)
        assertEquals(4_000.0, index.recording(bare)!!.endedAt!!, 0.0)
        catalog.closeAtLastAnchor(9_999)
        // The newest first, and only takes filed under a stream.
        assertEquals(listOf(open, take), catalog.recordings().map { it.recordingID })

        // The stream on the air, for a relaunch.
        assertNull(catalog.live())
        catalog.setLive(PhoneCatalog.LiveContext("s2", "g1", "First Base"))
        assertEquals(PhoneCatalog.LiveContext("s2", "g1", "First Base"), catalog.live())
        catalog.clearLive()
        assertNull(catalog.live())
        index.close()
    }

    @Test
    fun retentionDeletesOnlyTakesUploadedAWeekAgo() {
        val (catalog, storage) = catalog()
        val index = catalog.index
        val day = 24 * 3_600.0
        fun take(stream: String, start: Double): Long {
            val id = index.beginRecording(start)
            catalog.add(id, stream, "g1", stream)
            index.setProgramFilename("program-$stream.mp4", id)
            File(storage.program, "program-$stream.mp4").writeBytes(ByteArray(8))
            index.insertProgramAnchor(id, 1, 0.0, start)
            return id
        }
        val old = take("old", 0.0)
        val recent = take("recent", 1.0)
        val waiting = take("waiting", 2.0)
        val protectedTake = take("protected", 3.0)
        catalog.markUploaded(old, "v1", 0.0)
        catalog.markUploaded(recent, "v2", 6 * day)
        catalog.setUpload("u3", "waiting", waiting)
        catalog.markUploaded(protectedTake, "v4", 0.0)
        storage.export(old).apply {
            parentFile!!.mkdirs()
            writeBytes(ByteArray(4))
        }
        val policy = PhoneRetentionPolicy()
        assertEquals(7 * day, policy.keepUploadedSeconds, 0.0)
        assertEquals(listOf(old), policy.expired(catalog.recordings(), 7 * day, setOf(protectedTake)).map { it.recordingID })
        assertEquals(1, policy.sweep(catalog, storage, 7 * day, setOf(protectedTake)))
        assertFalse(File(storage.program, "program-old.mp4").exists())
        assertFalse(storage.export(old).exists())
        assertTrue(File(storage.program, "program-waiting.mp4").exists())
        assertNull(index.recording(old))
        assertTrue(index.programAnchors(old).isEmpty())
        assertEquals(setOf(recent, waiting, protectedTake), catalog.recordings().map { it.recordingID }.toSet())
        // Never one that has not been uploaded, however old.
        assertEquals(2, policy.sweep(catalog, storage, 1_000 * day))
        assertEquals(setOf(waiting), catalog.recordings().map { it.recordingID }.toSet())
        assertEquals(File(context.filesDir, "phoneStream"), PhoneStorage.standard(context).root)
        index.close()
    }

    @Test
    fun batteryAndHeatComeFromTheSystem() {
        val status = SystemDeviceStatus(context)
        assertNull(status.battery())
        context.sendStickyBroadcast(
            Intent(Intent.ACTION_BATTERY_CHANGED)
                .putExtra(BatteryManager.EXTRA_LEVEL, 41)
                .putExtra(BatteryManager.EXTRA_SCALE, 50)
                .putExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_CHARGING)
        )
        val battery = status.battery()!!
        assertEquals(82, battery.percent)
        assertTrue(battery.isCharging)
        val power = context.getSystemService(PowerManager::class.java)
        shadowOf(power).setCurrentThermalStatus(PowerManager.THERMAL_STATUS_SEVERE)
        assertEquals(ThermalBadgeLevel.WARM, status.thermal())
        shadowOf(power).setCurrentThermalStatus(PowerManager.THERMAL_STATUS_NONE)
        assertEquals(ThermalBadgeLevel.COOL, status.thermal())
    }

    private class MemoryStore(var serials: List<String> = emptyList(), var enabled: Boolean = false) : RadarFleetStore {
        override fun readSerials() = serials
        override fun writeSerials(serials: List<String>) {
            this.serials = serials
        }
        override fun readEnabled() = enabled
        override fun writeEnabled(enabled: Boolean) {
            this.enabled = enabled
        }
    }

    @Test
    fun theRadarCardReadsTheFleetAndHearsEveryChange() {
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val store = MemoryStore(listOf("ADFA0000001"))
        var bluetooth: Boolean? = true
        val fleet = RadarFleet(
            store = store,
            newRadio = { systemRadarRadio(context) },
            bluetoothOn = { bluetooth == true },
            locationOn = { true },
            permissionsGranted = { true },
            log = {},
            later = { _, _ -> }
        )
        val radar = PhoneRadar(fleet) { bluetooth }
        val seen = mutableListOf<PhoneRadarState>()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        radar.start(scope) { seen += it }
        radar.start(scope) { fail("started twice") }
        assertEquals(listOf("ADFA0000001"), radar.state.devices.map { it.serial })
        assertFalse(radar.state.enabled)
        radar.setEnabled(true)
        assertTrue(store.enabled)
        assertTrue(seen.last().enabled)
        radar.scan()
        assertTrue(seen.last().scanning)
        radar.stopScan()
        assertFalse(radar.state.scanning)
        assertTrue(radar.pair("ADFA0000002"))
        assertFalse(radar.pair("not a radar"))
        assertEquals(listOf("ADFA0000001", "ADFA0000002"), store.serials)
        radar.unpair("ADFA0000001")
        assertEquals(listOf("ADFA0000002"), seen.last().devices.map { it.serial })
        radar.refresh()
        assertEquals("on", radar.state.bluetooth)
        bluetooth = false
        assertEquals("off", radar.state.bluetooth)
        bluetooth = null
        assertEquals("unknown", radar.state.bluetooth)
        radar.stop()
        val count = seen.size
        radar.setEnabled(false)
        assertEquals(count, seen.size)

        assertEquals(listOf(android.Manifest.permission.ACCESS_FINE_LOCATION), PhoneRadar.permissions(30))
        assertEquals(
            listOf(android.Manifest.permission.BLUETOOTH_SCAN, android.Manifest.permission.BLUETOOTH_CONNECT),
            PhoneRadar.permissions(34)
        )
        val stored = PhoneRadar.store(context)
        assertFalse(stored.readEnabled())
        stored.writeSerials(listOf("ADFA0000003"))
        assertEquals(listOf("ADFA0000003"), stored.readSerials())
        assertNotNull(PhoneRadar.system(context).state)
    }
}
