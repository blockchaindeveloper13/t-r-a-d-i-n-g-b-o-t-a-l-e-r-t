// Merged index.js - All files combined into one

const { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const ccxt = require('ccxt');
const { RSI, MACD, EMA, PSAR, StochasticRSI } = require('technicalindicators');
const axios = require('axios');
const WebSocket = require('ws');

// Cache for API responses
const cache = new Map();
const CACHE_DURATION = 3 * 60 * 1000; // 3 minutes

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '7551795139:AAHJa1du2jRmmA1gmTPIHwJbUsRT7wOksaI');
const parser = new Parser();
const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT'];
const SHORT_TIMEFRAMES = ['1min', '5min', '30min', '1hour']; // Only short-term timeframes
const GROUP_ID = '-1002869335730'; // @tradingroup95 grup ID'si
let isBotStarted = false;

// Rate limit control for Grok API
const RATE_LIMIT_MS = 300; // 300ms between requests
let lastGrokRequest = 0;

async function rateLimitedCallGrok(prompt) {
  const now = Date.now();
  if (now - lastGrokRequest < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - (now - lastGrokRequest)));
  }
  lastGrokRequest = Date.now();

  const cacheKey = prompt;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log('Cache hit for:', cacheKey);
      return cached.data;
    }
  }

  try {
    const response = await axios.post(
      'https://api.x.ai/v1/chat/completions',
      {
        messages: [
          { role: 'system', content: 'Sen bir kripto para analiz botusun. Sadece kısa vadeli zaman dilimlerini (1min, 5min, 30min, 1hour) inceleyip teknik indikatörlere dayalı tek bir kısa, samimi, anlaşılır ve doğal Türkçe yorum yap (maksimum 300 kelime). Giriş fiyatı için 📉, çıkış fiyatı için 📈 kullan.' },
          { role: 'user', content: prompt },
        ],
        model: 'grok-4-0709',
        stream: false,
        temperature: 0.7,
        max_tokens: 600,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROK_API_KEY}`,
        },
      }
    );
    console.log('Grok API response:', JSON.stringify(response.data, null, 2));
    const result = response.data.choices[0].message.content.trim();
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    console.error('Grok API error:', error.response?.data || error.message);
    return null;
  }
}

// db.js content
function initDB(db) {
  return new Promise((resolve, reject) => {
    db.run(`CREATE TABLE IF NOT EXISTS analizler (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarih TEXT,
      coin TEXT,
      analiz TEXT
    )`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function saveAnalysis(db, analysis) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO analizler (tarih, coin, analiz) VALUES (?, ?, ?)`, [
      analysis.tarih,
      analysis.coin || 'Tüm coinler',
      JSON.stringify(analysis)
    ], (err) => {
      if (err) {
        console.error('Save analysis error:', err);
        reject(err);
      }
      db.run(`DELETE FROM analizler WHERE id NOT IN (SELECT id FROM analizler ORDER BY id DESC LIMIT 100)`, (err) => {
        if (err) {
          console.error('Delete old analyses error:', err);
          reject(err);
        } else resolve();
      });
    });
  });
}

async function getRecentAnalyses(db) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM analizler ORDER BY id DESC LIMIT 100`, [], (err, rows) => {
      if (err) {
        console.error('Get recent analyses error:', err);
        reject(err);
      } else resolve(rows);
    });
  });
}

// SQLite setup
const db = new sqlite3.Database(':memory:'); // Use in-memory DB for Heroku
initDB(db).catch(err => console.error('DB init error:', err));

// news.js content
const RSS_LINKS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss',
  'https://www.newsbtc.com/feed/',
  'https://rss.app/feeds/v1.1/afLheyG37mUeVDxY.json'
];

async function fetchNews() {
  let news = [];
  for (const url of RSS_LINKS) {
    try {
      const feed = await parser.parseURL(url);
      news.push(...feed.items.slice(0, 5).map(item => item.title + ': ' + (item.contentSnippet || '')));
    } catch (e) {
      console.error(`News fetch error for ${url}:`, e.message);
      news.push(`${url} veri çekilemedi!`);
    }
  }
  return news;
}

// websocket.js content
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
}

async function startWebSocket(coin, targetPrice, callback) {
  const token = await getWebSocketToken();
  if (!token) {
    console.error('WebSocket token alınamadı, fiyat takibi devam edecek.');
    return { startPriceWebSocket: () => {}, fetchKlines: async () => [] };
  }

  const ws = new WebSocket(`wss://ws-api-spot.kucoin.com?token=${token}&connectId=${Date.now()}`);
  let pingInterval;

  ws.on('open', () => {
    console.log(`WebSocket connected for ${coin} ticker`);
    const subscribeMsg = {
      id: Date.now(),
      type: 'subscribe',
      topic: `/market/ticker:${coin}`,
      response: true,
    };
    ws.send(JSON.stringify(subscribeMsg));

    pingInterval = setInterval(() => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.send(JSON.stringify({ id: Date.now(), type: 'ping' }));
    }, 20000);
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'message' && msg.topic.includes('/market/ticker')) {
        const price = parseFloat(msg.data.price);
        callback({ price });
      }
      if (msg.type === 'pong') ws.isAlive = true;
    } catch (error) {
      console.error('WebSocket message error:', error.message);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });

  ws.on('close', () => {
    console.log('WebSocket closed, reconnecting...');
    clearInterval(pingInterval);
    setTimeout(() => startWebSocket(coin, targetPrice, callback), 5000);
  });

  return {
    startPriceWebSocket: (coin, targetPrice, priceCallback) => {
      callback({ price: targetPrice });
    },
    fetchKlines: async () => [], // WebSocket Klines devre dışı
  };
}

