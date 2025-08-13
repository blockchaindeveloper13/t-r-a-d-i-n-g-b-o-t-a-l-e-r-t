const { RSI, MACD, EMA, PSAR, StochasticRSI } = require('technicalindicators');
const axios = require('axios');
const { startWebSocket } = require('./websocket');

const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT'];
const TIMEFRAMES = ['1min', '5min', '30min', '1hour', '2hour', '4hour', '1day', '1week'];

async function fetchKlines(coin, timeframe) {
  return new Promise((resolve) => {
    const klines = [];
    const ws = startWebSocket(coin, timeframe, (data) => {
      klines.push(data);
      if (klines.length >= 200) { // EMA200 için yeterli veri
        resolve(klines.slice(-200));
      }
    });
    setTimeout(() => {
      if (klines.length < 200) {
        console.warn(`Insufficient klines for ${coin}_${timeframe}, got ${klines.length}`);
        resolve(klines);
      }
    }, 30000); // 30 saniye bekle
  });
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
  if (indicators.RSI < 30) comment += `${coin} ${timeframe} zaman diliminde aşırı satım bölgesinde, alım fırsatı olabilir. `;
  else if (indicators.RSI > 70) comment += `${coin} ${timeframe} zaman diliminde aşırı alım bölgesinde, satış düşünülebilir. `;
  else comment += `${coin} ${timeframe} zaman diliminde nötr bölgede. `;
  comment += `RSI: ${indicators.RSI.toFixed(2)}, MACD: ${indicators.MACD.toFixed(2)}, Hacim değişimi: ${indicators.volumeChange.toFixed(2)}%. `;
  comment += `Tahmini giriş: ${dip.toFixed(2)}, Tahmini çıkış: ${tp.toFixed(2)}.`;
  return comment;
}

async function callGrok(prompt) {
  try {
    const response = await axios.post(
      'https://api.x.ai/v1/chat/completions',
      {
        messages: [
          { role: 'system', content: 'Sen bir kripto para analiz botusun. Teknik indikatörlere ve Bitcoin durumuna dayalı kısa, doğal, Türkçe yorumlar yap (maksimum 100 kelime).' },
          { role: 'user', content: prompt },
        ],
        model: 'grok-4-0709',
        stream: false,
        temperature: 0.7,
        max_tokens: 200,
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
      Türkçe, kısa, doğal ve ayrıntılı bir analiz yorumu yap (maksimum 100 kelime).`;
    let comment = await callGrok(prompt);
    if (!comment) {
      comment = generateFallbackComment(indicators, btcStatus, dip, tp, timeframe, coin);
    }

    result.analyses[timeframe] = { giriş: dip, çıkış: tp, yorum: comment, indicators };
  }
  return result;
}

async function fullAnalysis(news) {
  const btcData = await fetchKlines('BTC-USDT', '1hour');
  const messages = [];
  for (const coin of COINS) {
    const analysis = await analyzeCoin(coin, btcData, news);
    for (const [timeframe, data] of Object.entries(analysis.analyses)) {
      let message = `${coin} Analizi (${timeframe}, ${new Date().toLocaleString('tr-TR')}):\n`;
      message += `  Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n`;
      const negative = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));
      if (negative && coin.includes('BTC') && timeframe === '1hour') {
        message += `  Alarm: Bitcoin düşüyor, dikkat! Tahmini dip: ${data.giriş.toFixed(2)}.\n`;
      }
      messages.push(message);
    }
  }
  return messages;
}

module.exports = { fetchKlines, calculateIndicators, analyzeCoin, fullAnalysis };
