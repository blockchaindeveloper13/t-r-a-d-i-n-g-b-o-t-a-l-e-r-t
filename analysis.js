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

async function fetchHttpKlines(coin, timeframe, startAt = 0, endAt = 0) {
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
    console.error(`HTTP Klines error for ${coin} (${timeframe}):`, error.message);
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

function generateFallbackComment(indicators, btcStatus, dip, tp, timeframe, coin) {
  let comment = `BTC durumu: ${btcStatus}. `;
  if (indicators.RSI < 30) comment += `${coin} ${timeframe}'de aşırı satım bölgesinde, alım fırsatı olabilir. `;
  else if (indicators.RSI > 70) comment += `${coin} ${timeframe}'de aşırı alım bölgesinde, satış düşünülebilir. `;
  else comment += `${coin} ${timeframe}'de nötr bölgede. `;
  comment += `RSI: ${indicators.RSI.toFixed(2)}, MACD: ${indicators.MACD.toFixed(2)}, Hacim değişimi: ${indicators.volumeChange.toFixed(2)}%. `;
  comment += `Giriş: ${dip.toFixed(2)}, Çıkış: ${tp.toFixed(2)}.`;
  return comment;
}

async function callGrok(prompt) {
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
        max_tokens: 1200, // Artırıldı
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROK_API_KEY}`,
        },
      }
    );
    console.log('Grok API response:', response.data);
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Grok API error:', error.response?.data || error.message);
    return null;
  }
}

async function analyzeCoin(coin, btcData = null, news = [], useWebSocket = false) {
  let result = { coin, tarih: new Date().toLocaleString('tr-TR'), analyses: {} };
  for (const timeframe of TIMEFRAMES) {
    const data = await fetchHttpKlines(coin, timeframe); // Her durumda HTTP Klines
    if (!data.length) continue;

    const indicators = calculateIndicators(data);
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

    result.analyses[timeframe] = { giriş: dip, çıkış: tp, yorum: comment, indicators };
  }
  return result;
}

async function fullAnalysis(news) {
  const btcData = await fetchHttpKlines('BTC-USDT', '1hour');
  const messages = [];
  for (const coin of COINS) {
    const analysis = await analyzeCoin(coin, btcData, news, false);
    for (const [timeframe, data] of Object.entries(analysis.analyses)) {
      let message = `${coin} Analizi (${timeframe}, ${new Date().toLocaleString('tr-TR')}):\n`;
      message += `  Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n`;
      const negative = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));
      if (negative && coin.includes('BTC') && timeframe === '1hour') {
        message += `  Alarm: Bitcoin düşüyor, dikkat! Tahmini dip: ${data.giriş.toFixed(2)}.\n`;
      }
      // Telegram 4096 karakter sınırı için mesajları böl
      if (message.length > 4000) {
        const chunks = message.match(/.{1,4000}/g);
        for (const chunk of chunks) {
          messages.push(chunk);
        }
      } else {
        messages.push(message);
      }
    }
  }
  return messages;
}

module.exports = { fetchHttpKlines, calculateIndicators, analyzeCoin, fullAnalysis };