// analysis.js content
const kucoin = new ccxt.kucoin({
  apiKey: process.env.KUCOIN_KEY,
  secret: process.env.KUCOIN_SECRET,
  enableRateLimit: true,
});

async function fetchHttpKlines(coin, timeframe, startAt = 0, endAt = 0) {
  const cacheKey = `${coin}-${timeframe}-${startAt}-${endAt}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log('Cache hit for klines:', cacheKey);
      return cached.data;
    }
  }

  try {
    const params = { symbol: coin, type: timeframe };
    if (startAt) params.startAt = startAt;
    if (endAt) params.endAt = endAt;
    const response = await axios.get('https://api.kucoin.com/api/v1/market/candles', { params });
    const data = response.data.data
      .map(([time, open, close, high, low, volume, amount]) => ({
        timestamp: new Date(parseInt(time) * 1000).toISOString(),
        open: parseFloat(open),
        high: parseFloat(high),
        low: parseFloat(low),
        close: parseFloat(close),
        volume: parseFloat(volume),
      }))
      .filter(d => d.low > 0 && d.high > 0 && d.low < d.high); // Mantıksız fiyatları filtrele
    if (data.length === 0) throw new Error('No valid data after filtering');
    cache.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.error(`HTTP Klines error for ${coin} (${timeframe}):`, error.message);
    return [];
  }
}

function calculateIndicators(data) {
  if (!data || data.length < 2) return null;
  const closes = data.map(d => d.close);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const volumes = data.map(d => d.volume);

  try {
    return {
      RSI: RSI.calculate({ period: 14, values: closes }).slice(-1)[0] || 0,
      MACD: MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes }).slice(-1)[0]?.MACD || 0,
      EMA50: EMA.calculate({ period: 50, values: closes }).slice(-1)[0] || 0,
      EMA200: EMA.calculate({ period: 200, values: closes }).slice(-1)[0] || 0,
      PSAR: PSAR.calculate({ high: highs, low: lows, step: 0.02, max: 0.2 }).slice(-1)[0] || 0,
      StochRSI: StochasticRSI.calculate({ period: 14, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3, values: closes }).slice(-1)[0]?.k || 0,
      volumeChange: ((volumes[volumes.length - 1] - volumes[volumes.length - 2]) / volumes[volumes.length - 2] * 100) || 0,
    };
  } catch (error) {
    console.error('Calculate indicators error:', error.message);
    return null;
  }
}

function generateFallbackComment(indicatorsByTimeframe, btcStatus, dip, tp, coin) {
  let comment = `BTC durumu: ${btcStatus}. `;
  const validIndicators = Object.values(indicatorsByTimeframe).filter(ind => ind !== null);
  if (!validIndicators.length) return `Veri eksik, ${coin} analizi yapılamadı. 📉 ${dip.toFixed(2)} 📈 ${tp.toFixed(2)}`;
  const rsiAvg = validIndicators.reduce((sum, ind) => sum + ind.RSI, 0) / validIndicators.length;
  if (rsiAvg < 30) comment += `${coin} kısa vadede aşırı satım bölgesinde, alım fırsatı olabilir. `;
  else if (rsiAvg > 70) comment += `${coin} kısa vadede aşırı alım bölgesinde, satış düşünülebilir. `;
  else comment += `${coin} kısa vadede nötr bölgede. `;
  comment += `Ortalama RSI: ${rsiAvg.toFixed(2)}, Giriş: 📉 ${dip.toFixed(2)}, Çıkış: 📈 ${tp.toFixed(2)}.`;
  return comment;
}

async function analyzeCoin(coin, btcData = null, news = [], useWebSocket = false) {
  let result = { coin, tarih: new Date().toLocaleString('tr-TR'), analyses: {} };
  let indicatorsByTimeframe = {};
  let dip = Infinity, tp = 0;

  // Son 24 saat için kısa vadeli zaman dilimlerini paralel olarak çek
  const endAt = Math.floor(Date.now() / 1000);
  const startAt = endAt - 24 * 60 * 60; // Son 24 saat
  const klinesPromises = SHORT_TIMEFRAMES.map(timeframe => fetchHttpKlines(coin, timeframe, startAt, endAt));
  const klinesResults = await Promise.all(klinesPromises);

  for (let i = 0; i < SHORT_TIMEFRAMES.length; i++) {
    const timeframe = SHORT_TIMEFRAMES[i];
    const data = klinesResults[i];
    if (!data.length) continue;

    const indicators = calculateIndicators(data);
    if (indicators) indicatorsByTimeframe[timeframe] = indicators;
    dip = Math.min(dip, ...data.map(d => d.low));
    tp = Math.max(tp, ...data.map(d => d.high)) * 1.05;
  }

  if (dip === Infinity || tp === 0) {
    console.error(`Invalid dip/tp for ${coin}: dip=${dip}, tp=${tp}`);
    dip = 0;
    tp = 0;
  }

  const btcIndicators = btcData ? calculateIndicators(btcData) : null;
  const btcStatus = btcIndicators && btcIndicators.EMA50 > btcIndicators.EMA200 ? 'Yükselişte' : 'Düşüşte';
  const negativeNews = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));

  const prompt = `
    ${coin} için kısa vadeli zaman dilimlerini (1min, 5min, 30min, 1hour) birleştirip analiz yap.
    İndikatörler: ${JSON.stringify(indicatorsByTimeframe, null, 2)}.
    BTC durumu: ${btcStatus}, Haber: ${negativeNews ? 'Olumsuz' : 'Nötr'}, Giriş: 📉 ${dip.toFixed(2)}, Çıkış: 📈 ${tp.toFixed(2)}.
    Kısa, samimi ve doğal bir Türkçe yorum yap (maksimum 300 kelime).`;
  let comment = await rateLimitedCallGrok(prompt);
  if (!comment) {
    comment = generateFallbackComment(indicatorsByTimeframe, btcStatus, dip, tp, coin);
  }

  result.analyses = { giriş: dip, çıkış: tp, yorum: comment, indicators: indicatorsByTimeframe };
  return result;
}

async function fullAnalysis(news) {
  const btcData = await fetchHttpKlines('BTC-USDT', '1hour', Math.floor(Date.now() / 1000) - 24 * 60 * 60, Math.floor(Date.now() / 1000));
  const messages = [];
  for (const coin of COINS) {
    const analysis = await analyzeCoin(coin, btcData, news, false);
    let message = `${coin} Analizi (${new Date().toLocaleString('tr-TR')}):\n`;
    message += `  Giriş: 📉 ${analysis.analyses.giriş.toFixed(2)}, Çıkış: 📈 ${analysis.analyses.çıkış.toFixed(2)}\n  Yorum: ${analysis.analyses.yorum}\n`;
    const negative = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));
    if (negative && coin.includes('BTC')) {
      message += `  Alarm: Bitcoin düşüyor, dikkat! Tahmini dip: 📉 ${analysis.analyses.giriş.toFixed(2)}.\n`;
    }
    messages.push(message);
  }
  return messages;
}

// Telegram Commands
bot.command('start', async (ctx) => {
  console.log('Start komutu alındı, chat ID:', ctx.chat.id);
  await ctx.reply('Merhaba! Kripto analiz botu hazır. /analiz ile başla veya coin sor (ör. "ADA ne durumda?"). 😎');
});

bot.command('analiz', async (ctx) => {
  console.log('Analiz komutu alındı, chat ID:', ctx.chat.id);
  try {
    const news = await fetchNews();
    const messages = await fullAnalysis(news);
    for (const message of messages) {
      await ctx.reply(message);
    }
    await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') }).catch(err => console.error('Save analysis error:', err));
    if (ctx.chat.id == GROUP_ID) {
      for (const message of messages) {
        await bot.telegram.sendMessage(GROUP_ID, message);
      }
    }
  } catch (error) {
    console.error('Analiz command error:', error);
    await ctx.reply('Analiz sırasında bir hata oluştu, lütfen tekrar deneyin. 😓');
  }
});

bot.command('alarm_kur', async (ctx) => {
  console.log('Alarm kur komutu alındı, chat ID:', ctx.chat.id);
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 2) {
    const [coin, price] = args;
    const coinPair = coin.toUpperCase() + '-USDT';
    const { startPriceWebSocket } = startWebSocket(coinPair, null, async ({ price: currentPrice }) => {
      if (currentPrice <= parseFloat(price) || currentPrice >= parseFloat(price)) {
        try {
          const news = await fetchNews();
          const analysis = await analyzeCoin(coinPair, null, news, false);
          let message = `Alarm: ${coin} ${currentPrice.toFixed(2)}'e ${currentPrice <= parseFloat(price) ? 'düştü' : 'çıktı'}! 🚨\n`;
          message += `${coin} Analizi (${new Date().toLocaleString('tr-TR')}):\n`;
          message += `  Giriş: 📉 ${analysis.analyses.giriş.toFixed(2)}, Çıkış: 📈 ${analysis.analyses.çıkış.toFixed(2)}\n  Yorum: ${analysis.analyses.yorum}\n`;
          await ctx.reply(message);
          if (ctx.chat.id == GROUP_ID) {
            await bot.telegram.sendMessage(GROUP_ID, message);
          }
        } catch (error) {
          console.error('Alarm error:', error);
          await ctx.reply(`Alarm: ${coin} ${currentPrice.toFixed(2)}'e ulaştı, ancak analiz alınamadı. 😓`);
        }
      }
    });
    startPriceWebSocket(coinPair, parseFloat(price), () => {});
    await ctx.reply(`${coin} için ${price} alarmı kuruldu. 🔔`);
  } else {
    await ctx.reply('Kullanım: /alarm_kur coin fiyat');
  }
});

