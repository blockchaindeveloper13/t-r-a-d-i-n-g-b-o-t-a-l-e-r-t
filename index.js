const { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const ccxt = require('ccxt');
const { RSI, MACD, EMA, PSAR, StochasticRSI } = require('technicalindicators');
const axios = require('axios');
const WebSocket = require('ws');
const http = require('http');

// Cache for API responses and analyses
const cache = new Map();
const CACHE_DURATION = 3 * 60 * 1000; // 3 minutes
const CACHE_CLEAR_INTERVAL = 30 * 1000; // 30 seconds

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || 'your-telegram-bot-token');
const parser = new Parser();
const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT'];
const SHORT_TIMEFRAMES = ['1min', '5min', '30min', '1hour'];
const GROUP_ID = '-1002869335730'; // @tradingroup95
let isBotStarted = false;

// Rate limit control for Grok API
const RATE_LIMIT_MS = 500;
let lastGrokRequest = 0;

// Alarm storage
const priceAlarms = new Map(); // coin -> {chatId, targetPrice}

async function rateLimitedCallGrok(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
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

      const response = await axios.post(
        'https://api.x.ai/v1/chat/completions',
        {
          messages: [
            {
              role: 'system',
              content: 'Sen bir kripto para analiz botusun, Grok-4-0709 modelini kullanıyorsun. Kısa vadeli zaman dilimlerini (1min, 5min, 30min, 1hour) inceleyip teknik ve temel analize dayalı kısa, samimi, anlaşılır Türkçe yorum yap (maksimum 300 kelime, kelime sayısını yazma). Güncel fiyat (💰), giriş (📉), kısa vadeli çıkış (4-6 saat, 📈), günlük çıkış (24 saat, 📈), haftalık çıkış (1 hafta, 📈), uzun vadeli çıkış (1-2 hafta, 📈) ve stop-loss (🛑) fiyatını giriş fiyatının altında 1.5 * ATR mesafede belirle. Giriş fiyatını belirlerken fiyatın düşebileceği potansiyel dip seviyelerini (SMA-50, PSAR, Fibonacci %38.2, ATR) analiz et, güncel fiyattan direkt giriş önerme, kâr marjını maksimize et. Kısa vadeli (1sa) ve uzun vadeli (1 hafta) destek/direnç noktaları belirle, her direnç noktası aşılırsa olası fiyat hedeflerini ver. Temel analiz için haberlerin pozitif/negatif etkisini vurgula. Konuşma geçmişini dikkate al, samimi sohbet et.'
            },
            { role: 'user', content: prompt },
          ],
          model: 'grok-4-0709',
          stream: false,
          temperature: 0.7,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.GROK_API_KEY}`,
          },
        }
      );
      let result = response.data.choices[0].message.content.trim();
      // Kelime sayısını kaldır
      result = result.replace(/\(\d+\s+kelime\)/, '').trim();
      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error(`Grok API error (attempt ${i + 1}/${retries}):`, error.response?.data || error.message);
      if (i === retries - 1) return null;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
}

// SQLite setup
function initDB(db) {
  return new Promise((resolve, reject) => {
    db.run(`CREATE TABLE IF NOT EXISTS analizler (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarih TEXT,
      coin TEXT,
      analiz TEXT
    )`, (err) => {
      if (err) return reject(err);
    });
    db.run(`CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      message TEXT,
      timestamp TEXT
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

async function saveChatHistory(db, chatId, message) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO chat_history (chat_id, message, timestamp) VALUES (?, ?, ?)`, [
      chatId,
      message,
      new Date().toLocaleString('tr-TR')
    ], (err) => {
      if (err) {
        console.error('Save chat history error:', err);
        reject(err);
      }
      db.run(`DELETE FROM chat_history WHERE id NOT IN (SELECT id FROM chat_history WHERE chat_id = ? ORDER BY id DESC LIMIT 10)`, [chatId], (err) => {
        if (err) {
          console.error('Delete old chat history error:', err);
          reject(err);
        } else resolve();
      });
    });
  });
}

async function getRecentChatHistory(db, chatId) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT message FROM chat_history WHERE chat_id = ? ORDER BY id DESC LIMIT 10`, [chatId], (err, rows) => {
      if (err) {
        console.error('Get recent chat history error:', err);
        reject(err);
      } else resolve(rows.map(row => row.message));
    });
  });
}

