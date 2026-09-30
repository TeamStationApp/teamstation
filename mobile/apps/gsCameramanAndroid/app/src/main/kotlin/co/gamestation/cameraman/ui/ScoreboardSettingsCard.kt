package co.gamestation.cameraman.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import co.gamestation.cameraman.radar.ScoreboardRoute
import co.gamestation.cameraman.radar.ScoreboardTarget
import co.gamestation.cameraman.scoreboard.ScoreboardEventRow
import co.gamestation.cameraman.scoreboard.ScoreboardUiState

/**
 * Where radar speeds go: the V1 autoState socket, or one signed-in event.
 *
 * Both radios are always on screen. The event radio and Choose event stay gray until an account
 * is signed in. V1 stays usable either way.
 */
/** Sign-in, alone, above every other card. The account server is the build's. */
@Composable
internal fun GameStationLoginCard(
    state: ScoreboardUiState,
    onSendCode: (String) -> Unit,
    onVerify: (String, String) -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier
) {
    var email by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = 16.dp)
            .semantics { testTagsAsResourceId = true }
            .testTag("settings-gamestation")
    ) {
        Column(modifier = Modifier.padding(bottom = 12.dp)) {
            Text(
                text = "GAMESTATION",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(start = 20.dp, top = 16.dp, end = 20.dp)
            )
            if (state.accountHost != ScoreboardTarget.PRODUCTION_ACCOUNT_HOST) {
                Text(
                    text = state.accountHost,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .padding(horizontal = 20.dp, vertical = 4.dp)
                        .testTag("scoreboard-account-server")
                )
            }
            if (state.signedIn) {
                Text(
                    text = state.accountLabel,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier
                        .padding(horizontal = 20.dp, vertical = 8.dp)
                        .testTag("scoreboard-account")
                )
                PillAction("Sign Out", "scoreboard-sign-out", onSignOut)
            } else {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 4.dp)
                        .testTag("scoreboard-email")
                )
                PillAction("Send Code", "scoreboard-send-code") { onSendCode(email) }
                if (state.awaitingCode) {
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it },
                        label = { Text("Code") },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp, vertical = 4.dp)
                            .testTag("scoreboard-code")
                    )
                    PillAction("Sign In", "scoreboard-sign-in") { onVerify(email, code) }
                }
            }
            if (state.status.isNotEmpty() && !isRouteStatus(state.status)) {
                Text(
                    text = state.status,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .padding(horizontal = 20.dp, vertical = 4.dp)
                        .testTag("scoreboard-account-status")
                )
            }
        }
    }
}

@Composable
private fun PillAction(label: String, tag: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        shape = RoundedCornerShape(percent = 50),
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary
        ),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 6.dp)
            .testTag(tag)
    ) {
        Text(label, fontWeight = FontWeight.SemiBold)
    }
}

private fun isRouteStatus(text: String): Boolean =
    text == "Choose an event" || text == "Enter a V1 event id"

@Composable
internal fun ScoreboardSettingsCard(
    state: ScoreboardUiState,
    onRoute: (ScoreboardRoute) -> Unit,
    onV1: (String, String) -> Unit,
    onOpenEvents: () -> Unit,
    onDismissEvents: () -> Unit,
    onChoose: (ScoreboardEventRow) -> Unit,
    modifier: Modifier = Modifier
) {
    var apiServer by remember { mutableStateOf(state.apiServer) }
    var eventId by remember { mutableStateOf(state.v1EventId) }
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 16.dp)
            .semantics { testTagsAsResourceId = true }
            .testTag("settings-scoreboard")
    ) {
        Column(modifier = Modifier.padding(bottom = 12.dp)) {
            Text(
                text = "SCOREBOARD",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(start = 20.dp, top = 16.dp, end = 20.dp)
            )
            Text(
                "Send radar speeds",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)
            )
            RouteRow(
                label = "GameStation V1",
                selected = state.route == ScoreboardRoute.V1,
                enabled = true,
                tag = "scoreboard-route-v1",
                onClick = { onRoute(ScoreboardRoute.V1) }
            )
            OutlinedTextField(
                value = apiServer,
                onValueChange = {
                    apiServer = it
                    onV1(it, eventId)
                },
                label = { Text("V1 server") },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 4.dp)
                    .testTag("scoreboard-v1-server")
            )
            OutlinedTextField(
                value = eventId,
                onValueChange = {
                    eventId = it
                    onV1(apiServer, it)
                },
                label = { Text("V1 event id") },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 4.dp)
                    .testTag("scoreboard-v1-event")
            )
            RouteRow(
                label = "GameStation event",
                selected = state.route == ScoreboardRoute.Event,
                enabled = state.signedIn,
                tag = "scoreboard-route-event",
                onClick = { onRoute(ScoreboardRoute.Event) }
            )
            TextButton(
                onClick = onOpenEvents,
                enabled = state.signedIn,
                modifier = Modifier
                    .padding(horizontal = 12.dp)
                    .testTag("scoreboard-choose-event")
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Text(if (state.gameTitle.isEmpty()) "Choose event" else state.gameTitle)
                    if (state.gameWhen.isNotEmpty()) {
                        Text(
                            state.gameWhen,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
            if (isRouteStatus(state.status)) {
                Text(
                    text = state.status,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .padding(horizontal = 20.dp, vertical = 4.dp)
                        .testTag("scoreboard-status")
                )
            }
        }
    }
    if (state.pickerOpen) {
        EventPicker(state, onDismissEvents, onChoose)
    }
}

@Composable
private fun RouteRow(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    tag: String,
    onClick: () -> Unit
) {
    val color = if (enabled) {
        MaterialTheme.colorScheme.onSurface
    } else {
        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 8.dp)
            .testTag(tag)
    ) {
        RadioButton(selected = selected, onClick = onClick, enabled = enabled)
        Text(label, color = color)
    }
}

@Composable
private fun EventPicker(
    state: ScoreboardUiState,
    onDismiss: () -> Unit,
    onChoose: (ScoreboardEventRow) -> Unit
) {
    Dialog(onDismissRequest = onDismiss) {
        Card(
            shape = RoundedCornerShape(24.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer)
        ) {
            Column(
                modifier = Modifier
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(8.dp)
            ) {
                Text(
                    "Events",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
                )
                if (state.pickerStatus.isNotEmpty()) {
                    Text(
                        state.pickerStatus,
                        modifier = Modifier
                            .padding(horizontal = 12.dp, vertical = 4.dp)
                            .testTag("scoreboard-events-status")
                    )
                }
                EventSection("Last 3 hours", "scoreboard-events-recent", state.recent, onChoose)
                EventSection("Next 5", "scoreboard-events-upcoming", state.upcoming, onChoose)
                TextButton(onClick = onDismiss, modifier = Modifier.testTag("scoreboard-events-close")) {
                    Text("Close")
                }
            }
        }
    }
}

@Composable
private fun EventSection(
    title: String,
    tag: String,
    rows: List<ScoreboardEventRow>,
    onChoose: (ScoreboardEventRow) -> Unit
) {
    Column(modifier = Modifier.testTag(tag)) {
        Text(
            title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp)
        )
        if (rows.isEmpty()) {
            Text(
                "None",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)
            )
        }
        rows.forEach { row ->
            TextButton(
                onClick = { onChoose(row) },
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("scoreboard-event-${row.gameId}")
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    Text(row.title)
                    Text(
                        row.whenLabel,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}