// Chatbot özelliği: Herhangi bir metne yanıt
bot.on('text', async (ctx) => {
  console.log('Metin alındı, chat ID:', ctx.chat.id, 'text:', ctx.message.text);
  const text = ctx.message.text.toLowerCase();
  const coin = COINS.find(c => text.includes(c.split('-')[0].toLowerCase()));
  try {
    if (coin) {
      console.log(`Coin analizi: ${coin}`);
      const news = await fetchNews();
      const analysis = await analyzeCoin(coin, null, news, false);
      let message = `${coin} Analizi (${new Date().toLocaleString('tr-TR')}):\nGiriş: 📉 ${analysis.analyses.giriş.toFixed(2)}, Çıkış: 📈 ${analysis.analyses.çıkış.toFixed(2)}\nYorum: ${analysis.analyses.yorum}`;
      await ctx.reply(message);
      if (ctx.chat.id == GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, message);
      }
      await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: JSON.stringify(analysis.analyses) }).catch(err => console.error('Save analysis error:', err));
    } else {
      console.log('Genel sohbet, metin:', text);
      const prompt = `Kullanıcı mesajı: "${text}". Kripto analiz botusun, kısa ve doğal Türkçe yanıt ver. Coin analizi istersen analiz yap, yoksa sohbet et. 😊`;
      const comment = await rateLimitedCallGrok(prompt);
      await ctx.reply(comment || 'Üzgünüm, bu konuda yorum yapamadım. Bir coin belirtir misin? 🤔');
    }
  } catch (error) {
    console.error('Text handler error:', error);
    await ctx.reply('Bir hata oluştu, lütfen tekrar deneyin. 😓');
  }
});

// Planlanmış grup analizleri
schedule.scheduleJob('0 */12 * * *', async () => {
  console.log('Planlanmış grup analizi başlıyor...');
  try {
    const news = await fetchNews();
    const messages = await fullAnalysis(news);
    for (const message of messages) {
      console.log('Planlanmış grup mesajı:', message);
      await bot.telegram.sendMessage(GROUP_ID, message);
    }
    await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') }).catch(err => console.error('Save analysis error:', err));
  } catch (error) {
    console.error('Scheduled analysis error:', error);
  }
});

// Handle SIGTERM gracefully
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, stopping bot...');
  bot.stop();
  db.close();
  process.exit(0);
});

// Start Bot
if (!isBotStarted) {
  isBotStarted = true;
  bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log('Bot polling modunda başlatıldı.');
  }).catch(err => {
    console.error('Bot launch error:', err);
  });
}

// Heroku PORT
const PORT = process.env.PORT || 3000;
require('http').createServer((req, res) => res.end('Bot çalışıyor')).listen(PORT);

// Genel hata yönetimi
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message, error.stack);
});
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error.message, error.stack);
});
