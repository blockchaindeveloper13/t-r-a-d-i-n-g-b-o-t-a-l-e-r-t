const { Telegraf } = require('telegraf');
const schedule = require('node-schedule');
const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const { initDB, saveAnalysis, getRecentAnalyses } = require('./db');
const { fetchNews } = require('./news');
const { startWebSocket } = require('./websocket');
const { analyzeCoin, fullAnalysis, fetchHttpKlines } = require('./analysis');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN || '7551795139:AAHJa1du2jRmmA1gmTPIHwJbUsRT7wOksaI', {
  telegram: { webhook: false },
  handlerTimeout: 900000 // 15 dakika timeout
});
const parser = new Parser();
const COINS = ['AAVE-USDT', 'COMP-USDT', 'LTC-USDT', 'XLM-USDT', 'ADA-USDT', 'MKR-USDT', 'BTC-USDT'];
const GROUP_ID = '-1002869335730'; // @tradingroup95 grup ID'si

// SQLite setup
const db = new sqlite3.Database('./analiz.db');
initDB(db);

// Botu polling modunda başlat
async function startBot() {
  try {
    await bot.launch({
      polling: {
        interval: 300, // 300ms polling intervali
        timeout: 30 // 30 saniye timeout
      }
    });
    console.log('Bot polling modunda başlatıldı.');
    await bot.telegram.sendMessage(GROUP_ID, 'Merhaba @tradingroup95! Kripto analiz botu aktif. /analiz ile başlayın veya coin sor (ör. "ADA ne durumda?").');
  } catch (error) {
    console.error('Bot başlatma hatası:', error.message, error.stack);
    console.log('5 saniye sonra tekrar deneniyor...');
    setTimeout(startBot, 5000);
  }
}

// Telegram Commands
bot.command('start', async (ctx) => {
  try {
    console.log('Start komutu alındı, chat ID:', ctx?.chat?.id || 'Bilinmiyor', 'user:', ctx?.from?.username || 'Bilinmiyor');
    await ctx.reply('Merhaba! Kripto analiz botu hazır. /analiz ile başla veya coin sor (ör. "ADA ne durumda?").');
    if (String(ctx.chat.id) === GROUP_ID) {
      await bot.telegram.sendMessage(GROUP_ID, 'Bot @tradingroup95 grubunda aktif! /analiz ile kripto analizlerini görün.');
    }
  } catch (error) {
    console.error('Start komutu hatası:', error.message, error.stack);
    if (ctx) await ctx.reply('Hata oluştu, lütfen tekrar deneyin.');
  }
});

bot.command('analiz', async (ctx) => {
  try {
    console.log('Analiz komutu alındı, chat ID:', ctx?.chat?.id || 'Bilinmiyor', 'user:', ctx?.from?.username || 'Bilinmiyor');
    const news = await fetchNews();
    const messages = await fullAnalysis(news);
    for (const message of messages) {
      console.log('Gönderilen mesaj:', message);
      if (message.length > 2000) {
        const chunks = message.match(/.{1,2000}/g);
        for (const chunk of chunks) {
          await ctx.reply(chunk);
          if (String(ctx.chat.id) === GROUP_ID) {
            await bot.telegram.sendMessage(GROUP_ID, chunk);
            console.log('Grup mesaj parçası gönderildi:', chunk);
          }
        }
      } else {
        await ctx.reply(message);
        if (String(ctx.chat.id) === GROUP_ID) {
          await bot.telegram.sendMessage(GROUP_ID, message);
          console.log('Grup mesajı gönderildi:', message);
        }
      }
    }
    await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') });
  } catch (error) {
    console.error('Analiz hatası:', error.message, error.stack);
    if (ctx) await ctx.reply('Analiz sırasında hata oluştu. Lütfen tekrar deneyin.');
  }
});

