package io.sublab.client.ui

import android.app.Application
import android.net.TrafficStats
import android.os.Process
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.sublab.client.SubLabApp
import io.sublab.client.core.CoreBridge
import io.sublab.client.core.Engine
import io.sublab.client.data.AppSettings
import io.sublab.client.data.ServerNode
import io.sublab.client.data.Subscription
import io.sublab.client.vpn.VpnController
import io.sublab.client.vpn.VpnState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Скорость и объём трафика текущего подключения. */
data class Traffic(
    val up: Long = 0,
    val down: Long = 0,
    val upSpeed: Long = 0,
    val downSpeed: Long = 0,
)

/** Результат пинга: null — ещё не мерили, -1 — сервер недоступен. */
typealias Pings = Map<String, Int>

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val repository = (application as SubLabApp).repository

    val subscriptions: StateFlow<List<Subscription>> = repository.subscriptions
    val settings: StateFlow<AppSettings> = repository.settings
    val vpnState: StateFlow<VpnState> = VpnController.state

    val selectedNode: StateFlow<ServerNode?> = combine(repository.subscriptions, repository.settings) { _, _ ->
        repository.selectedNode()
    }.stateIn(viewModelScope, SharingStarted.Eagerly, repository.selectedNode())

    private val _pings = MutableStateFlow<Pings>(emptyMap())
    val pings: StateFlow<Pings> = _pings.asStateFlow()

    private val _pinging = MutableStateFlow(false)
    val pinging: StateFlow<Boolean> = _pinging.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private val _traffic = MutableStateFlow(Traffic())
    val traffic: StateFlow<Traffic> = _traffic.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    private var trafficJob: Job? = null

    init {
        viewModelScope.launch {
            vpnState.collect { state ->
                when (state) {
                    is VpnState.Connected -> startTrafficPolling()
                    is VpnState.Failed -> {
                        stopTrafficPolling()
                        _messages.tryEmit(state.message)
                    }
                    else -> stopTrafficPolling()
                }
            }
        }
    }

    /** Нажатие на большую кнопку. [requestPermission] вызывается, если VPN ещё не разрешён. */
    fun toggle(needsPermission: Boolean, requestPermission: () -> Unit) {
        when (vpnState.value) {
            is VpnState.Connected, VpnState.Connecting -> VpnController.stop(getApplication())
            VpnState.Stopping -> Unit
            else -> {
                val node = repository.selectedNode()
                if (node == null) {
                    _messages.tryEmit("Сначала добавьте подписку")
                    return
                }
                if (!node.supports(settings.value.engine)) {
                    _messages.tryEmit("«${node.title}» не поддерживается ядром ${settings.value.engine.title}")
                    return
                }
                if (needsPermission) requestPermission() else VpnController.start(getApplication())
            }
        }
    }

    fun connectAfterPermission() = VpnController.start(getApplication())

    fun setEngine(engine: Engine) {
        if (engine == settings.value.engine) return
        repository.setEngine(engine)
        val node = repository.selectedNode()
        if (node != null && !node.supports(engine)) {
            _messages.tryEmit("«${node.title}» не работает на ${engine.title} — выберите другой сервер")
            if (VpnController.isActive) VpnController.stop(getApplication())
            return
        }
        restartIfActive()
    }

    fun select(node: ServerNode) {
        repository.selectNode(node)
        if (!node.supports(settings.value.engine)) {
            _messages.tryEmit("Этот сервер работает только на ${if (node.mihomo) "Mihomo" else "Xray"}")
            return
        }
        restartIfActive()
    }

    fun updateSettings(restart: Boolean = true, transform: (AppSettings) -> AppSettings) {
        repository.updateSettings(transform)
        if (restart) restartIfActive()
    }

    private fun restartIfActive() {
        if (vpnState.value is VpnState.Connected) VpnController.restart(getApplication())
    }

    fun addSubscription(input: String, name: String?, onDone: () -> Unit) {
        viewModelScope.launch {
            _refreshing.value = true
            runCatching { repository.addSubscription(input, name) }
                .onSuccess {
                    _messages.tryEmit("Добавлено серверов: ${it.nodes.size}")
                    onDone()
                    pingAll()
                }
                .onFailure { _messages.tryEmit(it.message ?: "Не удалось добавить подписку") }
            _refreshing.value = false
        }
    }

    fun refreshAll() {
        if (_refreshing.value) return
        viewModelScope.launch {
            _refreshing.value = true
            repository.refreshAll()
            _refreshing.value = false
            subscriptions.value.firstOrNull { it.error != null }?.let {
                _messages.tryEmit("${it.name}: ${it.error}")
            }
        }
    }

    fun refresh(subscription: Subscription) {
        viewModelScope.launch {
            _refreshing.value = true
            repository.refresh(subscription.id)
                .onSuccess { _messages.tryEmit("${it.name}: обновлено") }
                .onFailure { _messages.tryEmit(it.message ?: "Ошибка обновления") }
            _refreshing.value = false
        }
    }

    fun rename(subscription: Subscription, name: String) = repository.rename(subscription.id, name)

    fun delete(subscription: Subscription) = repository.delete(subscription.id)

    @OptIn(ExperimentalCoroutinesApi::class)
    fun pingAll() {
        if (_pinging.value) return
        val nodes = repository.allNodes
        if (nodes.isEmpty()) return
        viewModelScope.launch {
            _pinging.value = true
            _pings.value = emptyMap()
            val limited = Dispatchers.IO.limitedParallelism(8)
            nodes.map { node ->
                launch(limited) {
                    val ms = CoreBridge.tcpPing(node.server, node.port)
                    _pings.update { it + (node.id to ms) }
                }
            }.forEach { it.join() }
            _pinging.value = false
        }
    }

    /** Выбирает сервер с наименьшим пингом среди поддерживаемых текущим ядром. */
    fun selectFastest() {
        val engine = settings.value.engine
        val best = repository.allNodes
            .filter { it.supports(engine) }
            .mapNotNull { node -> _pings.value[node.id]?.takeIf { it > 0 }?.let { node to it } }
            .minByOrNull { it.second }
            ?.first
        if (best == null) {
            _messages.tryEmit("Сначала проверьте пинг")
            return
        }
        select(best)
    }

    suspend fun configPreview(): String = withContext(Dispatchers.IO) {
        val node = repository.selectedNode() ?: return@withContext "Сервер не выбран"
        runCatching {
            CoreBridge.buildConfig(settings.value.engine, node.json, settings.value.coreOptions(1500))
        }.getOrElse { it.message ?: it.toString() }
    }

    suspend fun logs(): String = withContext(Dispatchers.IO) {
        CoreBridge.logs().ifBlank { "Журнал пуст. Он появляется, пока ядро запущено." }
    }

    val versions: String by lazy {
        runCatching { "Xray ${CoreBridge.xrayVersion()} · Mihomo ${CoreBridge.mihomoVersion()}" }.getOrDefault("")
    }

    /**
     * Трафик считается по UID приложения: сам клиент исключён из туннеля, поэтому
     * всё, что он отправляет и получает, — это соединения ядра с сервером. Так
     * статистика одинакова для обоих ядер.
     */
    private fun startTrafficPolling() {
        if (trafficJob?.isActive == true) return
        trafficJob = viewModelScope.launch(Dispatchers.IO) {
            val uid = Process.myUid()
            val baseUp = TrafficStats.getUidTxBytes(uid)
            val baseDown = TrafficStats.getUidRxBytes(uid)
            if (baseUp == TrafficStats.UNSUPPORTED.toLong() || baseDown == TrafficStats.UNSUPPORTED.toLong()) return@launch
            var lastUp = 0L
            var lastDown = 0L
            while (isActive) {
                delay(1000)
                val up = TrafficStats.getUidTxBytes(uid) - baseUp
                val down = TrafficStats.getUidRxBytes(uid) - baseDown
                _traffic.value = Traffic(
                    up = up,
                    down = down,
                    upSpeed = (up - lastUp).coerceAtLeast(0),
                    downSpeed = (down - lastDown).coerceAtLeast(0),
                )
                lastUp = up
                lastDown = down
            }
        }
    }

    private fun stopTrafficPolling() {
        trafficJob?.cancel()
        trafficJob = null
        _traffic.value = Traffic()
    }
}
