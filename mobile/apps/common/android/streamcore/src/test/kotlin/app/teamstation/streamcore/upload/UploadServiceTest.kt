package app.teamstation.streamcore.upload

import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.ServerSocket
import java.util.concurrent.TimeUnit

/**
 * [UploadService] against a stand-in server: four tries per step with waits of 1, 2 and 4 s, a resume
 * from what the server already has, the finish and the polling after it, and the live-stream fields.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UploadServiceTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer().apply { start() }
    private val waits = mutableListOf<Long>()
    private val client = UploadClient(server.url("/").toString(), token = "token-0000")
    private val service = UploadService(client, sleep = { waits += it }, pollLimitMillis = 20_000)

    @After
    fun tearDown() = server.shutdown()

    private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status).setBody(body)

    private fun take(): RecordedRequest = server.takeRequest(1, TimeUnit.SECONDS) ?: error("no request")

    private fun file(size: Int) = folder.newFile("program-20261012-100000.mp4").apply { writeBytes(ByteArray(size) { it.toByte() }) }

    @Test
    fun aCancelledPartStopsAtOnceThoughTheServerNeverAnswers() {
        // The server takes the part and never answers: only the five-minute timeout would end the wait.
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE))
        runBlocking {
            val sending = launch(kotlinx.coroutines.Dispatchers.IO) { client.sendPart("u1", 0, ByteArray(1_024)) }
            take()
            val started = System.nanoTime()
            kotlinx.coroutines.withTimeout(5_000) { sending.cancelAndJoin() }
            assertTrue(sending.isCancelled)
            assertTrue((System.nanoTime() - started) / 1_000_000 < 2_000)
        }
    }

    @Test
    fun aRecordingGoesUpInPartsAndIsFollowedToItsVideo() {
        server.enqueue(json("""{"uploadId":"u1","partSize":4,"parts":3,"received":[]}"""))
        repeat(3) { server.enqueue(json("""{"received":${it + 1},"parts":3,"missing":[]}""")) }
        server.enqueue(json("""{"state":"assembling","step":"probing"}""", status = 202))
        server.enqueue(json("""{"uploadId":"u1","state":"assembling","partSize":4,"parts":3,"received":[0,1,2],"missing":[],"receivedBytes":10,"step":"remuxing"}"""))
        server.enqueue(json("""{"uploadId":"u1","state":"ready","partSize":4,"parts":3,"received":[0,1,2],"missing":[],"receivedBytes":10,"videoId":"v1"}"""))
        val progress = mutableListOf<UploadService.Progress>()
        val video = runBlocking {
            service.send(
                file(10), "game-1", "Game one", "programme", startedAt = 1_760_000_000.25, serverClockOffsetMs = -1_234,
                liveStreamId = "00000000-0000-4000-8000-000000000001", wholeStream = true, onProgress = progress::add
            )
        }
        assertEquals("v1", video)

        val open = take()
        assertEquals("POST", open.method)
        assertEquals("/api/v1/director/uploads", open.path)
        assertEquals("Bearer token-0000", open.getHeader("authorization"))
        val body = JSONObject(open.body.readUtf8())
        assertEquals("game-1", body.getString("gameId"))
        assertEquals("programme", body.getString("kind"))
        assertEquals("program-20261012-100000.mp4", body.getString("filename"))
        assertEquals(10, body.getInt("sizeBytes"))
        assertEquals("2025-10-09T08:53:20.250Z", body.getString("startAt"))
        assertEquals(-1_234, body.getInt("serverClockOffsetMs"))
        assertEquals("00000000-0000-4000-8000-000000000001", body.getString("liveStreamId"))
        assertTrue(body.getBoolean("wholeStream"))
        for (index in 0 until 3) {
            val part = take()
            assertEquals("PUT", part.method)
            assertEquals("/api/v1/director/uploads/u1/parts/$index", part.path)
            assertEquals("application/octet-stream", part.getHeader("content-type"))
            assertEquals(if (index < 2) 4L else 2L, part.bodySize)
            // One buffer carries every part, so the short last one must not drag the previous part's
            // tail along: each part is exactly its own slice of the file.
            val from = index * 4
            assertEquals((from until minOf(from + 4, 10)).map { it.toByte() }, part.body.readByteArray().toList())
        }
        assertEquals("/api/v1/director/uploads/u1/finish", take().path)
        assertEquals("GET", take().method)
        assertEquals(listOf(5_000L, 5_000L), waits)
        assertEquals(listOf(0, 1, 2, 3, 3, 3), progress.map { it.sent })
        assertEquals(listOf(null, null, null, null, "probing", "remuxing"), progress.map { it.step })
        assertEquals(1.0, progress.last().fraction, 0.0)
    }

    @Test
    fun anInterruptedUploadResumesFromWhatTheServerHas() {
        server.enqueue(json("""{"uploadId":"u2","state":"open","partSize":4,"parts":3,"received":[0,2],"missing":[1],"receivedBytes":6}"""))
        server.enqueue(json("""{"received":3,"parts":3,"missing":[]}"""))
        server.enqueue(json("""{"videoId":"v2","state":"ready"}"""))
        val video = runBlocking { service.send(file(10), "game-1", "Game one", "programme", 1_760_000_000.0, uploadId = "u2") }
        assertEquals("v2", video)
        assertEquals("/api/v1/director/uploads/u2", take().path)
        val part = take()
        assertEquals("/api/v1/director/uploads/u2/parts/1", part.path)
        assertEquals(listOf<Byte>(4, 5, 6, 7), part.body.readByteArray().toList())
        assertEquals("/api/v1/director/uploads/u2/finish", take().path)
        assertTrue(waits.isEmpty())
    }

    @Test
    fun aStepIsTriedFourTimesWithGrowingWaits() {
        repeat(3) { server.enqueue(json("""{"code":"busy","message":"restarting"}""", status = 503)) }
        server.enqueue(json("""{"uploadId":"u3","partSize":8,"parts":1,"received":[]}"""))
        repeat(4) { server.enqueue(json("""{"code":"busy","message":"part refused"}""", status = 500)) }
        try {
            runBlocking { service.send(file(8), "game-1", "Game one", "programme", 1_760_000_000.0) }
            fail("sent")
        } catch (error: UploadService.UploadError.GaveUp) {
            assertEquals("part 0", error.step)
            assertEquals("part refused", error.because)
        }
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 1_000L, 2_000L, 4_000L), waits)
        val open = take()
        assertFalse(JSONObject(open.body.readUtf8()).has("wholeStream"))
    }

    @Test
    fun aFailedOrEndlessFinishGivesUp() {
        server.enqueue(json("""{"uploadId":"u4","state":"open","partSize":8,"parts":1,"received":[0],"missing":[],"receivedBytes":8}"""))
        server.enqueue(json("""{"state":"assembling"}"""))
        server.enqueue(json("not json"))
        server.enqueue(json("""{"uploadId":"u4","state":"failed","partSize":8,"parts":1,"received":[0],"missing":[],"receivedBytes":8,"message":"not a video"}"""))
        try {
            runBlocking { service.send(file(8), "game-1", "Game one", "programme", 1_760_000_000.0, uploadId = "u4") }
            fail("finished")
        } catch (error: UploadService.UploadError.GaveUp) {
            assertEquals(UploadService.UploadError.GaveUp("finishing the upload", "not a video"), error)
        }
        server.enqueue(json("""{"uploadId":"u5","state":"open","partSize":8,"parts":1,"received":[0],"missing":[],"receivedBytes":8}"""))
        server.enqueue(json("""{"state":"assembling","step":"writing"}"""))
        repeat(4) { server.enqueue(json("""{"uploadId":"u5","state":"assembling","partSize":8,"parts":1,"received":[0],"missing":[],"receivedBytes":8,"step":"writing"}""")) }
        try {
            runBlocking { service.send(folder.newFile("again.mp4").apply { writeBytes(ByteArray(8)) }, "g", "t", "programme", 0.0, uploadId = "u5") }
            fail("finished")
        } catch (error: UploadService.UploadError.GaveUp) {
            assertEquals("still writing", error.because)
        }
        try {
            runBlocking { service.send(folder.newFile("empty.mp4"), "g", "t", "programme", 0.0) }
            fail("sent")
        } catch (error: UploadService.UploadError.CannotRead) {
            assertTrue(error.what.contains("empty.mp4"))
        }
    }

    @Test
    fun theClientSaysWhyARequestFailed() = runBlocking {
        server.enqueue(json("{}", status = 401))
        assertEquals(UploadClientError.NotSignedIn, runCatching { client.uploadState("u") }.exceptionOrNull())
        server.enqueue(json("""{"code":"gone","message":"That upload is gone"}""", status = 410))
        assertEquals(UploadClientError.Server("That upload is gone"), runCatching { client.uploadState("u") }.exceptionOrNull())
        server.enqueue(json("", status = 500))
        assertEquals(UploadClientError.Server("TeamStation answered 500"), runCatching { client.uploadState("u") }.exceptionOrNull())
        server.enqueue(json("[1]"))
        assertEquals(UploadClientError.Server("TeamStation sent something unreadable"), runCatching { client.uploadState("u") }.exceptionOrNull())
        val port = ServerSocket(0).use { it.localPort }
        val offline = UploadClient("http://127.0.0.1:$port")
        assertEquals(UploadClientError.Offline, runCatching { offline.finishUpload("u") }.exceptionOrNull())
        val broken = UploadClient("http://127.0.0.1:$port", open = { throw java.io.IOException("no") })
        assertEquals(UploadClientError.Offline, runCatching { broken.uploadState("u") }.exceptionOrNull())
        repeat(4) { take() }
        server.enqueue(json("""{"uploadId":"a b","state":"open","partSize":1,"parts":1,"received":[],"missing":[0],"receivedBytes":0,"step":null}"""))
        assertEquals("a b", client.uploadState("a b").uploadId)
        assertEquals("/api/v1/director/uploads/a%20b", take().path)
        assertEquals("1970-01-01T00:00:00.000Z", UploadClient.instant(0.0))
        assertEquals(0.0, UploadService.Progress(0, 0, 0, 0).fraction, 0.0)
    }

    /** A part's bytes, told as they go: the client writes 100 kB at a time, a clock that moves [step] ms a reading. */
    private fun sendWithin(step: Long, uploadId: String? = null): List<UploadService.Progress> {
        var time = 0L
        val chunked = UploadClient(server.url("/").toString(), token = "token-0000", chunkBytes = 100_000)
        val paced = UploadService(chunked, sleep = { waits += it }, now = { time += step; time })
        val progress = mutableListOf<UploadService.Progress>()
        runBlocking {
            val take = folder.root.resolve("program-${System.nanoTime()}.mp4").apply { writeBytes(ByteArray(400_000)) }
            paced.send(take, "game-1", "Game one", "programme", 1_760_000_000.0, uploadId = uploadId, onProgress = progress::add)
        }
        return progress
    }

    @Test
    fun aPartsBytesAreToldAsTheyGoFourTimesASecondAtMost() {
        // A part is 32 MB, which a field's uplink takes minutes over: told only as each one landed,
        // the bar sat still for minutes and then jumped.
        server.enqueue(json("""{"uploadId":"u7","partSize":300000,"parts":2,"received":[]}"""))
        repeat(2) { server.enqueue(json("""{"received":${it + 1},"parts":2,"missing":[]}""")) }
        server.enqueue(json("""{"videoId":"v7","state":"ready"}"""))
        val progress = sendWithin(step = 300)
        assertEquals(listOf(0L, 100_000L, 200_000L, 300_000L, 300_000L, 400_000L, 400_000L), progress.map { it.bytesSent })
        assertEquals(listOf(0, 0, 0, 0, 1, 1, 2), progress.map { it.sent })
        assertTrue(progress.all { it.bytesTotal == 400_000L && it.step == null })
        take()
        assertEquals(300_000L, take().bodySize)
        assertEquals(100_000L, take().bodySize)

        // A clock that has not moved a quarter of a second tells only the parts' ends.
        server.enqueue(json("""{"uploadId":"u8","partSize":300000,"parts":2,"received":[]}"""))
        repeat(2) { server.enqueue(json("""{"received":${it + 1},"parts":2,"missing":[]}""")) }
        server.enqueue(json("""{"videoId":"v8","state":"ready"}"""))
        assertEquals(listOf(0L, 300_000L, 400_000L), sendWithin(step = 50).map { it.bytesSent })
    }

    @Test
    fun aResumedUploadToldWhatTheServerHasThenCarriesOnWithinThePart() {
        server.enqueue(json("""{"uploadId":"u9","state":"open","partSize":300000,"parts":2,"received":[0],"missing":[1],"receivedBytes":300000}"""))
        server.enqueue(json("""{"received":2,"parts":2,"missing":[]}"""))
        server.enqueue(json("""{"videoId":"v9","state":"ready"}"""))
        val progress = sendWithin(step = 300, uploadId = "u9")
        assertEquals(listOf(300_000L, 400_000L, 400_000L), progress.map { it.bytesSent })
        assertEquals(0.75, progress.first().fraction, 0.0)
    }

    @Test
    fun pacingNeverGoesBackAndWaitsItsInterval() {
        val pacing = ProgressPacing(intervalMillis = 250, startingAt = 10, now = 0)
        assertFalse(pacing.admits(20, 100))
        assertTrue(pacing.admits(20, 250))
        assertFalse(pacing.admits(15, 600))
        pacing.reached(40, 700)
        assertFalse(pacing.admits(30, 1_000))
        assertFalse(pacing.admits(50, 900))
        assertTrue(pacing.admits(50, 950))
    }
}
