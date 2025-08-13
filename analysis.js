const ccxt = require('ccxt');
const { RSI, MACD, EMA, PSAR, StochasticRSI } = require('technicalindicators');
const axios = require('axios');

const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT'];
const TIMEFRAMES = ['1min', '5min', '30min', '1hour', '2hour', '4hour', '1day', '1week', '1month'];

const kucoin = new ccxt.kucoin({
  apiKey: process.env.KUCOIN_KEY,
  secret: process.env.KUCOIN_SECRET,
  enableRateLimit: true,
});

async function fetchKlines(coin, timeframe, startAt = 0, endAt = 0) {
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
    console.error(`Klines error for ${coin} (${timeframe}):`, error.message);
    return [];
  }
}

function calculateIndicators(data) {
  const closes = data.map(d => d.close);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const volumes = data.map(d => d.volume);

  return {
    RSI: RSI.calculate({ period: 14, values: closes }).slice(-1)[0] || 0,
    MACD: MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes }).slice(-1)[0]?.MACD || 0,
    EMA50: EMA.calculate({ period: 50, values: closes }).slice(-1)[0] || 0,
    EMA200: EMA.calculate({ period: 200, values: closes }).slice(-1)[0] || 0,
    PSAR: PSAR.calculate({ high: highs, low: lows, step: 0.02, max: 0.2 }).slice(-1)[0] || 0,
    StochRSI: StochasticRSI.calculate({ period: 14, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3, values: closes }).slice(-1)[0]?.k || 0,
    volumeChange: ((volumes[volumes.length - 1] - volumes[volumes.length - 2]) / volumes[volumes.length - 2] * 100) || 0,
  };
}

async function callGrok(prompt) {
  try {
    const response = await axios.post(
      'https://api.x.ai/v1/chat/completions',
      {
        messages: [
          { role: 'system', content: 'Sen bir kripto para analiz botusun. Teknik indikatörlere ve Bitcoin durumuna dayalı doğal, Türkçe yorumlar yap.' },
          { role: 'user', content: prompt },
        ],
        model: 'grok-4-latest',
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
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Grok API error:', error.message);
    return `Yorum oluşturulamadı: ${error.message}`;
  }
}

async function analyzeCoin(coin, btcData = null, news = []) {
  let result = { coin, tarih: new Date().toLocaleString('tr-TR'), analyses: {} };
  for (const timeframe of TIMEFRAMES) {
    const data = await fetchKlines(coin, timeframe);
    if (!data.length) continue;

    const indicators = calculateIndicators(data);
    const dip = Math.min(...data.map(d => d.low));
    const tp = Math.max(...data.map(d => d.high)) * 1.05;

    const btcIndicators = btcData ? calculateIndicators(btcData) : {};
    const btcStatus = btcIndicators.EMA50 > btcIndicators.EMA200 ? 'Yükselişte' : 'Düşüşte';

    const negativeNews = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));
    const prompt = `
      Coin: ${coin}, Zaman dilimi: ${timeframe}, RSI: ${indicators.RSI.toFixed(2)}, 
      MACD: ${indicators.MACD.toFixed(2)}, EMA50: ${indicators.EMA50.toFixed(2)}, 
      EMA200: ${indicators.EMA200.toFixed(2)}, PSAR: ${indicators.PSAR.toFixed(2)}, 
      StochRSI: ${indicators.StochRSI.toFixed(2)}, Hacim değişimi: ${indicators.volumeChange.toFixed(2)}%, 
      BTC durumu: ${btcStatus}, Haber durumu: ${negativeNews ? 'Olumsuz' : 'Nötr'}. 
      Giriş: ${dip.toFixed(2)}, Çıkış: ${tp.toFixed(2)}. 
      Türkçe, doğal ve ayrıntılı bir analiz yorumu yap.`;
    const comment = await callGrok(prompt);

    result.analyses[timeframe] = { giriş: dip, çıkış: tp, yorum: comment, indicators };
  }
  return result;
}

async function fullAnalysis(news) {
  const btcData = await fetchKlines('BTC-USDT', '1hour');
  const messages = [];
  for (const coin of COINS) {
    const analysis = await analyzeCoin(coin, btcData, news);
    let message = `${coin} Analizi (${new Date().toLocaleString('tr-TR')}):\n`;
    for (const [timeframe, data] of Object.entries(analysis.analyses)) {
      message += `  ${timeframe}: Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n\n`;
      if (message.length > 3500) {
        messages.push(message);
        message = '';
      }
    }
    const negative = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));
    if (negative && coin.includes('BTC')) {
      message += `  Alarm: Bitcoin düşüyor, dikkat! Tahmini dip: ${analysis.analyses['1hour']?.giriş.toFixed(2)}.\n`;
    }
    if (message) messages.push(message);
  }
  return messages;
}

module.exports = { fetchKlines, calculateIndicators, analyzeCoin, fullAnalysis };
