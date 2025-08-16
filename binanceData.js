const axios = require('axios');
const WebSocket = require('ws');
const { RSI, MACD, EMA, PSAR, StochasticRSI } = require('technicalindicators');

// Cache for REST and WebSocket data
const cache = new Map();
const CACHE_DURATION = 2 * 60 * 60 * 1000; // 2 hours
const RATE_LIMIT_MS = 500;
let lastBinanceRequest = 0;
const wsConnections = new Map(); // WebSocket bağlantıları için

// Rate-limited REST API call
async function rateLimitedBinanceCall(url, params = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const now = Date.now();
      if (now - lastBinanceRequest < RATE_LIMIT_MS) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - (now - lastBinanceRequest)));
      }
      lastBinanceRequest = Date.now();

      const cacheKey = `${url}-${JSON.stringify(params)}`;
      if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_DURATION) {
          console.log('Cache hit for Binance REST:', cacheKey);
          return cached.data;
        }
      }

      const response = await axios.get(url, { params });
      cache.set(cacheKey, { data: response.data, timestamp: Date.now() });
      return response.data;
    } catch (error) {
      console.error(`Binance REST API error (attempt ${i + 1}/${retries}):`, error.message);
      if (i === retries - 1) return null;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// WebSocket bağlantısı başlat
function startWebSocket(symbol, streams = ['depth20@100ms', 'kline_1h'], onData) {
  const wsKey = symbol.toLowerCase();
  if (wsConnections.has(wsKey)) {
    console.log(`WebSocket for ${symbol} already active`);
    return wsConnections.get(wsKey);
  }

  const ws = new WebSocket(`wss://ws-api.binance.com:443/ws-api/v3`);
  wsConnections.set(wsKey, { ws, data: { orderBook: null, kline: null } });

  ws.on('open', () => {
    console.log(`WebSocket opened for ${symbol}`);
    const subscribeMsg = {
      id: `${symbol}-${Date.now()}`,
      method: 'subscribe',
      params: { streams: streams.map(s => `${symbol.toLowerCase()}@${s}`) },
    };
    ws.send(JSON.stringify(subscribeMsg));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const wsData = wsConnections.get(wsKey).data;

    if (msg.event === 'ping') {
      ws.send(JSON.stringify({ id: msg.id, method: 'pong', params: { payload: msg.params.payload } }));
      return;
    }

    if (msg.stream?.includes('depth')) {
      wsData.orderBook = {
        bids: msg.data.bids.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
        asks: msg.data.asks.map(([price, qty]) => ({ price: parseFloat(price), qty: parseFloat(qty) })),
        bidVolume: msg.data.bids.reduce((sum, [_, qty]) => sum + parseFloat(qty), 0),
        askVolume: msg.data.asks.reduce((sum, [_, qty]) => sum + parseFloat(qty), 0),
        lastUpdateId: msg.data.lastUpdateId,
      };
      wsData.orderBook.bidAskRatio = wsData.orderBook.bidVolume / (wsData.orderBook.bidVolume + wsData.orderBook.askVolume) || 0;
      wsData.orderBook.direction = wsData.orderBook.bidAskRatio > 0.6 ? 'Alış baskısı (Bullish)' :
                                  wsData.orderBook.bidAskRatio < 0.4 ? 'Satış baskısı (Bearish)' : 'Nötr';
      onData(wsData);
    } else if (msg.stream?.includes('kline')) {
      wsData.kline = {
        timestamp: new Date(msg.data.k.t).toISOString(),
        open: parseFloat(msg.data.k.o),
        high: parseFloat(msg.data.k.h),
        low: parseFloat(msg.data.k.l),
        close: parseFloat(msg.data.k.c),
        volume: parseFloat(msg.data.k.v),
      };
      onData(wsData);
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${symbol}:`, error.message);
    wsConnections.delete(wsKey);
  });

  ws.on('close', () => {
    console.log(`WebSocket closed for ${symbol}`);
    wsConnections.delete(wsKey);
  });

  return ws;
}

// Fetch current price (REST)
async function getBinanceCurrentPrice(symbol) {
  try {
    const data = await rateLimitedBinanceCall('https://api.binance.com/api/v3/ticker/price', { symbol });
    return parseFloat(data.price);
  } catch (error) {
    console.error(`Binance price error for ${symbol}:`, error.message);
    return null;
  }
}

// Fetch kline data (REST)
async function fetchBinanceKlines(symbol, timeframe, limit = 100) {
  try {
    const data = await rateLimitedBinanceCall('https://api.binance.com/api/v3/klines', {
      symbol,
      interval: timeframe,
      limit,
    });
    return data.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp: new Date(timestamp).toISOString(),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    })).filter(d => d.low > 0 && d.high > 0 && d.close > 0);
  } catch (error) {
    console.error(`Binance klines error for ${symbol} (${timeframe}):`, error.message);
    return [];
  }
}

// Calculate technical indicators
function calculateBinanceIndicators(data) {
  if (!data || data.length < 2) return null;
  const closes = data.map(d => d.close);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const volumes = data.map(d => d.volume);

  try {
    const volumeChange = ((volumes[volumes.length - 1] - volumes[volumes.length - 2]) / volumes[volumes.length - 2] * 100) || 0;
    return {
      RSI: RSI.calculate({ period: 14, values: closes }).slice(-1)[0] || 0,
      MACD: MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes }).slice(-1)[0]?.MACD || 0,
      signal: MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes }).slice(-1)[0]?.signal || 0,
      EMA50: EMA.calculate({ period: 50, values: closes }).slice(-1)[0] || 0,
      EMA200: EMA.calculate({ period: 200, values: closes }).slice(-1)[0] || 0,
      PSAR: PSAR.calculate({ high: highs, low: lows, step: 0.02, max: 0.2 }).slice(-1)[0] || 0,
      StochRSI: StochasticRSI.calculate({ period: 14, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3, values: closes }).slice(-1)[0]?.k || 0,
      volumeChange,
      volumeDirection: volumeChange > 10 ? 'Yükselen hacim (Bullish)' : volumeChange < -10 ? 'Düşen hacim (Bearish)' : 'Nötr hacim',
    };
  } catch (error) {
    console.error('Calculate indicators error:', error.message);
    return null;
  }
}

// Calculate ATR
function calculateBinanceATR(data) {
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

// Fetch top 100 coins by trading volume
async function fetchBinanceTop100Coins() {
  try {
    const data = await rateLimitedBinanceCall('https://api.binance.com/api/v3/ticker/24hr');
    return data
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('BUSD'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 100)
      .map(t => t.symbol);
  } catch (error) {
    console.error('Error fetching Binance top 100 coins:', error.message);
    return [];
  }
}

// Analyze single coin with WebSocket
async function analyzeBinanceCoin(coin, timeframe = '1h', grokPromptFunction) {
  return new Promise(async (resolve) => {
    try {
      const currentPrice = await getBinanceCurrentPrice(coin);
      const klines = await fetchBinanceKlines(coin, timeframe, 200);
      const indicators = calculateBinanceIndicators(klines);
      const atr = calculateBinanceATR(klines);

      let orderBook = { bids: [], asks: [], bidVolume: 0, askVolume: 0, bidAskRatio: 0, direction: 'Nötr' };
      let latestKline = klines.length ? klines[klines.length - 1] : null;

      // WebSocket ile gerçek zamanlı veri
      startWebSocket(coin, ['depth20@100ms', `kline_${timeframe}`], (wsData) => {
        if (wsData.orderBook) orderBook = wsData.orderBook;
        if (wsData.kline) latestKline = wsData.kline;

        if (!currentPrice || !klines.length || !indicators) {
          resolve({
            coin,
            tarih: new Date().toLocaleString('tr-TR'),
            analyses: {
              error: `Veri eksik: ${coin} için analiz yapılamadı.`,
              currentPrice: currentPrice ? currentPrice.toFixed(2) : 'Bilinmiyor',
            },
          });
          return;
        }

        const prompt = `
          ${coin} için kısa vadeli (${timeframe}) teknik ve arz-talep analizi yap.
          İndikatörler: ${JSON.stringify(indicators, null, 2)}.
          Güncel fiyat: ${currentPrice.toFixed(2)}.
          ATR: ${atr.toFixed(2)}.
          Emir defteri: 
            - En iyi alış: ${orderBook.bids[0]?.price.toFixed(2) || 'Bilinmiyor'}
            - En iyi satış: ${orderBook.asks[0]?.price.toFixed(2) || 'Bilinmiyor'}
            - Alış hacmi: ${orderBook.bidVolume.toFixed(2)}
            - Satış hacmi: ${orderBook.askVolume.toFixed(2)}
            - Alış/Satış oranı: ${orderBook.bidAskRatio.toFixed(2)} (${orderBook.direction})
          Hacim değişimi: ${indicators.volumeChange.toFixed(2)}% (${indicators.volumeDirection}).
          Giriş (📉) fiyatını belirlerken fiyatın düşebileceği potansiyel dip seviyelerini (SMA-50, PSAR, Fibonacci %38.2, ATR) analiz et, güncel fiyattan direkt giriş önerme, kâr marjını maksimize et.
          Çıkış (📈) için:
            - Kısa vadeli (4-6 saat) hedef,
            - Günlük (24 saat) hedef,
            - Haftalık (1 hafta) hedef,
            - Uzun vadeli (1-2 hafta) hedef ver.
          Stop-loss (🛑) fiyatını giriş fiyatının altında, 1.5 * ATR mesafede belirle.
          Kısa vadeli (1sa) ve uzun vadeli (1 hafta) destek/direnç noktaları belirle. Her direnç noktası aşılırsa olası fiyat hedeflerini ver.
          Alış/Satış baskısını ve hacim değişimini dikkate alarak net bir al/sat sinyali ver (örneğin, "Al: Güçlü alış baskısı ve hacim artışı").
          Kısa, samimi Türkçe yorum (maksimum 300 kelime, kelime sayısını yazma).
        `;

        grokPromptFunction(prompt).then(comment => {
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

          const priceMatch = comment?.match(/📉 (\d+\.?\d*)/);
          const shortTpMatch = comment?.match(/Kısa vadeli 📈 (\d+\.?\d*)/);
          const dailyTpMatch = comment?.match(/Günlük 📈 (\d+\.?\d*)/);
          const weeklyTpMatch = comment?.match(/Haftalık 📈 (\d+\.?\d*)/);
          const longTpMatch = comment?.match(/Uzun vadeli 📈 (\d+\.?\d*)/);
          const stopLossMatch = comment?.match(/🛑 (\d+\.?\d*)/);
          const shortTermSupportMatch = comment?.match(/Kısa vadeli destek: (\d+\.?\d*)/);
          const shortTermResistanceMatch = comment?.match(/Kısa vadeli direnç: (\d+\.?\d*)/);
          const longTermSupportMatch = comment?.match(/Uzun vadeli destek: (\d+\.?\d*)/);
          const longTermResistanceMatch = comment?.match(/Uzun vadeli direnç: (\d+\.?\d*)/);
          const shortTermResistanceTargetMatch = comment?.match(/Kısa vadeli direnç aşılırsa hedef: (\d+\.?\d*)/);
          const longTermResistanceTargetMatch = comment?.match(/Uzun vadeli direnç aşılırsa hedef: (\d+\.?\d*)/);

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

          resolve({
            coin,
            tarih: new Date().toLocaleString('tr-TR'),
            analyses: {
              currentPrice,
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
              yorum: comment || 'Analiz yapılamadı, veri eksik.',
              indicators,
              orderBook,
              latestKline,
            },
          });
        }).catch(error => {
          console.error(`Grok prompt error for ${coin}:`, error.message);
          resolve({
            coin,
            tarih: new Date().toLocaleString('tr-TR'),
            analyses: {
              error: `Grok analizi başarısız: ${error.message}`,
              currentPrice: currentPrice ? currentPrice.toFixed(2) : 'Bilinmiyor',
            },
          });
        });
      });
    } catch (error) {
      console.error(`Binance analysis error for ${coin}:`, error.message);
      resolve({
        coin,
        tarih: new Date().toLocaleString('tr-TR'),
        analyses: {
          error: `Analiz hatası: ${error.message}`,
          currentPrice: null,
        },
      });
    }
  });
}

// Find top 3 trade opportunities
async function findTopTradeOpportunities(grokPromptFunction, batchSize = 10) {
  try {
    const coins = await fetchBinanceTop100Coins();
    if (!coins.length) {
      return { error: 'Top 100 coin listesi alınamadı.' };
    }

    const results = [];
    for (let i = 0; i < coins.length; i += batchSize) {
      const batch = coins.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (coin) => {
          console.log(`Analyzing ${coin} for trade opportunity...`);
          const analysis = await analyzeBinanceCoin(coin, '1h', grokPromptFunction);
          if (analysis.analyses.error) return null;

          const shortTermGain = analysis.analyses.shortTermÇıkış / analysis.analyses.giriş - 1;
          let score = shortTermGain * 100;
          if (analysis.analyses.indicators.RSI < 30) score += 30;
          if (analysis.analyses.indicators.MACD > analysis.analyses.indicators.signal) score += 20;
          if (analysis.analyses.indicators.volumeChange > 10) score += 15;
          if (analysis.analyses.orderBook.bidAskRatio > 0.6) score += 20;
          if (analysis.analyses.orderBook.bidAskRatio < 0.4) score -= 20;

          return { ...analysis, score };
        })
      );
      results.push(...batchResults.filter(r => r !== null));
      if (i + batchSize < coins.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const top3 = results
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    // WebSocket bağlantılarını kapat
    wsConnections.forEach((conn, key) => {
      conn.ws.close();
      wsConnections.delete(key);
    });

    return {
      timestamp: new Date().toLocaleString('tr-TR'),
      opportunities: top3,
      summary: top3.length ? `En iyi 3 trade fırsatı: ${top3.map(r => r.coin).join(', ')}` : 'Fırsat bulunamadı.',
    };
  } catch (error) {
    console.error('Error finding top trade opportunities:', error.message);
    return { error: `Fırsat tarama hatası: ${error.message}` };
  }
}

// Cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (now - value.timestamp > CACHE_DURATION) {
      cache.delete(key);
    }
  }
  console.log('Binance cache temizlendi, kalan öğe sayısı:', cache.size);
}, 30 * 1000);

// WebSocket connection cleanup
setInterval(() => {
  wsConnections.forEach((conn, key) => {
    if (conn.ws.readyState === WebSocket.CLOSED) {
      wsConnections.delete(key);
      console.log(`Closed WebSocket connection removed for ${key}`);
    }
  });
}, 60 * 1000);

module.exports = {
  getBinanceCurrentPrice,
  fetchBinanceKlines,
  wsConnections,
  calculateBinanceIndicators,
  calculateBinanceATR,
  analyzeBinanceCoin,
  fetchBinanceTop100Coins,
  findTopTradeOpportunities,
};

