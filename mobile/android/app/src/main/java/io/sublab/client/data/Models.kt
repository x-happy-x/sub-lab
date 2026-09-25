package io.sublab.client.data

import io.sublab.client.core.Engine
import org.json.JSONArray
import org.json.JSONObject

/** Сервер из подписки. [json] — узел в формате libcore, его и получает ядро. */
data class ServerNode(
    val id: String,
    val subscriptionId: String,
    val name: String,
    val type: String,
    val server: String,
    val port: Int,
    val xray: Boolean,
    val mihomo: Boolean,
    val json: String,
) {
    fun supports(engine: Engine) = when (engine) {
        Engine.XRAY -> xray
        Engine.MIHOMO -> mihomo
    }

    /** Флаг из начала названия («🇩🇪 Германия») или null. */
    val flag: String? get() = leadingFlag(name)

    /** Название без флага в начале. */
    val title: String get() = flag?.let { name.removePrefix(it).trim() }?.ifEmpty { name } ?: name

    companion object {
        fun fromLibcore(subscriptionId: String, item: JSONObject): ServerNode {
            val name = item.optString("name")
            return ServerNode(
                id = "$subscriptionId/$name",
                subscriptionId = subscriptionId,
                name = name,
                type = item.optString("type"),
                server = item.optString("server"),
                port = item.optInt("port"),
                xray = item.has("xray"),
                mihomo = item.has("clash"),
                json = item.toString(),
            )
        }

        fun listFromLibcore(subscriptionId: String, json: String): List<ServerNode> {
            val array = JSONArray(json)
            return List(array.length()) { fromLibcore(subscriptionId, array.getJSONObject(it)) }
        }
    }
}

data class Subscription(
    val id: String,
    val name: String,
    /** Ссылка подписки или пусто, если серверы вставлены вручную. */
    val url: String,
    val updatedAt: Long = 0,
    val upload: Long = 0,
    val download: Long = 0,
    val total: Long = 0,
    /** Окончание подписки, секунды Unix; 0 — бессрочно. */
    val expire: Long = 0,
    val nodes: List<ServerNode> = emptyList(),
    val error: String? = null,
) {
    val used: Long get() = upload + download

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("url", url)
        put("updatedAt", updatedAt)
        put("upload", upload)
        put("download", download)
        put("total", total)
        put("expire", expire)
        error?.let { put("error", it) }
        put("nodes", JSONArray().apply { nodes.forEach { put(JSONObject(it.json)) } })
    }

    companion object {
        fun fromJson(json: JSONObject): Subscription {
            val id = json.getString("id")
            val nodes = json.optJSONArray("nodes") ?: JSONArray()
            return Subscription(
                id = id,
                name = json.optString("name"),
                url = json.optString("url"),
                updatedAt = json.optLong("updatedAt"),
                upload = json.optLong("upload"),
                download = json.optLong("download"),
                total = json.optLong("total"),
                expire = json.optLong("expire"),
                nodes = List(nodes.length()) { ServerNode.fromLibcore(id, nodes.getJSONObject(it)) },
                error = json.optString("error").ifEmpty { null },
            )
        }
    }
}

data class AppSettings(
    val engine: Engine = Engine.XRAY,
    val selectedNodeId: String? = null,
    val dns: String = "1.1.1.1",
    val bypassLan: Boolean = true,
    val directRu: Boolean = false,
    val ipv6: Boolean = false,
    val userAgent: String = DEFAULT_USER_AGENT,
    val logLevel: String = "warning",
) {
    /** Настройки в формате libcore Options. */
    fun coreOptions(mtu: Int): String = JSONObject().apply {
        put("dns", dns)
        put("mtu", mtu)
        put("bypassLan", bypassLan)
        put("directRu", directRu)
        put("ipv6", ipv6)
        put("logLevel", logLevel)
    }.toString()

    companion object {
        /** С этим UA панели отдают обычный список ссылок, который понимают оба ядра. */
        const val DEFAULT_USER_AGENT = "v2rayNG/1.10.5"
    }
}

/** Региональные индикаторы (флаги) — пары символов из диапазона U+1F1E6..U+1F1FF. */
fun leadingFlag(text: String): String? {
    val trimmed = text.trimStart()
    if (trimmed.length < 4) return null
    val first = trimmed.codePointAt(0)
    val second = trimmed.codePointAt(Character.charCount(first))
    val range = 0x1F1E6..0x1F1FF
    if (first !in range || second !in range) return null
    return String(Character.toChars(first)) + String(Character.toChars(second))
}
