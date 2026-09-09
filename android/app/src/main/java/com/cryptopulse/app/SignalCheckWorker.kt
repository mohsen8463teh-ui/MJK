package com.cryptopulse.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.media.AudioAttributes
import android.media.RingtoneManager
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.abs
import kotlin.math.roundToInt

class SignalCheckWorker(ctx: Context, params: WorkerParameters): CoroutineWorker(ctx, params) {
    private val prefs=ctx.getSharedPreferences("mjk",Context.MODE_PRIVATE)
    private val fallback=listOf("BTCUSDT","ETHUSDT","XRPUSDT","BNBUSDT","SOLUSDT","DOGEUSDT","ADAUSDT","TRXUSDT","LINKUSDT","AVAXUSDT")
    private val base="https://api.kucoin.com/api/v1"
    private val stable=setOf("USDT","USDC","USDE","DAI","FDUSD","USDS","TUSD","USDD")

    override suspend fun doWork(): Result=withContext(Dispatchers.IO){
        try{val symbols=topSymbols();for(symbol in symbols){try{checkSymbol(symbol)}catch(_:Exception){}};checkRadarRelay();Result.success()}
        catch(_:Exception){Result.retry()}
    }

    private fun topSymbols():List<String>{
        return try{
            val coins=JSONArray(open("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false"))
            val markets=JSONObject(open("$base/symbols"));val available=mutableSetOf<String>();val arr=markets.optJSONArray("data")?:JSONArray()
            for(i in 0 until arr.length()){val x=arr.getJSONObject(i);if(x.optString("quoteCurrency")=="USDT"&&x.optBoolean("enableTrading",true))available.add(x.optString("symbol").uppercase())}
            val out=mutableListOf<String>()
            for(i in 0 until coins.length()){
                val sym=coins.getJSONObject(i).optString("symbol").uppercase();if(sym.isBlank()||stable.contains(sym))continue
                if(available.contains("$sym-USDT"))out.add(sym+"USDT")
                if(out.size==10)break
            }
            if(out.size==10)out else fallback
        }catch(_:Exception){fallback}
    }

    private fun checkSymbol(symbol:String){
        val rows=getKlines(symbol,220).filter{it.getLong(6)<System.currentTimeMillis()};if(rows.size<210)return
        val closes=rows.map{it.getDouble(4)};val e20=ema(closes,20);val e200=ema(closes,200);val a14=atr(rows,14);val i=rows.lastIndex;val c=rows[i]
        val last=prefs.getLong("last_signal_close_$symbol",0L);val gap=last==0L||c.getLong(6)-last>=10L*15L*60L*1000L
        val signal=closes[i]>e200[i]&&e20[i]>e200[i]&&c.getDouble(3)<=e20[i]&&closes[i]>c.getDouble(1)&&closes[i]>e20[i]&&gap
        val activeJson=prefs.getString("active_trade_$symbol",null);val price=getPrice(symbol)
        if(activeJson!=null){val o=JSONObject(activeJson);val sl=o.getDouble("stop_loss");val tp=o.getDouble("take_profit_1");if(price<=sl||price>=tp){val hit=price>=tp;prefs.edit().remove("active_trade_$symbol").apply();notify("MJK: $symbol","معامله بسته شد",if(hit)"TP رسید | قیمت ${fmt(price)}" else "SL رسید | قیمت ${fmt(price)}")}}
        if(activeJson==null&&signal){val entry=closes[i];val sl=entry-1.5*a14[i];val tp=entry+3*a14[i];val id="$symbol-${c.getLong(6)}";val lastId=prefs.getString("last_signal_id_$symbol","");if(id!=lastId){val o=JSONObject().put("id",id).put("symbol",symbol).put("entry_price",entry).put("stop_loss",sl).put("take_profit_1",tp).put("close_time_ms",c.getLong(6));prefs.edit().putString("last_signal_id_$symbol",id).putLong("last_signal_close_$symbol",c.getLong(6)).putString("active_trade_$symbol",o.toString()).apply();notify("MJK: $symbol","سیگنال BUY جدید","Entry ${fmt(entry)} | SL ${fmt(sl)} | TP ${fmt(tp)}")}}
    }

