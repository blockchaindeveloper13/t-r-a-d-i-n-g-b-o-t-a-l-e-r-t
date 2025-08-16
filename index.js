const { Telegraf, Markup } = require('telegraf');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const ccxt = require('ccxt');
const { RSI, MACD, EMA, PSAR, StochasticRSI } = require('technicalindicators');
const axios = require('axios');
const WebSocket = require('ws');
const http = require('http');

// Cache for API responses, analyses, and Bitcoin signals
const cache = new Map();
const CACHE_DURATION = 2 * 60 * 60 * 1000; // 2 hours
const CACHE_CLEAR_INTERVAL = 30 * 1000; // 30 seconds
const BITCOIN_SIGNAL_COOLDOWN = 2 * 60 * 60 * 1000; // 2 hours cooldown for same signal type

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || 'your-telegram-bot-token');
const parser = new Parser();
const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT', 'ETH-USDT'];
const SHORT_TIMEFRAMES = ['1min', '5min', '30min', '1hour'];
const GROUP_ID = '-1002869335730'; // @tradingroup95
let isBotStarted = false;
let isBitcoinMonitoringPaused = false;
let pauseEndTime = 0;

// Rate limit control for APIs
const RATE_LIMIT_MS = 500;
let lastGrokRequest = 0;

// Deduplication for sent messages and Bitcoin signals
const sentMessages = new Set();
const lastBitcoinSignal = { type: null, timestamp: 0, price: 0, comment: null };

// Alarm storage
const priceAlarms = new Map(); // coin -> {chatId, targetPrice}

// Rate limit for Grok API
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
              content: 'Sen bir kripto para analiz botusun, Grok-4-0709 modelini kullanıyorsun. Kısa vadeli zaman dilimlerini (1min, 5min, 30min, 1hour) inceleyip teknik ve temel analize dayalı kısa, samimi, anlaşılır Türkçe yorum yap (maksimum 300 kelime, kelime sayısını yazma). Güncel fiyat (💰), giriş (📉), kısa vadeli çıkış (4-6 saat, 📈), günlük çıkış (24 saat, 📈), haftalık çıkış (1 hafta, 📈), uzun vadeli çıkış (1-2 hafta, 📈) ve stop-loss (🛑) fiyatını giriş fiyatının altında 1.5 * ATR mesafede belirle. Giriş fiyatını belirlerken fiyatın düşebileceği potansiyel dip seviyelerini (SMA-50, PSAR, Fibonacci %38.2, ATR) analiz et, güncel fiyattan direkt giriş önerme, kâr marjını maksimize et. Kısa vadeli (1sa) ve uzun vadeli (1 hafta) destek/direnç noktaları belirle, her direnç noktası aşılırsa olası fiyat hedeflerini ver. Temel analiz için haberlerin ve CoinMarketCal etkinliklerinin pozitif/negatif etkisini vurgula. Konuşma geçmişini dikkate al, samimi sohbet et. Kullanıcı "yeniden analiz yap" demedikçe önbellekteki son analizi kullan, yeni analiz yapma. "Yeniden analiz yap" denirse yeni analiz yap ve önbelleği güncelle. Serbest metin mesajlarında coin adı geçiyorsa analizi veya durumu döndür, yoksa samimi bir şekilde sohbet et.'
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
      result = result.replace(/\(\d+\s+kelime\)/, '').trim();
      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.error(`Grok API error (attempt ${i + 1}/${retries}):`, error.response?.data || error.message);
      if (i === retries - 1) return null;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// Rate limit for CoinMarketCal API
