package io.sublab.client.data

import android.content.Context
import io.sublab.client.core.CoreBridge
import io.sublab.client.core.Engine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.File
import java.util.UUID

/**
 * Подписки и настройки. Подписки лежат JSON-файлом, настройки — в SharedPreferences;
 * наружу всё отдаётся через StateFlow, чтобы экран и VPN-сервис видели одно и то же.
 */
class Repository(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val file = File(context.filesDir, "subscriptions.json")

    private val _subscriptions = MutableStateFlow(loadSubscriptions())
    val subscriptions: StateFlow<List<Subscription>> = _subscriptions.asStateFlow()

    private val _settings = MutableStateFlow(loadSettings())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    val allNodes: List<ServerNode> get() = _subscriptions.value.flatMap { it.nodes }

    fun selectedNode(): ServerNode? {
        val nodes = allNodes
        val selectedId = _settings.value.selectedNodeId
        return nodes.firstOrNull { it.id == selectedId } ?: nodes.firstOrNull()
    }

    fun updateSettings(transform: (AppSettings) -> AppSettings) {
        _settings.update(transform)
        saveSettings(_settings.value)
    }

    fun selectNode(node: ServerNode) = updateSettings { it.copy(selectedNodeId = node.id) }

    fun setEngine(engine: Engine) = updateSettings { it.copy(engine = engine) }

    /** Добавляет подписку по ссылке или вставленные вручную ссылки серверов. */
    suspend fun addSubscription(input: String, name: String?): Subscription = withContext(Dispatchers.IO) {
        val text = input.trim()
        val id = UUID.randomUUID().toString()
        val subscription = if (text.startsWith("http://") || text.startsWith("https://")) {
            download(Subscription(id = id, name = name.orEmpty(), url = text))
        } else {
            val nodes = ServerNode.listFromLibcore(id, CoreBridge.parseSubscription(text))
            Subscription(
                id = id,
                name = name?.ifBlank { null } ?: "Свои серверы",
                url = "",
                updatedAt = System.currentTimeMillis(),
                nodes = nodes,
            )
        }
        _subscriptions.update { it + subscription }
        persist()
        if (_settings.value.selectedNodeId == null) {
            subscription.nodes.firstOrNull()?.let { selectNode(it) }
        }
        subscription
    }

    /** Обновляет подписку; при ошибке оставляет прежние серверы и запоминает текст ошибки. */
    suspend fun refresh(subscriptionId: String): Result<Subscription> = withContext(Dispatchers.IO) {
        val current = _subscriptions.value.firstOrNull { it.id == subscriptionId }
            ?: return@withContext Result.failure(IllegalArgumentException("Подписка не найдена"))
        if (current.url.isEmpty()) return@withContext Result.success(current)
        val result = runCatching { download(current) }
        val updated = result.getOrElse { current.copy(error = it.message ?: it.toString()) }
        _subscriptions.update { list -> list.map { if (it.id == subscriptionId) updated else it } }
        persist()
        result
    }

    suspend fun refreshAll() {
        _subscriptions.value.filter { it.url.isNotEmpty() }.forEach { refresh(it.id) }
    }

    fun rename(subscriptionId: String, name: String) {
        _subscriptions.update { list -> list.map { if (it.id == subscriptionId) it.copy(name = name) else it } }
        persist()
    }

    fun delete(subscriptionId: String) {
        _subscriptions.update { list -> list.filterNot { it.id == subscriptionId } }
        persist()
        if (_settings.value.selectedNodeId?.startsWith("$subscriptionId/") == true) {
            updateSettings { it.copy(selectedNodeId = allNodes.firstOrNull()?.id) }
        }
    }

    private fun download(base: Subscription): Subscription {
        val fetched = SubscriptionFetcher.fetch(base.url, _settings.value.userAgent)
        val nodes = ServerNode.listFromLibcore(base.id, CoreBridge.parseSubscription(fetched.body))
        return base.copy(
            name = base.name.ifBlank { fetched.title ?: hostOf(base.url) },
            updatedAt = System.currentTimeMillis(),
            upload = fetched.upload,
            download = fetched.download,
            total = fetched.total,
            expire = fetched.expire,
            nodes = nodes,
            error = null,
        )
    }

    private fun hostOf(url: String): String =
        runCatching { java.net.URL(url).host }.getOrNull()?.ifEmpty { null } ?: "Подписка"

    private fun loadSubscriptions(): List<Subscription> = runCatching {
        if (!file.exists()) return emptyList()
        val array = JSONArray(file.readText())
        List(array.length()) { Subscription.fromJson(array.getJSONObject(it)) }
    }.getOrDefault(emptyList())

    @Synchronized
    private fun persist() {
        val array = JSONArray().apply { _subscriptions.value.forEach { put(it.toJson()) } }
        val temp = File(file.parentFile, "${file.name}.tmp")
        temp.writeText(array.toString())
        temp.renameTo(file)
    }

    private fun loadSettings(): AppSettings {
        val defaults = AppSettings()
        return AppSettings(
            engine = Engine.of(prefs.getString("engine", defaults.engine.id)),
            selectedNodeId = prefs.getString("selectedNodeId", null),
            dns = prefs.getString("dns", defaults.dns) ?: defaults.dns,
            bypassLan = prefs.getBoolean("bypassLan", defaults.bypassLan),
            directRu = prefs.getBoolean("directRu", defaults.directRu),
            ipv6 = prefs.getBoolean("ipv6", defaults.ipv6),
            userAgent = prefs.getString("userAgent", defaults.userAgent) ?: defaults.userAgent,
            logLevel = prefs.getString("logLevel", defaults.logLevel) ?: defaults.logLevel,
        )
    }

    private fun saveSettings(settings: AppSettings) {
        prefs.edit()
            .putString("engine", settings.engine.id)
            .putString("selectedNodeId", settings.selectedNodeId)
            .putString("dns", settings.dns)
            .putBoolean("bypassLan", settings.bypassLan)
            .putBoolean("directRu", settings.directRu)
            .putBoolean("ipv6", settings.ipv6)
            .putString("userAgent", settings.userAgent)
            .putString("logLevel", settings.logLevel)
            .apply()
    }
}
