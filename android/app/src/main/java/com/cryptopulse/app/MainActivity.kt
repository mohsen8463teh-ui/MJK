package com.cryptopulse.app

import android.Manifest
import android.app.Activity
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.media.MediaPlayer
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.speech.tts.TextToSpeech
import java.util.Locale
import android.content.pm.PackageManager
import android.webkit.WebResourceRequest
import java.net.HttpURLConnection
import java.net.URL
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager

class MainActivity : Activity() {
    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("mjk", MODE_PRIVATE) }
    private var musicPlayer: MediaPlayer? = null
    private var welcomeTts: TextToSpeech? = null
    private var welcomeFinished = false
    private var musicIndex = 0
    private val musicTracks = intArrayOf(
        R.raw.shab_aramesh, R.raw.ney_bahar, R.raw.setar_roya, R.raw.santour_mahtab,
        R.raw.baran_narenj, R.raw.daryaye_sokoot, R.raw.kavir_shab, R.raw.tehran_bedtime
    )
    private val musicNames = arrayOf(
        "شب آرامش", "نی بهار", "سه‌تار رویا", "سنتور مهتاب",
        "باران نارنج", "دریای سکوت", "کویر شب", "تهران خواب"
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationPermission()
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.settings.allowContentAccess = true
        // The UI is loaded from file://; allow it to call HTTPS public market-data APIs.
        web.settings.allowUniversalAccessFromFileURLs = true
        web.settings.allowFileAccessFromFileURLs = true
        web.settings.setSupportZoom(false)
        web.webViewClient = WebViewClient()
        web.addJavascriptInterface(MjkBridge(), "MJKNative")
        setContentView(web)
        // TSETMC legacy market-watch endpoints are HTTP-only; allow this specific data path.
        // The app does not send credentials over these endpoints.
        web.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        web.loadUrl("file:///android_asset/www/index.html")
        scheduleBackgroundCheck()
        startWelcomeVoice()
    }
    inner class MjkBridge {
        private fun request(url: String, method: String = "GET", body: String? = null, contentType: String? = null): String {
            val u = URL(url)
            require(u.protocol == "https" || u.protocol == "http") { "Unsupported protocol" }
            val c = (u.openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15000
                readTimeout = 15000
                useCaches = false
                setRequestProperty("Accept", "application/json, text/plain, text/html, */*")
                setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 12; SM-A315F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")
                setRequestProperty("Referer", if (u.host.contains("tsetmc.com")) "https://www.tsetmc.com/" else "https://www.tse.ir/")
                setRequestProperty("Origin", if (u.host.contains("tsetmc.com")) "https://www.tsetmc.com" else "https://www.tse.ir")
                setRequestProperty("Accept-Language", "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7")
                setRequestProperty("Cache-Control", "no-cache")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", contentType ?: "application/json")
                }
            }
            return try {
                if (body != null) c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = c.responseCode
                if (code !in 200..299) throw Exception("HTTP $code from ${u.host}")
                BufferedReader(InputStreamReader(c.inputStream, Charsets.UTF_8)).use { it.readText() }
            } finally { c.disconnect() }
        }
        @JavascriptInterface
        fun fetchJson(url: String): String = try { request(url) } catch (e: Exception) { "MJK_NATIVE_ERROR:" + (e.message ?: "network error") }
        @JavascriptInterface
        fun fetchText(url: String): String = try { request(url) } catch (e: Exception) { "MJK_NATIVE_ERROR:" + (e.message ?: "network error") }
        @JavascriptInterface
        fun fetchJsonPost(url: String, body: String): String = try { request(url, "POST", body, "application/json") } catch (e: Exception) { "MJK_NATIVE_ERROR:" + (e.message ?: "network error") }

        @JavascriptInterface fun signalIssued(json:String) {
            try {
                val o = org.json.JSONObject(json)
                val symbol = o.optString("symbol")
                val id = o.optString("id")
                prefs.edit().putString("active_trade_$symbol", json).putString("last_signal_id_$symbol", id).putString("pending_signal_json", json).apply()
                postSignalNotification(o)
            } catch (_: Exception) { }
        }

        private fun postSignalNotification(o: org.json.JSONObject) {
            if (!prefs.getBoolean("notify_enabled", true)) return
            if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestNotificationPermission()
                return
            }
            val nm = getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            val channel = "mjk_signal"
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(android.app.NotificationChannel(channel, "MJK Signals", android.app.NotificationManager.IMPORTANCE_HIGH))
            }
            val symbol = o.optString("symbol", "MJK")
            val id = o.optString("id", System.currentTimeMillis().toString())
            val entry = o.optDouble("entry_price", Double.NaN)
            val sl = o.optDouble("stop_loss", Double.NaN)
            val tp = o.optDouble("take_profit_1", Double.NaN)
            val details = if (entry.isFinite() && sl.isFinite() && tp.isFinite()) {
                "Entry ${fmtNotification(entry)} | SL ${fmtNotification(sl)} | TP ${fmtNotification(tp)}"
            } else "سیگنال BUY جدید شناسایی شد"
            val n = androidx.core.app.NotificationCompat.Builder(this@MainActivity, channel)
                .setSmallIcon(R.drawable.mjk_notification)
                .setContentTitle("MJK · سیگنال BUY")
                .setContentText("$symbol · $details")
                .setStyle(androidx.core.app.NotificationCompat.BigTextStyle().bigText("$symbol · $details"))
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                .setCategory(androidx.core.app.NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .build()
            nm.notify(("signal:" + symbol + ":" + id).hashCode(), n)
            prefs.edit().remove("pending_signal_json").apply()
        }

        @JavascriptInterface fun setNotificationsEnabled(enabled:Boolean) {
            prefs.edit().putBoolean("notify_enabled", enabled).apply()
        }

        @JavascriptInterface fun testNotification(): Boolean {
            if (!prefs.getBoolean("notify_enabled", true)) return false
            val o = org.json.JSONObject().put("symbol", "MJK").put("id", "test-${System.currentTimeMillis()}")
                .put("entry_price", 0.0).put("stop_loss", 0.0).put("take_profit_1", 0.0)
            postSignalNotification(o)
            return true
        }

        private fun fmtNotification(v: Double): String =
            String.format(java.util.Locale.US, "%.6f", v)
        @JavascriptInterface fun tradeClosed(json:String) {
            try {
                val o = org.json.JSONObject(json)
                val symbol = o.optString("symbol")
                prefs.edit().remove("active_trade_$symbol").putString("last_closed", json).apply()
            } catch (_: Exception) { }
        }

        @JavascriptInterface fun setRadarRelay(url: String) { prefs.edit().putString("radar_relay_url", url.trim().trimEnd('/')).apply() }

        @JavascriptInterface fun radarAlert(json: String) {
            try {
                if (!prefs.getBoolean("notify_enabled", true)) return
                if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) { requestNotificationPermission(); return }

                val o = org.json.JSONObject(json)
                val kind = if (o.optString("kind") == "commodity") "رادار کالا" else "رادار بورس ایران"
                val symbol = o.optString("symbol", "فرصت جدید")
                val score = o.optInt("score", 0)
                val direction = o.optString("direction", "WATCH")
                val nm = getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                val channel = "mjk_radar_v2"
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    val ch = android.app.NotificationChannel(channel, "MJK Radar", android.app.NotificationManager.IMPORTANCE_HIGH)
                    ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build())
                    nm.createNotificationChannel(ch)
                }
                val n = androidx.core.app.NotificationCompat.Builder(this@MainActivity, channel)
                    .setSmallIcon(R.drawable.mjk_notification)
                    .setContentTitle("MJK · $kind")
                    .setContentText("$symbol · احتمال تاریخی ${o.optInt("probability", score)}% · ${o.optInt("samples", 0)} نمونه")
                    .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                    .setCategory(androidx.core.app.NotificationCompat.CATEGORY_ALARM)
                    .setAutoCancel(true).build()
                nm.notify(("radar:" + symbol + System.currentTimeMillis()).hashCode(), n)
            } catch (_: Exception) { }
        }

        @JavascriptInterface fun musicToggle(): Boolean {
            val muted = !prefs.getBoolean("music_muted", false)
            prefs.edit().putBoolean("music_muted", muted).apply()
            if (muted) {
                musicPlayer?.pause()
            } else {
                if (musicPlayer == null) windowMusicStart() else musicPlayer?.start()
            }
            return !muted
        }
        @JavascriptInterface fun musicNext(): String {
            if (prefs.getBoolean("music_muted", false)) return ""
            musicIndex = (musicIndex + 1) % musicTracks.size
            windowMusicStart()
            return musicNames[musicIndex]
        }
        @JavascriptInterface fun musicCurrentName(): String = musicNames[musicIndex]
        @JavascriptInterface fun musicIsPlaying(): Boolean = musicPlayer?.isPlaying == true
    }

    private fun startWelcomeVoice() {
        if (prefs.getBoolean("music_muted", false)) return
        welcomeTts?.shutdown()
        welcomeFinished = false
        welcomeTts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val tts = welcomeTts ?: return@TextToSpeech
                tts.language = Locale.US
                tts.setSpeechRate(0.92f)
                tts.setPitch(1.0f)
                if (android.os.Build.VERSION.SDK_INT >= 21) {
                    tts.speak("Welcome to MJK, Mohsen Jalili.", TextToSpeech.QUEUE_FLUSH, null, "mjk_welcome")
                } else {
                    @Suppress("DEPRECATION")
                    tts.speak("Welcome to MJK, Mohsen Jalili.", TextToSpeech.QUEUE_FLUSH, null)
                }
                if (android.os.Build.VERSION.SDK_INT >= 21) {
                    tts.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
                        override fun onStart(utteranceId: String?) {}
                        override fun onDone(utteranceId: String?) {
                            if (utteranceId == "mjk_welcome") {
                                runOnUiThread {
                                    if (!welcomeFinished) {
                                        welcomeFinished = true
                                        windowMusicStart()
                                    }
                                }
                            }
                        }
                        override fun onError(utteranceId: String?) {
                            if (utteranceId == "mjk_welcome") runOnUiThread { windowMusicStart() }
                        }
                    })
                }
            } else {
                windowMusicStart()
            }
        }
    }

    private fun windowMusicStart() {
        runOnUiThread {
            try {
                musicPlayer?.release()
                musicPlayer = MediaPlayer.create(this, musicTracks[musicIndex])
                musicPlayer?.setOnCompletionListener {
                    if (!prefs.getBoolean("music_muted", false)) {
                        musicIndex = (musicIndex + 1) % musicTracks.size
                        windowMusicStart()
                    }
                }
                musicPlayer?.start()
            } catch (_: Exception) { }
        }
    }

    private fun requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
    }
    private fun scheduleBackgroundCheck() {
        val request = PeriodicWorkRequestBuilder<SignalCheckWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("mjk_signal_check", ExistingPeriodicWorkPolicy.UPDATE, request)
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100 && grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            prefs.getString("pending_signal_json", null)?.let {
                try { MjkBridge().let { bridge -> bridge.signalIssued(it) } } catch (_: Exception) { }
            }
        }
    }

    override fun onDestroy() {
        musicPlayer?.release()
        musicPlayer = null
        welcomeTts?.stop()
        welcomeTts?.shutdown()
        welcomeTts = null
        super.onDestroy()
    }
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }
}
