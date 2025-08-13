const { Telegraf } = require('telegraf');
const ccxt = require('ccxt');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { RSI, MACD, EMA, SAR, StochasticRSI } = require('technicalindicators');
const { initDB, saveAnalysis, getRecentAnalyses } = require('./db');
const { fetchNews } = require('./news');
const { startWebSocket } = require('./websocket');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const parser = new Parser();
const COINS = ['AAVE/USDT', 'COMP/USDT', 'LTC/USDT', 'XLM/USDT', 'ADA/USDT', 'MKR/USDT', 'BTC/USDT'];
const RSS_LINKS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss',
  'https://www.newsbtc.com/feed/',
  'https://rss.app/feeds/v1.1/afLheyG37mUeVDxY.json'
];

// Exchange setup
const binance = new ccxt.binance({ enableRateLimit: true });
const kucoin = new ccxt.kucoin({
  apiKey: process.env.KUCOIN_KEY,
  secret: process.env.KUCOIN_SECRET,
  enableRateLimit: true,
});

// SQLite setup
const db = new sqlite3.Database('./analiz.db');
initDB(db);

// Fetch OHLCV
async function fetchOHLCV(coin, timeframe = '1h', limit = 100) {
  const ohlcv = await binance.fetchOHLCV(coin, timeframe, undefined, limit);
  return ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
    timestamp: new Date(timestamp).toISOString(),
    open, high, low, close, volume
  }));
}

// Calculate Indicators
function calculateIndicators(data) {
  const closes = data.map(d => d.close);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const volumes = data.map(d => d.volume);

  return {
    RSI: RSI.calculate({ period: 14, values: closes }).slice(-1)[0],
    MACD: MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes }).slice(-1)[0].MACD,
    EMA50: EMA.calculate({ period: 50, values: closes }).slice(-1)[0],
    EMA200: EMA.calculate({ period: 200, values: closes }).slice(-1)[0],
    SAR: SAR.calculate({ high: highs, low: lows, step: 0.02, max: 0.2 }).slice(-1)[0],
    StochRSI: StochasticRSI.calculate({ period: 14, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3, values: closes }).slice(-1)[0].k,
    volumeChange: ((volumes[volumes.length - 1] - volumes[volumes.length - 2]) / volumes[volumes.length - 2] * 100) || 0
  };
}

// Analyze Coin
async function analyzeCoin(coin, btcData = null) {
  const data = await fetchOHLCV(coin);
  const indicators = calculateIndicators(data);

  // BTC baz
  if (!btcData) btcData = await fetchOHLCV('BTC/USDT');
  const btcIndicators = calculateIndicators(btcData);
  const btcStatus = btcIndicators.EMA50 > btcIndicators.EMA200 ? 'Yükselişte' : 'Düşüşte';

  // Giriş/Çıkış
  const dip = Math.min(...data.map(d => d.low));
  const tp = Math.max(...data.map(d => d.high)) * 1.05;
  let comment = `BTC durumu: ${btcStatus}. RSI: ${indicators.RSI.toFixed(2)}. Hacim değişimi: ${indicators.volumeChange.toFixed(2)}%.`;

  // News check
  const news = await fetchNews();
  const negative = news.some(n => n.toLowerCase().includes('düşüş') || n.toLowerCase().includes('hack'));
  if (negative && coin.includes('BTC')) {
    comment += ` Alarm: Bitcoin düşüyor, dikkat! Tahmini dip: ${dip.toFixed(2)}.`;
  }

  return {
    coin,
    giriş: dip,
    çıkış: tp,
    yorum: comment,
    tarih: new Date().toLocaleString('tr-TR')
  };
}

// Full Analysis
async function fullAnalysis() {
  const btcData = await fetchOHLCV('BTC/USDT');
  let message = `Analiz Zamanı: ${new Date().toLocaleString('tr-TR')}\n`;
  for (const coin of COINS) {
    const analysis = await analyzeCoin(coin, btcData);
    message += `${coin}: Giriş: ${analysis.giriş.toFixed(2)}, Çıkış: ${analysis.çıkış.toFixed(2)}\nYorum: ${analysis.yorum}\n\n`;
    await saveAnalysis(db, analysis);
  }
  return message;
}

// Telegram Commands
bot.command('start', async (ctx) => {
  await ctx.reply('Merhaba! Kripto analiz botu hazır. /analiz ile başla.');
});

bot.command('analiz', async (ctx) => {
  const result = await fullAnalysis();
  await ctx.reply(result);
  // Grup paylaşımı için grup ID'si ekle
  // await bot.telegram.sendMessage(GROUP_ID, result);
});

bot.command('alarm_kur', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 2) {
    const [coin, price] = args;
    startWebSocket(coin.toUpperCase() + '/USDT', parseFloat(price), async (currentPrice) => {
      if (currentPrice <= price) {
        await ctx.reply(`Alarm: ${coin} ${currentPrice.toFixed(2)}'e düştü!`);
      }
    });
    await ctx.reply(`${coin} için ${price} alarmı kuruldu.`);
  } else {
    await ctx.reply('Kullanım: /alarm_kur coin fiyat');
  }
});

// Schedule
schedule.scheduleJob('0 */12 * * *', async () => {
  const result = await fullAnalysis();
  // Kullanıcıya/gruba gönder
  // await bot.telegram.sendMessage(CHAT_ID, result);
});

// Start Bot
bot.launch();
console.log('Bot çalışıyor...');

// Heroku PORT
const PORT = process.env.PORT || 3000;
require('http').createServer((req, res) => res.end('Bot çalışıyor')).listen(PORT);
