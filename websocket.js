const WebSocket = require('ws');
const axios = require('axios');

async function getWebSocketToken() {
  try {
    const response = await axios.get('https://api.kucoin.com/api/v1/bullet-public');
    return response.data.data.token;
  } catch (error) {
    console.error('KuCoin WebSocket token error:', error.message);
    return null;
  }
}

async function startWebSocket(coin, timeframe, callback) {
  const token = await getWebSocketToken();
  if (!token) {
    console.error('WebSocket token alınamadı.');
    return;
  }

  const ws = new WebSocket(`wss://ws-api-spot.kucoin.com?token=${token}&connectId=${Date.now()}`);
  let pingInterval;

  ws.on('open', () => {
    console.log(`WebSocket connected for ${coin}_${timeframe}`);
    const subscribeMsg = {
      id: Date.now(),
      type: 'subscribe',
      topic: `/market/candles:${coin}_${timeframe}`,
      response: true,
    };
    ws.send(JSON.stringify(subscribeMsg));

    // Keep-alive için ping
    pingInterval = setInterval(() => {
      ws.send(JSON.stringify({ id: Date.now(), type: 'ping' }));
    }, 20000);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'message' && msg.topic.includes('/market/candles')) {
        const { symbol, candles } = msg.data;
        const [time, open, close, high, low, volume, amount] = candles;
        callback({
          timestamp: new Date(parseInt(time) * 1000).toISOString(),
          open: parseFloat(open),
          high: parseFloat(high),
          low: parseFloat(low),
          close: parseFloat(close),
          volume: parseFloat(volume),
        });
      }
    } catch (error) {
      console.error('WebSocket message error:', error.message);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });

  ws.on('close', () => {
    console.log('WebSocket closed, reconnecting...');
    clearInterval(pingInterval);
    setTimeout(() => startWebSocket(coin, timeframe, callback), 5000);
  });

  // Fiyat alarmı için mevcut WebSocket mantığı
  async function startPriceWebSocket(coin, targetPrice, priceCallback) {
    const kucoin = new ccxt.kucoin({ enableRateLimit: true });
    while (true) {
      try {
        const ticker = await kucoin.fetchTicker(coin);
        priceCallback(ticker.last);
        await new Promise(resolve => setTimeout(resolve, 60000));
      } catch (e) {
        console.error('Price WebSocket error:', e);
      }
    }
  }

  return { ws, startPriceWebSocket };
}

module.exports = { startWebSocket };
