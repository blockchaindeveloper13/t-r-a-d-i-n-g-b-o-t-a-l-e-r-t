const ccxt = require('ccxt');

async function startWebSocket(coin, targetPrice, callback) {
  const binance = new ccxt.binance({ enableRateLimit: true });
  while (true) {
    try {
      const ticker = await binance.fetchTicker(coin);
      callback(ticker.last);
      await new Promise(resolve => setTimeout(resolve, 60000));
    } catch (e) {
      console.error('WebSocket error:', e);
    }
  }
}

module.exports = { startWebSocket };