bot.command('alarm_kur', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 2) {
      const [coin, price] = args;
      const coinPair = coin.toUpperCase() + '-USDT';
      console.log(`Alarm kuruluyor: ${coinPair} için ${price}, chat ID: ${ctx?.chat?.id || 'Bilinmiyor'}, user: ${ctx?.from?.username || 'Bilinmiyor'}`);
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
              if (String(ctx.chat.id) === GROUP_ID) {
                await bot.telegram.sendMessage(GROUP_ID, chunk);
                console.log('Alarm mesaj parçası gönderildi:', chunk);
              }
            }
          } else {
            await ctx.reply(message);
            if (String(ctx.chat.id) === GROUP_ID) {
              await bot.telegram.sendMessage(GROUP_ID, message);
              console.log('Alarm mesajı gönderildi:', message);
            }
          }
        }
      });
      startPriceWebSocket(coinPair, parseFloat(price), () => {});
      await ctx.reply(`${coin} için ${price} alarmı kuruldu.`);
    } else {
      await ctx.reply('Kullanım: /alarm_kur coin fiyat');
    }
  } catch (error) {
    console.error('Alarm kur hatası:', error.message, error.stack);
    if (ctx) await ctx.reply('Alarm kurulumunda hata oluştu. Lütfen tekrar deneyin.');
  }
});

// Grup mesajlarına yanıt
bot.on('text', async (ctx) => {
  try {
    const text = ctx.message.text.toLowerCase();
    const coin = COINS.find(c => text.includes(c.split('-')[0].toLowerCase()));
    if (coin && String(ctx.chat.id) === GROUP_ID) {
      console.log(`Grup metin analizi: ${coin}, chat ID: ${ctx?.chat?.id || 'Bilinmiyor'}, user: ${ctx?.from?.username || 'Bilinmiyor'}`);
      const news = await fetchNews();
      const analysis = await analyzeCoin(coin, null, news, false); // HTTP Klines
      for (const [timeframe, data] of Object.entries(analysis.analyses)) {
        let message = `${coin} Analizi (${timeframe}, ${new Date().toLocaleString('tr-TR')}):\n`;
        message += `  Giriş: ${data.giriş.toFixed(2)}, Çıkış: ${data.çıkış.toFixed(2)}\n  Yorum: ${data.yorum}\n`;
        console.log('Grup metin mesajı:', message);
        if (message.length > 2000) {
          const chunks = message.match(/.{1,2000}/g);
          for (const chunk of chunks) {
            await ctx.reply(chunk);
            await bot.telegram.sendMessage(GROUP_ID, chunk);
            console.log('Grup metin mesaj parçası gönderildi:', chunk);
          }
        } else {
          await ctx.reply(message);
          await bot.telegram.sendMessage(GROUP_ID, message);
          console.log('Grup metin mesajı gönderildi:', message);
        }
      }
      await saveAnalysis(db, { tarih: analysis.tarih, analiz: JSON.stringify(analysis.analyses) });
    }
  } catch (error) {
    console.error('Grup analiz hatası:', error.message, error.stack);
    if (ctx) await ctx.reply('Analiz sırasında hata oluştu. Lütfen tekrar deneyin.');
  }
});

// Planlanmış grup analizleri
schedule.scheduleJob('0 */12 * * *', async () => {
  try {
    console.log('Planlanmış grup analizi başlıyor...');
    const news = await fetchNews();
    const messages = await fullAnalysis(news);
    for (const message of messages) {
      console.log('Planlanmış grup mesajı:', message);
      if (message.length > 2000) {
        const chunks = message.match(/.{1,2000}/g);
        for (const chunk of chunks) {
          await bot.telegram.sendMessage(GROUP_ID, chunk);
          console.log('Planlanmış grup mesaj parçası gönderildi:', chunk);
        }
      } else {
        await bot.telegram.sendMessage(GROUP_ID, message);
        console.log('Planlanmış grup mesajı gönderildi:', message);
      }
    }
    await saveAnalysis(db, { tarih: new Date().toLocaleString('tr-TR'), analiz: messages.join('\n') });
  } catch (error) {
    console.error('Planlanmış analiz hatası:', error.message, error.stack);
  }
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