    private fun checkRadarRelay(){
        val raw="https://raw.githubusercontent.com/mohsen8463teh-ui/MJK/main/radar-data/stocks.json"
        try {
            val j=JSONObject(open(raw+"?t="+System.currentTimeMillis()/60000))
            val rows=j.optJSONArray("items") ?: j.optJSONArray("rows") ?: return
            val candidates=mutableListOf<JSONObject>()
            for(i in 0 until rows.length()){
                val x=rows.optJSONObject(i) ?: continue
                if(x.optString("insCode").isBlank()||x.optDouble("last",0.0)<=0||x.optDouble("prev",0.0)<=0)continue
                val ch=x.optDouble("change",(x.optDouble("last")-x.optDouble("prev"))/x.optDouble("prev")*100.0)
                val vol=x.optDouble("vol",0.0);val base=x.optDouble("baseVol",0.0)
                val last=x.optDouble("last");val close=x.optDouble("close",last);val low=x.optDouble("low",last);val high=x.optDouble("high",last)
                val pos=if(high>low)((last-low)/(high-low)).coerceIn(0.0,1.0) else .5
                var score=0.0
                score += when { ch in 0.4..2.5 -> 20.0; ch>0 && ch<0.4 -> 12.0; ch in 2.5..4.0 -> 8.0; ch>4 -> -12.0; else -> -10.0 }
                if(last>=close)score+=10
                score+=pos*15
                if(base>0){val r=vol/base;score+=when{r>=3->18.0;r>=2->14.0;r>=1.3->9.0;else->0.0}}
                x.put("preSurgeScore",score.coerceIn(0.0,100.0));candidates.add(x)
            }
            candidates.sortByDescending{it.optDouble("preSurgeScore")}
            val top=candidates.take(8)
            var best:JSONObject?=null
            for(x in top){
                try{
                    val p=empiricalRadarProbability(x)
                    if(p!=null){x.put("probability",p.first);x.put("probabilitySamples",p.second);x.put("probabilityWins",p.third)}
                    if(x.optInt("probability",0)>=80 && x.optInt("probabilitySamples",0)>=40 && x.optDouble("preSurgeScore")>=65){
                        if(best==null || x.optInt("probability")>best!!.optInt("probability")) best=x
                    }
                }catch(_:Exception){}
            }
            val b=best ?: return
            val symbol=b.optString("symbol", "فرصت جدید")
            val prob=b.optInt("probability")
            val samples=b.optInt("probabilitySamples")
            val key="radar_pre_surge_${symbol}_${prob}"
            val old=prefs.getLong(key,0L)
            if(System.currentTimeMillis()-old < 18*60*60*1000L)return
            prefs.edit().putLong(key,System.currentTimeMillis()).apply()
            notify("MJK · رادار بورس",symbol,"احتمال تاریخی ${prob}% | ${samples} نمونه مشابه | هدف ۴٪ در حداکثر ۲ روز")
        }catch(_:Exception){}
    }

    private fun empiricalRadarProbability(x:JSONObject):Triple<Int,Int,Int>?{
        val id=x.optString("insCode");if(id.isBlank())return null
        val j=JSONObject(open("https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/$id/260"))
        val a=j.optJSONArray("closingPriceDaily")?:return null
        data class Bar(val last:Double,val prev:Double,val low:Double,val high:Double,val vol:Double)
        val h=mutableListOf<Bar>()
        for(i in 0 until a.length()){
            val r=a.optJSONObject(i)?:continue
            val last=r.optDouble("pDrCotVal",Double.NaN);val prev=r.optDouble("priceYesterday",Double.NaN);val low=r.optDouble("priceMin",Double.NaN);val high=r.optDouble("priceMax",Double.NaN);val vol=r.optDouble("qTotTran5J",0.0)
            if(last.isFinite()&&prev.isFinite()&&prev>0&&low.isFinite()&&high.isFinite())h.add(Bar(last,prev,low,high,vol))
        }
        if(h.size<90)return null
        h.reverse()
        fun feat(i:Int):DoubleArray{
            val r=h[i];val ch=(r.last-r.prev)/r.prev*100.0;val pos=if(r.high>r.low)((r.last-r.low)/(r.high-r.low)).coerceIn(0.0,1.0) else .5
            val vs=h.subList(maxOf(0,i-20),i).map{it.vol}.filter{it>0}.sorted();val med=if(vs.isEmpty())1.0 else vs[vs.size/2];val vr=(r.vol/med).coerceAtMost(10.0)
            var acc=ch;val from=maxOf(0,i-5);if(i>from){var sm=0.0;var n=0;for(k in from until i){sm+=(h[k].last-h[k].prev)/h[k].prev*100.0;n++};if(n>0)acc-=sm/n}
            return doubleArrayOf(ch,pos,vr,acc)
        }
        val currentCh=x.optDouble("change",0.0);val low=x.optDouble("low",x.optDouble("last"));val high=x.optDouble("high",x.optDouble("last"));val last=x.optDouble("last");val pos=if(high>low)((last-low)/(high-low)).coerceIn(0.0,1.0) else .5
        val recentVols=h.takeLast(20).map{it.vol}.filter{it>0}.sorted();val medCurrent=if(recentVols.isEmpty())1.0 else recentVols[recentVols.size/2];val currentVol=x.optDouble("vol",medCurrent);val cur=doubleArrayOf(currentCh,pos,(currentVol/medCurrent).coerceAtMost(10.0),0.0);val pairs=mutableListOf<Pair<Double,Int>>()
        for(i in 45 until h.size-2){val f=feat(i);if(f[0]>8||f[0]<-8)continue;val d=Math.sqrt(((cur[0]-f[0])/2.5).let{it*it}+((cur[1]-f[1])/.35).let{it*it}+(Math.log1p(cur[2])-Math.log1p(f[2])).let{(it/.7)*(it/.7)}+((cur[3]-f[3])/2.5).let{it*it});pairs.add(d to i)}
        pairs.sortBy{it.first};val top=pairs.take(50);if(top.size<40)return null
        var wins=0
        for((_,i) in top){val entry=h[i].last;var hit=false;var stopped=false;for(k in i+1..minOf(i+2,h.lastIndex)){val up=(h[k].high-entry)/entry*100.0;val down=(h[k].low-entry)/entry*100.0;if(down<=-2.0){stopped=true;break};if(up>=4.0){hit=true;break}};if(hit&&!stopped)wins++}
        return Triple((wins*100.0/top.size).roundToInt(),top.size,wins)
    }