async function getCachedAnalysis(db, coin) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT analiz FROM analizler WHERE coin = ? ORDER BY id DESC LIMIT 1`, [coin], (err, row) => {
      if (err) {
        console.error('Get cached analysis error:', err);
        reject(err);
      } else if (row) {
        const analysis = JSON.parse(row.analiz);
        if (Date.now() - new Date(analysis.tarih).getTime() < CACHE_DURATION) {
          console.log(`Cached analysis found for ${coin}`);
          resolve(analysis);
        } else {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
  });
}

const db = new sqlite3.Database(':memory:');
initDB(db).catch(err => console.error('DB init error:', err));

// News fetching
const RSS_LINKS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss',
  'https://www.newsbtc.com/feed/',
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

// WebSocket for current price
async function getWebSocketToken() {
  try {
    const response = await axios.post('https://api.kucoin.com/api/v1/bullet-public', {}, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log('WebSocket token response:', response.data);
    return response.data.data.token;
  } catch (error) {
    console.error('KuCoin WebSocket token error:', error.response?.data || error.message);
    return null;
  }
}

async function getCoinMarketCapPrice(coin) {
  try {
    const coinId = coin.split('-')[0].toLowerCase();
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
      params: {
        symbol: coinId.toUpperCase(),
        convert: 'USD',
      },
      headers: {
        'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API,
      },
    });
    const price = parseFloat(response.data.data[coinId.toUpperCase()].quote.USD.price);
    console.log(`CoinMarketCap fiyat alındı: ${coin} = ${price}`);
    return price;
  } catch (error) {
    console.error(`CoinMarketCap fiyat hatası: ${coin}`, error.message);
    return null;
  }
}

async function getCoinGeckoPrice(coin) {
  try {
    const coinId = coin.split('-')[0].toLowerCase();
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`);
    const price = parseFloat(response.data[coinId].usd);
    console.log(`CoinGecko fiyat alındı: ${coin} = ${price}`);
    return price;
  } catch (error) {
    console.error(`CoinGecko fiyat hatası: ${coin}`, error.message);
    return null;
  }
}

async function getCurrentPrice(coin) {
  let price = null;
  const token = await getWebSocketToken();
  if (token) {
    price = await new Promise((resolve) => {
      const ws = new WebSocket(`wss://ws-api-spot.kucoin.com?token=${token}&connectId=${Date.now()}`);
      let pingInterval;

      ws.on('open', () => {
        console.log(`WebSocket connected for ${coin} ticker`);
        ws.send(JSON.stringify({
          id: Date.now(),
          type: 'subscribe',
          topic: `/market/ticker:${coin}`,
          response: true,
        }));
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
            ws.close();
            clearInterval(pingInterval);
            resolve(price);
          }
          if (msg.type === 'pong') ws.isAlive = true;
        } catch (error) {
          console.error('WebSocket message error:', error.message);
          resolve(null);
        }
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        resolve(null);
      });

      ws.on('close', () => {
        clearInterval(pingInterval);
      });
    });
  }

  if (!price) {
    console.log(`WebSocket başarısız, CoinMarketCap ile fiyat çekiliyor: ${coin}`);
    price = await getCoinMarketCapPrice(coin);
  }

  if (!price) {
    console.log(`CoinMarketCap başarısız, HTTP ile fiyat çekiliyor: ${coin}`);
    try {
      const response = await axios.get(`https://api.kucoin.com/api/v1/market/stats?symbol=${coin}`);
      price = parseFloat(response.data.data.price);
      console.log(`HTTP fiyat alındı: ${coin} = ${price}`);
    } catch (error) {
      console.error(`HTTP fiyat hatası: ${coin}`, error.message);
      price = await getCoinGeckoPrice(coin);
    }
  }

  if (price) {
    const cmcPrice = await getCoinMarketCapPrice(coin);
    if (cmcPrice && Math.abs(price - cmcPrice) / cmcPrice > 0.1) {
      console.log(`Fiyat uyuşmazlığı: KuCoin=${price}, CoinMarketCap=${cmcPrice}, CoinMarketCap kullanılıyor`);
      price = cmcPrice;
    }
  }
  return price;
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
    ws.send(JSON.stringify({
      id: Date.now(),
      type: 'subscribe',
      topic: `/market/ticker:${coin}`,
      response: true,
    }));
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
        callback({ price: parseFloat(msg.data.price) });
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
    fetchKlines: async () => [],
  };
}

// Analysis functions
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
      .filter(d => d.low > 0 && d.high > 0 && d.low < d.high && d.close > 0);
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

