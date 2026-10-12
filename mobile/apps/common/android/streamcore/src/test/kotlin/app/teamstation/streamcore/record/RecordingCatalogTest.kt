package app.teamstation.streamcore.record

import app.teamstation.streamcore.MediaFixtures
import app.teamstation.streamcore.core.StreamCodec
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The catalog's schema against `ArchiveIndex`'s, and what the recording path asks of it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RecordingCatalogTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val catalog by lazy { RecordingCatalog(File(folder.root, "index.sqlite")) }

    @After
    fun tearDown() = catalog.close()

    /** The columns `ArchiveIndex.swift` gives a table: its CREATE TABLE and every ADD COLUMN after it. */
    private fun archiveIndexColumns(table: String): List<String> {
        val source = File(MediaFixtures.directory.parentFile, "DirectorExport/Sources/DirectorExport/ArchiveIndex.swift").readText()
        val create = Regex("""CREATE TABLE IF NOT EXISTS $table \((.*?)\);""", RegexOption.DOT_MATCHES_ALL).find(source)!!
        val columns = create.groupValues[1].lines().map { it.trim() }.filter { it.isNotEmpty() }
            .map { it.substringBefore(' ') }.filter { it.uppercase() != "PRIMARY" }.toMutableList()
        Regex("""ALTER TABLE $table ADD COLUMN (\w+)""").findAll(source).forEach { match ->
            val column = match.groupValues[1]
            if (column !in columns) columns += column
        }
        return columns
    }

    @Test
    fun theSchemaIsArchiveIndexsInWalMode() {
        assertEquals("wal", catalog.journalMode)
        for (table in listOf("recordings", "program_anchors", "live_session")) {
            val expected = archiveIndexColumns(table)
            assertTrue(expected.size >= 4)
            assertEquals(table, expected, catalog.columns(table))
        }
        assertTrue("live_stream_id" in catalog.columns("recordings"))
        // Opening it again adds nothing and loses nothing.
        val id = catalog.beginRecording(1_000.0)
        val columns = catalog.columns("recordings")
        catalog.close()
        RecordingCatalog(File(folder.root, "index.sqlite")).use { again ->
            assertEquals(columns, again.columns("recordings"))
            assertEquals(id, again.recordings().single().id)
        }
    }

    @Test
    fun aTakesRowKeepsWhatTheRecordingPathWrites() {
        val id = catalog.beginRecording(1_000.0)
        assertEquals(setOf(id), catalog.openRecordingIDs())
        catalog.setLiveStreamId("00000000-0000-4000-8000-000000000001", id)
        catalog.setProgramFilename("program-a.mp4,program-a-2.mp4", id)
        catalog.setGame(id, "game-1", "Game one")
        catalog.setGame(id, "game-2", "Game two")
        catalog.setGame(id, "game-2", "Game two", replacing = "game-1")
        catalog.noteResumed(id, 1_100.0)
        val encoding = TakeEncoding(EncodeSettings(), EncodeSettings(codec = StreamCodec.H264, width = 1280, height = 720))
        catalog.saveEncoding(encoding, id)
        catalog.saveSelections("[]", id)
        catalog.recordSoundCheck(ProgramSoundCheck(2, 10.0, 9.0, 400, "two"), id)
        catalog.recordSoundCheck(ProgramSoundCheck(1, 10.0, 10.0, 469, "one"), id)
        catalog.recordSoundCheck(ProgramSoundCheck(1, 11.0, 11.0, 515, "one again"), id)
        catalog.endRecording(id, 1_200.0)

        val summary = catalog.recording(id)!!
        assertEquals("00000000-0000-4000-8000-000000000001", summary.liveStreamId)
        assertEquals(listOf("program-a.mp4", "program-a-2.mp4"), summary.programFilenames)
        assertEquals("game-2", summary.gameId)
        assertEquals("Game two", summary.gameTitle)
        assertEquals(1, summary.resumeCount)
        assertEquals(encoding, summary.encoding)
        assertEquals(encoding, catalog.encoding(id))
        assertEquals("[]", catalog.selections(id))
        assertEquals(listOf(1, 2), summary.soundChecks.map { it.part })
        assertEquals("one again", summary.soundChecks[0].detail)
        assertTrue(summary.soundChecks[1].isShort)
        assertEquals(1.0, summary.soundChecks[1].shortfall, 0.0)
        assertEquals(1_200.0, summary.endedAt!!, 0.0)
        assertTrue(catalog.openRecordingIDs().isEmpty())
        catalog.setLiveStreamId(null, id)
        assertNull(catalog.recording(id)!!.liveStreamId)
        assertNull(catalog.selections(999))
        assertNull(catalog.encoding(999))
        assertTrue(catalog.soundChecks(999).isEmpty())
        assertNull(TakeEncoding.fromJson("not json"))
        assertTrue(ProgramSoundCheck.listFromJson("[").isEmpty())
    }

    @Test
    fun anchorsSayWhereEachPartStartsAndWhichPartIsNext() {
        val id = catalog.beginRecording(1_000.0)
        assertEquals(1, catalog.nextProgramPart(id))
        for (index in 0 until 10) catalog.insertProgramAnchor(id, 1, index * 3.0, 1_000.02 + index * 3.0 + (index % 3) * 0.01)
        catalog.insertProgramAnchor(id, 2, 0.0, 1_330.5)
        catalog.insertProgramAnchor(id, 2, 3.0, 1_333.5)
        assertEquals(3, catalog.nextProgramPart(id))
        val starts = catalog.programPartStarts(id)
        assertEquals(1_000.03, starts.getValue(1), 1e-9)
        assertEquals(1_330.5, starts.getValue(2), 1e-9)
        assertEquals(12, catalog.programAnchors(id).size)
        assertNull(RecordingCatalog.partStart(emptyList()))
    }

    @Test
    fun theLiveSessionKeepsBothHalvesAndOnlyMovesForward() {
        assertNull(catalog.liveSession())
        catalog.closeLiveSession()
        val id = catalog.beginRecording(1_000.0)
        catalog.openLiveSession(recordingID = id, wall = 1_000.0)
        catalog.openLiveSession(streaming = true, wall = 1_001.0)
        var session = catalog.liveSession()!!
        assertEquals(id, session.recordingID)
        assertTrue(session.streaming)
        assertEquals(1_000.0, session.startedAt, 0.0)
        catalog.heartbeat(1_010.0)
        catalog.heartbeat(1_005.0)
        assertEquals(1_010.0, catalog.liveSession()!!.lastAlive, 0.0)
        assertEquals(id, catalog.liveRecording()!!.id)
        catalog.closeLiveSession(streaming = true)
        session = catalog.liveSession()!!
        assertFalse(session.streaming)
        assertFalse(session.isEmpty)
        // A take closed since is not one to come back to: the pointer is cleared, and the row with it.
        catalog.endRecording(id, 1_020.0)
        assertNull(catalog.liveRecording())
        assertNull(catalog.liveSession())
        catalog.openLiveSession(recordingID = 999, wall = 1_030.0)
        assertNull(catalog.liveRecording())
        catalog.openLiveSession(recordingID = id, streaming = true, wall = 1_040.0)
        catalog.closeLiveSession()
        assertNull(catalog.liveSession())
    }

    @Test
    fun theResumePlanReadsTheSession() {
        assertNull(LiveSessionResume.plan(catalog, now = 2_000.0))
        val id = catalog.beginRecording(1_000.0)
        catalog.insertProgramAnchor(id, 1, 0.0, 1_000.0)
        catalog.openLiveSession(recordingID = id, streaming = true, wall = 1_000.0)
        catalog.heartbeat(1_500.0)
        val resume = LiveSessionResume.plan(catalog, now = 1_620.0)!!
        assertEquals(120.0, resume.downtime, 0.0)
        assertEquals(
            LiveSessionResume.Outcome.Resume(LiveSessionResume.Take(id, 1_000.0, null, 2), streaming = true),
            resume.outcome
        )
        assertEquals(id, resume.liveRecordingID)
        assertFalse(resume.isExpired)
        assertEquals("Resumed recording and stream — app was away 2m 0s", resume.banner(3_600.0))

        val expired = LiveSessionResume.plan(catalog, now = 1_500.0 + 3_601)!!
        assertTrue(expired.isExpired)
        assertNull(expired.liveRecordingID)
        assertEquals(LiveSessionResume.Outcome.Expired(id), expired.outcome)
        assertEquals("Take closed — app was away 1h 0m, longer than the 1h 0m resume limit", expired.banner(3_600.0))

        catalog.closeLiveSession(streaming = true)
        assertEquals("Resumed recording — app was away 50s", LiveSessionResume.plan(catalog, now = 1_550.0)!!.banner(3_600.0))
        catalog.endRecording(id, 1_600.0)
        catalog.openLiveSession(recordingID = id, streaming = true, wall = 1_600.0)
        val streamOnly = LiveSessionResume.plan(catalog, now = 1_605.0)!!
        assertEquals(LiveSessionResume.Outcome.Resume(null, streaming = true), streamOnly.outcome)
        assertEquals("Resumed stream — app was away 5s", streamOnly.banner(3_600.0))
        catalog.openLiveSession(recordingID = id, streaming = false, wall = 1_610.0)
        catalog.endRecording(id, 1_600.0)
        assertNull(LiveSessionResume.plan(catalog, now = 1_615.0))
    }
}
