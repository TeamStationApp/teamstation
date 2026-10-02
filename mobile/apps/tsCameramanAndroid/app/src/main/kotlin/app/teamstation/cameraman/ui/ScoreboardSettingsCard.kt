package app.teamstation.cameraman.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.teamstation.cameraman.radar.ScoreboardRoute
import app.teamstation.cameraman.scoreboard.ScoreboardEventRow
import app.teamstation.cameraman.scoreboard.ScoreboardUiState

/**
 * Where radar speeds go: the V1 autoState socket, or one signed-in event.
 *
 * Both radios are always on screen. The event radio and Choose event stay gray until an account
 * is signed in. V1 stays usable either way.
 */
/** Sign-in, alone, above every other card. The account server is the build's. */
@Composable
internal fun TeamStationLoginCard(
    state: ScoreboardUiState,
    onSendCode: (String) -> Unit,
    onVerify: (String, String) -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier
) {
    var flow by remember { mutableStateOf(LoginFlow()) }
    var open by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(state.awaitingCode) {
        if (state.awaitingCode && flow.step == LoginFlow.Step.Email) flow = flow.codeSent()
    }
    LaunchedEffect(state.signedIn) {
        if (state.signedIn) open = false
    }
    LaunchedEffect(open, flow.step) {
        if (open) {
            focus.requestFocus()
            keyboard?.show()
        }
    }
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = 16.dp)
            .semantics { testTagsAsResourceId = true }
            .testTag("settings-teamstation")
    ) {
        Column(
            modifier = Modifier
                .clickable { flow = flow.tapElsewhere() }
                .padding(bottom = 12.dp)
        ) {
            Text(
                text = if (state.signedIn) "TEAMSTATION ACCOUNT" else "LOG IN TO TEAMSTATION",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(start = 20.dp, top = 16.dp, end = 20.dp)
            )
            if (LoginFlow.showsDevelopmentHost(state.accountHost)) {
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
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 8.dp)
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = LoginFlow.loggedInLine(state.accountLabel),
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier
                                .weight(1f)
                                .clickable { flow = flow.tapElsewhere() }
                                .testTag("scoreboard-account")
                        )
                        if (!flow.logoutArmed) {
                            TextButton(
                                onClick = { flow = flow.armLogout().tapElsewhere() },
                                modifier = Modifier.testTag("scoreboard-sign-out")
                            ) {
                                Text("Logout", color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                    if (flow.logoutArmed) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 8.dp),
                            contentAlignment = Alignment.CenterEnd
                        ) {
                            SlideToStop(
                                animate = true,
                                onStop = {
                                    val (next, confirm) = flow.slide(1.0)
                                    flow = next
                                    if (confirm) onSignOut()
                                },
                                label = "Slide to log out",
                                trackTag = "teamstation-slide-logout"
                            )
                        }
                    }
                }
            } else {
                TextButton(
                    onClick = {
                        flow = flow.cancel()
                        open = true
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp)
                        .testTag("scoreboard-login-row")
                ) {
                    Text(
                        "Tap to Login",
                        modifier = Modifier.fillMaxWidth(),
                        textAlign = TextAlign.Start
                    )
                }
            }
            if (state.status.isNotEmpty() && !isRouteStatus(state.status) && !open) {
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
    if (open && !state.signedIn) {
        LoginDialog(
            flow = flow,
            status = state.status,
            focus = focus,
            onFlow = { flow = it },
            onSendCode = onSendCode,
            onVerify = onVerify,
            onCancel = {
                flow = flow.cancel()
                open = false
            }
        )
    }
}

@Composable
private fun LoginDialog(
    flow: LoginFlow,
    status: String,
    focus: FocusRequester,
    onFlow: (LoginFlow) -> Unit,
    onSendCode: (String) -> Unit,
    onVerify: (String, String) -> Unit,
    onCancel: () -> Unit
) {
    val width = LocalConfiguration.current.screenWidthDp.dp
    Dialog(
        onDismissRequest = onCancel,
        properties = DialogProperties(usePlatformDefaultWidth = false)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.92f))
                .semantics { testTagsAsResourceId = true },
            contentAlignment = Alignment.Center
        ) {
            TextButton(
                onClick = onCancel,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .testTag("teamstation-cancel")
            ) {
                Text("Cancel", color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.SemiBold)
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = "TeamStation",
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.testTag("teamstation-logo")
                )
                val notice = if (flow.fieldIsCode) {
                    if (status.contains("wrong") || status.contains("expired")) {
                        LoginFlow.BAD_CODE
                    } else {
                        flow.notice ?: LoginFlow.CHECK_EMAIL
                    }
                } else if (status.isNotEmpty() && !isRouteStatus(status)) {
                    status
                } else {
                    null
                }
                if (notice != null) {
                    Text(
                        text = notice,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 12.dp)
                    )
                }
                OutlinedTextField(
                    value = if (flow.fieldIsCode) flow.code else flow.email,
                    onValueChange = { raw ->
                        if (flow.fieldIsCode) {
                            val (next, submit) = flow.replaceCode(raw)
                            onFlow(next)
                            if (submit) onVerify(next.email, next.code)
                        } else {
                            onFlow(flow.copy(email = raw))
                        }
                    },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(textAlign = TextAlign.Center),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = if (flow.fieldIsCode) KeyboardType.Number else KeyboardType.Email
                    ),
                    modifier = Modifier
                        .padding(top = 16.dp)
                        .width(width / 2)
                        .focusRequester(focus)
                        .testTag(if (flow.fieldIsCode) "scoreboard-code" else "scoreboard-email")
                )
                Button(
                    onClick = {
                        if (flow.fieldIsCode) {
                            if (flow.code.length == LoginFlow.CODE_LENGTH) {
                                onVerify(flow.email, flow.code)
                            }
                        } else {
                            onSendCode(flow.email)
                        }
                    },
                    enabled = !flow.fieldIsCode || flow.code.length == LoginFlow.CODE_LENGTH,
                    shape = RoundedCornerShape(percent = 50),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary
                    ),
                    modifier = Modifier
                        .padding(top = 16.dp)
                        .wrapContentWidth()
                        .testTag(if (flow.fieldIsCode) "scoreboard-verify" else "scoreboard-send-code")
                ) {
                    Text(flow.buttonLabel, fontWeight = FontWeight.SemiBold)
                }
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
                label = "TeamStation V1",
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
                label = "TeamStation event",
                selected = state.route == ScoreboardRoute.Event,
                enabled = state.signedIn,
                tag = "scoreboard-route-event",
                onClick = { onRoute(ScoreboardRoute.Event) }
            )
            Text(
                "TeamStation Event",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp)
            )
            Text(
                "Pick event for radar data",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp)
            )
            TextButton(
                onClick = onOpenEvents,
                enabled = state.signedIn,
                modifier = Modifier
                    .padding(horizontal = 12.dp)
                    .testTag("scoreboard-choose-event")
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    if (state.gameWhen.isNotEmpty()) {
                        Text(
                            state.gameWhen,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Text(if (state.gameTitle.isEmpty()) "Tap to pick an event" else state.gameTitle)
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
                EventSection("Events", "scoreboard-events-upcoming", state.upcoming, onChoose)
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
                    Text(
                        row.whenLabel,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(row.title)
                }
            }
        }
    }
}