function calculateATR(data) {
  if (!data || data.length < 15) return 0;
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const closes = data.map(d => d.close);
  let trs = [];
  for (let i = 1; i < data.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const atr = trs.slice(-14).reduce((sum, val) => sum + val, 0) / 14;
  return atr;
}

function generateFallbackComment(indicatorsByTimeframe, btcStatus, currentPrice, coin, news) {
  let comment = `BTC durumu: ${btcStatus}. `;
  const validIndicators = Object.values(indicatorsByTimeframe).filter(ind => ind !== null);
  if (!validIndicators.length) return `Veri eksik, ${coin} analizi yapılamadı. Güncel Fiyat: 💰 ${currentPrice ? currentPrice.toFixed(2) : 'Bilinmiyor'}. 😓`;
  const rsiAvg = validIndicators.reduce((sum, ind) => sum + ind.RSI, 0) / validIndicators.length;
  if (rsiAvg < 30) comment += `${coin} kısa vadede aşırı satım bölgesinde, alım fırsatı olabilir. `;
  else if (rsiAvg > 70) comment += `${coin} kısa vadede aşırı alım bölgesinde, satış düşünülebilir. `;
  else comment += `${coin} kısa vadede nötr bölgede. `;
  comment += news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack')) 
    ? `Olumsuz haberler var, dikkatli ol! ` 
    : `Haberler nötr, piyasa sakin görünüyor. `;
  comment += `Güncel Fiyat: 💰 ${currentPrice ? currentPrice.toFixed(2) : 'Bilinmiyor'}.`;
  return comment;
}

async function analyzeCoin(coin, btcData = null, news = [], chatHistory = []) {
  // Önce önbellekteki analizi kontrol et
  const cachedAnalysis = await getCachedAnalysis(db, coin);
  if (cachedAnalysis) {
    return { coin, tarih: cachedAnalysis.tarih, analyses: cachedAnalysis };
  }

  let result = { coin, tarih: new Date().toLocaleString('tr-TR'), analyses: {} };
  let indicatorsByTimeframe = {};

  const currentPrice = await getCurrentPrice(coin);
  const endAt = Math.floor(Date.now() / 1000);
  const startAt = endAt - 24 * 60 * 60;
  const klinesPromises = SHORT_TIMEFRAMES.map(timeframe => fetchHttpKlines(coin, timeframe, startAt, endAt));
  const klinesResults = await Promise.all(klinesPromises);

  for (let i = 0; i < SHORT_TIMEFRAMES.length; i++) {
    const timeframe = SHORT_TIMEFRAMES[i];
    const data = klinesResults[i];
    if (!data.length) continue;

    const indicators = calculateIndicators(data);
    if (indicators) indicatorsByTimeframe[timeframe] = indicators;
  }

  const btcIndicators = btcData ? calculateIndicators(btcData) : null;
  const btcStatus = btcIndicators && btcIndicators.EMA50 > btcIndicators.EMA200 ? 'Yükselişte' : 'Düşüşte';
  const newsSummary = news.length ? news.join('; ') : 'Haber bulunamadı.';
  const atr = calculateATR(klinesResults[SHORT_TIMEFRAMES.indexOf('1hour')]);

  const prompt = `
    ${coin} için kısa vadeli (1min, 5min, 30min, 1hour) teknik ve temel analiz yap.
    İndikatörler: ${JSON.stringify(indicatorsByTimeframe, null, 2)}.
    Güncel fiyat: ${currentPrice ? currentPrice.toFixed(2) : 'Bilinmiyor'}.
    ATR (1sa): ${atr.toFixed(2)}.
    BTC durumu: ${btcStatus}, Haberler: ${newsSummary}.
    Son 10 konuşma: ${chatHistory.join('; ')}.
    Giriş (📉) fiyatını belirlerken fiyatın düşebileceği potansiyel dip seviyelerini (SMA-50, PSAR, Fibonacci %38.2, ATR) analiz et, güncel fiyattan direkt giriş önerme, kâr marjını maksimize et. 
    Çıkış (📈) için:
      - Kısa vadeli (4-6 saat) hedef,
      - Günlük (24 saat) hedef,
      - Haftalık (1 hafta) hedef,
      - Uzun vadeli (1-2 hafta) hedef ver.
    Stop-loss (🛑) fiyatını giriş fiyatının altında, 1.5 * ATR mesafede belirle.
    Kısa vadeli (1sa) ve uzun vadeli (1 hafta) destek/direnç noktaları belirle. Her direnç noktası aşılırsa olası fiyat hedeflerini ver.
    Kısa, samimi Türkçe yorum (maksimum 300 kelime, kelime sayısını yazma). Haberlerin pozitif/negatif etkisini vurgula.`;
  let comment = await rateLimitedCallGrok(prompt);
  if (!comment) {
    comment = generateFallbackComment(indicatorsByTimeframe, btcStatus, currentPrice, coin, news);
  }

  let dip = currentPrice || 0;
  let shortTp = currentPrice ? currentPrice * 1.05 : 0;
  let dailyTp = currentPrice ? currentPrice * 1.1 : 0;
  let weeklyTp = currentPrice ? currentPrice * 1.2 : 0;
  let longTp = currentPrice ? currentPrice * 1.3 : 0;
  let stopLoss = dip - 1.5 * atr;
  let shortTermSupport = currentPrice ? currentPrice * 0.98 : 0;
  let shortTermResistance = currentPrice ? currentPrice * 1.03 : 0;
  let longTermSupport = currentPrice ? currentPrice * 0.95 : 0;
  let longTermResistance = currentPrice ? currentPrice * 1.15 : 0;
  let shortTermResistanceTarget = shortTermResistance * 1.1;
  let longTermResistanceTarget = longTermResistance * 1.2;

  const priceMatch = comment.match(/📉 (\d+\.?\d*)/);
  const shortTpMatch = comment.match(/Kısa vadeli 📈 (\d+\.?\d*)/);
  const dailyTpMatch = comment.match(/Günlük 📈 (\d+\.?\d*)/);
  const weeklyTpMatch = comment.match(/Haftalık 📈 (\d+\.?\d*)/);
  const longTpMatch = comment.match(/Uzun vadeli 📈 (\d+\.?\d*)/);
  const stopLossMatch = comment.match(/🛑 (\d+\.?\d*)/);
  const shortTermSupportMatch = comment.match(/Kısa vadeli destek: (\d+\.?\d*)/);
  const shortTermResistanceMatch = comment.match(/Kısa vadeli direnç: (\d+\.?\d*)/);
  const longTermSupportMatch = comment.match(/Uzun vadeli destek: (\d+\.?\d*)/);
  const longTermResistanceMatch = comment.match(/Uzun vadeli direnç: (\d+\.?\d*)/);
  const shortTermResistanceTargetMatch = comment.match(/Kısa vadeli direnç aşılırsa hedef: (\d+\.?\d*)/);
  const longTermResistanceTargetMatch = comment.match(/Uzun vadeli direnç aşılırsa hedef: (\d+\.?\d*)/);

  if (priceMatch) {
    dip = parseFloat(priceMatch[1]);
    shortTp = shortTpMatch ? parseFloat(shortTpMatch[1]) : dip * 1.05;
    dailyTp = dailyTpMatch ? parseFloat(dailyTpMatch[1]) : dip * 1.1;
    weeklyTp = weeklyTpMatch ? parseFloat(weeklyTpMatch[1]) : dip * 1.2;
    longTp = longTpMatch ? parseFloat(longTpMatch[1]) : dip * 1.3;
    stopLoss = stopLossMatch ? parseFloat(stopLossMatch[1]) : dip - 1.5 * atr;
    shortTermSupport = shortTermSupportMatch ? parseFloat(shortTermSupportMatch[1]) : dip * 0.98;
    shortTermResistance = shortTermResistanceMatch ? parseFloat(shortTermResistanceMatch[1]) : dip * 1.03;
    longTermSupport = longTermSupportMatch ? parseFloat(longTermSupportMatch[1]) : dip * 0.95;
    longTermResistance = longTermResistanceMatch ? parseFloat(longTermResistanceMatch[1]) : dip * 1.15;
    shortTermResistanceTarget = shortTermResistanceTargetMatch ? parseFloat(shortTermResistanceTargetMatch[1]) : shortTermResistance * 1.1;
    longTermResistanceTarget = longTermResistanceTargetMatch ? parseFloat(longTermResistanceTargetMatch[1]) : longTermResistance * 1.2;
  }

  result.analyses = {
    giriş: dip,
    shortTermÇıkış: shortTp,
    dailyÇıkış: dailyTp,
    weeklyÇıkış: weeklyTp,
    longTermÇıkış: longTp,
    stopLoss,
    shortTermSupport,
    shortTermResistance,
    longTermSupport,
    longTermResistance,
    shortTermResistanceTarget,
    longTermResistanceTarget,
    currentPrice,
    yorum: comment,
    indicators: indicatorsByTimeframe,
  };

  // Analizi veritabanına kaydet
  await saveAnalysis(db, { tarih: result.tarih, coin, analiz: JSON.stringify(result.analyses) });
  return result;
}

async function fullAnalysis(news, chatHistory) {
  const btcData = await fetchHttpKlines('BTC-USDT', '1hour', Math.floor(Date.now() / 1000) - 24 * 60 * 60, Math.floor(Date.now() / 1000));
  const messages = [];
  for (const coin of COINS) {
    const analysis = await analyzeCoin(coin, btcData, news, chatHistory);
    let message = `${coin} Analizi (${new Date().toLocaleString('tr-TR')}):\n`;
    message += `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice ? analysis.analyses.currentPrice.toFixed(2) : 'Bilinmiyor'}\n`;
    message += `  Giriş: 📉 ${analysis.analyses.giriş.toFixed(2)}\n`;
    message += `  Kısa Vadeli Çıkış (4-6 saat): 📈 ${analysis.analyses.shortTermÇıkış.toFixed(2)}\n`;
    message += `  Günlük Çıkış (24 saat): 📈 ${analysis.analyses.dailyÇıkış.toFixed(2)}\n`;
    message += `  Haftalık Çıkış (1 hafta): 📈 ${analysis.analyses.weeklyÇıkış.toFixed(2)}\n`;
    message += `  Uzun Vadeli Çıkış (1-2 hafta): 📈 ${analysis.analyses.longTermÇıkış.toFixed(2)}\n`;
    message += `  Stop-Loss: 🛑 ${analysis.analyses.stopLoss.toFixed(2)}\n`;
    message += `  Kısa Vadeli Destek (1sa): ${analysis.analyses.shortTermSupport.toFixed(2)}\n`;
    message += `  Kısa Vadeli Direnç (1sa): ${analysis.analyses.shortTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.shortTermResistanceTarget.toFixed(2)})\n`;
    message += `  Uzun Vadeli Destek (1hf): ${analysis.analyses.longTermSupport.toFixed(2)}\n`;
    message += `  Uzun Vadeli Direnç (1hf): ${analysis.analyses.longTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.longTermResistanceTarget.toFixed(2)})\n`;
    message += `  Yorum: ${analysis.analyses.yorum}\n`;
    const negative = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));
    if (negative && coin.includes('BTC')) {
      message += `  Alarm: Bitcoin düşüyor, dikkat! Tahmini dip: 📉 ${analysis.analyses.giriş.toFixed(2)}. 🚨\n`;
    }
    messages.push(message);
  }
  return messages;
}

