package app.teamstation.streamcore.phonestream

import android.Manifest
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The phone engine on a real phone, against a TeamStation server: the camera and microphone through
 * the programme to a live stream and a recording, a cut in the stream, a kill and a resume as the
 * take's second part, and the upload that replaces the stream's live copy.
 *
 * It runs only when given a stream, through the runner's arguments
 * (`-Pandroid.testInstrumentationRunnerArguments.<name>=…`):
 * - `rtmpUrl`, `liveStreamId`, `gameId`: the stream a `POST …/live-streams` with `recordsLocally`
 *   handed out, and its game
 * - `apiBase`, `token`, `deviceId`: what the redial and the upload ask the server with
 * - `angleName` (Home Plate), `recordSeconds` (60), `resumeSeconds` (30)
 * - `step`: `all` (the default) kills the engine in-process; `record` records and then leaves the
 *   take running when the run ends, which kills the process, and `resume`, run within the hour,
 *   continues it as part 2, stops and uploads. A run of `record` keeps its APK and data with
 *   `-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true`.
 *
 * Every status, once a second, and every upload event goes to logcat under [TAG].
 */
@RunWith(AndroidJUnit4::class)
class PhoneStreamEngineDeviceTest {
    @get:Rule
    val permissions: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)

    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun argument(name: String): String? = arguments.getString(name)?.takeIf { it.isNotEmpty() }

    private fun log(line: String) {
        Log.i(TAG, line)
    }

    @Test
    fun recordsThroughACutAndAKillAndUploadsTheTakeAsTheStreamsReplacement() {
        val rtmpUrl = argument("rtmpUrl")
        assumeTrue("needs -Pandroid.testInstrumentationRunnerArguments.rtmpUrl", rtmpUrl != null)
        val step = argument("step") ?: "all"
        val apiBase = argument("apiBase")!!
        val token = argument("token")!!
        val liveStreamId = argument("liveStreamId")!!
        val gameId = argument("gameId")!!
        val angleName = argument("angleName") ?: "Home Plate"
        val recordSeconds = argument("recordSeconds")?.toInt() ?: 60
        val resumeSeconds = argument("resumeSeconds")?.toInt() ?: 30
        val request = PhoneStreamRequest(apiBase, token, argument("deviceId")!!)
        log("STEP $step device=${request.deviceModel} capabilities=${PhoneStreamCapabilities.current()}")

        ActivityScenario.launch(PhoneStreamTestActivity::class.java).use { scenario ->
            if (step == "all" || step == "record") {
                val engine = opened(scenario, angleName)
                runBlocking { engine.startRecording(rtmpUrl!!, liveStreamId, gameId, angleName, request) }
                log("RECORDING started stream=$liveStreamId")
                watch(engine, recordSeconds)
                if (step == "record") {
                    // The run ends with the take rolling: the process is killed, nothing finished.
                    log("KILL_READY recordings=${runBlocking { engine.recordings() }}")
                    return
                }
                runBlocking { engine.abandonForTesting() }
                log("KILLED in process")
                Thread.sleep(5_000)
            }
            val engine = opened(scenario, angleName)
            val interrupted = runBlocking { engine.interruptedSession() }
            log("INTERRUPTED $interrupted")
            assertNotNull(interrupted)
            assertEquals(liveStreamId, interrupted!!.liveStreamId)
            assertTrue(runBlocking { engine.resumeInterrupted(request) })
            log("RESUMED")
            watch(engine, resumeSeconds)
            assertEquals("live", engine.status.phase)
            runBlocking { engine.stopRecording() }
            val take = runBlocking { engine.recordings() }.single { it.liveStreamId == liveStreamId }
            val summary = engine.index.recording(take.recordingID)
            log(
                "TAKE id=${take.recordingID} parts=${take.parts} startedAt=${take.startedAt} endedAt=${take.endedAt} " +
                    "wholeStream=${take.coversWholeStream} files=${summary?.programFilenames} soundChecks=${summary?.soundChecks}"
            )
            assertEquals(2, take.parts)
            val video = runBlocking { engine.uploadRecording(liveStreamId, apiBase, token, angleName) }
            log("UPLOADED video=$video")
            runBlocking { engine.close() }
        }
    }

    private fun opened(scenario: ActivityScenario<PhoneStreamTestActivity>, angleName: String): PhoneStreamEngine {
        val engine = PhoneStreamEngine(PhoneStreamEnvironment.live(context))
        engine.observe { event ->
            if (event is PhoneStreamEvent.Upload) log("UPLOAD ${event.upload}")
        }
        runBlocking { engine.open(angleName) }
        var rotation = 0
        scenario.onActivity {
            it.show(engine)
            rotation = it.displayRotationDegrees
        }
        runBlocking { engine.setDisplayRotation(rotation) }
        log("OPEN rotation=$rotation")
        return engine
    }

    /** Lets the engine run for [seconds], logging its status every second. */
    private fun watch(engine: PhoneStreamEngine, seconds: Int) {
        repeat(seconds) {
            Thread.sleep(1_000)
            val status = engine.status
            log(
                "STATUS phase=${status.phase} retryIn=${status.retryInSeconds} kbps=${status.bitrateKbps} " +
                    "recording=${"%.1f".format(status.recordingSeconds)} error=${status.error?.rawValue} " +
                    "ticks=${engine.programme.ticks} recFrames=${engine.programme.recordingFramesSent} " +
                    "streamFrames=${engine.programme.streamFramesSent} encoded=${engine.encoder.frameCount} " +
                    "lastError=${engine.telemetry.lastError} recordingError=${engine.telemetry.lastRecordingError}"
            )
        }
    }

    companion object {
        const val TAG = "PhoneStreamE2E"
    }
}
