const { Telegraf, Markup } = require('telegraf');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const ccxt = require('ccxt');
const { RSI, MACD, EMA, PSAR, StochasticRSI } = require('technicalindicators');
const axios = require('axios');
const WebSocket = require('ws');
const http = require('http');
const { analyzeBinanceCoin, findTopTradeOpportunities, wsConnections } = require('./binanceData');
const fs = require('fs').promises;
const path = require('path');

// Cache dosyası
const CACHE_FILE = path.join('/tmp', 'coinmarketcal_events.json');
const CACHE_DURATION = 2 * 60 * 60 * 1000; // 2 saat
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 300 }); // 5dk TTL
const BITCOIN_SIGNAL_COOLDOWN = 2 * 60 * 60 * 1000; // 2 saat soğuma süresi

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || 'your-telegram-bot-token');
const parser = new Parser();
const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT', 'ETH-USDT'];
const SHORT_TIMEFRAMES = ['1min', '5min', '30min', '1hour'];
const GROUP_ID = '-1002869335730'; // @tradingroup95
let isBotStarted = false;
let isBitcoinMonitoringPaused = false;
let pauseEndTime = 0;

// Rate limit kontrolü
const RATE_LIMIT_MS = 500;
let lastGrokRequest = 0;

// Deduplication için
const sentMessages = new Set();
const lastBitcoinSignal = { type: null, timestamp: 0, price: 0, comment: null };
const priceAlarms = new Map(); // coin -> {chatId, targetPrice}

// Cache temizleme
function clearCache() {
  cache.flushAll();
  console.log('Cache tamamen temizlendi');
}

// JSON cache fonksiyonları
async function saveEventsToCache(events) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(events, null, 2));
    console.log('Veriler cache’e kaydedildi:', CACHE_FILE);
  } catch (error) {
    console.error('Cache yazma hatası:', error.message);
  }
}

async function loadEventsFromCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Cache okuma hatası:', error.message);
    return null;
  }
}

async function updateCache() {
  const events = await fetchTopCoinEvents();
  if (events.length > 0) {
    await saveEventsToCache(events);
    console.log('Cache güncellendi, etkinlik sayısı:', events.length);
    return events;
  }
  return [];
}

// Rate limit for Grok API
async function rateLimitedCallGrok(prompt, retries = 3) {
  const systemMessage = `
Sen bir kripto para analiz botusun, Grok-4-0709 modelini kullanıyorsun. CoinMarketCal verileri /tmp/coinmarketcal_events.json dosyasında saklanıyor, analiz yaparken bu JSON dosyasını oku ve etkinlikleri değerlendir. Kısa vadeli zaman dilimlerini (1min, 5min, 30min, 1hour) inceleyip teknik ve temel analize dayalı kısa, samimi, anlaşılır Türkçe yorum yap (maksimum 300 kelime, kelime sayısını yazma). Güncel fiyat (💰), giriş (📉), kısa vadeli çıkış (4-6 saat, 📈), günlük çıkış (24 saat, 📈), haftalık çıkış (1 hafta, 📈), uzun vadeli çıkış (1-2 hafta, 📈) ve stop-loss (🛑) fiyatını giriş fiyatının altında 1.5 * ATR mesafede belirle. Giriş fiyatını belirlerken fiyatın düşebileceği potansiyel dip seviyelerini (SMA-50, PSAR, Fibonacci %38.2, ATR) analiz et, güncel fiyattan direkt giriş önerme, kâr marjını maksimize et. Kısa vadeli (1sa) ve uzun vadeli (1 hafta) destek/direnç noktaları belirle, her direnç noktası aşılırsa olası fiyat hedeflerini ver. Temel analiz için JSON’daki CoinMarketCal etkinliklerini (yeni borsa listelemeleri, ortaklıklar, halving, vb.) değerlendir, pozitif/negatif etkisini vurgula, CoinMarketCal’ı kaynak olarak belirt. Konuşma geçmişini dikkate al, samimi sohbet et. Kullanıcı "yeniden analiz yap" demedikçe JSON’daki son verileri kullan, yeni analiz yapma. "Yeniden analiz yap" denirse yeni analiz yap ve önbelleği güncelle. Serbest metin mesajlarında coin adı geçiyorsa analizi veya durumu döndür, yoksa samimi bir şekilde sohbet et.
`;

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
            { role: 'system', content: systemMessage },
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
  const events = await fetchTopCoinEvents();
  news.push(...events.map(e => `${e.coin}: ${e.title} (${e.date})`));
  return news;
}

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

async function fetchTopCoinEvents() {
  try {
    const events = await rateLimitedCallCoinMarketCal('https://developers.coinmarketcal.com/v1/events', {
      max: 200,
      showVotes: true,
      showViews: true,
      translations: 'tr',
    });
    console.log('CoinMarketCal etkinlik sayısı:', events.length);
    const filteredEvents = events
      .filter(event => event.coins && Array.isArray(event.coins) && event.coins.length > 0)
      .map(event => ({
        coin: event.coins[0]?.name || 'Bilinmiyor',
        symbol: event.coins[0]?.symbol || 'Unknown',
        title: event.title?.en || 'Etkinlik başlığı yok',
        date: event.displayed_date || 'Bilinmiyor',
        impact: event.is_popular || event.catalyst_score > 0 ? 'Positive' : 'Neutral',
        catalystScore: event.catalyst_score || 0,
        viewCount: event.view_count || 0,
        voteCount: event.vote_count || 0,
        description: event.description?.en || 'Açıklama yok',
        proofLink: event.source || 'Kaynak belirtilmemiş',
      }));
    console.log('Filtrelenmiş etkinlik sayısı:', filteredEvents.length);
    return filteredEvents;
  } catch (error) {
    console.error('CoinMarketCal events error:', error.message);
    return [];
  }
}