// Telegram Commands
bot.command('start', async (ctx) => {
  console.log('Start komutu alındı, chat ID:', ctx.chat.id);
  await ctx.reply('Merhaba! Kripto analiz botu hazır. /analiz coin ile başla (ör. /analiz ADA) veya coin sor (ör. "ADA ne durumda?"). Fiyat alarmı için /alarm_kur coin fiyat (ör. /alarm_kur XLM 0.50). 😎');
  await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
});

bot.command(/analiz(?:@traderbot95_bot)?/, async (ctx) => {
  console.log('Analiz komutu alındı, chat ID:', ctx.chat.id);
  const args = ctx.message.text.split(' ').slice(1);
  const coin = args.length ? args[0].toUpperCase() + '-USDT' : null;
  try {
    if (!coin || !COINS.includes(coin)) {
      await ctx.reply('Lütfen geçerli bir coin belirt (ör. /analiz ADA). 😊');
      return;
    }
    const news = await fetchNews();
    const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
    await ctx.reply(`${coin.split('-')[0]}'yı analiz ediyorum, biraz bekle! 😎`);
    
    // Önbellekteki analizi kontrol et
    const cachedAnalysis = await getCachedAnalysis(db, coin);
    let analysis;
    if (cachedAnalysis) {
      analysis = { coin, tarih: cachedAnalysis.tarih, analyses: cachedAnalysis };
    } else {
      analysis = await analyzeCoin(coin, null, news, chatHistory);
    }

    let message = `${coin} Analizi (${new Date(analysis.tarih).toLocaleString('tr-TR')}):\n`;
    message += `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice ? analysis.analyses.currentPrice.toFixed(2) : 'Bilinmiyor'}\n`;
    message += `  Giriş: 📉 ${analysis.analyses.giriş.toFixed(2)}\n`;
    message += `  Kısa Vadeli Çıkış (4-6 saat): 📈 ${analysis.analyses.shortTermÇıkış.toFixed(2)}\n`;
    message += `  Günlük Çıkış (24 saat): 📈 ${analysis.analyses.dailyÇıkış.toFixed(2)}\n`;
    message += `  Haftalık Çıkış (1 hafta): 📈 ${analysis.analyses.weeklyÇıkış.toFixed(2)}\n`;
    message += `  Uzun Vadeli Çıkış (1-2 hafta): 📈 ${analysis.analyses.longTermÇıkış.toFixed(2)}\n`;
    message += `  Stop-Loss: 🛑 ${analysis.analyses.stopLoss.toFixed(2)}\n`;
    message += `  Kısa Vadeli Destek (1sa): ${analysis.analyses.shortTermSupport.toFixed(2)}\n`;
    message += `  Kısa Vadeli Direnç (1sa): ${analysis.analyses.shortTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.shortTermResistanceTarget.toFixed(2)})\n`;
    message += `  Uzun Vadeli Destek (1hf): ${analysis.analyses.longTermSupport.toFixed(2)}\n`;
    message += `  Uzun Vadeli Direnç (1hf): ${analysis.analyses.longTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.longTermResistanceTarget.toFixed(2)})\n`;
    message += `  Yorum: ${analysis.analyses.yorum}\n`;
    await ctx.reply(message);
    if (ctx.chat.id.toString() === GROUP_ID) {
      await bot.telegram.sendMessage(GROUP_ID, message);
    }
    if (!cachedAnalysis) {
      await saveAnalysis(db, { tarih: analysis.tarih, coin, analiz: JSON.stringify(analysis.analyses) });
    }
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    console.error('Analiz command error:', error);
    await ctx.reply('Analiz sırasında hata oluştu, lütfen tekrar deneyin. 😓');
  }
});

