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
    @Test fun `shared vectors validate exactly and derive safe legacy values`() {
        var root = File(System.getProperty("user.dir"))
        while (!File(root, "src/common/userId.vectors.json").exists()) {
            root = root.parentFile ?: error("Shared identity corpus not found")
        }
        val vectors = JSONObject(File(root, "src/common/userId.vectors.json").readText())
        val accepted = vectors.getJSONArray("accepted")
        for (i in 0 until accepted.length()) {
            val row = accepted.getJSONObject(i)
            val id = row.getString("userId")
            val decimal = row.getString("value")
            assertEquals(id, TeamStationUserId.canonical(id))
            assertEquals(id, TeamStationUserId.upgradingStored(id))
            if (decimal.toLongOrNull()?.let { it <= 9_007_199_254_740_991L } == true) {
                assertEquals(id, TeamStationUserId.fromLegacyDecimal(decimal))
                assertEquals(id, TeamStationUserId.upgradingStored(decimal))
            } else assertNull(TeamStationUserId.fromLegacyDecimal(decimal))
        }
        val rejected = vectors.getJSONArray("rejected")
        for (i in 0 until rejected.length()) assertNull(TeamStationUserId.canonical(rejected.getString(i)))
        for (bad in listOf("", "0", "01", "-1", "1.0", " 1", "1\n", "9007199254740992")) {
            assertNull(TeamStationUserId.fromLegacyDecimal(bad))
            assertNull(TeamStationUserId.upgradingStored(bad))
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

    @Test fun `real scoreboard load persists upgrades once and keeps failed writes for retry`() {
        val store = Store()
        val prefix = "app.teamstation.cameraman.scoreboard."
        store.values.putAll(mapOf(prefix + "token" to "fixture-token", prefix + "gameId" to "gam_fixture",
            prefix + "accountServer" to "https://app.example.test", prefix + "userId" to "1"))
        val old = store.values.toMap()
        store.refuse = true
        assertEquals("usr_1111111111111111111112", ScoreboardTarget.load(store).userId)
        assertEquals(old, store.values)
        store.refuse = false
        val upgraded = ScoreboardTarget.load(store)
        assertEquals("fixture-token", upgraded.token)
        assertEquals("gam_fixture", upgraded.gameId)
        assertEquals("https://app.example.test", upgraded.accountServer)
        assertEquals(old + (prefix + "userId" to upgraded.userId), store.values)
        val writes = store.writes
        assertEquals(upgraded, ScoreboardTarget.load(store))
        assertEquals(writes, store.writes)
        for (bad in listOf("", "0", "01", "9007199254740992", "usr_invalid")) {
            store.values[prefix + "userId"] = bad
            assertEquals("", ScoreboardTarget.load(store).userId)
            assertEquals(bad, store.values[prefix + "userId"])
        }
        assertEquals("", ScoreboardTarget.load(Store()).userId)
        store.values[prefix + "userId"] = "1"
        store.values.remove(prefix + "token")
        assertEquals("", ScoreboardTarget.load(store).userId)
        assertEquals("1", store.values[prefix + "userId"])
    }
}
