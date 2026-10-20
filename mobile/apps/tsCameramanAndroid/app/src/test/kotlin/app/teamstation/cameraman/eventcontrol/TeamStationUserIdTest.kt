package app.teamstation.cameraman.eventcontrol

import app.teamstation.cameraman.radar.ScoreboardTarget
import app.teamstation.streamcore.core.SettingsStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TeamStationUserIdTest {
    @Test fun `shared vectors validate exactly and reject decimal values`() {
        var root = File(System.getProperty("user.dir"))
        while (!File(root, "src/common/userId.vectors.json").exists()) {
            root = root.parentFile ?: error("Shared identity corpus not found")
        }
        val vectors = JSONObject(File(root, "src/common/userId.vectors.json").readText())
        val accepted = vectors.getJSONArray("accepted")
        for (i in 0 until accepted.length()) {
            val row = accepted.getJSONObject(i)
            val id = row.getString("userId")
            assertEquals(id, TeamStationUserId.canonical(id))
            assertNull(TeamStationUserId.canonical(row.getString("value")))
        }
        val rejected = vectors.getJSONArray("rejected")
        for (i in 0 until rejected.length()) assertNull(TeamStationUserId.canonical(rejected.getString(i)))
        for (bad in listOf("", "0", "01", "-1", "1.0", " 1", "1\n", "9007199254740992")) {
            assertNull(TeamStationUserId.canonical(bad))
        }
    }

    private class Store : SettingsStore {
        val values = mutableMapOf<String, String>()
        var writes = 0
        var refuse = false
        override fun string(key: String): String? = values[key]
        override fun setString(value: String, key: String) {
            writes++
            if (refuse) error("fixture write failure")
            values[key] = value
        }
    }

    @Test fun `old or missing account IDs sign out and current accounts survive reload`() {
        val prefix = "app.teamstation.cameraman.scoreboard."
        for (id in listOf("1", "9007199254740991", "", "0", "01", "9007199254740992", "usr_invalid")) {
            val store = Store()
            store.values.putAll(mapOf(prefix + "token" to "fixture-token", prefix + "gameId" to "gam_fixture",
                prefix + "accountServer" to "https://app.example.test", prefix + "userId" to id,
                prefix + "displayName" to "Hank Aaron", prefix + "email" to "fixture@example.test"))
            val old = store.values.toMap()
            store.refuse = true
            assertEquals("", ScoreboardTarget.load(store).token)
            assertEquals(old, store.values)
            store.refuse = false
            val cleared = ScoreboardTarget.load(store)
            assertEquals("", cleared.token)
            assertEquals("", cleared.userId)
            assertEquals("", cleared.displayName)
            assertEquals("", cleared.email)
            assertEquals("gam_fixture", cleared.gameId)
            assertEquals("https://app.example.test", cleared.accountServer)
            assertEquals("", store.values[prefix + "token"])
            assertEquals("", store.values[prefix + "userId"])
            assertEquals(cleared, ScoreboardTarget.load(store))
            val fresh = cleared.copy(token = "new-token", userId = "usr_1111111111111111111112")
            ScoreboardTarget.save(store, fresh)
            val writes = store.writes
            assertEquals(fresh, ScoreboardTarget.load(store))
            assertEquals(writes, store.writes)
        }
        val missing = Store()
        missing.values[prefix + "token"] = "fixture-token"
        assertEquals("", ScoreboardTarget.load(missing).token)
        assertEquals("", ScoreboardTarget.load(Store()).userId)
    }
}
