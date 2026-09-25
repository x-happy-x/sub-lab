package io.sublab.client.data

import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder

/** Ответ сервера подписки вместе с метаданными из заголовков. */
data class FetchedSubscription(
    val body: String,
    val title: String?,
    val upload: Long,
    val download: Long,
    val total: Long,
    val expire: Long,
)

object SubscriptionFetcher {
    fun fetch(url: String, userAgent: String): FetchedSubscription {
        var target = URL(url)
        // HttpURLConnection не переходит между http и https сам — делаем это вручную.
        repeat(5) {
            val connection = (target.openConnection() as HttpURLConnection).apply {
                connectTimeout = 15_000
                readTimeout = 20_000
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", userAgent)
                setRequestProperty("Accept", "*/*")
            }
            try {
                val code = connection.responseCode
                if (code in 300..399) {
                    val location = connection.getHeaderField("Location")
                        ?: throw IllegalStateException("Редирект без адреса")
                    target = URL(target, location)
                    return@repeat
                }
                if (code !in 200..299) {
                    throw IllegalStateException("Сервер подписки ответил $code")
                }
                val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                val info = parseUserInfo(connection.getHeaderField("subscription-userinfo"))
                return FetchedSubscription(
                    body = body,
                    title = decodeTitle(connection.getHeaderField("profile-title"))
                        ?: fileName(connection.getHeaderField("content-disposition")),
                    upload = info["upload"] ?: 0,
                    download = info["download"] ?: 0,
                    total = info["total"] ?: 0,
                    expire = info["expire"] ?: 0,
                )
            } finally {
                connection.disconnect()
            }
        }
        throw IllegalStateException("Слишком много редиректов")
    }

    /** `upload=1; download=2; total=3; expire=4` → карта чисел. */
    fun parseUserInfo(header: String?): Map<String, Long> {
        if (header.isNullOrBlank()) return emptyMap()
        return header.split(';').mapNotNull { part ->
            val pieces = part.split('=', limit = 2)
            if (pieces.size != 2) return@mapNotNull null
            val value = pieces[1].trim().toDoubleOrNull()?.toLong() ?: return@mapNotNull null
            pieces[0].trim().lowercase() to value
        }.toMap()
    }

    private fun decodeTitle(header: String?): String? {
        if (header.isNullOrBlank()) return null
        if (header.startsWith("base64:")) {
            return runCatching {
                String(Base64.decode(header.removePrefix("base64:"), Base64.DEFAULT), Charsets.UTF_8)
            }.getOrNull()?.trim()?.ifEmpty { null }
        }
        return header.trim()
    }

    private fun fileName(header: String?): String? {
        if (header.isNullOrBlank()) return null
        val encoded = Regex("filename\\*=(?:UTF-8'')?([^;]+)", RegexOption.IGNORE_CASE).find(header)
        if (encoded != null) {
            return runCatching { URLDecoder.decode(encoded.groupValues[1].trim('"'), "UTF-8") }.getOrNull()
        }
        return Regex("filename=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(header)?.groupValues?.get(1)
    }
}
