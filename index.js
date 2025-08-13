// Merged index.js - All files combined into oneconst { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const ccxt = require('ccxt');
const { RSI, MACD, EMA, PSAR, StochasticRSI } = require('technicalindicators');
const axios = require('axios');
const WebSocket = require('ws');const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '7551795139:AAHJa1du2jRmmA1gmTPIHwJbUsRT7wOksaI');
const parser = new Parser();
const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT'];
const TIMEFRAMES = ['1min', '5min', '30min', '1hour', '2hour', '4hour', '1day', '1week', '1month'];
const GROUP_ID = '-1002869335730'; // @tradingroup95
 grup ID'si// db.js content
function initDB(db) {
  db.run(CREATE TABLE IF NOT EXISTS analizler (     id INTEGER PRIMARY KEY AUTOINCREMENT,     tarih TEXT,     coin TEXT,     analiz TEXT   ));
}async function saveAnalysis(db, analysis) {
  db.run(INSERT INTO analizler (tarih, coin, analiz) VALUES (?, ?, ?), [
    analysis.tarih,
    analysis.coin || 'Tüm coinler',
    JSON.stringify(analysis)
  ]);
  db.run(DELETE FROM analizler WHERE id NOT IN (SELECT id FROM analizler ORDER BY id DESC LIMIT 100));
}async function getRecentAnalyses(db) {
  return new Promise((resolve) => {
    db.all(SELECT * FROM analizler ORDER BY id DESC LIMIT 100, [], (err, rows) => {
      resolve(rows);
    });
  });
}// SQLite setup
const db = new sqlite3.Database('./analiz.db');
initDB(db);// news.js content
const RSS_LINKS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss',
  'https://www.newsbtc.com/feed/',
  'https://rss.app/feeds/v1.1/afLheyG37mUeVDxY.json&#39;
];async function fetchNews() {
  let news = [];
  for (const url of RSS_LINKS) {
    try {
      const feed = await parser.parseURL(url);
      news.push(...feed.items.slice(0, 5).map(item => item.title + ': ' + (item.contentSnippet || '')));
    } catch (e) {
      news.push(${url} veri çekilemedi!);
    }
  }
  return news;
}// websocket.js content
async function getWebSocketToken() {
  try {
    const response = await axios.post('https://api.kucoin.com/api/v1/bullet-public', {}, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    console.log('WebSocket token response:', response.data);
    return response.data.data.token;
  } catch (error) {
    console.error('KuCoin WebSocket token error:', error.response?.data || error.message);
    return null;
  }
}async function startWebSocket(coin, targetPrice, callback) {
  const token = await getWebSocketToken();
  if (!token) {
    console.error('WebSocket token alınamadı, fiyat takibi devam edecek.');
    return { startPriceWebSocket: () => {}, fetchKlines: async () => [] };
  }  const ws = new WebSocket(wss://ws-api-spot.kucoin.com?token=${token}&connectId=${Date.now()});
  let pingInterval;  ws.on('open', () => {
    console.log(WebSocket connected for ${coin} ticker);
    const subscribeMsg = {
      id: Date.now(),
      type: 'subscribe',
      topic: /market/ticker:${coin},
      response: true,
    };
    ws.send(JSON.stringify(subscribeMsg));pingInterval = setInterval(() => {
  ws.send(JSON.stringify({ id: Date.now(), type: 'ping' }));
}, 20000);  });  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'message' && msg.topic.includes('/market/ticker')) {
        const price = parseFloat(msg.data.price);
        callback({ price });
      }
    } catch (error) {
      console.error('WebSocket message error:', error.message);
    }
  });  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });  ws.on('close', () => {
    console.log('WebSocket closed, reconnecting...');
    clearInterval(pingInterval);
    setTimeout(() => startWebSocket(coin, targetPrice, callback), 5000);
  });  return {
    startPriceWebSocket: (coin, targetPrice, priceCallback) => {
      callback({ price: targetPrice });
    },
    fetchKlines: async () => [], // WebSocket Klines devre dışı
  };
}// analysis.js content
const kucoin = new ccxt.kucoin({
  apiKey: process.env.KUCOIN_KEY,
  secret: process.env.KUCOIN_SECRET,
  enableRateLimit: true,
});async function fetchHttpKlines(coin, timeframe, startAt = 0, endAt = 0) {
  try {
    const params = { symbol: coin, type: timeframe };
    if (startAt) params.startAt = startAt;
    if (endAt) params.endAt = endAt;
    const response = await axios.get('https://api.kucoin.com/api/v1/market/candles', { params });
    return response.data.data.map(([time, open, close, high, low, volume, amount]) => ({
      timestamp: new Date(parseInt(time) * 1000).toISOString(),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    }));
  } catch (error) {
    console.error(HTTP Klines error for ${coin} (${timeframe}):, error.message);
    return [];
  }
}function calculateIndicators(data) {
  const closes = data.map(d => d.close);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const volumes = data.map(d => d.volume);  return {
    RSI: RSI.calculate({ period: 14, values: closes }).slice(-1)[0] || 0,
    MACD: MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes }).slice(-1)[0]?.MACD || 0,
    EMA50: EMA.calculate({ period: 50, values: closes }).slice(-1)[0] || 0,
    EMA200: EMA.calculate({ period: 200, values: closes }).slice(-1)[0] || 0,
    PSAR: PSAR.calculate({ high: highs, low: lows, step: 0.02, max: 0.2 }).slice(-1)[0] || 0,
    StochRSI: StochasticRSI.calculate({ period: 14, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3, values: closes }).slice(-1)[0]?.k || 0,
    volumeChange: ((volumes[volumes.length - 1] - volumes[volumes.length - 2]) / volumes[volumes.length - 2] * 100) || 0,
  };
}function generateFallbackComment(indicators, btcStatus, dip, tp, timeframe, coin) {
  let comment = BTC durumu: ${btcStatus}. ;
  if (indicators.RSI < 30) comment += ${coin} ${timeframe}'de aşırı satım bölgesinde, alım fırsatı olabilir. ;
  else if (indicators.RSI > 70) comment += ${coin} ${timeframe}'de aşırı alım bölgesinde, satış düşünülebilir. ;
  else comment += ${coin} ${timeframe}'de nötr bölgede. ;
  comment += RSI: ${indicators.RSI.toFixed(2)}, MACD: ${indicators.MACD.toFixed(2)}, Hacim değişimi: ${indicators.volumeChange.toFixed(2)}%. ;
  comment += Giriş: ${dip.toFixed(2)}, Çıkış: ${tp.toFixed(2)}.;
  return comment;
}async function callGrok(prompt) {
  try {
    const response = await axios.post(
      'https://api.x.ai/v1/chat/completions',
      {
        messages: [
          { role: 'system', content: 'Sen bir kripto para analiz botusun. Teknik indikatörlere dayalı kısa, samimi, anlaşılır ve doğal Türkçe yorumlar yap (maksimum 600 kelime).' },
          { role: 'user', content: prompt },
        ],
        model: 'grok-4-0709',
        stream: false,
        temperature: 0.7,
        max_tokens: 1200,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: Bearer ${process.env.GROK_API_KEY},
        },
      }
    );
    console.log('Grok API response:', response.data);
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Grok API error:', error.response?.data || error.message);
    return null;
  }
}async function analyzeCoin(coin, btcData = null, news = [], useWebSocket = false) {
  let result = { coin, tarih: new Date().toLocaleString('tr-TR'), analyses: {} };
  for (const timeframe of TIMEFRAMES) {
    const data = await fetchHttpKlines(coin, timeframe); // Her durumda HTTP Klines
    if (!data.length) continue;const indicators = calculateIndicators(data);
const dip = Math.min(...data.map(d => d.low));
const tp = Math.max(...data.map(d => d.high)) * 1.05;

const btcIndicators = btcData ? calculateIndicators(btcData) : {};
const btcStatus = btcIndicators.EMA50 > btcIndicators.EMA200 ? 'Yükselişte' : 'Düşüşte';

const negativeNews = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));
const prompt = `
  ${coin} için ${timeframe} zaman diliminde analiz yap. 
  RSI: ${indicators.RSI.toFixed(2)}, MACD: ${indicators.MACD.toFixed(2)}, 
  EMA50: ${indicators.EMA50.toFixed(2)}, EMA200: ${indicators.EMA200.toFixed(2)}, 
  PSAR: ${indicators.PSAR.toFixed(2)}, StochRSI: ${indicators.StochRSI.toFixed(2)}, 
  Hacim değişimi: ${indicators.volumeChange.toFixed(2)}%, BTC durumu: ${btcStatus}, 
  Haber: ${negativeNews ? 'Olumsuz' : 'Nötr'}, Giriş: ${dip.toFixed(2)}, Çıkış: ${tp.toFixed(2)}. 
  Kısa, samimi ve doğal bir Türkçe yorum yap (maksimum 600 kelime).`;
