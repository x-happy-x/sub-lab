package io.sublab.client

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sublab.client.ui.MainViewModel
import io.sublab.client.ui.screens.AddSubscriptionSheet
import io.sublab.client.ui.screens.HomeScreen
import io.sublab.client.ui.screens.ServersScreen
import io.sublab.client.ui.screens.SettingsScreen
import io.sublab.client.ui.theme.Palette
import io.sublab.client.ui.theme.SubLabTheme
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    /** Ссылка из sublab://import?url=… — открывает окно добавления с подставленным адресом. */
    private val pendingImport = MutableStateFlow<String?>(null)

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) viewModel.connectAfterPermission()
    }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        askNotificationPermission()
        handleIntent(intent)

        setContent {
            SubLabTheme {
                App(
                    viewModel = viewModel,
                    pendingImport = pendingImport.collectAsStateWithLifecycle().value,
                    onImportConsumed = { pendingImport.value = null },
                    onToggle = ::toggleVpn,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        if (intent.getBooleanExtra(EXTRA_CONNECT, false)) {
            intent.removeExtra(EXTRA_CONNECT)
            toggleVpn()
        }
        val data: Uri = intent.data ?: return
        if (data.scheme == "sublab" && data.host == "import") {
            pendingImport.value = data.getQueryParameter("url")
        }
    }

    private fun toggleVpn() {
        val prepare = VpnService.prepare(this)
        viewModel.toggle(needsPermission = prepare != null) { prepare?.let { vpnPermission.launch(it) } }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    companion object {
        const val EXTRA_CONNECT = "connect"
    }
}

private enum class Tab(val title: String, val icon: ImageVector) {
    HOME("Главная", Icons.Rounded.Home),
    SERVERS("Серверы", Icons.Rounded.Dns),
    SETTINGS("Настройки", Icons.Rounded.Settings),
}

@Composable
private fun App(
    viewModel: MainViewModel,
    pendingImport: String?,
    onImportConsumed: () -> Unit,
    onToggle: () -> Unit,
) {
    val subscriptions by viewModel.subscriptions.collectAsStateWithLifecycle()
    val settings by viewModel.settings.collectAsStateWithLifecycle()
    val state by viewModel.vpnState.collectAsStateWithLifecycle()
    val node by viewModel.selectedNode.collectAsStateWithLifecycle()
    val pings by viewModel.pings.collectAsStateWithLifecycle()
    val pinging by viewModel.pinging.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val traffic by viewModel.traffic.collectAsStateWithLifecycle()

    var tab by rememberSaveable { mutableStateOf(Tab.HOME) }
    var adding by rememberSaveable { mutableStateOf(false) }
    var addUrl by rememberSaveable { mutableStateOf("") }
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        viewModel.messages.collect { snackbar.showSnackbar(it) }
    }
    LaunchedEffect(pendingImport) {
        if (pendingImport != null) {
            addUrl = pendingImport
            adding = true
            onImportConsumed()
        }
    }
    // Пинги при первом открытии, чтобы в списке сразу было видно живые серверы.
    LaunchedEffect(subscriptions.isNotEmpty()) {
        if (subscriptions.isNotEmpty() && pings.isEmpty()) viewModel.pingAll()
    }

    Scaffold(
        containerColor = Palette.Background,
        snackbarHost = {
            SnackbarHost(snackbar) {
                Snackbar(it, containerColor = Palette.SurfaceHighest, contentColor = Palette.TextPrimary, shape = RoundedCornerShape(14.dp))
            }
        },
        bottomBar = { BottomBar(tab) { tab = it } },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .background(Palette.Background)
                .statusBarsPadding()
                .padding(bottom = padding.calculateBottomPadding()),
        ) {
            Crossfade(targetState = tab, label = "tab") { current ->
                when (current) {
                    Tab.HOME -> HomeScreen(
                        state = state,
                        engine = settings.engine,
                        node = node,
                        ping = node?.let { pings[it.id] },
                        subscription = subscriptions.firstOrNull { it.id == node?.subscriptionId },
                        traffic = traffic,
                        onToggle = onToggle,
                        onEngine = viewModel::setEngine,
                        onOpenServers = { tab = Tab.SERVERS },
                        onAddSubscription = { adding = true },
                    )
                    Tab.SERVERS -> ServersScreen(
                        subscriptions = subscriptions,
                        selectedId = node?.id,
                        engine = settings.engine,
                        pings = pings,
                        pinging = pinging,
                        refreshing = refreshing,
                        onSelect = viewModel::select,
                        onPingAll = viewModel::pingAll,
                        onFastest = viewModel::selectFastest,
                        onRefreshAll = viewModel::refreshAll,
                        onRefresh = viewModel::refresh,
                        onRename = viewModel::rename,
                        onDelete = viewModel::delete,
                        onAdd = { adding = true },
                    )
                    Tab.SETTINGS -> SettingsScreen(
                        settings = settings,
                        versions = viewModel.versions,
                        onEngine = viewModel::setEngine,
                        onUpdate = { restart, transform -> viewModel.updateSettings(restart, transform) },
                        loadLogs = viewModel::logs,
                        loadConfig = viewModel::configPreview,
                    )
                }
            }
        }
    }

    if (adding) {
        AddSubscriptionSheet(
            initialUrl = addUrl,
            busy = refreshing,
            onDismiss = {
                adding = false
                addUrl = ""
            },
            onSubmit = { input, name ->
                viewModel.addSubscription(input, name) {
                    adding = false
                    addUrl = ""
                    tab = Tab.SERVERS
                }
            },
        )
    }
}

@Composable
private fun BottomBar(selected: Tab, onSelect: (Tab) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Palette.Background)
            .navigationBarsPadding(),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp)
                .clip(RoundedCornerShape(22.dp))
                .background(Palette.Surface)
                .border(1.dp, Palette.Stroke, RoundedCornerShape(22.dp))
                .padding(6.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Tab.entries.forEach { tab ->
                val active = tab == selected
                Row(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(16.dp))
                        .background(if (active) Palette.SurfaceHighest else Color.Transparent)
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onSelect(tab) }
                        .padding(vertical = 10.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        tab.icon,
                        contentDescription = tab.title,
                        tint = if (active) Palette.VioletSoft else Palette.TextMuted,
                        modifier = Modifier.size(20.dp),
                    )
                    if (active) {
                        Spacer(Modifier.size(8.dp))
                        Text(tab.title, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = Palette.TextPrimary)
                    }
                }
            }
        }
        Spacer(Modifier.height(2.dp))
    }
}
