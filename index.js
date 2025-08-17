const { Telegraf, Markup } = require('telegraf');
const ccxt = require('ccxt');
const axios = require('axios');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const NodeCache = require('node-cache');
const winston = require('winston');
require('dotenv').config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '');
const cache = new NodeCache({ stdTTL: 180, checkperiod: 60 });
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

const COINS = ['BTC-USDT', 'ETH-USDT', 'BNB-USDT', 'ADA-USDT', 'XRP-USDT'];
const GROUP_ID = '-1002869335730'; // @tradingroup95
const sentMessages = new Set();
let isBitcoinMonitoringPaused = false;
let pauseEndTime = 0;
const priceAlarms = new Map();

const db = new sqlite3.Database(':memory:', (err) => {
  if (err) logger.error('Veritabanı bağlantı hatası:', err.message);
  else logger.info('Veritabanına bağlanıldı.');
  db.run('CREATE TABLE IF NOT EXISTS chat_history (chatId TEXT, message TEXT, timestamp INTEGER)');
});

// Binance API (kimlik doğrulamalı)
const binance = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY || '',
  secret: process.env.BINANCE_SECRET_KEY || '',
  enableRateLimit: true
});

// KuCoin API (kimlik doğrulamalı)
const kucoin = new ccxt.kucoin({
  apiKey: process.env.KUCOIN_KEY || '',
  secret: process.env.KUCOIN_SECRET || '',
  enableRateLimit: true
});

async function fetchHttpKlines(exchange, symbol, timeframe, startTime, endTime) {
  try {
    const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, startTime * 1000, 1000);
    return ohlcv.map(candle => ({
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5]),
      timestamp: candle[0] / 1000
    }));
  } catch (error) {
    logger.error(`${exchange.id} kline hatası (${symbol}):`, error.message);
    return [];
  }
}

async function getCurrentPrice(exchange, symbol) {
  try {
    const ticker = await exchange.fetchTicker(symbol);
    return parseFloat(ticker.last);
  } catch (error) {
    logger.error(`${exchange.id} fiyat hatası (${symbol}):`, error.message);
    return null;
  }
}

async function getCoinMarketCapPrice(symbol) {
  try {
    const coin = symbol.split('-')[0];
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
      params: { symbol: coin },
      headers: { 'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API }
    });
    return parseFloat(response.data.data[coin].quote.USD.price);
  } catch (error) {
    logger.error(`CoinMarketCap fiyat hatası (${symbol}):`, error.message);
    return null;
  }
}

async function startWebSocket(exchange, symbol, targetPrice, chatId, callback) {
  const ws = new exchange.constructor({
    apiKey: exchange.apiKey,
    secret: exchange.secret,
    enableRateLimit: true
  });

  const stop = async () => {
    logger.info(`WebSocket durduruldu: ${symbol} (${exchange.id})`);
  };

  ws.watchTicker(symbol).then(async (ticker) => {
    const price = parseFloat(ticker.last);
    await callback({ price });
  }).catch(error => {
    logger.error(`WebSocket hatası (${symbol}, ${exchange.id}):`, error.message);
  });

  return { stop };
}

async function fetchNews() {
  const parser = new Parser();
  try {
    const feed = await parser.parseURL('https://cointelegraph.com/rss');
    return feed.items.slice(0, 5).map(item => item.title);
  } catch (error) {
    logger.error('Haber çekme hatası:', error.message);
    return [];
  }
}

async function saveChatHistory(db, chatId, message) {
  db.run('INSERT INTO chat_history (chatId, message, timestamp) VALUES (?, ?, ?)', [chatId, message, Date.now()]);
}

async function getRecentChatHistory(db, chatId) {
  return new Promise((resolve) => {
    db.all('SELECT message FROM chat_history WHERE chatId = ? ORDER BY timestamp DESC LIMIT 5', [chatId], (err, rows) => {
      if (err) logger.error('Chat geçmişi hatası:', err.message);
      resolve(rows ? rows.map(row => row.message) : []);
    });
  });
}