let comment = await callGrok(prompt);
if (!comment) {
  comment = generateFallbackComment(indicators, btcStatus, dip, tp, timeframe, coin);
}

result.analyses[timeframe] = { giriş: dip, çıkış: tp, yorum: comment, indicators };  }
  return result;
}async function fullAnalysis(news) {
  const btcData = await fetchHttpKlines('BTC-USDT', '1hour');
  const messages = [];
  for (const coin of COINS) {
    const analysis = await analyzeCoin(coin, btcData, news, false);
    for (const [timeframe, data] of Object.entries(analysis.analyses)) {
      let message = ${coin} Analizi (${timeframe}, ${new Date().toLocaleString('tr-TR')}):\n;
      message +=   Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n;
      const negative = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));
      if (negative && coin.includes('BTC') && timeframe === '1hour') {
        message +=   Alarm: Bitcoin düşüyor, dikkat! Tahmini dip: ${data.giriş.toFixed(2)}.\n;
      }
      messages.push(message);
    }
  }
  return messages;
}// Telegram Commands
bot.command('start', async (ctx) => {
  console.log('Start komutu alındı, chat ID:', ctx.chat.id);
  await ctx.reply('Merhaba! Kripto analiz botu hazır. /analiz ile başla veya coin sor (ör. "ADA ne durumda?").');
});bot.command('analiz', async (ctx) => {
  console.log('Analiz komutu alındı, chat ID:', ctx.chat.id);
  const news = await fetchNews();
  const messages = await fullAnalysis(news);
  for (const message of messages) {
    await ctx.reply(message);
  }
  await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') });
  // Grup paylaşımı
  if (ctx.chat.id == GROUP_ID) {
    for (const message of messages) {
      await bot.telegram.sendMessage(GROUP_ID, message);
    }
  }
});bot.command('alarm_kur', async (ctx) => {
  console.log('Alarm kur komutu alındı, chat ID:', ctx.chat.id);
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 2) {
    const [coin, price] = args;
    const coinPair = coin.toUpperCase() + '-USDT';
    const { startPriceWebSocket } = startWebSocket(coinPair, null, async ({ price: currentPrice }) => {
      if (currentPrice <= parseFloat(price) || currentPrice >= parseFloat(price)) {
        const news = await fetchNews();
        const analysis = await analyzeCoin(coinPair, null, news, false); // HTTP Klines
        const timeframe = '1hour';
        const data = analysis.analyses[timeframe];
        let message = Alarm: ${coin} ${currentPrice.toFixed(2)}'e ${currentPrice <= parseFloat(price) ? 'düştü' : 'çıktı'}!\n;
        if (data) {
          message += ${coin} Analizi (${timeframe}, ${new Date().toLocaleString('tr-TR')}):\n;
          message +=   Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n;
        } else {
          message += 'Analiz verisi alınamadı.';
        }
        await ctx.reply(message);
        if (ctx.chat.id == GROUP_ID) {
          await bot.telegram.sendMessage(GROUP_ID, message);
        }
      }
    });
    startPriceWebSocket(coinPair, parseFloat(price), () => {});
    await ctx.reply(${coin} için ${price} alarmı kuruldu.);
  } else {
    await ctx.reply('Kullanım: /alarm_kur coin fiyat');
  }
});// Chatbot özelliği: Herhangi bir metne yanıt
bot.on('text', async (ctx) => {
  console.log('Metin alındı, chat ID:', ctx.chat.id, 'text:', ctx.message.text);
  const text = ctx.message.text.toLowerCase();
  const coin = COINS.find(c => text.includes(c.split('-')[0].toLowerCase()));
  if (coin) {
    console.log(Coin analizi: ${coin});
    const news = await fetchNews();
    const analysis = await analyzeCoin(coin, null, news, false);
    for (const [timeframe, data] of Object.entries(analysis.analyses)) {
      let message = ${coin} Analizi (${timeframe}):\nGiriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\nYorum: ${data.yorum};
      await ctx.reply(message);
      if (ctx.chat.id == GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, message);
      }
    }
    await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: JSON.stringify(analysis.analyses) });
  } else {
    // Genel sohbet için Grok-4 yanıtı
    console.log('Genel sohbet, metin:', text);
    const prompt = Kullanıcı mesajı: "${text}". Kripto analiz botusun, kısa ve doğal Türkçe yanıt ver. Coin analizi istersen analiz yap, yoksa sohbet et.;
    const comment = await callGrok(prompt);
    await ctx.reply(comment || 'Üzgünüm, bu konuda yorum yapamadım. Bir coin belirtir misin?');
  }
});// Planlanmış grup analizleri
schedule.scheduleJob('0 */12 * * *', async () => {
  console.log('Planlanmış grup analizi başlıyor...');
  const news = await fetchNews();
  const messages = await fullAnalysis(news);
  for (const message of messages) {
    console.log('Planlanmış grup mesajı:', message);
    await bot.telegram.sendMessage(GROUP_ID, message);
  }
  await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') });
});// Start Bot
startBot();
console.log('Bot çalışıyor...');// Heroku PORT
const PORT = process.env.PORT || 3000;
require('http').createServer((req, res) => res.end('Bot çalışıyor')).listen(PORT);// Genel hata yönetimi
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message, error.stack);
});
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error.message, error.stack);
});

