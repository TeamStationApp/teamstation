package app.teamstation.app.walkup

import java.io.File
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin half of U24: every case in the fixtures `localFileId.test.ts`
 * also reads normalises and hashes to the same text and the same `lf:` id
 * here, so a file saved on one phone is found by its hash on another.
 */
class LocalFileIdTest {
  private val fixtures: JSONArray by lazy {
    // Gradle runs unit tests from the module directory, android/app.
    JSONArray(File("../../src/app/walkup/localFileId.fixtures.json").readText())
  }

  @Test
  fun matchesTheSharedFixtures() {
    assertTrue(fixtures.length() > 10)
    for (index in 0 until fixtures.length()) {
      val case = fixtures.getJSONObject(index)
      val title = case.getString("title")
      val artist = case.getString("artist")
      assertEquals(title, case.getString("normalisedTitle"), LocalFileId.normalise(title))
      assertEquals(artist, case.getString("normalisedArtist"), LocalFileId.normalise(artist))
      assertEquals(
          "$title / $artist",
          case.getString("id"),
          LocalFileId.of(title, artist, case.getLong("durationMs")))
    }
  }
}