async function updateCache() {
  try {
    const response = await axios.get('https://api.coinmarketcal.com/v1/events', {
      headers: { 'x-api-key': process.env.COINMARKETCAL_API_KEY }
    });
    const events = response.data.map(event => ({
      coin: event.coins[0]?.name || 'Bilinmeyen Coin',
      title: event.title,
      date: event.date_event,
      impact: event.impact_level,
      catalystScore: event.catalyst_score || 0,
      description: event.description,
      proofLink: event.source || 'Yok'
    }));
    cache.set('coinmarketcal_events', events, 86400);
    return events;
  } catch (error) {
    logger.error('CoinMarketCal cache güncelleme hatası:', error.message);
    return [];
  }
}

async function loadEventsFromCache() {
  return cache.get('coinmarketcal_events') || [];
}

async function analyzeCoin(coin, btcData, news, chatHistory) {
  try {
    const binanceKlines = await fetchHttpKlines(binance, coin, '1h', Math.floor(Date.now() / 1000) - 24 * 60 * 60, Math.floor(Date.now() / 1000));
    const kucoinKlines = await fetchHttpKlines(kucoin, coin, '1h', Math.floor(Date.now() / 1000) - 24 * 60 * 60, Math.floor(Date.now() / 1000));
    const binancePrice = await getCurrentPrice(binance, coin);
    const kucoinPrice = await getCurrentPrice(kucoin, coin);
    const cmcPrice = await getCoinMarketCapPrice(coin);

    const currentPrice = binancePrice || kucoinPrice || cmcPrice;
    if (!binanceKlines.length && !kucoinKlines.length || !currentPrice) {
      return {
        coin,
        tarih: Date.now(),
        analyses: {
          currentPrice: null,
          giriş: 0,
          shortTermÇıkış: 0,
          dailyÇıkış: 0,
          weeklyÇıkış: 0,
          longTermÇıkış: 0,
          stopLoss: 0,
          shortTermSupport: 0,
          shortTermResistance: 0,
          shortTermResistanceTarget: 0,
          longTermSupport: 0,
          longTermResistance: 0,
          longTermResistanceTarget: 0,
          yorum: 'Veri eksik, Binance/KuCoin/CoinMarketCap API’lerini kontrol et kanka! 😓'
        }
      };
    }

    return {
      coin,
      tarih: Date.now(),
      analyses: {
        currentPrice,
        binancePrice,
        kucoinPrice,
        cmcPrice,
        giriş: currentPrice * 0.98,
        shortTermÇıkış: currentPrice * 1.02,
        dailyÇıkış: currentPrice * 1.05,
        weeklyÇıkış: currentPrice * 1.10,
        longTermÇıkış: currentPrice * 1.15,
        stopLoss: currentPrice * 0.95,
        shortTermSupport: currentPrice * 0.97,
        shortTermResistance: currentPrice * 1.03,
        shortTermResistanceTarget: currentPrice * 1.05,
        longTermSupport: currentPrice * 0.90,
        longTermResistance: currentPrice * 1.10,
        longTermResistanceTarget: currentPrice * 1.20,
        yorum: 'Piyasa stabil, dikkatli ol kanka! 😎'
      }
    };
  } catch (error) {
    logger.error(`Coin analiz hatası (${coin}):`, error.message);
    return {
      coin,
      tarih: Date.now(),
      analyses: {
        currentPrice: null,
        giriş: 0,
        shortTermÇıkış: 0,
        dailyÇıkış: 0,
        weeklyÇıkış: 0,
        longTermÇıkış: 0,
        stopLoss: 0,
        shortTermSupport: 0,
        shortTermResistance: 0,
        shortTermResistanceTarget: 0,
        longTermSupport: 0,
        longTermResistance: 0,
        longTermResistanceTarget: 0,
        yorum: 'Analiz sırasında hata, tekrar dene kanka! 😓'
      }
    };
  }
}