bot.command('alarm_kur', async (ctx) => {
  console.log('Alarm kur komutu alındı, chat ID:', ctx.chat.id);
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 2) {
    const [coin, price] = args;
    const coinPair = coin.toUpperCase() + '-USDT';
    if (!COINS.includes(coinPair)) {
      await ctx.reply('Lütfen geçerli bir coin belirt (ör. /alarm_kur ADA 1.50). 😊');
      return;
    }
    const targetPrice = parseFloat(price);
    if (isNaN(targetPrice)) {
      await ctx.reply('Geçerli bir fiyat gir (ör. /alarm_kur XLM 0.50). 😊');
      return;
    }
    await ctx.reply(`${coin} için ${price} alarmını kuruyorum, biraz bekle! 😎`);
    priceAlarms.set(`${coinPair}-${ctx.chat.id}`, { chatId: ctx.chat.id.toString(), targetPrice });
    const { startPriceWebSocket } = startWebSocket(coinPair, targetPrice, async ({ price: currentPrice }) => {
      if (Math.abs(currentPrice - targetPrice) <= 0.01 * targetPrice) {
        try {
          const news = await fetchNews();
          const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
          const cachedAnalysis = await getCachedAnalysis(db, coinPair);
          let analysis;
          if (cachedAnalysis) {
            analysis = { coin: coinPair, tarih: cachedAnalysis.tarih, analyses: cachedAnalysis };
          } else {
            analysis = await analyzeCoin(coinPair, null, news, chatHistory);
          }
          let message = `Alarm: ${coin} ${currentPrice.toFixed(2)}'e ${currentPrice <= targetPrice ? 'düştü' : 'çıktı'}! 🚨\n`;
          message += `${coin} Analizi (${new Date(analysis.tarih).toLocaleString('tr-TR')}):\n`;
          message += `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice ? analysis.analyses.currentPrice.toFixed(2) : 'Bilinmiyor'}\n`;
          message += `  Giriş: 📉 ${analysis.analyses.giriş.toFixed(2)}\n`;
          message += `  Kısa Vadeli Çıkış (4-6 saat): 📈 ${analysis.analyses.shortTermÇıkış.toFixed(2)}\n`;
          message += `  Günlük Çıkış (24 saat): 📈 ${analysis.analyses.dailyÇıkış.toFixed(2)}\n`;
          message += `  Haftalık Çıkış (1 hafta): 📈 ${analysis.analyses.weeklyÇıkış.toFixed(2)}\n`;
          message += `  Uzun Vadeli Çıkış (1-2 hafta): 📈 ${analysis.analyses.longTermÇıkış.toFixed(2)}\n`;
          message += `  Stop-Loss: 🛑 ${analysis.analyses.stopLoss.toFixed(2)}\n`;
          message += `  Kısa Vadeli Destek (1sa): ${analysis.analyses.shortTermSupport.toFixed(2)}\n`;
          message += `  Kısa Vadeli Direnç (1sa): ${analysis.analyses.shortTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.shortTermResistanceTarget.toFixed(2)})\n`;
          message += `  Uzun Vadeli Destek (1hf): ${analysis.analyses.longTermSupport.toFixed(2)}\n`;
          message += `  Uzun Vadeli Direnç (1hf): ${analysis.analyses.longTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.longTermResistanceTarget.toFixed(2)})\n`;
          message += `  Yorum: ${analysis.analyses.yorum}\n`;
          await ctx.reply(message);
          if (ctx.chat.id.toString() === GROUP_ID) {
            await bot.telegram.sendMessage(GROUP_ID, message);
          }
          await bot.telegram.sendMessage('1616739367', message);
          priceAlarms.delete(`${coinPair}-${ctx.chat.id}`);
          if (!cachedAnalysis) {
            await saveAnalysis(db, { tarih: analysis.tarih, coin: coinPair, analiz: JSON.stringify(analysis.analyses) });
          }
        } catch (error) {
          console.error('Alarm error:', error);
          await ctx.reply(`Alarm: ${coin} ${currentPrice.toFixed(2)}'e ulaştı, ancak analiz alınamadı. 😓`);
        }
      }
    });
    startPriceWebSocket(coinPair, targetPrice, () => {});
    await ctx.reply(`${coin} için ${price} alarmı kuruldu. 🔔`);
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } else {
    await ctx.reply('Kullanım: /alarm_kur coin fiyat (ör. /alarm_kur XLM 0.50)');
  }
});

