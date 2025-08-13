const WebSocket = require('ws');
const axios = require('axios');

async function getWebSocketToken() {
  try {
    const response = await axios.post('https://api.kucoin.com/api/v1/bullet-public', {}, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    console.log('WebSocket token response:', response.data);
    return response.data.data.token;
  } catch (error) {
    console.error('KuCoin WebSocket token error:', error.response?.data || error.message);
    return null;
  }
}

async function startWebSocket(coin, timeframe, callback) {
  const token = await getWebSocketToken();
  if (!token) {
    console.error('WebSocket token alınamadı, HTTP Klines kullanılacak.');
    return { ws: null, startPriceWebSocket: () => {}, fetchKlines: () => [] };
  }

  const ws = new WebSocket(`wss://ws-api-spot.kucoin.com?token=${token}&connectId=${Date.now()}`);
  let pingInterval;
  const klines = [];

  ws.on('open', () => {
    console.log(`WebSocket connected for ${coin}_${timeframe}`);
    const subscribeMsg = {
      id: Date.now(),
      type: 'subscribe',
      topic: timeframe ? `/market/candles:${coin}_${timeframe}` : `/market/ticker:${coin}`,
      response: true,
    };
    ws.send(JSON.stringify(subscribeMsg));

    pingInterval = setInterval(() => {
      ws.send(JSON.stringify({ id: Date.now(), type: 'ping' }));
    }, 20000);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'message') {
        if (msg.topic.includes('/market/ticker')) {
          const price = parseFloat(msg.data.price);
          callback({ price });
        } else if (msg.topic.includes('/market/candles')) {
          const { candles } = msg.data;
          const [time, open, close, high, low, volume, amount] = candles;
          klines.push({
            timestamp: new Date(parseInt(time) * 1000).toISOString(),
            open: parseFloat(open),
            high: parseFloat(high),
            low: parseFloat(low),
            close: parseFloat(close),
            volume: parseFloat(volume),
          });
          callback({ klines });
        }
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

  return {
    ws,
    startPriceWebSocket: (coin, targetPrice, priceCallback) => {
      if (!timeframe) callback({ price: targetPrice });
    },
    fetchKlines: () => klines.slice(-200), // Son 200 veriyi dön
  };
}

module.exports = { startWebSocket };