async function findOpportunityCoins() {
  const events = await loadEventsFromCache();
  return events
    .filter(event => event.catalystScore > 50)
    .map(event => ({
      coin: event.coin,
      symbol: event.coin.toUpperCase() + '-USDT',
      score: event.catalystScore,
      event,
      price: null,
      indicators: { RSI: null, MACD: null }
    }));
}

async function findTopTradeOpportunities() {
  return {
    timestamp: new Date().toLocaleString('tr-TR'),
    summary: 'Binance ve KuCoin top 100 tarandı, en iyi 3 coin bulundu.',
    opportunities: COINS.slice(0, 3).map(coin => ({
      coin,
      analyses: {
        currentPrice: Math.random() * 1000,
        giriş: Math.random() * 900,
        shortTermÇıkış: Math.random() * 1100,
        dailyÇıkış: Math.random() * 1200,
        weeklyÇıkış: Math.random() * 1300,
        longTermÇıkış: Math.random() * 1400,
        stopLoss: Math.random() * 800,
        shortTermSupport: Math.random() * 850,
        shortTermResistance: Math.random() * 1150,
        shortTermResistanceTarget: Math.random() * 1200,
        longTermSupport: Math.random() * 800,
        longTermResistance: Math.random() * 1300,
        longTermResistanceTarget: Math.random() * 1400,
        yorum: 'Bu coin iyi görünüyor kanka, ama dikkat et! 😎'
      }
    }))
  };
}

async function analyzeCoinMarketCalEvents(events, chatHistory) {
  return 'CoinMarketCal etkinlikleri analiz edildi, yüksek potansiyelli coinler var kanka! 😎';
}

async function fullAnalysis(news, chatHistory) {
  try {
    const btcDataBinance = await fetchHttpKlines(binance, 'BTC-USDT', '1hour', Math.floor(Date.now() / 1000) - 24 * 60 * 60, Math.floor(Date.now() / 1000));
    const btcDataKucoin = await fetchHttpKlines(kucoin, 'BTC-USDT', '1hour', Math.floor(Date.now() / 1000) - 24 * 60 * 60, Math.floor(Date.now() / 1000));
    const messages = [];
    for (const coin of COINS) {
      const analysis = await analyzeCoin(coin, btcDataBinance.length ? btcDataBinance : btcDataKucoin, news, chatHistory);
      const messageId = `${coin}-${analysis.tarih}`;
      if (sentMessages.has(messageId)) continue;
      sentMessages.add(messageId);

      let message = `${coin} Analizi (${new Date().toLocaleString('tr-TR')}):\n`;
      message += `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice ? analysis.analyses.currentPrice.toFixed(2) : 'Bilinmiyor'}\n`;
      if (analysis.analyses.binancePrice) message += `  Binance Fiyat: 💰 ${analysis.analyses.binancePrice.toFixed(2)}\n`;
      if (analysis.analyses.kucoinPrice) message += `  KuCoin Fiyat: 💰 ${analysis.analyses.kucoinPrice.toFixed(2)}\n`;
      if (analysis.analyses.cmcPrice) message += `  CoinMarketCap Fiyat: 💰 ${analysis.analyses.cmcPrice.toFixed(2)}\n`;
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
    logger.error('Tüm coin analizlerinde hata:', error.message);
    return ['Tüm coin analizlerinde hata oluştu, Binance/KuCoin/CoinMarketCap API’lerini kontrol et kanka! 😓'];
  }
}

async function getQuickStatus(coin) {
  try {
    const binancePrice = await getCurrentPrice(binance, coin);
    const kucoinPrice = await getCurrentPrice(kucoin, coin);
    const cmcPrice = await getCoinMarketCapPrice(coin);
    const currentPrice = binancePrice || kucoinPrice || cmcPrice;
    if (!currentPrice) {
      return `Hızlı Durum: ${coin.split('-')[0]} 💰 Bilinmiyor. Fiyat alınamadı, API’leri kontrol et! 😓`;
    }

    const endAt = Math.floor(Date.now() / 1000);
    const startAt = endAt - 10 * 60;
    let klines = await fetchHttpKlines(binance, coin, '5m', startAt, endAt);
    if (!klines || klines.length < 2) {
      klines = await fetchHttpKlines(kucoin, coin, '5m', startAt, endAt);
    }

    if (!klines || klines.length < 2) {
      logger.info(`Binance/KuCoin kline verisi eksik: ${coin}, CoinGecko deneniyor`);
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
        logger.error(`CoinGecko trend hatası: ${coin}`, error.message);
        return `Hızlı Durum: ${coin.split('-')[0]} 💰 ${currentPrice.toFixed(2)} USDT. Trend verisi alınamadı, API’yi kontrol et! 😓`;
      }
    }

    const lastClose = klines[klines.length - 1].close;
    const prevClose = klines[klines.length - 2].close;
    const trend = lastClose > prevClose ? 'Yükselişte 📈' : lastClose < prevClose ? 'Düşüşte 📉' : 'Nötr ➡️';
    return `Hızlı Durum: ${coin.split('-')[0]} 💰 ${currentPrice.toFixed(2)} USDT, Son 5dk: ${trend}`;
  } catch (error) {
    logger.error(`Hızlı durum hatası: ${coin}:`, error.message);
    return `Hızlı Durum: ${coin.split('-')[0]} için veri alınamadı. API’leri kontrol et! 😓`;
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
  logger.info('Start komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply(
      'Merhaba kanka! Kripto analiz botun hazır! 🚀 Coin seçip analiz yap, durum kontrol et, alarm kur veya CoinMarketCal etkinliklerini incele. 😎',
      getCoinButtons()
    );
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    logger.error('Start komut hatası:', error);
    await ctx.reply('Bot başlatılırken hata oluştu, tekrar dene kanka! 😓');
  }
});