bot.command('clear_history', async (ctx) => {
  console.log('Clear history komutu alındı, chat ID:', ctx.chat.id);
  try {
    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM chat_history WHERE chat_id = ?`, [ctx.chat.id.toString()], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    await ctx.reply('Konuşma geçmişi temizlendi! 😎 Artık sıfırdan başlıyoruz.');
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    console.error('Clear history error:', error);
    await ctx.reply('Geçmişi temizlerken hata oluştu, tekrar deneyin. 😓');
  }
});

// Handle all text messages
bot.on('text', async (ctx) => {
  console.log('Metin alındı, chat ID:', ctx.chat.id, 'text:', ctx.message.text);
  const text = ctx.message.text.toLowerCase();
  const coin = COINS.find(c => text.includes(c.split('-')[0].toLowerCase()));
  try {
    const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);

    // Sadece fiyat sorulmuşsa
    if (text.match(/^(.*\s*)?fiyat(\s*.*)?$/)) {
      if (coin) {
        const price = await getCurrentPrice(coin);
        await ctx.reply(`${coin.split('-')[0]} Güncel Fiyat: 💰 ${price ? price.toFixed(2) : 'Bilinmiyor'} USDT`);
        return;
      } else {
        await ctx.reply('Lütfen bir coin belirt (ör. "ADA fiyatı"). 😊');
        return;
      }
    }

    if (coin) {
      console.log(`Coin analizi: ${coin}`);
      await ctx.reply(`${coin.split('-')[0]}'yı hemen kontrol ediyorum! 😎`);
      const news = await fetchNews();
      
      // Önbellekteki analizi kontrol et
      const cachedAnalysis = await getCachedAnalysis(db, coin);
      let analysis;
      if (cachedAnalysis) {
        analysis = { coin, tarih: cachedAnalysis.tarih, analyses: cachedAnalysis };
      } else {
        analysis = await analyzeCoin(coin, null, news, chatHistory);
      }

      let message = `${coin} Analizi (${new Date(analysis.tarih).toLocaleString('tr-TR')}):\n`;
      message += `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice ? analysis.analyses.currentPrice.toFixed(2) : 'Bilinmiyor'}\n`;
      message += `  Giriş: 📉 ${analysis.analyses.giriş.toFixed(2)}\n`;
      message += `  Kısa Vadeli Çıkış (4-6 saat): 📈 ${analysis.analyses.shortTermÇıkış.toFixed(2)}\n`;
      message += `  Günlük Çıkış (24 saat): 📈 ${analysis.analyses.dailyÇıkış.toFixed(2)}\n`;
      message += `  Haftalık Çıkış (1 hafta): 📈 ${analysis.analyses.weeklyÇıkış.toFixed(2)}\n`;
      message += `  Uzun Vadeli Çıkış (1-2 hafta): 📈 ${analysis.analyses.longTermÇıkış.toFixed(2)}\n`;
      message += `  Stop-Loss: 🛑 ${analysis.analyses.stopLoss.toFixed(2)}\n`;
      message += `  Kısa Vadeli Destek (1sa): ${analysis.analyses.shortTermSupport.toFixed(2)}\n`;
      message += `  Kısa Vadeli Direnç (1sa): ${analysis.analyses.shortTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.shortTermResistanceTarget.toFixed(2)})\n`;
      message += `  Uzun Vadeli Destek (1hf): ${analysis.analyses.longTermSupport.toFixed(2)}\n`;
      message += `  Uzun Vadeli Direnç (1hf): ${analysis.analyses.longTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.longTermResistanceTarget.toFixed(2)})\n`;
      message += `  Yorum: ${analysis.analyses.yorum}`;
      await ctx.reply(message);
      if (ctx.chat.id.toString() === GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, message);
      }
      if (!cachedAnalysis) {
        await saveAnalysis(db, { tarih: analysis.tarih, coin, analiz: JSON.stringify(analysis.analyses) });
      }
    } else if (text.includes('grok') && (text.includes('versiyon') || text.includes('model'))) {
      await ctx.reply('Haha, kanka, ben Grok-4-0709 modelini kullanıyorum, xAI’nin en son harikası! 😎 Kripto analizleri için tam gaz buradayım. Başka neyi merak ediyorsun, XLM mi, AAVE mi, yoksa başka bi’ coin mi? 🚀');
    } else {
      console.log('Genel sohbet, metin:', text);
      const prompt = `Kullanıcı mesajı: "${text}". Son 10 konuşma: ${chatHistory.join('; ')}. Sen Grok-4-0709’sun, kripto analiz botusun, kısa ve doğal Türkçe yanıt ver, sohbet tarzında, kelime sayısını yazma. Coin analizi istersen analiz yap, yoksa bağlama uygun samimi sohbet et. 😊`;
      const comment = await rateLimitedCallGrok(prompt);
      await ctx.reply(comment || 'Üzgünüm, bu konuda yorum yapamadım. Bir coin belirtir misin ya da başka ne konuşalım? 🤔');
    }
  } catch (error) {
    console.error('Text handler error:', error);
    await ctx.reply('Bir hata oluştu, lütfen tekrar deneyin. 😓');
  }
});