async function rateLimitedCallCoinMarketCal(url, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const now = Date.now();
      if (now - lastGrokRequest < RATE_LIMIT_MS) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - (now - lastGrokRequest)));
      }
      lastGrokRequest = Date.now();
      const cacheKey = `${url}-${JSON.stringify(params)}`;
      if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_DURATION) {
          console.log('Cache hit for CoinMarketCal:', cacheKey);
          return cached.data;
        }
      }
      const response = await axios.get(url, {
        headers: {
          'x-api-key': process.env.COINMARKETCAL_API_KEY,
          'Accept': 'application/json',
          'Accept-Encoding': 'deflate, gzip',
        },
        params,
      });
      cache.set(cacheKey, { data: response.data.body, timestamp: Date.now() });
      return response.data.body;
    } catch (error) {
      console.error(`CoinMarketCal API error (attempt ${i + 1}/${retries}):`, error.message);
      if (i === retries - 1) return null;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
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
    db.get(`SELECT analiz, tarih FROM analizler WHERE coin = ? ORDER BY id DESC LIMIT 1`, [coin], (err, row) => {
      if (err) {
        console.error('Get cached analysis error:', err);
        reject(err);
      } else if (row) {
        const analysis = JSON.parse(row.analiz);
        analysis.tarih = row.tarih;
        if (Date.now() - new Date(row.tarih).getTime() < CACHE_DURATION) {
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

// News and CoinMarketCal fetching
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
  // CoinMarketCal etkinlikleri
  const { top100 } = await getTopCoinsFromCMCAndCMCal();
  const events = await fetchTopCoinEvents(top100);
  news.push(...events.map(e => `${e.coin}: ${e.title} (${e.date})`));
  return news;
}

// CoinMarketCal coin listesi
async function fetchCoinMarketCalCoins() {
  try {
    const coins = await rateLimitedCallCoinMarketCal('https://developers.coinmarketcal.com/v1/coins', {});
    return coins.map(coin => ({
      id: coin.id,
      symbol: coin.symbol.toUpperCase(),
      name: coin.name,
      popular: coin.popular,
      influential: coin.influential,
      catalyst: coin.catalyst,
      upcoming: coin.upcoming,
    }));
  } catch (error) {
    console.error('CoinMarketCal coins fetch error:', error.message);
    return [];
  }
}

// CoinMarketCal etkinlikleri
async function fetchTopCoinEvents(coins, filter = 'catalyst_events') {
  try {
    const symbols = coins.map(coin => coin.symbol.toLowerCase()).join(',');
    const events = await rateLimitedCallCoinMarketCal('https://developers.coinmarketcal.com/v1/events', {
      coins: symbols,
      max: 50,
      sortBy: filter,
      showOnly: filter,
      dateRangeStart: new Date().toISOString().split('T')[0], // Bugün
      dateRangeEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 1 hafta sonrası
      showVotes: true,
      showViews: true,
      translations: 'tr', // Türkçe çeviriler
    });
    return events.map(event => ({
      coin: event.coin,
      title: event.title,
      date: event.displayed_date,
      impact: event.is_popular || event.catalyst_score > 0 ? 'Positive' : 'Neutral',
      catalystScore: event.catalyst_score || 0,
      viewCount: event.view_count || 0,
      voteCount: event.vote_count || 0,
    }));
  } catch (error) {
    console.error('CoinMarketCal events error:', error.message);
    return [];
  }
}

// CoinMarketCal etkinliklerini Grok ile yorumlama
async function analyzeCoinMarketCalEvents(events, chatHistory) {
  const eventSummaries = events.map(e => `${e.coin}: ${e.title} (${e.date}, Etki: ${e.impact}, Catalyst Skor: ${e.catalystScore})`).join('; ');
  const prompt = `
    CoinMarketCal’dan gelen etkinlikler: ${eventSummaries}.
    Her etkinliği (token yakma, kilit açılışı, borsa listelenmesi vb.) tarihleriyle oku ve fiyat üzerindeki potansiyel etkisini Türkçe, samimi, kısa bir şekilde yorumla (her etkinlik için maks. 100 kelime). 
    Fırsat coin’lerini belirle, neden fırsat olduğunu açıkla (örn. token yakma arzı azaltır, fiyat artabilir). 
    Teknik analiz verisi olmadan sadece etkinliklere odaklan. 
    Son 10 konuşma: ${chatHistory.join('; ')}.
    Yorumlar trader’lara hitap etsin, alım/satım önerisi ver, stop-loss ve hedef fiyat belirtme.
  `;
  const comment = await rateLimitedCallGrok(prompt);
  return comment || 'Etkinlikler analiz edilemedi, lütfen tekrar dene kanka! 😓';
}

// CoinMarketCap top 100 ve top 500
async function fetchTopCoinsCMC(limit, start) {
  try {
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
      headers: { 'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY },
      params: { start, limit, convert: 'USD' },
    });
    return response.data.data.map(coin => ({
      symbol: coin.symbol,
      name: coin.name,
      marketCap: coin.quote.USD.market_cap,
      price: coin.quote.USD.price,
      volume24h: coin.quote.USD.volume_24h,
      percentChange24h: coin.quote.USD.percent_change_24h,
      percentChange7d: coin.quote.USD.percent_change_7d,
    }));
  } catch (error) {
    console.error('CoinMarketCap API error:', error.message);
    return [];
  }
}

async function getTopCoinsFromCMCAndCMCal() {
  const cmcalCoins = await fetchCoinMarketCalCoins();
  const cmcCoins = [
    ...(await fetchTopCoinsCMC(100, 1)), // Top 100
    ...(await fetchTopCoinsCMC(400, 101)), // 101-500
  ];

  const topCoins = cmcCoins
    .filter(cmc => cmcalCoins.some(cmcal => cmcal.symbol === cmc.symbol))
    .sort((a, b) => b.marketCap - a.marketCap);

  return {
    top100: topCoins.slice(0, 100),
    top500: topCoins.slice(0, 500),
  };
}

// Fırsat coin’leri bulma
async function findOpportunityCoins() {
  const { top100, top500 } = await getTopCoinsFromCMCAndCMCal();
  const opportunities = [];

  for (const coin of [...top100, ...top500.slice(100)]) {
    const events = await fetchTopCoinEvents([coin]);
    const klines = await fetchHttpKlines(`${coin.symbol}-USDT`, '1hour');
    const indicators = calculateIndicators(klines);
    const price = await getCurrentPrice(`${coin.symbol}-USDT`);

    let score = 0;
    if (events.some(e => e.impact === 'Positive')) score += 50;
    if (events.some(e => e.catalystScore > 0)) score += 30;
    if (events.some(e => e.viewCount > 1000)) score += 10;
    if (events.length > 0) score += 20;

    if (indicators?.RSI < 30) score += 30;
    if (indicators?.MACD > 0 && indicators.MACD > indicators.signal) score += 20;
    if (coin.volume24h > coin.marketCap * 0.05) score += 10;
    if (coin.percentChange7d < -10 && coin.percentChange7d > -30) score += 15;

    if (score > 50) {
      opportunities.push({
        coin: coin.symbol,
        score,
        events,
        indicators,
        price,
        marketCap: coin.marketCap,
      });
    }
  }

  return opportunities.sort((a, b) => b.score - a.score).slice(0, 10);
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

async function getKucoinWebSocketPrice(coin) {
  const token = await getWebSocketToken();
  if (!token) {
    console.error('KuCoin WebSocket token alınamadı.');
    return null;
  }

  return new Promise((resolve) => {
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

async function getCoinMarketCapPrice(coin) {
  try {
    const coinId = coin.split('-')[0].toLowerCase();
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
      params: {
        symbol: coinId.toUpperCase(),
        convert: 'USD',
      },
      headers: {
        'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY,
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
  let price = await getKucoinWebSocketPrice(coin);
  if (!price) {
    console.log(`KuCoin WebSocket başarısız, HTTP ile fiyat çekiliyor: ${coin}`);
    try {
      const response = await axios.get(`https://api.kucoin.com/api/v1/market/stats?symbol=${coin}`);
      price = parseFloat(response.data.data.price);
      console.log(`HTTP fiyat alındı: ${coin} = ${price}`);
    } catch (error) {
      console.error(`KuCoin HTTP fiyat hatası: ${coin}`, error.message);
      price = await getCoinMarketCapPrice(coin);
    }
  }

  if (!price) {
    console.log(`CoinMarketCap başarısız, CoinGecko ile fiyat çekiliyor: ${coin}`);
    price = await getCoinGeckoPrice(coin);
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

// WebSocket for price alarms
async function startWebSocket(coin, targetPrice, chatId, callback) {
  const token = await getWebSocketToken();
  if (!token) {
    console.error('WebSocket token alınamadı, HTTP ile fiyat takibi deneniyor.');
    try {
      const price = await getCurrentPrice(coin);
      if (price && Math.abs(price - targetPrice) <= 0.01 * targetPrice) {
        callback({ price });
      }
      return {
        startPriceWebSocket: () => {},
        stop: () => {}
      };
    } catch (error) {
      console.error('HTTP fiyat kontrolü hatası:', error.message);
      return {
        startPriceWebSocket: () => {},
        stop: () => {}
      };
    }
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
    console.log(`WebSocket closed for ${coin}, reconnecting...`);
    clearInterval(pingInterval);
    setTimeout(() => startWebSocket(coin, targetPrice, chatId, callback), 5000);
  });

  return {
    startPriceWebSocket: () => {},
    stop: () => {
      ws.close();
      clearInterval(pingInterval);
    }
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
      .filter(d => d.low > 0 && d.high > 0 && d.close > 0);
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
      signal: MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes }).slice(-1)[0]?.signal || 0,
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

async function analyzeCoin(coin, btcData = null, news = [], chatHistory = [], forceReanalyze = false) {
  if (!forceReanalyze) {
    const cachedAnalysis = await getCachedAnalysis(db, coin);
    if (cachedAnalysis) {
      return { coin, tarih: cachedAnalysis.tarih, analyses: cachedAnalysis };
    }
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
    BTC durumu: ${btcStatus}, Haberler ve Etkinlikler: ${newsSummary}.
    Son 10 konuşma: ${chatHistory.join('; ')}.
    Giriş (📉) fiyatını belirlerken fiyatın düşebileceği potansiyel dip seviyelerini (SMA-50, PSAR, Fibonacci %38.2, ATR) analiz et, güncel fiyattan direkt giriş önerme, kâr marjını maksimize et. 
    Çıkış (📈) için:
      - Kısa vadeli (4-6 saat) hedef,
      - Günlük (24 saat) hedef,
      - Haftalık (1 hafta) hedef,
      - Uzun vadeli (1-2 hafta) hedef ver.
    Stop-loss (🛑) fiyatını giriş fiyatının altında, 1.5 * ATR mesafede belirle.
    Kısa vadeli (1sa) ve uzun vadeli (1 hafta) destek/direnç noktaları belirle. Her direnç noktası aşılırsa olası fiyat hedeflerini ver.
    Kısa, samimi Türkçe yorum (maksimum 300 kelime, kelime sayısını yazma). Haberlerin ve etkinliklerin pozitif/negatif etkisini vurgula.`;
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

  await saveAnalysis(db, { tarih: result.tarih, coin, analiz: JSON.stringify(result.analyses) });
  return result;
}

async function fullAnalysis(news, chatHistory) {
  const btcData = await fetchHttpKlines('BTC-USDT', '1hour', Math.floor(Date.now() / 1000) - 24 * 60 * 60, Math.floor(Date.now() / 1000));
  const messages = [];
  for (const coin of COINS) {
    const analysis = await analyzeCoin(coin, btcData, news, chatHistory);
    const messageId = `${coin}-${analysis.tarih}`;
    if (sentMessages.has(messageId)) continue;
    sentMessages.add(messageId);

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

async function getQuickStatus(coin) {
  try {
    const currentPrice = await getCurrentPrice(coin);
    if (!currentPrice) {
      return `Hızlı Durum: ${coin.split('-')[0]} 💰 Bilinmiyor. Fiyat alınamadı, KuCoin veya CoinMarketCap API’ye bak! 😓`;
    }

    const endAt = Math.floor(Date.now() / 1000);
    const startAt = endAt - 10 * 60;
    let klines = await fetchHttpKlines(coin, '5min', startAt, endAt);

    if (!klines || klines.length < 2) {
      console.log(`KuCoin kline verisi eksik: ${coin}, CoinGecko deneniyor`);
      try {
        const coinId = coin.split('-')[0].toLowerCase();
        const response = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=0.006944`);
        const prices = response.data.prices;
        if (prices.length < 2) {
          return `Hızlı Durum: ${coin.split('-')[0]} 💰 ${currentPrice.toFixed(2)} USDT. Trend verisi eksik, API’yi kontrol et! 😓`;
        }
        const lastPrice = prices[prices.length - 1][1];
        const prevPrice = prices[prices.length - 2][1];
        const trend = lastPrice > prevPrice ? 'Yükselişte 📈' : lastPrice < prevPrice ? 'Düşüşte 📉' : 'Nötr ➡️';
        return `Hızlı Durum: ${coin.split('-')[0]} 💰 ${currentPrice.toFixed(2)} USDT, Son 5dk: ${trend} (CoinGecko)`;
      } catch (error) {
        console.error(`CoinGecko trend hatası: ${coin}`, error.message);
        return `Hızlı Durum: ${coin.split('-')[0]} 💰 ${currentPrice.toFixed(2)} USDT. Trend verisi alınamadı, KuCoin veya CoinGecko API’yi kontrol et! 😓`;
      }
    }

    const lastClose = klines[klines.length - 1].close;
    const prevClose = klines[klines.length - 2].close;
    const trend = lastClose > prevClose ? 'Yükselişte 📈' : lastClose < prevClose ? 'Düşüşte 📉' : 'Nötr ➡️';
    return `Hızlı Durum: ${coin.split('-')[0]} 💰 ${currentPrice.toFixed(2)} USDT, Son 5dk: ${trend}`;
  } catch (error) {
    console.error(`Quick status error for ${coin}:`, error.message);
    return `Hızlı Durum: ${coin.split('-')[0]} için veri alınamadı. API’yi kontrol et! 😓`;
  }
}

// Inline Buttons
function getCoinButtons() {
  return Markup.inlineKeyboard(
    COINS.map(coin => [
      Markup.button.callback(coin.split('-')[0], `analyze_${coin}`),
      Markup.button.callback(`Durum (${coin.split('-')[0]})`, `status_${coin}`)
    ]).concat([
      [Markup.button.callback('Alarm Kur', 'alarm_menu')],
      [Markup.button.callback('Bildirimleri Durdur', 'alarm_stop')],
      [Markup.button.callback('CoinMarketCal Verileri', 'coinmarketcal')]
    ]), { columns: 2 }
  );
}

function getAlarmButtons() {
  return Markup.inlineKeyboard(
    COINS.map(coin => [
      Markup.button.callback(coin.split('-')[0], `alarm_${coin}`)
    ]), { columns: 2 }
  );
}

// Commands
bot.command('start', async (ctx) => {
  console.log('Start komutu alındı, chat ID:', ctx.chat.id);
  await ctx.reply(
    'Merhaba kanka! Kripto analiz botun hazır! 🚀 Coin seçip analiz yap, durum kontrol et, alarm kur veya CoinMarketCal etkinliklerini incele. 😎',
    getCoinButtons()
  );
  await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
});

bot.command(/analiz(?:@traderbot95_bot)?/, async (ctx) => {
  console.log('Analiz komutu alındı, chat ID:', ctx.chat.id);
  await ctx.reply('Hangi coin’i analiz edeyim kanka? 😎', getCoinButtons());
  await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
});

bot.command('alarm_kur', async (ctx) => {
  console.log('Alarm kur komutu alındı, chat ID:', ctx.chat.id);
  await ctx.reply('Hangi coin için alarm kuralım? 😊', getAlarmButtons());
  await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
});

bot.command('alarm_stop', async (ctx) => {
  console.log('Alarm stop komutu alındı, chat ID:', ctx.chat.id);
  try {
    isBitcoinMonitoringPaused = true;
    pauseEndTime = Date.now() + 24 * 60 * 60 * 1000;
    const pauseMessage = `Bitcoin izleme bildirimleri 24 saatliğine durduruldu. Kalan süre: ${(pauseEndTime - Date.now()) / 1000 / 60} dakika. 24 saat sonra otomatik devam edecek. 🛑`;
    await ctx.reply(pauseMessage, getCoinButtons());
    console.log(pauseMessage);
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    console.error('Alarm stop error:', error);
    await ctx.reply('Alarm durdurma sırasında hata oluştu, tekrar deneyin. 😓', getCoinButtons());
  }
});

// Inline Actions
bot.action('alarm_stop', async (ctx) => {
  console.log('Inline alarm stop isteği, chat ID:', ctx.chat.id);
  try {
    isBitcoinMonitoringPaused = true;
    pauseEndTime = Date.now() + 24 * 60 * 60 * 1000;
    const pauseMessage = `Bitcoin izleme bildirimleri 24 saatliğine durduruldu. Kalan süre: ${(pauseEndTime - Date.now()) / 1000 / 60} dakika. 24 saat sonra otomatik devam edecek. 🛑`;
    await ctx.reply(pauseMessage, getCoinButtons());
    console.log(pauseMessage);
    await saveChatHistory(db, ctx.chat.id.toString(), 'Inline: alarm_stop');
  } catch (error) {
    console.error('Inline alarm stop error:', error);
    await ctx.reply('Alarm durdurma sırasında hata oluştu, tekrar deneyin. 😓', getCoinButtons());
  }
});

bot.action('alarm_menu', async (ctx) => {
  console.log('Inline alarm menu isteği, chat ID:', ctx.chat.id);
  await ctx.reply('Hangi coin için alarm kuralım? 😊', getAlarmButtons());
  await saveChatHistory(db, ctx.chat.id.toString(), 'Inline: alarm_menu');
});

bot.action(/analyze_(.+)/, async (ctx) => {
  const coin = ctx.match[1];
  console.log(`Inline analiz isteği: ${coin}, chat ID: ${ctx.chat.id}`);
  try {
    if (!COINS.includes(coin)) {
      await ctx.reply('Geçerli bir coin seç kanka! 😊', getCoinButtons());
      return;
    }
    const news = await fetchNews();
    const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
    await ctx.reply(`${coin.split('-')[0]}’yı analiz ediyorum, biraz bekle! 😎`);

    const cachedAnalysis = await getCachedAnalysis(db, coin);
    let analysis;
    if (cachedAnalysis) {
      analysis = { coin, tarih: cachedAnalysis.tarih, analyses: cachedAnalysis };
    } else {
      analysis = await analyzeCoin(coin, null, news, chatHistory);
    }

    const messageId = `${coin}-${analysis.tarih}`;
    if (sentMessages.has(messageId)) return;
    sentMessages.add(messageId);

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

    await ctx.reply(message, getCoinButtons());
    if (ctx.chat.id.toString() === GROUP_ID) {
      await bot.telegram.sendMessage(GROUP_ID, message, getCoinButtons());
    }
    await saveChatHistory(db, ctx.chat.id.toString(), `Inline: analyze_${coin}`);
  } catch (error) {
    console.error('Inline analyze error:', error);
    await ctx.reply('Analiz sırasında hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action(/status_(.+)/, async (ctx) => {
  const coin = ctx.match[1];
  console.log(`Inline durum isteği: ${coin}, chat ID: ${ctx.chat.id}`);
  try {
    if (!COINS.includes(coin)) {
      await ctx.reply('Geçerli bir coin seç kanka! 😊', getCoinButtons());
      return;
    }
    const status = await getQuickStatus(coin);
    await ctx.reply(status, getCoinButtons());
    await saveChatHistory(db, ctx.chat.id.toString(), `Inline: status_${coin}`);
  } catch (error) {
    console.error('Inline status error:', error);
    await ctx.reply('Durum kontrolünde hata oluştu, tekrar dene! 😓', getCoinButtons());
  }
});

bot.action(/alarm_(.+)/, async (ctx) => {
  const coin = ctx.match[1];
  console.log(`Inline alarm isteği: ${coin}, chat ID: ${ctx.chat.id}`);
  try {
    if (!COINS.includes(coin)) {
      await ctx.reply('Geçerli bir coin seç kanka! 😊', getCoinButtons());
      return;
    }
    await ctx.reply(`📢 ${coin.split('-')[0]} için alarm fiyatını yaz (ör. 330.50):`, {
      reply_markup: { force_reply: true }
    });

    bot.hears(/^\d*\.?\d+$/, async (ctx) => {
      const price = parseFloat(ctx.message.text);
      if (isNaN(price) || price <= 0) {
        await ctx.reply('Geçerli bir fiyat gir kanka (ör. 330.50)! 😊', getCoinButtons());
        return;
      }
      try {
        const alarmKey = `${coin}-${ctx.chat.id}`;
        priceAlarms.set(alarmKey, { chatId: ctx.chat.id.toString(), targetPrice: price });
        console.log(`Alarm kaydedildi: ${alarmKey}, Fiyat: ${price}`);

        const { stop } = await startWebSocket(coin, price, ctx.chat.id, async ({ price: currentPrice }) => {
          if (Math.abs(currentPrice - price) <= 0.01 * price) {
            try {
              const news = await fetchNews();
              const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
              const cachedAnalysis = await getCachedAnalysis(db, coin);
              let analysis;
              if (cachedAnalysis) {
                analysis = { coin, tarih: cachedAnalysis.tarih, analyses: cachedAnalysis };
              } else {
                analysis = await analyzeCoin(coin, null, news, chatHistory);
              }
              const messageId = `${coin}-${analysis.tarih}`;
              if (sentMessages.has(messageId)) return;
              sentMessages.add(messageId);

              let message = `Alarm: ${coin.split('-')[0]} ${currentPrice.toFixed(2)}'e ${currentPrice <= price ? 'düştü' : 'çıktı'}! 🚨\n`;
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
              await ctx.reply(message, getCoinButtons());
              if (ctx.chat.id.toString() === GROUP_ID) {
                await bot.telegram.sendMessage(GROUP_ID, message, getCoinButtons());
              }
              await bot.telegram.sendMessage('1616739367', message, getCoinButtons());
              priceAlarms.delete(alarmKey);
              stop();
            } catch (error) {
              console.error('Alarm bildirim hatası:', error);
              await ctx.reply(`Alarm: ${coin.split('-')[0]} ${currentPrice.toFixed(2)}'e ulaştı, ancak analiz alınamadı. 😓`, getCoinButtons());
              priceAlarms.delete(alarmKey);
              stop();
            }
          }
        });

        await ctx.reply(`${coin.split('-')[0]} için ${price.toFixed(2)} alarmı kuruldu. 🔔`, getCoinButtons());
        await saveChatHistory(db, ctx.chat.id.toString(), `Inline: alarm_${coin}_${price}`);
      } catch (error) {
        console.error('Inline alarm set error:', error);
        await ctx.reply('Alarm kurarken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
      }
    });
    await saveChatHistory(db, ctx.chat.id.toString(), `Inline: alarm_${coin}`);
  } catch (error) {
    console.error('Inline alarm error:', error);
    await ctx.reply('Alarm kurma sırasında hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

// Yeni Inline Buton: CoinMarketCal Verileri
bot.action('coinmarketcal', async (ctx) => {
  console.log('Inline CoinMarketCal isteği, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('CoinMarketCal etkinliklerini çekiyorum, biraz bekle kanka! 😎');
    const { top100, top500 } = await getTopCoinsFromCMCAndCMCal();
    const events = await fetchTopCoinEvents([...top100, ...top500.slice(100)]);
    const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());

    if (!events.length) {
      await ctx.reply('CoinMarketCal’dan etkinlik bulunamadı. 😓', getCoinButtons());
      return;
    }

    // Etkinlikleri listele
    let eventMessage = '📅 CoinMarketCal Etkinlikleri (1 Hafta İçinde):\n';
    for (const event of events) {
      eventMessage += `\n${event.coin}: ${event.title} (${event.date})\n`;
      eventMessage += `Etki: ${event.impact}, Catalyst Skor: ${event.catalystScore}\n`;
      eventMessage += `Görüntülenme: ${event.viewCount}, Oy: ${event.voteCount}\n`;
    }

    // Grok ile yorumlat
    const comment = await analyzeCoinMarketCalEvents(events, chatHistory);
    await ctx.reply(eventMessage, getCoinButtons());
    await ctx.reply(`📝 Grok Yorumu:\n${comment}`, getCoinButtons());

    if (ctx.chat.id.toString() === GROUP_ID) {
      await bot.telegram.sendMessage(GROUP_ID, eventMessage, getCoinButtons());
      await bot.telegram.sendMessage(GROUP_ID, `📝 Grok Yorumu:\n${comment}`, getCoinButtons());
    }
    await saveChatHistory(db, ctx.chat.id.toString(), 'Inline: coinmarketcal');
  } catch (error) {
    console.error('Inline CoinMarketCal error:', error);
    await ctx.reply('CoinMarketCal verilerini çekerken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

// Text Handler
bot.on('text', async (ctx) => {
  const message = ctx.message.text.trim().toLowerCase();
  console.log(`Metin mesajı alındı: ${message}, chat ID: ${ctx.chat.id}`);
  await saveChatHistory(db, ctx.chat.id.toString(), message);

  if (message.startsWith('/')) {
    return;
  }

  const coinMap = {
    'aave': 'AAVE-USDT',
    'comp': 'COMP-USDT',
    'ltc': 'LTC-USDT',
    'xlm': 'XLM-USDT',
    'ada': 'ADA-USDT',
    'mkr': 'MKR-USDT',
    'btc': 'BTC-USDT',
    'eth': 'ETH-USDT',
    'bitcoin': 'BTC-USDT',
    'ethereum': 'ETH-USDT'
  };
  let selectedCoin = null;
  for (const [key, coin] of Object.entries(coinMap)) {
    if (message.includes(key)) {
      selectedCoin = coin;
      break;
    }
  }

  const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());

  if (selectedCoin && (message.includes('analiz') || message.includes('ne olur') || message.includes('ne yapayım'))) {
    try {
      await ctx.reply(`${selectedCoin.split('-')[0]}’yı analiz ediyorum, biraz bekle! 😎`);
      const news = await fetchNews();
      const forceReanalyze = message.includes('yeniden analiz yap');
      const analysis = await analyzeCoin(selectedCoin, null, news, chatHistory, forceReanalyze);

      const messageId = `${selectedCoin}-${analysis.tarih}`;
      if (sentMessages.has(messageId)) {
        await ctx.reply('Bu analizi az önce gönderdim kanka, tekrar bak istersen! 😊', getCoinButtons());
        return;
      }
      sentMessages.add(messageId);

      let response = `${selectedCoin} Analizi (${new Date(analysis.tarih).toLocaleString('tr-TR')}):\n`;
      response += `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice ? analysis.analyses.currentPrice.toFixed(2) : 'Bilinmiyor'}\n`;
      response += `  Giriş: 📉 ${analysis.analyses.giriş.toFixed(2)}\n`;
      response += `  Kısa Vadeli Çıkış (4-6 saat): 📈 ${analysis.analyses.shortTermÇıkış.toFixed(2)}\n`;
      response += `  Günlük Çıkış (24 saat): 📈 ${analysis.analyses.dailyÇıkış.toFixed(2)}\n`;
      response += `  Haftalık Çıkış (1 hafta): 📈 ${analysis.analyses.weeklyÇıkış.toFixed(2)}\n`;
      response += `  Uzun Vadeli Çıkış (1-2 hafta): 📈 ${analysis.analyses.longTermÇıkış.toFixed(2)}\n`;
      response += `  Stop-Loss: 🛑 ${analysis.analyses.stopLoss.toFixed(2)}\n`;
      response += `  Kısa Vadeli Destek (1sa): ${analysis.analyses.shortTermSupport.toFixed(2)}\n`;
      response += `  Kısa Vadeli Direnç (1sa): ${analysis.analyses.shortTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.shortTermResistanceTarget.toFixed(2)})\n`;
      response += `  Uzun Vadeli Destek (1hf): ${analysis.analyses.longTermSupport.toFixed(2)}\n`;
      response += `  Uzun Vadeli Direnç (1hf): ${analysis.analyses.longTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.longTermResistanceTarget.toFixed(2)})\n`;
      response += `  Yorum: ${analysis.analyses.yorum}\n`;

      await ctx.reply(response, getCoinButtons());
      if (ctx.chat.id.toString() === GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, response, getCoinButtons());
      }
      await saveChatHistory(db, ctx.chat.id.toString(), `Text: analyze_${selectedCoin}`);
    } catch (error) {
      console.error(`Text analyze error for ${selectedCoin}:`, error);
      await ctx.reply('Analiz sırasında hata oluştu, butonlardan dene kanka! 😓', getCoinButtons());
    }
    return;
  }

  if (selectedCoin && (message.includes('durum') || message.includes('ne durumda'))) {
    try {
      const status = await getQuickStatus(selectedCoin);
      await ctx.reply(status, getCoinButtons());
      await saveChatHistory(db, ctx.chat.id.toString(), `Text: status_${selectedCoin}`);
    } catch (error) {
      console.error(`Text status error for ${selectedCoin}:`, error);
      await ctx.reply('Durum kontrolünde hata oluştu, butonlardan dene kanka! 😓', getCoinButtons());
    }
    return;
  }
if (selectedCoin && message.includes('alarm kur')) {
  try {
    await ctx.reply(`📢 ${selectedCoin.split('-')[0]} için alarm fiyatını yaz (ör. 330.50):`, {
      reply_markup: { force_reply: true }
    });
    bot.hears(/^\d*\.?\d+$/, async (ctx) => {
      const price = parseFloat(ctx.message.text);
      if (isNaN(price) || price <= 0) {
        await ctx.reply('Geçerli bir fiyat gir kanka (ör. 330.50)! 😊', getCoinButtons());
        return;
      }
      try {
        const alarmKey = `${selectedCoin}-${ctx.chat.id}`;
        priceAlarms.set(alarmKey, { chatId: ctx.chat.id.toString(), targetPrice: price });
        console.log(`Alarm kaydedildi: ${alarmKey}, Fiyat: ${price}`);

        const { stop } = await startWebSocket(selectedCoin, price, ctx.chat.id, async ({ price: currentPrice }) => {
          if (Math.abs(currentPrice - price) <= 0.01 * price) {
            try {
              const news = await fetchNews();
              const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
              const cachedAnalysis = await getCachedAnalysis(db, selectedCoin);
              let analysis;
              if (cachedAnalysis) {
                analysis = { coin: selectedCoin, tarih: cachedAnalysis.tarih, analyses: cachedAnalysis };
              } else {
                // Kaldığın yer burası, buradan devam
                analysis = await analyzeCoin(selectedCoin, null, news, chatHistory);
              }
              const messageId = `${selectedCoin}-${analysis.tarih}`;
              if (sentMessages.has(messageId)) return;
              sentMessages.add(messageId);

              let message = `Alarm: ${selectedCoin.split('-')[0]} ${currentPrice.toFixed(2)}'e ${currentPrice <= price ? 'düştü' : 'çıktı'}! 🚨\n`;
              message += `${selectedCoin} Analizi (${new Date(analysis.tarih).toLocaleString('tr-TR')}):\n`;
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
              await ctx.reply(message, getCoinButtons());
              if (ctx.chat.id.toString() === GROUP_ID) {
                await bot.telegram.sendMessage(GROUP_ID, message, getCoinButtons());
              }
              await bot.telegram.sendMessage('1616739367', message, getCoinButtons());
              priceAlarms.delete(alarmKey);
              stop();
            } catch (error) {
              console.error('Alarm bildirim hatası:', error);
              await ctx.reply(`Alarm: ${selectedCoin.split('-')[0]} ${currentPrice.toFixed(2)}'e ulaştı, ancak analiz alınamadı. 😓`, getCoinButtons());
              priceAlarms.delete(alarmKey);
              stop();
            }
          }
        });

        await ctx.reply(`${selectedCoin.split('-')[0]} için ${price.toFixed(2)} alarmı kuruldu. 🔔`, getCoinButtons());
        await saveChatHistory(db, ctx.chat.id.toString(), `Text: alarm_${selectedCoin}_${price}`);
      } catch (error) {
        console.error('Text alarm set error:', error);
        await ctx.reply('Alarm kurarken hata oluştu, butonlardan dene kanka! 😓', getCoinButtons());
      }
    });
    await saveChatHistory(db, ctx.chat.id.toString(), `Text: alarm_${selectedCoin}`);
  } catch (error) {
    console.error('Text alarm error:', error);
    await ctx.reply('Alarm kurma sırasında hata oluştu, butonlardan dene kanka! 😓', getCoinButtons());
  }
  return;
}

try {
  const prompt = `Kullanıcı mesajı: "${message}". Samimi, Türkçe, kısa bir yanıt ver (maksimum 100 kelime). Kripto para konseptine uygun, trader’lara hitap eden bir üslup kullan. Coin veya analizle ilgili değilse, genel bir sohbet tarzında cevap ver ve kullanıcıyı butonlara yönlendir. Son 10 konuşma: ${chatHistory.join('; ')}.`;
  let response = await rateLimitedCallGrok(prompt);
  if (!response) {
    response = 'Kanka, neyi kastediyorsun tam anlamadım! 😅 Coin analizi, durum veya CoinMarketCal verileri için butonları kullan, hemen bakalım! 🚀';
  }
  await ctx.reply(response, getCoinButtons());
} catch (error) {
  console.error('Text chat error:', error);
  await ctx.reply('Bir şeyler ters gitti kanka, butonlarla dene istersen! 😓', getCoinButtons());
}
});

// Bitcoin Minute-by-Minute Monitoring
async function monitorBitcoinPrice() {
  const coin = 'BTC-USDT';
  try {
    const now = Date.now();
    if (isBitcoinMonitoringPaused && now < pauseEndTime) {
      console.log(`Bitcoin izleme durdurulmuş, kalan süre: ${(pauseEndTime - now) / 1000 / 60} dakika`);
      return;
    } else if (isBitcoinMonitoringPaused && now >= pauseEndTime) {
      isBitcoinMonitoringPaused = false;
      console.log('Bitcoin izleme yeniden başlatıldı.');
    }

    const currentPrice = await getKucoinWebSocketPrice(coin);
    if (!currentPrice) {
      console.error('Bitcoin fiyatı alınamadı.');
      return;
    }

    const priceChange = lastBitcoinSignal.price ? (lastBitcoinSignal.price - currentPrice) / lastBitcoinSignal.price : 0;
    lastBitcoinSignal.price = currentPrice;

    const endAt = Math.floor(Date.now() / 1000);
    const startAt = endAt - 24 * 60 * 60;
    const klinesPromises = SHORT_TIMEFRAMES.map(timeframe => fetchHttpKlines(coin, timeframe, startAt, endAt));
    const klinesResults = await Promise.all(klinesPromises);
    const indicatorsByTimeframe = {};

    for (let i = 0; i < SHORT_TIMEFRAMES.length; i++) {
      const timeframe = SHORT_TIMEFRAMES[i];
      const data = klinesResults[i];
      if (!data.length) continue;

      const indicators = calculateIndicators(data);
      if (indicators) indicatorsByTimeframe[timeframe] = indicators;
    }

    const news = await fetchNews();
    const negativeNews = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack') || n.toLowerCase().includes('kriz') || n.toLowerCase().includes('bearish'));

    let negativeSignals = 0;
    let signalType = '';
    const validIndicators = Object.values(indicatorsByTimeframe).filter(ind => ind !== null);
    for (const timeframe of SHORT_TIMEFRAMES) {
      const indicators = indicatorsByTimeframe[timeframe];
      if (!indicators) continue;

      if (indicators.RSI < 30 && indicators.MACD < indicators.signal && indicators.StochRSI < 20) {
        negativeSignals++;
      }
    }

    if (negativeSignals >= 2 && priceChange > 0.05 && negativeNews) {
      signalType = 'Düşüş';
    } else {
      signalType = 'Nötr';
    }

    if (signalType === lastBitcoinSignal.type && (now - lastBitcoinSignal.timestamp) < BITCOIN_SIGNAL_COOLDOWN) {
      console.log(`Aynı Bitcoin sinyali, soğuma süresi: ${(BITCOIN_SIGNAL_COOLDOWN - (now - lastBitcoinSignal.timestamp)) / 1000 / 60} dakika`);
      return;
    }

    if (signalType === 'Düşüş') {
      const chatHistory = await getRecentChatHistory(db, GROUP_ID);
      const analysis = await analyzeCoin(coin, klinesResults[SHORT_TIMEFRAMES.indexOf('1hour')], news, chatHistory);
      const messageId = `${coin}-${analysis.tarih}`;
      if (sentMessages.has(messageId)) return;
      sentMessages.add(messageId);

      let message = `🚨 Bitcoin Düşüş Sinyali! (${new Date().toLocaleString('tr-TR')}):\n`;
      message += `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice ? analysis.analyses.currentPrice.toFixed(2) : 'Bilinmiyor'}\n`;
      message += `  Tahmini Dip: 📉 ${analysis.analyses.giriş.toFixed(2)}\n`;
      message += `  Stop-Loss: 🛑 ${analysis.analyses.stopLoss.toFixed(2)}\n`;
      message += `  Kısa Vadeli Destek (1sa): ${analysis.analyses.shortTermSupport.toFixed(2)}\n`;
      message += `  Kısa Vadeli Direnç (1sa): ${analysis.analyses.shortTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.shortTermResistanceTarget.toFixed(2)})\n`;
      message += `  Yorum: ${analysis.analyses.yorum}\n`;
      message += `  Haberler: ${negativeNews ? 'Olumsuz haberler var, dikkat!' : 'Piyasa nötr.'}\n`;

      await bot.telegram.sendMessage(GROUP_ID, message, getCoinButtons());
      await bot.telegram.sendMessage('1616739367', message, getCoinButtons());
      lastBitcoinSignal.type = signalType;
      lastBitcoinSignal.timestamp = now;
      lastBitcoinSignal.comment = message;
      console.log('Bitcoin düşüş sinyali gönderildi:', message);
    }
  } catch (error) {
    console.error('Bitcoin izleme hatası:', error);
  }
}

// Cache Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (now - value.timestamp > CACHE_DURATION) {
      cache.delete(key);
    }
  }
  console.log('Cache temizlendi, kalan öğe sayısı:', cache.size);
}, CACHE_CLEAR_INTERVAL);

// Bot Start
async function startBot() {
  if (isBotStarted) return;
  isBotStarted = true;
  console.log('Bot başlatılıyor...');

  // Bitcoin izleme her dakika
  schedule.scheduleJob('*/1 * * * *', async () => {
    console.log('Bitcoin izleme çalışıyor...');
    await monitorBitcoinPrice();
  });

  // Günlük fırsat coin’leri
  schedule.scheduleJob('0 8 * * *', async () => {
    console.log('Günlük fırsat coin’leri kontrol ediliyor...');
    try {
      const opportunities = await findOpportunityCoins();
      if (opportunities.length === 0) {
        await bot.telegram.sendMessage(GROUP_ID, 'Bugün için fırsat coin’i bulunamadı kanka! 😓', getCoinButtons());
        return;
      }

      let message = '📈 Günlük Fırsat Coin’leri:\n';
      for (const opp of opportunities) {
        message += `\n${opp.coin} (Skor: ${opp.score}):\n`;
        message += `  Güncel Fiyat: 💰 ${opp.price ? opp.price.toFixed(2) : 'Bilinmiyor'}\n`;
        message += `  Etkinlikler: ${opp.events.map(e => `${e.title} (${e.date})`).join(', ') || 'Yok'}\n`;
        message += `  RSI: ${opp.indicators?.RSI.toFixed(2) || 'Bilinmiyor'}\n`;
        message += `  MACD: ${opp.indicators?.MACD.toFixed(2) || 'Bilinmiyor'}\n`;
      }
      await bot.telegram.sendMessage(GROUP_ID, message, getCoinButtons());
      await bot.telegram.sendMessage('1616739367', message, getCoinButtons());
    } catch (error) {
      console.error('Fırsat coin’leri hatası:', error);
      await bot.telegram.sendMessage(GROUP_ID, 'Fırsat coin’leri alınırken hata oluştu, sonra tekrar dene! 😓', getCoinButtons());
    }
  });

  // Bot başlatma
  bot.launch().then(() => {
    console.log('Bot başlatıldı!');
    bot.telegram.sendMessage(GROUP_ID, 'Kripto analiz botu aktif! 🚀 Coin seç, analiz yapalım! 😎', getCoinButtons());
  }).catch(err => {
    console.error('Bot başlatma hatası:', err);
    isBotStarted = false;
  });
}

// HTTP Server for Health Check
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running!');
});

// Start the bot and server
server.listen(3000, () => {
  console.log('HTTP server 3000 portunda çalışıyor.');
  startBot();
});

// Error Handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});
