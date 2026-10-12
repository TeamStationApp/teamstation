package app.teamstation.streamcore.record

import app.teamstation.streamcore.MediaFixtures
import app.teamstation.streamcore.double
import app.teamstation.streamcore.int
import app.teamstation.streamcore.list
import app.teamstation.streamcore.long
import app.teamstation.streamcore.obj
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The recording path's decisions equal TS Director's, value for value: grid placement of jittered
 * pictures, the sound's origin, hold-fill lengths, resumed-part offsets, and export placement.
 */
class RecordingFixtureTest {
    @Test
    fun gridPlacementEqualsDirectors() {
        val fixture = MediaFixtures.json("programme-grid-placement.json")
        assertEquals(fixture["gridSlackFrames"].double(), ProgramEncoder.gridSlack, 0.0)
        val rate = fixture["frameRate"].double()
        var lastSlot = -1L
        for (step in fixture["steps"].list().map { it.obj() }) {
            val host = step["hostSeconds"].double()
            val hostSlot = Math.round(host * rate)
            val slot = ProgramEncoder.gridSlot(
                sourceSeconds = step["sourceSeconds"]?.double(),
                rate = rate,
                hostSlot = hostSlot,
                lastSlot = lastSlot,
                onClockGrid = step["onClockGrid"] as Boolean,
                continuingAfterRecovery = false
            )
            val written = if (slot > lastSlot) slot else null
            if (written != null) lastSlot = written
            assertEquals("host $host", step["slot"]?.long(), written)
        }
    }

    @Test
    fun theSoundOriginEqualsDirectors() {
        val fixture = MediaFixtures.json("programme-sound-origin.json")
        assertEquals(fixture["seedSeconds"].double(), ProgrammeSoundOrigin.seedSeconds, 0.0)
        for (case in fixture["cases"].list().map { it.obj() }) {
            val origin = ProgrammeSoundOrigin()
            for (offer in case["offers"].list().map { it.list() }) origin.offer(offer[0].double(), offer[1].double())
            val expected = case["partStartWall"]?.double()
            assertEquals(case["name"] as String, expected, origin.partStartWall)
        }
    }

    @Test
    fun holdFillLengthsEqualDirectors() {
        val fixture = MediaFixtures.json("programme-hold-fill.json")
        assertEquals(fixture["silenceChunkSeconds"].double(), ProgramEncoder.silenceChunkSeconds, 0.0)
        assertEquals(fixture["maximumSilenceChunks"].int(), ProgramEncoder.HoldFill.maximumSilenceChunks)
        assertEquals(fixture["gridFillSeconds"].double(), ProgramEncoder.HoldFill.gridFillSeconds, 0.0)
        for (case in fixture["cases"].list().map { it.obj() }) {
            val name = case["name"] as String
            val fill = ProgramEncoder.HoldFill(
                case["requestedEnd"].double(),
                case["lastPictureSeconds"]?.double(),
                case["frameRate"].int(),
                case["writtenSoundEnd"].double()
            )
            assertEquals(name, case["pictureFillFrom"].double(), fill.pictureFrom, 0.0)
            assertEquals(name, case["pictureFillStep"].double(), fill.pictureStep, 0.0)
            assertEquals(name, case["pictureFillCount"].int(), fill.pictureCount)
            assertEquals(name, case["soundFillEnd"].double(), fill.soundEnd, 0.0)
            assertEquals(name, case["silenceSeconds"].double(), fill.silenceSeconds, 0.0)
            assertEquals(name, case["silenceCapped"] as Boolean, fill.silenceCapped)
        }
    }

    @Test
    fun resumedPartOffsetsEqualDirectors() {
        for (case in MediaFixtures.json("programme-resumed-part.json")["cases"].list().map { it.obj() }) {
            val opens = case["firstPictureAt"]?.double() ?: case["resumedAt"].double()
            assertEquals(
                case["name"] as String,
                case["previousPartsSeconds"].double(),
                ProgramEncoder.previousPartsSeconds(case["takeStart"].double(), opens),
                0.0
            )
        }
    }

    @Test
    fun exportPlacementEqualsDirectors() {
        val fixture = MediaFixtures.json("programme-export-placement.json")
        assertEquals(fixture["anchorAgreementSeconds"].double(), RecordingCatalog.anchorAgreementSeconds, 0.0)
        for (case in fixture["cases"].list().map { it.obj() }) {
            val name = case["name"] as String
            val anchors = case["anchors"].list().map { it.list() }
                .map { RecordingCatalog.ProgramAnchor(it[0].int(), it[1].double(), it[2].double()) }
            val starts = RecordingCatalog.partStarts(anchors)
            val expected = case["partStarts"].obj().mapKeys { it.key.toInt() }.mapValues { it.value.double() }
            assertEquals(name, expected.keys, starts.keys)
            for ((part, wall) in expected) assertEquals("$name part $part", wall, starts.getValue(part), 0.0)
            val parts = expected.size
            val plan = ProgrammeExport.plan(
                partCount = parts,
                resumeCount = if (name.contains("resumed")) 1 else 0,
                anchors = anchors,
                reading = ProgrammeExport.PartReading(0.0, 600.0, 600.0, true),
                windowStart = starts[1] ?: 0.0,
                windowEnd = (starts[1] ?: 0.0) + 600,
                frameRate = 30
            )
            assertEquals(name, case["plan"], plan.description)
        }
    }
}