    private fun getPrice(symbol:String):Double{val market=symbol.removeSuffix("USDT")+"-USDT";val j=JSONObject(open("$base/market/stats?symbol=$market"));return j.getJSONObject("data").getDouble("last")}
    private fun getKlines(symbol: String, n: Int): List<JSONArray> {
        val market = symbol.removeSuffix("USDT") + "-USDT"
        val j = JSONObject(open("$base/market/candles?symbol=$market&type=15min&limit=$n"))
        val a = j.getJSONArray("data")
        val out = mutableListOf<JSONArray>()
        for (i in 0 until a.length()) {
            val r = a.getJSONArray(i)
            val t = r.getLong(0)
            out.add(
                JSONArray()
                    .put(t)
                    .put(r.getDouble(1))
                    .put(r.getDouble(3))
                    .put(r.getDouble(4))
                    .put(r.getDouble(2))
                    .put(r.getDouble(5))
                    .put(t + 15L * 60L * 1000L - 1)
            )
        }
        return out.sortedBy { it.getLong(0) }
    }
    private fun open(u:String):String{val c=URL(u).openConnection() as HttpURLConnection;c.connectTimeout=12000;c.readTimeout=12000;c.requestMethod="GET";c.setRequestProperty("Accept","application/json");c.setRequestProperty("User-Agent","MJK-Android/1.0");return try{if(c.responseCode !in 200..299)throw Exception("HTTP ${c.responseCode}");c.inputStream.bufferedReader().use{it.readText()}}finally{c.disconnect()}}
    private fun fmt(v:Double)=String.format(java.util.Locale.US,"%.4f",v)
    private fun ema(v:List<Double>,p:Int):DoubleArray{val o=DoubleArray(v.size);var sum=0.0;for(i in 0 until p)sum+=v[i];var prev=sum/p;o[p-1]=prev;val k=2.0/(p+1);for(i in p until v.size){prev=(v[i]-prev)*k+prev;o[i]=prev};return o}
    private fun atr(c:List<JSONArray>,p:Int):DoubleArray{val tr=DoubleArray(c.size);for(i in c.indices){val h=c[i].getDouble(2);val l=c[i].getDouble(3);val pc=if(i==0)h else c[i-1].getDouble(4);tr[i]=if(i==0)h-l else maxOf(h-l,abs(h-pc),abs(l-pc))};val o=DoubleArray(c.size);var s=0.0;for(i in 0 until p)s+=tr[i];var prev=s/p;o[p-1]=prev;for(i in p until c.size){prev=(prev*(p-1)+tr[i])/p;o[i]=prev};return o}
    private fun notify(title:String,head:String,text:String){
        val nm=applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val id="mjk_signal_v2"
        if(Build.VERSION.SDK_INT>=26){
            val ch=NotificationChannel(id,"MJK Signals",NotificationManager.IMPORTANCE_HIGH)
            ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build())
            nm.createNotificationChannel(ch)
        }
        val n=NotificationCompat.Builder(applicationContext,id).setSmallIcon(com.cryptopulse.app.R.drawable.mjk_notification).setContentTitle(title).setContentText("$head | $text").setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_ALARM).setAutoCancel(true).build()
        nm.notify((title.hashCode()+System.currentTimeMillis()).toInt(),n)
    }
}
