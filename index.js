const { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const { initDB, saveAnalysis, getRecentAnalyses } = require('./db');
const { fetchNews } = require('./news');
const { startWebSocket } = require('./websocket');
const { analyzeCoin, fullAnalysis, fetchHttpKlines } = require('./analysis');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '7551795139:AAHJa1du2jRmmA1gmTPIHwJbUsRT7wOksaI');
const parser = new Parser();
const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT'];
const GROUP_ID = '-1002869335730'; // @tradingroup95 grup ID'si

// SQLite setup
const db = new sqlite3.Database('./analiz.db');
initDB(db);

// Botu polling modunda başlat
bot.launch({ polling: true });
console.log('Bot polling modunda başlatıldı.');

// Telegram Commands
bot.command('start', async (ctx) => {
  console.log('Start komutu alındı, chat ID:', ctx.chat.id);
  await ctx.reply('Merhaba! Kripto analiz botu hazır. /analiz ile başla veya coin sor (ör. "ADA ne durumda?").');
});

bot.command('analiz', async (ctx) => {
  console.log('Analiz komutu alındı, chat ID:', ctx.chat.id);
  const news = await fetchNews();
  const messages = await fullAnalysis(news);
  for (const message of messages) {
    await ctx.reply(message);
  }
  await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') });
  // Grup paylaşımı
  if (ctx.chat.id == GROUP_ID) {
    for (const message of messages) {
      await bot.telegram.sendMessage(GROUP_ID, message);
    }
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
        const news = await fetchNews();
        const analysis = await analyzeCoin(coinPair, null, news, false); // HTTP Klines
        const timeframe = '1hour';
        const data = analysis.analyses[timeframe];
        let message = `Alarm: ${coin} ${currentPrice.toFixed(2)}'e ${currentPrice <= parseFloat(price) ? 'düştü' : 'çıktı'}!\n`;
        if (data) {
          message += `${coin} Analizi (${timeframe}, ${new Date().toLocaleString('tr-TR')}):\n`;
          message += `  Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n`;
        } else {
          message += 'Analiz verisi alınamadı.';
        }
        await ctx.reply(message);
        if (ctx.chat.id == GROUP_ID) {
          await bot.telegram.sendMessage(GROUP_ID, message);
        }
      }
    });
    startPriceWebSocket(coinPair, parseFloat(price), () => {});
    await ctx.reply(`${coin} için ${price} alarmı kuruldu.`);
  } else {
    await ctx.reply('Kullanım: /alarm_kur coin fiyat');
  }
});

// Chatbot özelliği: Herhangi bir metne yanıt
bot.on('text', async (ctx) => {
  console.log('Metin alındı, chat ID:', ctx.chat.id, 'text:', ctx.message.text);
  const text = ctx.message.text.toLowerCase();
  const coin = COINS.find(c => text.includes(c.split('-')[0].toLowerCase()));
  if (coin) {
    console.log(`Coin analizi: ${coin}`);
    const news = await fetchNews();
    const analysis = await analyzeCoin(coin, null, news, false);
    for (const [timeframe, data] of Object.entries(analysis.analyses)) {
      let message = `${coin} Analizi (${timeframe}):\nGiriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\nYorum: ${data.yorum}`;
      await ctx.reply(message);
      if (ctx.chat.id == GROUP_ID) {
        await bot.telegram.sendMessage(GROUP_ID, message);
      }
    }
    await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: JSON.stringify(analysis.analyses) });
  } else {
    // Genel sohbet için Grok-4 yanıtı
    console.log('Genel sohbet, metin:', text);
    const prompt = `Kullanıcı mesajı: "${text}". Kripto analiz botusun, kısa ve doğal Türkçe yanıt ver. Coin analizi istersen analiz yap, yoksa sohbet et.`;
    const comment = await callGrok(prompt);
    await ctx.reply(comment || 'Üzgünüm, bu konuda yorum yapamadım. Bir coin belirtir misin?');
  }
});

// Planlanmış grup analizleri
schedule.scheduleJob('0 */12 * * *', async () => {
  console.log('Planlanmış grup analizi başlıyor...');
  const news = await fetchNews();
  const messages = await fullAnalysis(news);
  for (const message of messages) {
    console.log('Planlanmış grup mesajı:', message);
    await bot.telegram.sendMessage(GROUP_ID, message);
  }
  await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') });
});

// Start Bot
startBot();
console.log('Bot çalışıyor...');

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