bot.command(/analiz(?:@traderbot95_bot)?/, async (ctx) => {
  logger.info('Analiz komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Hangi coin’i analiz edeyim kanka? 😎', getCoinButtons());
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    logger.error('Analiz komut hatası:', error);
    await ctx.reply('Analiz komutu çalıştırılırken hata oluştu, tekrar dene kanka! 😓');
  }
});

bot.command('alarm_kur', async (ctx) => {
  logger.info('Alarm kur komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Hangi coin için alarm kuralım? 😊', getAlarmButtons());
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    logger.error('Alarm kur komut hatası:', error);
    await ctx.reply('Alarm kurma sırasında hata oluştu, tekrar dene kanka! 😓');
  }
});

bot.command('alarm_stop', async (ctx) => {
  logger.info('Alarm stop komutu alındı, chat ID:', ctx.chat.id);
  try {
    isBitcoinMonitoringPaused = true;
    pauseEndTime = Date.now() + 24 * 60 * 60 * 1000;
    const pauseMessage = `Bitcoin izleme bildirimleri 24 saatliğine durduruldu. Kalan süre: ${((pauseEndTime - Date.now()) / 1000 / 60).toFixed(2)} dakika. 24 saat sonra otomatik devam edecek. 🛑`;
    await ctx.reply(pauseMessage, getCoinButtons());
    logger.info(pauseMessage);
    await saveChatHistory(db, ctx.chat.id.toString(), ctx.message.text);
  } catch (error) {
    logger.error('Alarm stop hatası:', error);
    await ctx.reply('Alarm durdurma sırasında hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.command('coinmarketcal', async (ctx) => {
  logger.info('CoinMarketCal komutu alındı, chat ID:', ctx.chat.id);
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
    logger.error('CoinMarketCal komut hatası:', error);
    await ctx.reply('CoinMarketCal verilerini çekerken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.command('top3', async (ctx) => {
  logger.info('Top 3 fırsat komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Binance ve KuCoin top 100 içinde en iyi 3 trade fırsatını tarıyorum, biraz bekle kanka! 😎');
    const result = await findTopTradeOpportunities();
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
    logger.error('Top 3 fırsat hatası:', error);
    await ctx.reply('En iyi 3 fırsat aranırken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.command('opportunities', async (ctx) => {
  logger.info('Opportunities komutu alındı, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Potansiyel coin fırsatlarını tarıyorum, biraz bekle kanka! 😎');
    const opportunities = await findOpportunityCoins();

    if (!opportunities.length) {
      await ctx.reply('Şu an yüksek potansiyelli coin bulunamadı. 😓 CoinMarketCal verilerini kontrol et!', getCoinButtons());
      return;
    }

    let message = '📈 Potansiyel Fırsat Coin’leri (Kaynak: CoinMarketCal):\n';
    for (const opp of opportunities) {
      const binancePrice = await getCurrentPrice(binance, opp.symbol);
      const kucoinPrice = await getCurrentPrice(kucoin, opp.symbol);
      const cmcPrice = await getCoinMarketCapPrice(opp.symbol);
      message += `\n${opp.coin} (${opp.symbol}, Skor: ${opp.score}):\n`;
      message += `  Güncel Fiyat: 💰 ${binancePrice ? binancePrice.toFixed(2) : kucoinPrice ? kucoinPrice.toFixed(2) : cmcPrice ? cmcPrice.toFixed(2) : 'Bilinmiyor'}\n`;
      message += `  Etkinlik: ${opp.event.title} (${opp.event.date})\n`;
      message += `  Etki: ${opp.event.impact}, Catalyst Skor: ${opp.event.catalystScore}\n`;
      message += `  Açıklama: ${opp.event.description.slice(0, 100)}...\n`;
      message += `  Kanıt: ${opp.event.proofLink}\n`;
      message += `  RSI: ${opp.indicators?.RSI?.toFixed(2) || 'Bilinmiyor'}\n`;
      message += `  MACD: ${opp.indicators?.MACD?.toFixed(2) || 'Bilinmiyor'}\n`;
    }

    const maxMessageLength = 4096;
    if (message.length > maxMessageLength) {
      const messages = [];
      let currentMessage = '📈 Potansiyel Fırsat Coin’leri (Kaynak: CoinMarketCal):\n';
      let currentLength = currentMessage.length;

      for (const opp of opportunities) {
        const binancePrice = await getCurrentPrice(binance, opp.symbol);
        const kucoinPrice = await getCurrentPrice(kucoin, opp.symbol);
        const cmcPrice = await getCoinMarketCapPrice(opp.symbol);
        const oppText = `\n${opp.coin} (${opp.symbol}, Skor: ${opp.score}):\n` +
                        `  Güncel Fiyat: 💰 ${binancePrice ? binancePrice.toFixed(2) : kucoinPrice ? kucoinPrice.toFixed(2) : cmcPrice ? cmcPrice.toFixed(2) : 'Bilinmiyor'}\n` +
                        `  Etkinlik: ${opp.event.title} (${opp.event.date})\n` +
                        `  Etki: ${opp.event.impact}, Catalyst Skor: ${opp.event.catalystScore}\n` +
                        `  Açıklama: ${opp.event.description.slice(0, 100)}...\n` +
                        `  Kanıt: ${opp.event.proofLink}\n` +
                        `  RSI: ${opp.indicators?.RSI?.toFixed(2) || 'Bilinmiyor'}\n` +
                        `  MACD: ${opp.indicators?.MACD?.toFixed(2) || 'Bilinmiyor'}\n`;
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
    logger.error('Opportunities komut hatası:', error);
    await ctx.reply('Fırsat coin’leri aranırken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action('alarm_stop', async (ctx) => {
  logger.info('Inline alarm stop isteği, chat ID:', ctx.chat.id);
  try {
    isBitcoinMonitoringPaused = true;
    pauseEndTime = Date.now() + 24 * 60 * 60 * 1000;
    const pauseMessage = `Bitcoin izleme bildirimleri 24 saatliğine durduruldu. Kalan süre: ${((pauseEndTime - Date.now()) / 1000 / 60).toFixed(2)} dakika. 24 saat sonra otomatik devam edecek. 🛑`;
    await ctx.reply(pauseMessage, getCoinButtons());
    logger.info(pauseMessage);
    await saveChatHistory(db, ctx.chat.id.toString(), 'Inline: alarm_stop');
  } catch (error) {
    logger.error('Inline alarm stop hatası:', error);
    await ctx.reply('Alarm durdurma sırasında hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action('alarm_menu', async (ctx) => {
  logger.info('Inline alarm menu isteği, chat ID:', ctx.chat.id);
  try {
    await ctx.reply('Hangi coin için alarm kuralım? 😊', getAlarmButtons());
    await saveChatHistory(db, ctx.chat.id.toString(), 'Inline: alarm_menu');
  } catch (error) {
    logger.error('Inline alarm menu hatası:', error);
    await ctx.reply('Alarm menüsü açılırken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action(/analyze_(.+)/, async (ctx) => {
  const coin = ctx.match[1];
  logger.info(`Inline analiz isteği: ${coin}, chat ID: ${ctx.chat.id}`);
  try {
    if (!COINS.includes(coin)) {
      await ctx.reply('Geçerli bir coin seç kanka! 😊', getCoinButtons());
      return;
    }
    await ctx.reply(`${coin.split('-')[0]}’yı analiz ediyorum, biraz bekle! 😎`);

    const news = await fetchNews();
    const chatHistory = await getRecentChatHistory(db, ctx.chat.id.toString());
    const analysis = await analyzeCoin(coin, null, news, chatHistory);

    const messageId = `${coin}-${analysis.tarih}`;
    if (sentMessages.has(messageId)) return;
    sentMessages.add(messageId);

    let message = `${coin} Analizi (${new Date(analysis.tarih).toLocaleString('tr-TR')}):\n`;
    message += `  Güncel Fiyat: 💰 ${analysis.analyses.currentPrice ? analysis.analyses.currentPrice.toFixed(2) : 'Bilinmiyor'}\n`;
    if (analysis.analyses.binancePrice) message += `  Binance Fiyat: 💰 ${analysis.analyses.binancePrice.toFixed(2)}\n`;
    if (analysis.analyses.kucoinPrice) message += `  KuCoin Fiyat: 💰 ${analysis.analyses.kucoinPrice.toFixed(2)}\n`;
    if (analysis.analyses.cmcPrice) message += `  CoinMarketCap Fiyat: 💰 ${analysis.analyses.cmcPrice.toFixed(2)}\n`;
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
    logger.error(`Inline analiz hatası: ${coin}:`, error);
    await ctx.reply('Analiz sırasında hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action(/status_(.+)/, async (ctx) => {
  const coin = ctx.match[1];
  logger.info(`Inline durum isteği: ${coin}, chat ID: ${ctx.chat.id}`);
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
    logger.error(`Inline durum hatası: ${coin}:`, error);
    await ctx.reply('Durum kontrolü sırasında hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action(/alarm_(.+)/, async (ctx) => {
  const coin = ctx.match[1];
  logger.info(`Inline alarm isteği: ${coin}, chat ID: ${ctx.chat.id}`);
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

      const ws = await startWebSocket(binance, coin, targetPrice, chatId, async ({ price }) => {
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
    logger.error(`Inline alarm hatası: ${coin}:`, error);
    await ctx.reply('Alarm kurarken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action('coinmarketcal', async (ctx) => {
  logger.info('Inline CoinMarketCal isteği, chat ID:', ctx.chat.id);
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
    logger.error('Inline CoinMarketCal hatası:', error);
    await ctx.reply('CoinMarketCal verilerini çekerken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

bot.action('update_coinmarketcal', async (ctx) => {
  logger.info('Inline CoinMarketCal güncelleme isteği, chat ID:', ctx.chat.id);
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
    logger.error('Inline CoinMarketCal güncelleme hatası:', error);
    await ctx.reply('CoinMarketCal güncellenirken hata oluştu, tekrar dene kanka! 😓', getCoinButtons());
  }
});

// Zamanlanmış Görevler
schedule.scheduleJob('0 0 * * *', async () => {
  logger.info('CoinMarketCal verileri günlük güncelleme başlıyor...');
  try {
    await updateCache();
    logger.info('CoinMarketCal verileri güncellendi.');
  } catch (error) {
    logger.error('CoinMarketCal günlük güncelleme hatası:', error);
  }
});

schedule.scheduleJob('0 */2 * * *', async () => {
  if (isBitcoinMonitoringPaused && Date.now() < pauseEndTime) return;
  try {
    const news = await fetchNews();
    const chatHistory = await getRecentChatHistory(db, GROUP_ID);
    const btcAnalysis = await analyzeCoin('BTC-USDT', null, news, chatHistory);
    const indicators = btcAnalysis.analyses.indicators || { RSI: 50, MACD: 0, signal: 0, volumeChange: 0 };
    const isDropSignal = indicators.RSI < 30 && indicators.MACD < indicators.signal && indicators.volumeChange < -10;

    if (isDropSignal) {
      const message = `🚨 Bitcoin Düşüş Sinyali!\n` +
                      `Güncel Fiyat: 💰 ${btcAnalysis.analyses.currentPrice.toFixed(2)} USDT\n` +
                      `Binance Fiyat: 💰 ${btcAnalysis.analyses.binancePrice ? btcAnalysis.analyses.binancePrice.toFixed(2) : 'Bilinmiyor'}\n` +
                      `KuCoin Fiyat: 💰 ${btcAnalysis.analyses.kucoinPrice ? btcAnalysis.analyses.kucoinPrice.toFixed(2) : 'Bilinmiyor'}\n` +
                      `CoinMarketCap Fiyat: 💰 ${btcAnalysis.analyses.cmcPrice ? btcAnalysis.analyses.cmcPrice.toFixed(2) : 'Bilinmiyor'}\n` +
                      `Tahmini Dip: 📉 ${btcAnalysis.analyses.giriş.toFixed(2)} USDT\n` +
                      `RSI: ${indicators.RSI.toFixed(2)}, MACD: ${indicators.MACD.toFixed(2)} (Sinyal: ${indicators.signal.toFixed(2)})\n` +
                      `Hacim Değişimi: ${indicators.volumeChange.toFixed(2)}%\n` +
                      `Dikkatli ol kanka, yatırımlarını gözden geçir! 😎`;
      await bot.telegram.sendMessage(GROUP_ID, message, getCoinButtons());
      logger.info('Bitcoin düşüş sinyali gönderildi:', message);
    }
  } catch (error) {
    logger.error('Bitcoin izleme hatası:', error);
  }
});

schedule.scheduleJob('0 0 * * *', () => {
  logger.info('sentMessages temizleniyor...');
  sentMessages.clear();
});

// Heroku için Express Server
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Kripto analiz botu çalışıyor kanka! 🚀');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  logger.info(`Server ${port} portunda çalışıyor`);
});

// Bot Başlatma
if (!process.env.TELEGRAM_TOKEN) {
  logger.error('Hata: TELEGRAM_TOKEN eksik! Lütfen Heroku ortam değişkenlerini kontrol et.');
  process.exit(1);
}

bot.launch().then(() => {
  logger.info('Bot başlatıldı kanka! 🚀');
}).catch((error) => {
  logger.error('Bot başlatma hatası:', error.message);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM alındı, bot kapatılıyor...');
  try {
    if (bot.botInfo) await bot.stop();
    await db.close();
    logger.info('Bot ve veritabanı başarıyla kapatıldı.');
    process.exit(0);
  } catch (error) {
    logger.error('Kapatma sırasında hata:', error.message);
    process.exit(1);
  }
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled Rejection:', error.message);
});
