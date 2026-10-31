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
    fun theServersClockIsReadFromTheQuickestRoundTrip() {
        assertNull(ServerClock.best(emptyList()))
        val trips = listOf(
            // Slow, and lopsided: its middle is a quarter of a second out.
            ServerClock.Trip(100.0, 101_500.0, 100.5),
            // Quick: the server reads 1.04 s ahead of this phone.
            ServerClock.Trip(200.0, 201_060.0, 200.04),
            ServerClock.Trip(300.0, 301_100.0, 300.2)
        )
        assertEquals(ServerClock.Sample(offsetMs = 1_040, rttMs = 40), ServerClock.best(trips))

        // Five requests, one after another: the two that fail are passed over, and of three equally
        // quick the earliest is kept.
        server.enqueue(MockResponse().setResponseCode(500))
        server.enqueue(MockResponse().setResponseCode(200).setBody("not json"))
        repeat(3) { server.enqueue(MockResponse().setResponseCode(200).setBody("""{"now":1790000003000}""")) }
        var clock = 1_790_000_000.0
        val sample = runBlocking { client().measureServerClock { clock.also { clock += 1.0 / 128 } } }
        assertEquals(ServerClock.Sample(offsetMs = 2_980, rttMs = 8), sample)
        repeat(ServerClock.TRIPS_PER_SAMPLE) { assertEquals("/api/v1/time", server.takeRequest(1, TimeUnit.SECONDS)!!.path) }

        repeat(ServerClock.TRIPS_PER_SAMPLE) { server.enqueue(MockResponse().setResponseCode(503)) }
        val refused = try {
            runBlocking { client().measureServerClock { 0.0 } }
            null
        } catch (error: LiveStreamClient.Error) {
            error
        }
        assertEquals(503, (refused as LiveStreamClient.Error.Server).status)
        val closed = java.net.ServerSocket(0).use { it.localPort }
        val offline = try {
            runBlocking { LiveStreamClient("http://127.0.0.1:$closed", "token-0000").measureServerClock { 0.0 } }
            null
        } catch (error: LiveStreamClient.Error) {
            error
        }
        assertEquals(LiveStreamClient.Error.Offline, offline)
    }

    @Test
    fun theLiveStartIsSentAsAnInstantOnTheStreamItPlaces() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"id":"s1"}"""))
        server.enqueue(MockResponse().setResponseCode(410))
        server.enqueue(MockResponse().setResponseCode(410).setBody("""{"message":"Ended"}"""))
        server.enqueue(MockResponse().setResponseCode(503))
        runBlocking { client().reportLiveStart("g1", "s1", 1_790_000_000.375) }
        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("PATCH", request.method)
        assertEquals("/api/v1/games/g1/live-streams/s1", request.path)
        assertEquals("Bearer token-0000", request.getHeader("authorization"))
        assertEquals("2026-09-21T14:13:20.375Z", JSONObject(request.body.readUtf8()).getString("liveStartedAt"))
        val errors = (1..3).map {
            try {
                runBlocking { client().reportLiveStart("g1", "s1", 1_790_000_000.0) }
                null
            } catch (error: LiveStreamClient.Error) {
                error
            }
        }
        assertEquals(LiveStreamClient.endedMessage, (errors[0] as LiveStreamClient.Error.StreamEnded).message)
        assertEquals("Ended", (errors[1] as LiveStreamClient.Error.StreamEnded).message)
        assertEquals(503, (errors[2] as LiveStreamClient.Error.Server).status)
        val closed = java.net.ServerSocket(0).use { it.localPort }
        val offline = try {
            runBlocking { LiveStreamClient("http://127.0.0.1:$closed", "token-0000").reportLiveStart("g1", "s1", 1.0) }
            null
        } catch (error: LiveStreamClient.Error) {
            error
        }
        assertEquals(LiveStreamClient.Error.Offline, offline)
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

    @Test
    fun anAnswerCutOffOnItsWayIsOfflineOrStillEnded() {
        val cut = okhttp3.mockwebserver.SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY
        val body = """{"message":"This camera was ended and the answer is long enough to be cut off half way"}"""
        server.enqueue(MockResponse().setResponseCode(410).setBody(body).setSocketPolicy(cut))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"id":"s1","url":"rtmp://ingest.example.test/live/key-0001","label":"Home Plate"}""").setSocketPolicy(cut))
        server.enqueue(MockResponse().setResponseCode(410).setBody(body).setSocketPolicy(cut))
        val errors = (1..2).map {
            try {
                runBlocking { client().requestLiveStream("g1", "Home Plate", "d1", "Google Pixel 10", "s1") }
                null
            } catch (error: LiveStreamClient.Error) {
                error
            }
        }
        // A 410 is the stream ended whatever its body; a success that never arrived whole is offline.
        assertEquals(LiveStreamClient.endedMessage, (errors[0] as LiveStreamClient.Error.StreamEnded).message)
        assertEquals(LiveStreamClient.Error.Offline, errors[1])
        val report = try {
            runBlocking { client().reportLiveStart("g1", "s1", 1_760_000_000.0) }
            null
        } catch (error: LiveStreamClient.Error) {
            error
        }
        assertEquals(LiveStreamClient.endedMessage, (report as LiveStreamClient.Error.StreamEnded).message)
    }

    private fun catalog(): Pair<PhoneCatalog, PhoneStorage> {
        val storage = PhoneStorage(File(folder.root, "phoneStream")).apply { prepare() }
        return PhoneCatalog(RecordingCatalog(storage.index)) to storage
    }

    @Test
    fun aCatalogMadeBeforeTakesKeptTheirClockOffsetGainsTheColumn() {
        val storage = PhoneStorage(File(folder.root, "phoneStream")).apply { prepare() }
        val index = RecordingCatalog(storage.index)
        index.database.execSQL(
            "CREATE TABLE phone_recordings (recording_id INTEGER PRIMARY KEY, live_stream_id TEXT NOT NULL, " +
                "game_id TEXT NOT NULL, angle_name TEXT NOT NULL, upload_id TEXT, upload_title TEXT, uploaded_at REAL, " +
                "video_id TEXT, low_storage_stop INTEGER NOT NULL DEFAULT 0, published_outside_parts INTEGER NOT NULL DEFAULT 0);"
        )
        val catalog = PhoneCatalog(index)
        val take = index.beginRecording(1_000.0)
        catalog.add(take, "s1", "g1", "Home Plate")
        catalog.setServerClockOffset(-0.25, take)
        assertEquals(-0.25, catalog.recording(take)!!.serverClockOffset!!, 0.0)
        // Opening it again finds the column there.
        assertEquals(-0.25, PhoneCatalog(index).recording(take)!!.serverClockOffset!!, 0.0)
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
        // The first clock offset measured for a take holds: it is the one taken while recording.
        assertNull(catalog.recording(take)!!.serverClockOffset)
        catalog.setServerClockOffset(1.04, take)
        catalog.setServerClockOffset(1.14, take)
        assertEquals(1.04, catalog.recording(take)!!.serverClockOffset!!, 0.0)
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
    fun retentionSweepsUploadedTakesAndOldUnuploadedOnes() {
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
        fun ended(stream: String): Long = take(stream, 0.0).also { index.endRecording(it, 60.0) }
        val uploaded = ended("uploaded")
        val unuploaded = ended("unuploaded")
        val waiting = ended("waiting")
        val protectedUpload = ended("protectedUpload")
        val protectedTake = ended("protected")
        // Still running, however long ago it began.
        val running = take("running", 0.0)
        catalog.markUploaded(uploaded, "v1", 0.0)
        catalog.setUpload("u3", "waiting", waiting)
        catalog.markUploaded(protectedUpload, "v4", 0.0)
        storage.export(uploaded).apply {
            parentFile!!.mkdirs()
            writeBytes(ByteArray(4))
        }
        val policy = PhoneRetentionPolicy()
        assertEquals(30 * day, policy.keepUnuploadedSeconds, 0.0)
        val shielded = setOf(protectedUpload, protectedTake)
        // 29 days after the takes ended: only the uploaded one goes.
        val early = 60 + 29 * day
        assertEquals(listOf(uploaded), policy.expired(catalog.recordings(), early, shielded).map { it.recordingID })
        assertEquals(1, policy.sweep(catalog, storage, early, shielded))
        assertFalse(File(storage.program, "program-uploaded.mp4").exists())
        assertFalse(storage.export(uploaded).exists())
        assertTrue(File(storage.program, "program-waiting.mp4").exists())
        assertNull(index.recording(uploaded))
        assertTrue(index.programAnchors(uploaded).isEmpty())
        // 30 days after: the unuploaded take with nothing holding it goes too.
        assertEquals(1, policy.sweep(catalog, storage, 60 + 30 * day, shielded))
        assertEquals(setOf(waiting, protectedUpload, protectedTake, running), catalog.recordings().map { it.recordingID }.toSet())
        assertNull(index.recording(unuploaded))
        // Nothing protects them any more: a pending upload and the running take stay, however old.
        assertEquals(2, policy.sweep(catalog, storage, 1_000 * day))
        assertEquals(setOf(waiting, running), catalog.recordings().map { it.recordingID }.toSet())
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
