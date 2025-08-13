const { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const { initDB, saveAnalysis, getRecentAnalyses } = require('./db');
const { fetchNews } = require('./news');
const { startWebSocket } = require('./websocket');
const { analyzeCoin, fullAnalysis, fetchHttpKlines } = require('./analysis');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const parser = new Parser();
const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT'];

// SQLite setup
const db = new sqlite3.Database('./analiz.db');
initDB(db);

// Webhook kontrolü ve polling
async function checkWebhook() {
  try {
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', JSON.stringify(webhookInfo, null, 2));
    if (webhookInfo.url) {
      console.log('Webhook bulundu, siliniyor ve polling moduna geçiliyor.');
      await bot.telegram.deleteWebhook();
    }
    console.log('Polling modunda başlatılıyor...');
    await bot.launch({ webhook: null });
  } catch (error) {
    console.error('Webhook kontrol hatası:', error.message);
    console.log('Polling modunda başlatılıyor...');
    await bot.launch({ webhook: null });
  }
}

// Telegram Commands
bot.command('start', async (ctx) => {
  try {
    console.log('Start komutu alındı, chat ID:', ctx.chat.id);
    await ctx.reply('Merhaba! Kripto analiz botu hazır. /analiz ile başla veya coin sor (ör. "ADA ne durumda?").');
  } catch (error) {
    console.error('Start komutu hatası:', error.message);
    await ctx.reply('Hata oluştu, lütfen tekrar deneyin.');
  }
});

bot.command('analiz', async (ctx) => {
  try {
    console.log('Analiz komutu alındı, chat ID:', ctx.chat.id);
    const news = await fetchNews();
    const messages = await fullAnalysis(news);
    for (const message of messages) {
      console.log('Gönderilen mesaj:', message);
      if (message.length > 2000) {
        const chunks = message.match(/.{1,2000}/g);
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
    console.error('Analiz hatası:', error.message);
    await ctx.reply('Analiz sırasında hata oluştu. Lütfen tekrar deneyin.');
  }
});

bot.command('alarm_kur', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 2) {
      const [coin, price] = args;
      const coinPair = coin.toUpperCase() + '-USDT';
      console.log(`Alarm kuruluyor: ${coinPair} için ${price}, chat ID: ${ctx.chat.id}`);
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
            message += 'Analiz verisi alınamadı, lütfen tekrar deneyin.\n';
          }
          console.log('Alarm mesajı:', message);
          if (message.length > 2000) {
            const chunks = message.match(/.{1,2000}/g);
            for (const chunk of chunks) {
              await ctx.reply(chunk);
            }
          } else {
            await ctx.reply(message);
          }
        }
      });
      startPriceWebSocket(coinPair, parseFloat(price), () => {});
      await ctx.reply(`${coin} için ${price} alarmı kuruldu.`);
    } else {
      await ctx.reply('Kullanım: /alarm_kur coin fiyat');
    }
  } catch (error) {
    console.error('Alarm kur hatası:', error.message);
    await ctx.reply('Alarm kurulumunda hata oluştu. Lütfen tekrar deneyin.');
  }
});

// Chatbot tarzı etkileşim
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text.toLowerCase();
    const coin = COINS.find(c => text.includes(c.split('-')[0].toLowerCase()));
    if (coin) {
      console.log(`Serbest metin analizi: ${coin}, chat ID: ${ctx.chat.id}`);
      const news = await fetchNews();
      const analysis = await analyzeCoin(coin, null, news, false); // HTTP Klines
      for (const [timeframe, data] of Object.entries(analysis.analyses)) {
        let message = `${coin} Analizi (${timeframe}, ${new Date().toLocaleString('tr-TR')}):\n`;
        message += `  Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n`;
        console.log('Serbest metin mesajı:', message);
        if (message.length > 2000) {
          const chunks = message.match(/.{1,2000}/g);
          for (const chunk of chunks) {
            await ctx.reply(chunk);
          }
        } else {
          await ctx.reply(message);
        }
      }
      await saveAnalysis(db, { tarih: analysis.tarih, analiz: JSON.stringify(analysis.analyses) });
    }
  } catch (error) {
    console.error('Özel analiz hatası:', error.message);
    await ctx.reply('Analiz sırasında hata oluştu. Lütfen tekrar deneyin.');
  }
});

// Schedule
schedule.scheduleJob('0 */12 * * *', async () => {
  try {
    console.log('Planlanmış analiz başlıyor...');
    const news = await fetchNews();
    const messages = await fullAnalysis(news);
    // Kullanıcıya/gruba gönder
    // for (const message of messages) {
    //   await bot.telegram.sendMessage(CHAT_ID, message);
    // }
  } catch (error) {
    console.error('Planlanmış analiz hatası:', error.message);
  }
});

// Start Bot
checkWebhook();
console.log('Bot çalışıyor...');

// Heroku PORT
const PORT = process.env.PORT || 3000;
require('http').createServer((req, res) => res.end('Bot çalışıyor')).listen(PORT);

// Genel hata yönetimi
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.message);
});
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error.message);
});