async function analyzeCoinMarketCalEvents(events, chatHistory) {
  try {
    let cachedEvents = await loadEventsFromCache();
    if (!cachedEvents || cachedEvents.length === 0) {
      cachedEvents = events.length > 0 ? events : await updateCache();
    }
    if (!cachedEvents.length) {
      return 'JSON cache’te veya API’de etkinlik bulunamadı.';
    }

    const eventSummaries = cachedEvents.map(event => ({
      coin: event.coin,
      symbol: event.symbol,
      title: event.title,
      date: event.date,
      impact: event.impact,
      catalystScore: event.catalystScore,
      viewCount: event.viewCount,
      voteCount: event.voteCount,
      description: event.description,
      proofLink: event.proofLink,
    }));

    const prompt = `
      Aşağıdaki CoinMarketCal etkinliklerini JSON cache’ten aldım, analiz et ve hangi coinlerin iyi yatırım fırsatları sunduğunu belirle. Her etkinliğin başlığını, açıklamasını, etki derecesini, catalyst skorunu, görüntülenme ve oy sayısını dikkate al. Yeni borsa listelemeleri, ortaklıklar, halving, token yakma, buyback, AMA’lar veya airdrop gibi etkinliklere öncelik ver. Popülerlik (viewCount, voteCount) ve açıklamadaki olumlu kelimeleri (örneğin, "lansman", "ortaklık", "listeleme") değerlendirerek fiyat artışı potansiyeli taşıyan coin’leri seç. Sonuçları kısa ve anlaşılır bir şekilde özetle, her coin için neden fırsat sunduğunu ve kanıt linkini belirt.

      Etkinlikler (JSON cache’ten):
      ${JSON.stringify(eventSummaries, null, 2)}

      Çıktı formatı:
      - Coin: [Coin Adı]
        - Fırsat Seviyesi: [Yüksek/Orta/Düşük]
        - Neden: [Kısa açıklama]
        - Kanıt: [Proof Link]
    `;

    const grokResponse = await rateLimitedCallGrok(prompt);
    return grokResponse || 'JSON’dan analiz yapılamadı, lütfen tekrar deneyin.';
  } catch (error) {
    console.error('Grok JSON analiz hatası:', error.message);
    return 'Grok JSON analizinde hata oluştu.';
  }
}

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
  try {
    const top100 = await fetchTopCoinsCMC(100, 1);
    const top500 = await fetchTopCoinsCMC(500, 101);
    const cmcCoins = [...top100, ...top500.slice(100)];
    console.log('CMC Coins:', cmcCoins.length);
    if (!cmcCoins.length) {
      console.error('No coins fetched from CoinMarketCap');
      return { top100: [], top500: [] };
    }
    const cmcalCoins = await rateLimitedCallCoinMarketCal('https://developers.coinmarketcal.com/v1/coins', {});
    console.log('CMCal Coins:', cmcalCoins.length);
    const cmcalCoinSymbols = cmcalCoins.map(coin => coin.symbol.toLowerCase());
    return {
      top100: cmcCoins.filter(coin => cmcalCoinSymbols.includes(coin.symbol.toLowerCase())),
      top500: cmcCoins.filter(coin => cmcalCoinSymbols.includes(coin.symbol.toLowerCase())),
    };
  } catch (error) {
    console.error('getTopCoinsFromCMCAndCMCal error:', error.message);
    return { top100: [], top500: [] };
  }
}

