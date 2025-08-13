const { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const { initDB, saveAnalysis, getRecentAnalyses } = require('./db');
const { fetchNews } = require('./news');
const { startWebSocket } = require('./websocket');
const { fullAnalysis } = require('./analysis');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const parser = new Parser();
const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT'];

// SQLite setup
const db = new sqlite3.Database('./analiz.db');
initDB(db);

// Telegram Commands
bot.command('start', async (ctx) => {
  await ctx.reply('Merhaba! Kripto analiz botu hazır. /analiz ile başla veya coin sor (ör. "ADA ne durumda?").');
});

bot.command('analiz', async (ctx) => {
  const news = await fetchNews();
  const result = await fullAnalysis(news);
  await ctx.reply(result);
  await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: result });
  // Grup paylaşımı için grup ID'si ekle
  // await bot.telegram.sendMessage(GROUP_ID, result);
});

bot.command('alarm_kur', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 2) {
    const [coin, price] = args;
    startWebSocket(coin.toUpperCase() + '-USDT', parseFloat(price), async (currentPrice) => {
      if (currentPrice <= price) {
        await ctx.reply(`Alarm: ${coin} ${currentPrice.toFixed(2)}'e düştü!`);
      }
    });
    await ctx.reply(`${coin} için ${price} alarmı kuruldu.`);
  } else {
    await ctx.reply('Kullanım: /alarm_kur coin fiyat');
  }
});

// Chatbot tarzı etkileşim
bot.on('text', async (ctx) => {
  const text = ctx.message.text.toLowerCase();
  const coin = COINS.find(c => text.includes(c.split('-')[0].toLowerCase()));
  if (coin) {
    const news = await fetchNews();
    const analysis = await require('./analysis').analyzeCoin(coin);
    let message = `${coin} Analizi (${new Date().toLocaleString('tr-TR')}):\n`;
    for (const [timeframe, data] of Object.entries(analysis.analyses)) {
      message += `  ${timeframe}: Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n\n`;
    }
    await ctx.reply(message);
    await saveAnalysis(db, { tarih: analysis.tarih, analiz: message });
  }
});

// Schedule
schedule.scheduleJob('0 */12 * * *', async () => {
  const news = await fetchNews();
  const result = await fullAnalysis(news);
  // Kullanıcıya/gruba gönder
  // await bot.telegram.sendMessage(CHAT_ID, result);
});

// Start Bot
bot.launch();
console.log('Bot çalışıyor...');

// Heroku PORT
const PORT = process.env.PORT || 3000;
require('http').createServer((req, res) => res.end('Bot çalışıyor')).listen(PORT);