// Scheduled full analysis
schedule.scheduleJob('0 */12 * * *', async () => {
  console.log('Planlanmış grup analizi başlıyor...');
  try {
    const news = await fetchNews();
    const chatHistory = await getRecentChatHistory(db, GROUP_ID);
    const messages = await fullAnalysis(news, chatHistory);
    for (const message of messages) {
      console.log('Planlanmış grup mesajı:', message);
      await bot.telegram.sendMessage(GROUP_ID, message);
    }
    await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') });
  } catch (error) {
    console.error('Scheduled analysis error:', error);
  }
});

// Keep-alive ping for Heroku
const server = http.createServer((req, res) => res.end('Bot çalışıyor'));
server.listen(process.env.PORT || 3000);
setInterval(() => {
  http.get(`http://${process.env.HEROKU_APP_NAME || 'localhost'}:${process.env.PORT || 3000}`, (res) => {
    console.log('Keep-alive ping sent:', res.statusCode);
  }).on('error', (err) => {
    console.error('Keep-alive ping error:', err.message);
  });
}, 5 * 60 * 1000); // Every 5 minutes

// Cache cleanup
setInterval(() => cache.clear(), CACHE_CLEAR_INTERVAL);

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, stopping bot...');
  bot.stop();
  db.close();
  server.close();
  process.exit(0);
});

// Start Bot
if (!isBotStarted) {
  isBotStarted = true;
  const startBot = async () => {
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log('Bot polling modunda başlatıldı.');
    } catch (err) {
      console.error('Bot launch error:', err);
      setTimeout(startBot, 5000); // Retry after 5 seconds
    }
  };
  startBot();
}

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message, error.stack);
});
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error.message, error.stack);
});