async function findOpportunityCoins() {
  let events = await loadEventsFromCache();
  if (!events || events.length === 0) {
    events = await updateCache();
  }

  const opportunities = [];
  const processedCoins = new Set();

  for (const event of events) {
    const coin = event.symbol.toUpperCase() + '-USDT';
    if (processedCoins.has(coin) || !COINS.includes(coin)) continue;

    const klines = await fetchHttpKlines(coin, '1hour');
    const indicators = calculateIndicators(klines);
    const price = await getCurrentPrice(coin);

    let score = 0;
    if (event.impact === 'Positive') score += 50;
    if (event.catalystScore > 0) score += event.catalystScore * 5;
    if (event.viewCount > 1000 || event.voteCount > 500) score += 20;
    if (event.title.toLowerCase().includes('halving')) score += 40;
    if (event.title.toLowerCase().includes('burn') || event.description.toLowerCase().includes('burn')) score += 30;
    if (event.title.toLowerCase().includes('buyback') || event.description.toLowerCase().includes('buyback')) score += 30;
    if (event.title.toLowerCase().includes('listing')) score += 25;
    if (event.title.toLowerCase().includes('ama')) score += 20;
    if (event.description.toLowerCase().includes('airdrop')) score += 20;

    if (indicators?.RSI < 30) score += 30;
    if (indicators?.MACD > 0 && indicators.MACD > indicators.signal) score += 20;

    if (score >= 50) {
      opportunities.push({
        coin: event.coin,
        symbol: event.symbol,
        score,
        event: {
          title: event.title,
          date: event.date,
          impact: event.impact,
          catalystScore: event.catalystScore,
          proofLink: event.proofLink,
          description: event.description,
        },
        indicators,
        price,
      });
      processedCoins.add(coin);
    }
  }

  console.log('Fırsat coin sayısı:', opportunities.length);
  return opportunities.sort((a, b) => b.score - a.score).slice(0, 5);
}

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
  const atr = calculateATR(klinesResults[SHORT_TIMEFRAMES.indexOf('1hour')]);

  let events = await loadEventsFromCache();
  if (!events || events.length === 0) {
    events = await updateCache();
  }
  const coinEvents = events.filter(event => 
    event.symbol.toLowerCase() === coin.split('-')[0].toLowerCase() || 
    event.coin.toLowerCase() === coin.split('-')[0].toLowerCase()
  );
  const eventSummary = coinEvents.length > 0 
    ? coinEvents.map(e => `${e.title} (${e.date}, Etki: ${e.impact}, Kaynak: CoinMarketCal ${e.proofLink})`).join('; ')
    : 'CoinMarketCal’da bu coin için etkinlik bulunamadı.';

  const prompt = `
    ${coin} için kısa vadeli (1min, 5min, 30min, 1hour) teknik ve temel analiz yap.
    İndikatörler: ${JSON.stringify(indicatorsByTimeframe, null, 2)}.
    Güncel fiyat: ${currentPrice ? currentPrice.toFixed(2) : 'Bilinmiyor'}.
    ATR (1sa): ${atr.toFixed(2)}.
    BTC durumu: ${btcStatus}.
    CoinMarketCal Etkinlikleri: ${eventSummary}.
    Haberler: ${news.length ? news.join('; ') : 'Haber bulunamadı.'}.
    Son 10 konuşma: ${chatHistory.join('; ')}.
    Giriş (📉) fiyatını belirlerken fiyatın düşebileceği potansiyel dip seviyelerini (SMA-50, PSAR, Fibonacci %38.2, ATR) analiz et, güncel fiyattan direkt giriş önerme, kâr marjını maksimize et. 
    Çıkış (📈) için:
      - Kısa vadeli (4-6 saat) hedef,
      - Günlük (24 saat) hedef,
      - Haftalık (1 hafta) hedef,
      - Uzun vadeli (1-2 hafta) hedef ver.
    Stop-loss (🛑) fiyatını giriş fiyatının altında, 1.5 * ATR mesafede belirle.
    Kısa vadeli (1sa) ve uzun vadeli (1 hafta) destek/direnç noktaları belirle. Her direnç noktası aşılırsa olası fiyat hedeflerini ver.
    CoinMarketCal etkinliklerini (halving, token yakma, buyback, borsa listelemeleri, AMA’lar) dikkate al ve yorumda bunlara vurgu yap. Kaynak olarak CoinMarketCal’ı belirt. Kısa, samimi Türkçe yorum (maksimum 300 kelime, kelime sayısını yazma).`;
  let comment = await rateLimitedCallGrok(prompt);
  if (!comment) {
    comment = generateFallbackComment(indicatorsByTimeframe, btcStatus, currentPrice, coin, news);
    comment += `\nKaynak: CoinMarketCal (Etkinlik bulunamadı).`;
  } else {
    comment += `\nKaynak: CoinMarketCal (${eventSummary ? 'Etkinlikler işlendi' : 'Etkinlik bulunamadı'}).`;
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
    coinMarketCalEvents: coinEvents,
  };

  await saveAnalysis(db, { tarih: result.tarih, coin, analiz: JSON.stringify(result.analyses) });
  return result;
}
async function fullAnalysis(news, chatHistory) {
  try {
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
  } catch (error) {
    console.error('Tüm coin analizlerinde hata:', error.message);
    return ['Tüm coin analizlerinde hata oluştu, API’leri kontrol et kanka! 😓'];
  }
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
    console.error(`Hızlı durum hatası: ${coin}:`, error.message);
    return `Hızlı Durum: ${coin.split('-')[0]} için veri alınamadı. API’yi kontrol et! 😓`;
  }
}

