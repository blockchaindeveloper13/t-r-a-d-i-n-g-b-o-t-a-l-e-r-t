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
  try {
    const news = await fetchNews();
    const messages = await fullAnalysis(news);
    for (const message of messages) {
      if (message.length > 4000) {
        const chunks = message.match(/.{1,4000}/g); // 4000 karakterlik parçalara böl
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      } else {
        await ctx.reply(message);
      }
    }
    await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') });
    // Grup paylaşımı için grup ID'si ekle
    // for (const message of messages) {
    //   await bot.telegram.sendMessage(GROUP_ID, message);
    // }
  } catch (error) {
    console.error('Analiz error:', error);
    await ctx.reply('Analiz sırasında bir hata oluştu. Lütfen tekrar deneyin.');
  }
});

bot.command('alarm_kur', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length === 2) {
    const [coin, price] = args;
    startWebSocket(coin.toUpperCase() + '-USDT', parseFloat(price), async (currentPrice) => {
      if (currentPrice <= price) {
        await ctx.reply(`Alarm: ${coin} ${currentPrice.toFixed(2)}'e düştü!`);
      } else if (currentPrice >= price) {
        await ctx.reply(`Alarm: ${coin} ${currentPrice.toFixed(2)}'e çıktı!`);
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
    try {
      const news = await fetchNews();
      const analysis = await require('./analysis').analyzeCoin(coin, null, news);
      let message = `${coin} Analizi (${new Date().toLocaleString('tr-TR')}):\n`;
      for (const [timeframe, data] of Object.entries(analysis.analyses)) {
        message += `  ${timeframe}: Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n\n`;
        if (message.length > 3500) {
          await ctx.reply(message);
          message = '';
        }
      }
      if (message) await ctx.reply(message);
      await saveAnalysis(db, { tarih: analysis.tarih, analiz: message });
    } catch (error) {
      console.error('Özel analiz error:', error);
      await ctx.reply('Analiz sırasında bir hata oluştu. Lütfen tekrar deneyin.');
    }
  }
});

// Schedule
schedule.scheduleJob('0 */12 * * *', async () => {
  try {
    const news = await fetchNews();
    const messages = await fullAnalysis(news);
    // Kullanıcıya/gruba gönder
    // for (const message of messages) {
    //   await bot.telegram.sendMessage(CHAT_ID, message);
    // }
  } catch (error) {
    console.error('Schedule error:', error);
  }
});

// Start Bot
bot.launch();
console.log('Bot çalışıyor...');

// Heroku PORT
const PORT = process.env.PORT || 3000;
require('http').createServer((req, res) => res.end('Bot çalışıyor')).listen(PORT);
