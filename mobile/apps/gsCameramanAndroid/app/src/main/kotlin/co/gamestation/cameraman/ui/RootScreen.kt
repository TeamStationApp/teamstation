package co.gamestation.cameraman.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import co.gamestation.cameraman.engine.AppEnvironment
import co.gamestation.cameraman.ui.theme.MonospaceLabel

/**
 * Chooses between the operating screen and a diagnostic one.
 *
 * The diagnostic screen is not a nicety: a denied camera permission has to be readable on the
 * device, because that is a state where there is no picture to show.
 */
@Composable
fun RootScreen(environment: AppEnvironment) {
    val permissions by environment.permissions.collectAsStateWithLifecycle()
    var isShowingSettings by remember { mutableStateOf(false) }

    when {
        !permissions.camera -> DiagnosticScreen(environment)
        isShowingSettings -> SettingsScreen(environment) { isShowingSettings = false }
        else -> CameraScreen(environment) { isShowingSettings = true }
    }
}

/**
 * Every value carries a test tag so a Maestro flow can assert it without scraping a screenshot.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiagnosticScreen(environment: AppEnvironment) {
    val status by environment.status.collectAsStateWithLifecycle()
    val identity by environment.identity.collectAsStateWithLifecycle()
    val permissions by environment.permissions.collectAsStateWithLifecycle()
    val serverStatus by environment.serverStatus.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        "GS Cameraman",
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.testTag("app-title")
                    )
                },
                navigationIcon = {
                    Icon(
                        imageVector = if (permissions.camera) {
                            Icons.Filled.Videocam
                        } else {
                            Icons.Filled.VideocamOff
                        },
                        contentDescription = null,
                        tint = if (permissions.camera) {
                            MaterialTheme.colorScheme.tertiary
                        } else {
                            MaterialTheme.colorScheme.error
                        },
                        modifier = Modifier.padding(horizontal = 16.dp)
                    )
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLowest
                )
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            DiagnosticCard("Camera") {
                Value("status", status, "status")
                Value("name", identity.name, "camera-name")
                Value("cname", identity.cname, "camera-cname")
                Value(
                    "camera",
                    if (permissions.camera) "granted" else "denied",
                    "camera-permission",
                    isFault = !permissions.camera
                )
                Value(
                    "mic",
                    if (permissions.microphone) "granted" else "denied",
                    "mic-permission",
                    isFault = !permissions.microphone
                )
                Value(
                    "notifications",
                    if (permissions.notifications) "granted" else "denied",
                    "notification-permission",
                    isFault = !permissions.notifications
                )
            }

            DiagnosticCard("Server") {
                Value(
                    "listening",
                    serverStatus.isListening.toString(),
                    "listening",
                    isFault = !serverStatus.isListening
                )
                Value("port", serverStatus.port?.toString() ?: "none", "port")
                Value("requestedPort", serverStatus.requestedPort?.toString() ?: "none", "requested-port")
                Value("advertising", serverStatus.isAdvertising.toString(), "advertising")
                Value("url", environment.streamURL, "stream-url")
                serverStatus.lastError?.let { Value("error", it, "server-error", isFault = true) }
            }
        }
    }
}

@Composable
private fun DiagnosticCard(
    title: String,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(vertical = 8.dp)) {
            Text(
                title.uppercase(java.util.Locale.US),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
            )
            content()
        }
    }
}

@Composable
private fun Value(label: String, value: String, tag: String, isFault: Boolean = false) {
    ListItem(
        headlineContent = { Text(label, style = MaterialTheme.typography.bodyMedium) },
        trailingContent = {
            Text(
                value,
                style = MonospaceLabel,
                // A denied permission or a listener that never bound is the reason this screen is on
                // the display at all, so it is coloured rather than left for the reader to find.
                color = if (isFault) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag(tag)
            )
        },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent)
    )
}