function getCoinButtons() {
  return Markup.inlineKeyboard(
    COINS.map(coin => [
      Markup.button.callback(coin.split('-')[0], `analyze_${coin}`),
      Markup.button.callback(`Durum (${coin.split('-')[0]})`, `status_${coin}`)
    ]).concat([
      [Markup.button.callback('Alarm Kur', 'alarm_menu')],
      [Markup.button.callback('Bildirimleri Durdur', 'alarm_stop')],
      [Markup.button.callback('CoinMarketCal Verileri', 'coinmarketcal')],
      [Markup.button.callback('CoinMarketCal Güncelle', 'update_coinmarketcal')],
      [Markup.button.callback('Fırsat Coin’leri', 'opportunities')]
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

// Bot Komutları
bot.command('start', async (ctx) => {
  console.log('Start komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply(
      'Merhaba kanka! Kripto analiz botun hazır! 🚀 Coin seçip analiz yap, durum kontrol et, alarm kur veya CoinMarketCal etkinliklerini incele. 😎',
      getCoinButtons()
    );
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    console.error('Start komut hatası:', error);
    await ctx.reply('Bot başlatılırken hata oluştu, tekrar dene kanka! 😓');
  }
});

bot.command(/analiz(?:@traderbot95_bot)?/, async (ctx) => {
  console.log('Analiz komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Hangi coin’i analiz edeyim kanka? 😎', getCoinButtons());
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    console.error('Analiz komut hatası:', error);
    await ctx.reply('Analiz komutu çalıştırılırken hata oluştu, tekrar dene kanka! 😓');
  }
});

bot.command('alarm_kur', async (ctx) => {
  console.log('Alarm kur komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Hangi coin için alarm kuralım? 😊', getAlarmButtons());
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    console.error('Alarm kur komut hatası:', error);
    await ctx.reply('Alarm kurma sırasında hata oluştu, tekrar dene kanka! 😓');
  }
});

bot.command('alarm_stop', async (ctx) => {
  console.log('Alarm stop komutu alındı, chat ID:', ctx.chat.id);
  try {
    isBitcoinMonitoringPaused = true;
    pauseEndTime = Date.now() + 24 * 60 * 60 * 1000;
    const pauseMessage = `Bitcoin izleme bildirimleri 24 saatliğine durduruldu. Kalan süre: ${((pauseEndTime - Date.now()) / 1000 / 60).toFixed(2)} dakika. 24 saat sonra otomatik devam edecek. 🛑`;
    await ctx.reply(pauseMessage, getCoinButtons());
    console.log(pauseMessage);
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    console.error('Alarm stop hatası:', error);
    await ctx.reply('Alarm durdurma sırasında hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.command('coinmarketcal', async (ctx) => {
  console.log('CoinMarketCal komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('CoinMarketCal etkinliklerini çekiyorum, biraz bekle kanka! 😎');
    let events = await loadEventsFromCache();
    if (!events || events.length === 0) {
      events = await updateCache();
    }

    if (!events.length) {
      await ctx.reply('CoinMarketCal’dan etkinlik bulunamadı. 😓', getCoinButtons());
      return;
    }

    const limitedEvents = events.slice(0, 10);
    let eventMessage = '📅 CoinMarketCal Etkinlikleri (1 Hafta İçinde):\n';
    for (const event of limitedEvents) {
      eventMessage += `\n${event.coin}: ${event.title} (${event.date})\n`;
      eventMessage += `Etki: ${event.impact}, Catalyst Skor: ${event.catalystScore}\n`;
      eventMessage += `Açıklama: ${event.description.slice(0, 100)}...\n`;
      eventMessage += `Kanıt: ${event.proofLink}\n`;
    }

    const maxMessageLength = 4096;
    if (eventMessage.length > maxMessageLength) {
      const messages = [];
      let currentMessage = '📅 CoinMarketCal Etkinlikleri (1 Hafta İçinde):\n';
      let currentLength = currentMessage.length;

      for (const event of limitedEvents) {
        const eventText = `\n${event.coin}: ${event.title} (${event.date})\nEtki: ${event.impact}, Catalyst Skor: ${event.catalystScore}\nAçıklama: ${event.description.slice(0, 100)}...\nKanıt: ${event.proofLink}\n`;
        if (currentLength + eventText.length > maxMessageLength) {
          messages.push(currentMessage);
          currentMessage = '📅 CoinMarketCal Etkinlikleri (Devam):\n';
          currentLength = currentMessage.length;
        }
        currentMessage += eventText;
        currentLength += eventText.length;
      }
      messages.push(currentMessage);

      for (const msg of messages) {
        await ctx.reply(msg, getCoinButtons());
        if (ctx.chat.id.toString() === GROUP_ID) {
          await bot.telegram.sendMessage(GROUP_ID, msg, getCoinButtons());
        }
      }
    } else {
      await ctx.reply(eventMessage, getCoinButtons());
      if (ctx.chat.id.toString() === GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, eventMessage, getCoinButtons());
      }
    }

    const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
    const comment = await analyzeCoinMarketCalEvents(limitedEvents, chatHistory);
    await ctx.reply(`📝 Grok Fırsat Analizi:\n${comment}`, getCoinButtons());
    if (ctx.chat.id.toString() === GROUP_ID) {
      await bot.telegram.sendMessage(GROUP_ID, `📝 Grok Fırsat Analizi:\n${comment}`, getCoinButtons());
    }
    await saveChatHistory(db, ctx.chat.id.toString(), 'Komut: coinmarketcal');
  } catch (error) {
    console.error('CoinMarketCal komut hatası:', error);
    await ctx.reply('CoinMarketCal verilerini çekerken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.command('top3', async (ctx) => {
  console.log('Top 3 fırsat komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Binance top 100 içinde en iyi 3 trade fırsatını tarıyorum, biraz bekle kanka! 😎');
    const result = await findTopTradeOpportunities(rateLimitedCallGrok);
    if (result.error) {
      await ctx.reply(`Hata: ${result.error}`, getCoinButtons());
      return;
    }

    let response = `📈 En İyi 3 Trade Fırsatı (${result.timestamp}):\n`;
    response += `${result.summary}\n\n`;
    result.opportunities.forEach((analysis, index) => {
      response += `${index + 1}. ${analysis.coin}\n`;
      response += `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice.toFixed(2)}\n`;
      response += `  Giriş: 📉 ${analysis.analyses.giriş.toFixed(2)}\n`;
      response += `  Kısa Vadeli Çıkış (4-6 saat): 📈 ${analysis.analyses.shortTermÇıkış.toFixed(2)} (+${((analysis.analyses.shortTermÇıkış / analysis.analyses.giriş - 1) * 100).toFixed(2)}%)\n`;
      response += `  Günlük Çıkış (24 saat): 📈 ${analysis.analyses.dailyÇıkış.toFixed(2)}\n`;
      response += `  Haftalık Çıkış (1 hafta): 📈 ${analysis.analyses.weeklyÇıkış.toFixed(2)}\n`;
      response += `  Uzun Vadeli Çıkış (1-2 hafta): 📈 ${analysis.analyses.longTermÇıkış.toFixed(2)}\n`;
      response += `  Stop-Loss: 🛑 ${analysis.analyses.stopLoss.toFixed(2)}\n`;
      response += `  Kısa Vadeli Destek (1sa): ${analysis.analyses.shortTermSupport.toFixed(2)}\n`;
      response += `  Kısa Vadeli Direnç (1sa): ${analysis.analyses.shortTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.shortTermResistanceTarget.toFixed(2)})\n`;
      response += `  Uzun Vadeli Destek (1hf): ${analysis.analyses.longTermSupport.toFixed(2)}\n`;
      response += `  Uzun Vadeli Direnç (1hf): ${analysis.analyses.longTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.longTermResistanceTarget.toFixed(2)})\n`;
      response += `  İndikatörler: RSI: ${analysis.analyses.indicators.RSI.toFixed(2)}, MACD: ${analysis.analyses.indicators.MACD.toFixed(2)} (Sinyal: ${analysis.analyses.indicators.signal.toFixed(2)})\n`;
      response += `  Arz-Talep: ${analysis.analyses.orderBook.direction} (Alış/Satış Oranı: ${analysis.analyses.orderBook.bidAskRatio.toFixed(2)})\n`;
      response += `  Hacim Değişimi: ${analysis.analyses.indicators.volumeChange.toFixed(2)}% (${analysis.analyses.indicators.volumeDirection})\n`;
      response += `  Son Kapanış (WebSocket): ${analysis.analyses.latestKline?.close.toFixed(2) || 'Bilinmiyor'}\n`;
      response += `  Yorum: ${analysis.analyses.yorum}\n\n`;
    });

    const maxMessageLength = 4096;
    if (response.length > maxMessageLength) {
      const messages = [];
      let currentMessage = `📈 En İyi 3 Trade Fırsatı (${result.timestamp}):\n${result.summary}\n\n`;
      let currentLength = currentMessage.length;

      result.opportunities.forEach((analysis, index) => {
        const oppText = `${index + 1}. ${analysis.coin}\n` +
                        `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice.toFixed(2)}\n` +
                        `  Giriş: 📉 ${analysis.analyses.giriş.toFixed(2)}\n` +
                        `  Kısa Vadeli Çıkış (4-6 saat): 📈 ${analysis.analyses.shortTermÇıkış.toFixed(2)} (+${((analysis.analyses.shortTermÇıkış / analysis.analyses.giriş - 1) * 100).toFixed(2)}%)\n` +
                        `  Günlük Çıkış (24 saat): 📈 ${analysis.analyses.dailyÇıkış.toFixed(2)}\n` +
                        `  Haftalık Çıkış (1 hafta): 📈 ${analysis.analyses.weeklyÇıkış.toFixed(2)}\n` +
                        `  Uzun Vadeli Çıkış (1-2 hafta): 📈 ${analysis.analyses.longTermÇıkış.toFixed(2)}\n` +
                        `  Stop-Loss: 🛑 ${analysis.analyses.stopLoss.toFixed(2)}\n` +
                        `  Kısa Vadeli Destek (1sa): ${analysis.analyses.shortTermSupport.toFixed(2)}\n` +
                        `  Kısa Vadeli Direnç (1sa): ${analysis.analyses.shortTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.shortTermResistanceTarget.toFixed(2)})\n` +
                        `  Uzun Vadeli Destek (1hf): ${analysis.analyses.longTermSupport.toFixed(2)}\n` +
                        `  Uzun Vadeli Direnç (1hf): ${analysis.analyses.longTermResistance.toFixed(2)} (Aşılırsa Hedef: ${analysis.analyses.longTermResistanceTarget.toFixed(2)})\n` +
                        `  İndikatörler: RSI: ${analysis.analyses.indicators.RSI.toFixed(2)}, MACD: ${analysis.analyses.indicators.MACD.toFixed(2)} (Sinyal: ${analysis.analyses.indicators.signal.toFixed(2)})\n` +
                        `  Arz-Talep: ${analysis.analyses.orderBook.direction} (Alış/Satış Oranı: ${analysis.analyses.orderBook.bidAskRatio.toFixed(2)})\n` +
                        `  Hacim Değişimi: ${analysis.analyses.indicators.volumeChange.toFixed(2)}% (${analysis.analyses.indicators.volumeDirection})\n` +
                        `  Son Kapanış (WebSocket): ${analysis.analyses.latestKline?.close.toFixed(2) || 'Bilinmiyor'}\n` +
                        `  Yorum: ${analysis.analyses.yorum}\n\n`;
        if (currentLength + oppText.length > maxMessageLength) {
          messages.push(currentMessage);
          currentMessage = `📈 En İyi 3 Trade Fırsatı (Devam):\n`;
          currentLength = currentMessage.length;
        }
        currentMessage += oppText;
        currentLength += oppText.length;
      });
      messages.push(currentMessage);

      for (const msg of messages) {
        await ctx.reply(msg, getCoinButtons());
        if (ctx.chat.id.toString() === GROUP_ID) {
          await bot.telegram.sendMessage(GROUP_ID, msg, getCoinButtons());
        }
      }
    } else {
      await ctx.reply(response, getCoinButtons());
      if (ctx.chat.id.toString() === GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, response, getCoinButtons());
      }
    }
    await saveChatHistory(db, ctx.chat.id.toString(), 'Komut: top3');
  } catch (error) {
    console.error('Top 3 fırsat hatası:', error);
    await ctx.reply('En iyi 3 fırsat aranırken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.command('opportunities', async (ctx) => {
  console.log('Opportunities komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Potansiyel coin fırsatlarını tarıyorum, biraz bekle kanka! 😎');
    const opportunities = await findOpportunityCoins();

    if (!opportunities.length) {
      await ctx.reply('Şu an yüksek potansiyelli coin bulunamadı. 😓 CoinMarketCal verilerini kontrol et!', getCoinButtons());
      return;
    }

    let message = '📈 Potansiyel Fırsat Coin’leri (Kaynak: CoinMarketCal):\n';
    for (const opp of opportunities) {
      message += `\n${opp.coin} (${opp.symbol}, Skor: ${opp.score}):\n`;
      message += `  Güncel Fiyat: 💰 ${opp.price ? opp.price.toFixed(2) : 'Bilinmiyor'}\n`;
      message += `  Etkinlik: ${opp.event.title} (${opp.event.date})\n`;
      message += `  Etki: ${opp.event.impact}, Catalyst Skor: ${opp.event.catalystScore}\n`;
      message += `  Açıklama: ${opp.event.description.slice(0, 100)}...\n`;
      message += `  Kanıt: ${opp.event.proofLink}\n`;
      message += `  RSI: ${opp.indicators?.RSI.toFixed(2) || 'Bilinmiyor'}\n`;
      message += `  MACD: ${opp.indicators?.MACD.toFixed(2) || 'Bilinmiyor'}\n`;
    }

    const maxMessageLength = 4096;
    if (message.length > maxMessageLength) {
      const messages = [];
      let currentMessage = '📈 Potansiyel Fırsat Coin’leri (Kaynak: CoinMarketCal):\n';
      let currentLength = currentMessage.length;

      for (const opp of opportunities) {
        const oppText = `\n${opp.coin} (${opp.symbol}, Skor: ${opp.score}):\n` +
                        `  Güncel Fiyat: 💰 ${opp.price ? opp.price.toFixed(2) : 'Bilinmiyor'}\n` +
                        `  Etkinlik: ${opp.event.title} (${opp.event.date})\n` +
                        `  Etki: ${opp.event.impact}, Catalyst Skor: ${opp.event.catalystScore}\n` +
                        `  Açıklama: ${opp.event.description.slice(0, 100)}...\n` +
                        `  Kanıt: ${opp.event.proofLink}\n` +
                        `  RSI: ${opp.indicators?.RSI.toFixed(2) || 'Bilinmiyor'}\n` +
                        `  MACD: ${opp.indicators?.MACD.toFixed(2) || 'Bilinmiyor'}\n`;
        if (currentLength + oppText.length > maxMessageLength) {
          messages.push(currentMessage);
          currentMessage = '📈 Potansiyel Fırsat Coin’leri (Devam):\n';
          currentLength = currentMessage.length;
        }
        currentMessage += oppText;
        currentLength += oppText.length;
      }
      messages.push(currentMessage);

      for (const msg of messages) {
        await ctx.reply(msg, getCoinButtons());
        if (ctx.chat.id.toString() === GROUP_ID) {
          await bot.telegram.sendMessage(GROUP_ID, msg, getCoinButtons());
        }
      }
    } else {
      await ctx.reply(message, getCoinButtons());
      if (ctx.chat.id.toString() === GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, message, getCoinButtons());
      }
    }

    await saveChatHistory(db, ctx.chat.id.toString(), 'Komut: opportunities');
  } catch (error) {
    console.error('Opportunities komut hatası:', error);
    await ctx.reply('Fırsat coin’leri aranırken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action('alarm_stop', async (ctx) => {
  console.log('Inline alarm stop isteği, chat ID:', ctx.chat.id);
  try {
    isBitcoinMonitoringPaused = true;
    pauseEndTime = Date.now() + 24 * 60 * 60 * 1000;
    const pauseMessage = `Bitcoin izleme bildirimleri 24 saatliğine durduruldu. Kalan süre: ${((pauseEndTime - Date.now()) / 1000 / 60).toFixed(2)} dakika. 24 saat sonra otomatik devam edecek. 🛑`;
    await ctx.reply(pauseMessage, getCoinButtons());
    console.log(pauseMessage);
    await saveChatHistory(db, ctx.chat.id.toString(), 'Inline: alarm_stop');
  } catch (error) {
    console.error('Inline alarm stop hatası:', error);
    await ctx.reply('Alarm durdurma sırasında hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action('alarm_menu', async (ctx) => {
  console.log('Inline alarm menu isteği, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Hangi coin için alarm kuralım? 😊', getAlarmButtons());
    await saveChatHistory(db, ctx.chat.id.toString(), 'Inline: alarm_menu');
  } catch (error) {
    console.error('Inline alarm menu hatası:', error);
    await ctx.reply('Alarm menüsü açılırken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action(/analyze_(.+)/, async (ctx) => {
  const coin = ctx.match[1];
  console.log(`Inline analiz isteği: ${coin}, chat ID: ${ctx.chat.id}`);
  try {
    if (!COINS.includes(coin)) {
      await ctx.reply('Geçerli bir coin seç kanka! 😊', getCoinButtons());
      return;
    }
    await ctx.reply(`${coin.split('-')[0]}’yı analiz ediyorum, biraz bekle! 😎`);

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

    const maxMessageLength = 4096;
    if (message.length > maxMessageLength) {
      const messages = [];
      let currentMessage = `${coin} Analizi (${new Date(analysis.tarih).toLocaleString('tr-TR')}):\n`;
      let currentLength = currentMessage.length;

      const lines = message.split('\n');
      for (const line of lines) {
        if (currentLength + line.length + 1 > maxMessageLength) {
          messages.push(currentMessage);
          currentMessage = `${coin} Analizi (Devam):\n`;
          currentLength = currentMessage.length;
        }
        currentMessage += line + '\n';
        currentLength += line.length + 1;
      }
      messages.push(currentMessage);

      for (const msg of messages) {
        await ctx.reply(msg, getCoinButtons());
        if (ctx.chat.id.toString() === GROUP_ID) {
          await bot.telegram.sendMessage(GROUP_ID, msg, getCoinButtons());
        }
      }
    } else {
      await ctx.reply(message, getCoinButtons());
      if (ctx.chat.id.toString() === GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, message, getCoinButtons());
      }
    }
    await saveChatHistory(db, ctx.chat.id.toString(), `Inline: analyze_${coin}`);
  } catch (error) {
    console.error(`Inline analiz hatası: ${coin}:`, error);
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
    if (ctx.chat.id.toString() === GROUP_ID) {
      await bot.telegram.sendMessage(GROUP_ID, status, getCoinButtons());
    }
    await saveChatHistory(db, ctx.chat.id.toString(), `Inline: status_${coin}`);
  } catch (error) {
    console.error(`Inline durum hatası: ${coin}:`, error);
    await ctx.reply('Durum kontrolü sırasında hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
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
    await ctx.reply(`📢 ${coin.split('-')[0]} için alarm fiyatını gir (örneğin: 100.50):`);
    bot.once('text', async (msgCtx) => {
      const targetPrice = parseFloat(msgCtx.message.text);
      if (isNaN(targetPrice) || targetPrice <= 0) {
        await msgCtx.reply('Geçerli bir fiyat gir kanka! 😊 Örnek: 100.50', getCoinButtons());
        return;
      }
      const chatId = msgCtx.chat.id.toString();
      priceAlarms.set(`${coin}-${chatId}`, { coin, chatId, targetPrice });
      await msgCtx.reply(
        `📢 ${coin.split('-')[0]} için ${targetPrice.toFixed(2)} USDT alarmı kuruldu! Fiyat ulaştığında haber veririm. 😎`,
        getCoinButtons()
      );
      await saveChatHistory(db, chatId, `Alarm kuruldu: ${coin} @ ${targetPrice.toFixed(2)}`);

      const ws = await startWebSocket(coin, targetPrice, chatId, async ({ price }) => {
        if (Math.abs(price - targetPrice) <= 0.01 * targetPrice) {
          await bot.telegram.sendMessage(
            chatId,
            `🚨 ${coin.split('-')[0]} fiyatı ${price.toFixed(2)} USDT’ye ulaştı! Hedef: ${targetPrice.toFixed(2)} USDT. 😎`,
            getCoinButtons()
          );
          priceAlarms.delete(`${coin}-${chatId}`);
          ws.stop();
        }
      });
    });
  } catch (error) {
    console.error(`Inline alarm hatası: ${coin}:`, error);
    await ctx.reply('Alarm kurarken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action('coinmarketcal', async (ctx) => {
  console.log('Inline CoinMarketCal isteği, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('CoinMarketCal etkinliklerini çekiyorum, biraz bekle kanka! 😎');
    let events = await loadEventsFromCache();
    if (!events || events.length === 0) {
      events = await updateCache();
    }

    if (!events.length) {
      await ctx.reply('CoinMarketCal’dan etkinlik bulunamadı. 😓', getCoinButtons());
      return;
    }

    const limitedEvents = events.slice(0, 10);
    let eventMessage = '📅 CoinMarketCal Etkinlikleri (1 Hafta İçinde):\n';
    for (const event of limitedEvents) {
      eventMessage += `\n${event.coin}: ${event.title} (${event.date})\n`;
      eventMessage += `Etki: ${event.impact}, Catalyst Skor: ${event.catalystScore}\n`;
      eventMessage += `Açıklama: ${event.description.slice(0, 100)}...\n`;
      eventMessage += `Kanıt: ${event.proofLink}\n`;
    }

    const maxMessageLength = 4096;
    if (eventMessage.length > maxMessageLength) {
      const messages = [];
      let currentMessage = '📅 CoinMarketCal Etkinlikleri (1 Hafta İçinde):\n';
      let currentLength = currentMessage.length;

      for (const event of limitedEvents) {
        const eventText = `\n${event.coin}: ${event.title} (${event.date})\nEtki: ${event.impact}, Catalyst Skor: ${event.catalystScore}\nAçıklama: ${event.description.slice(0, 100)}...\nKanıt: ${event.proofLink}\n`;
        if (currentLength + eventText.length > maxMessageLength) {
          messages.push(currentMessage);
          currentMessage = '📅 CoinMarketCal Etkinlikleri (Devam):\n';
          currentLength = currentMessage.length;
        }
        currentMessage += eventText;
        currentLength += eventText.length;
      }
      messages.push(currentMessage);

      for (const msg of messages) {
        await ctx.reply(msg, getCoinButtons());
        if (ctx.chat.id.toString() === GROUP_ID) {
          await bot.telegram.sendMessage(GROUP_ID, msg, getCoinButtons());
        }
      }
    } else {
      await ctx.reply(eventMessage, getCoinButtons());
      if (ctx.chat.id.toString() === GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, eventMessage, getCoinButtons());
      }
    }

    const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
    const comment = await analyzeCoinMarketCalEvents(limitedEvents, chatHistory);
    await ctx.reply(`📝 Grok Fırsat Analizi:\n${comment}`, getCoinButtons());
    if (ctx.chat.id.toString() === GROUP_ID) {
      await bot.telegram.sendMessage(GROUP_ID, `📝 Grok Fırsat Analizi:\n${comment}`, getCoinButtons());
    }
    await saveChatHistory(db, ctx.chat.id.toString(), 'Inline: coinmarketcal');
  } catch (error) {
    console.error('Inline CoinMarketCal hatası:', error);
    await ctx.reply('CoinMarketCal verilerini çekerken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action('update_coinmarketcal', async (ctx) => {
  console.log('Inline CoinMarketCal güncelleme isteği, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('CoinMarketCal verilerini güncelliyorum, biraz bekle kanka! 😎');
    const events = await updateCache();
    if (!events.length) {
      await ctx.reply('CoinMarketCal’dan yeni etkinlik bulunamadı. 😓', getCoinButtons());
      return;
    }

    const limitedEvents = events.slice(0, 10);
    let eventMessage = '📅 Güncellenmiş CoinMarketCal Etkinlikleri (1 Hafta İçinde):\n';
    for (const event of limitedEvents) {
      eventMessage += `\n${event.coin}: ${event.title} (${event.date})\n`;
      eventMessage += `Etki: ${event.impact}, Catalyst Skor: ${event.catalystScore}\n`;
      eventMessage += `Açıklama: ${event.description.slice(0, 100)}...\n`;
      eventMessage += `Kanıt: ${event.proofLink}\n`;
    }

    const maxMessageLength = 4096;
    if (eventMessage.length > maxMessageLength) {
      const messages = [];
      let currentMessage = '📅 Güncellenmiş CoinMarketCal Etkinlikleri (1 Hafta İçinde):\n';
      let currentLength = currentMessage.length;

      for (const event of limitedEvents) {
        const eventText = `\n${event.coin}: ${event.title} (${event.date})\nEtki: ${event.impact}, Catalyst Skor: ${event.catalystScore}\nAçıklama: ${event.description.slice(0, 100)}...\nKanıt: ${event.proofLink}\n`;
        if (currentLength + eventText.length > maxMessageLength) {
          messages.push(currentMessage);
          currentMessage = '📅 Güncellenmiş CoinMarketCal Etkinlikleri (Devam):\n';
          currentLength = currentMessage.length;
        }
        currentMessage += eventText;
        currentLength += eventText.length;
      }
      messages.push(currentMessage);

      for (const msg of messages) {
        await ctx.reply(msg, getCoinButtons());
        if (ctx.chat.id.toString() === GROUP_ID) {
          await bot.telegram.sendMessage(GROUP_ID, msg, getCoinButtons());
        }
      }
    } else {
      await ctx.reply(eventMessage, getCoinButtons());
      if (ctx.chat.id.toString() === GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, eventMessage, getCoinButtons());
      }
    }

    const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
    const comment = await analyzeCoinMarketCalEvents(limitedEvents, chatHistory);
    await ctx.reply(`📝 Grok Fırsat Analizi (Güncellenmiş):\n${comment}`, getCoinButtons());
    if (ctx.chat.id.toString() === GROUP_ID) {
      await bot.telegram.sendMessage(GROUP_ID, `📝 Grok Fırsat Analizi (Güncellenmiş):\n${comment}`, getCoinButtons());
    }
    await saveChatHistory(db, ctx.chat.id.toString(), 'Inline: update_coinmarketcal');
  } catch (error) {
    console.error('Inline CoinMarketCal güncelleme hatası:', error);
    await ctx.reply('CoinMarketCal güncellenirken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

// Zamanlanmış Görevler
const schedule = require('node-schedule');

// CoinMarketCal verilerini her gün 00:00’da güncelle
schedule.scheduleJob('0 0 * * *', async () => {
  console.log('CoinMarketCal verileri günlük güncelleme başlıyor...');
  try {
    await updateCache();
    console.log('CoinMarketCal verileri güncellendi.');
  } catch (error) {
    console.error('CoinMarketCal günlük güncelleme hatası:', error);
  }
});

// Bitcoin fiyatını 2 saatte bir kontrol et
schedule.scheduleJob('0 */2 * * *', async () => {
  if (isBitcoinMonitoringPaused && Date.now() < pauseEndTime) return;
  try {
    const news = await fetchNews();
    const chatHistory = await getRecentChatHistory(db, GROUP_ID);
    const btcAnalysis = await analyzeCoin('BTC-USDT', null, news, chatHistory);
    const indicators = btcAnalysis.analyses.indicators;
    const isDropSignal = indicators.RSI < 30 && indicators.MACD < indicators.signal && indicators.volumeChange < -10;

    if (isDropSignal) {
      const message = `🚨 Bitcoin Düşüş Sinyali!\n` +
                      `Güncel Fiyat: 💰 ${btcAnalysis.analyses.currentPrice.toFixed(2)} USDT\n` +
                      `Tahmini Dip: 📉 ${btcAnalysis.analyses.giriş.toFixed(2)} USDT\n` +
                      `RSI: ${indicators.RSI.toFixed(2)}, MACD: ${indicators.MACD.toFixed(2)} (Sinyal: ${indicators.signal.toFixed(2)})\n` +
                      `Hacim Değişimi: ${indicators.volumeChange.toFixed(2)}%\n` +
                      `Dikkatli ol kanka, yatırımlarını gözden geçir! 😎`;
      await bot.telegram.sendMessage(GROUP_ID, message, getCoinButtons());
      console.log('Bitcoin düşüş sinyali gönderildi:', message);
    }
  } catch (error) {
    console.error('Bitcoin izleme hatası:', error);
  }
});

// sentMessages Set’ini her 24 saatte bir temizle
schedule.scheduleJob('0 0 * * *', () => {
  console.log('sentMessages temizleniyor...');
  sentMessages.clear();
});

// Heroku için Server Kurulumu
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Kripto analiz botu çalışıyor! 🚀');
});

// Botun düzgün kapanması için SIGTERM işleme
process.on('SIGTERM', async () => {
  console.log('SIGTERM alındı, bot kapatılıyor...');
  try {
    await bot.stop();
    await db.close();
    console.log('Bot ve veritabanı başarıyla kapatıldı.');
    process.exit(0);
  } catch (error) {
    console.error('Kapatma sırasında hata:', error);
    process.exit(1);
  }
});

// Botu başlat
bot.launch().then(() => {
  console.log('Bot başlatıldı! 🚀');
}).catch((error) => {
  console.error('Bot başlatma hatası:', error);
});

// Serverı başlat
app.listen(port, () => {
  console.log(`Server ${port} portunda çalışıyor.`);
});
