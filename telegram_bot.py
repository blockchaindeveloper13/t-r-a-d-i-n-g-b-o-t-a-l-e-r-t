import os
import pandas as pd
import pandas_ta as ta
import logging
import asyncio
import aiohttp
import signal
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes, MessageHandler, filters
from openai import AsyncOpenAI
from aiohttp import web
from dotenv import load_dotenv
from datetime import datetime, timedelta
import psycopg2
from urllib.parse import urlparse
import json
import re
import numpy as np

# Loglama ayarları
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

load_dotenv()

# Seçilen coinler ve kısaltmaları
COINS = {
    "OKBUSDT": ["okb", "okbusdt"],
    "ADAUSDT": ["ada", "adausdt"],
    "DOTUSDT": ["dot", "dotusdt"],
    "XLMUSDT": ["xlm", "xlmusdt"],
    "LTCUSDT": ["ltc", "ltcusdt"],
    "UNIUSDT": ["uni", "uniusdt"],
    "ATOMUSDT": ["atom", "atomusdt"],
    "CRVUSDT": ["crv", "crvusdt"],
    "TRUMPUSDT": ["trump", "trumpusdt"],
    "AAVEUSDT": ["aave", "aaveusdt"],
    "BNBUSDT": ["bnb", "bnbusdt"],
    "ETHUSDT": ["eth", "ethusdt", "ethereum"],
    "BTCUSDT": ["btc", "btcusdt", "bitcoin"],
    "LINKUSDT": ["link", "linkusdt", "chainlink"],
    "MKRUSDT": ["mkr", "mkrusdt", "maker"]
}

# Seçilen zaman dilimleri
TIMEFRAMES = ['5m', '15m', '60m', '6h']

def validate_data(df):
    """Veride eksik veya geçersiz değerleri kontrol et ve düzelt. 🛠️"""
    if df.empty:
        logger.warning("Boş DataFrame, işlem atlanıyor. 😕")
        return df

    if df[['open', 'high', 'low', 'close', 'volume']].isnull().any().any():
        logger.warning("Eksik veri tespit edildi, ileri ve geri doldurma yapılıyor. 🔄")
        df = df.fillna(method='ffill').fillna(method='bfill')

    invalid_rows = df[df['high'] < df['low']]
    if not invalid_rows.empty:
        logger.warning(f"Geçersiz veri (high < low): {invalid_rows[['timestamp', 'high', 'low']].to_dict()}")
        df.loc[df['high'] < df['low'], ['high', 'low']] = df.loc[df['high', 'low'], ['low', 'high']].values
        logger.info("High ve Low sütunları yer değiştirildi. ✅")

    if (df[['open', 'high', 'low', 'close']] <= 0).any().any():
        logger.warning("Sıfır veya negatif fiyat tespit edildi, bu satırlar kaldırılıyor. 🚫")
        df = df[df[['open', 'high', 'low', 'close']].gt(0).all(axis=1)]

    df['max_price'] = df[['open', 'close', 'high', 'low']].max(axis=1)
    df['min_price'] = df[['open', 'close', 'high', 'low']].min(axis=1)
    df.loc[df['high'] != df['max_price'], 'high'] = df['max_price']
    df.loc[df['low'] != df['min_price'], 'low'] = df['min_price']
    df = df.drop(columns=['max_price', 'min_price'])

    return df

class KuCoinClient:
    """KuCoin API ile iletişim kurar. 🌐"""
    def __init__(self):
        self.base_url = "https://api.kucoin.com"
        self.api_key = os.getenv('KUCOIN_KEY')
        self.api_secret = os.getenv('KUCOIN_SECRET')
        self.session = None

    async def initialize(self):
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession()
            logger.info("KuCoin session başlatıldı. 🚀")

    async def fetch_kline_data(self, symbol, interval, count=200):
        await self.initialize()
        try:
            kucoin_intervals = {
                '5m': '5min', '15m': '15min', '60m': '1hour', '6h': '6hour'
            }
            if interval not in kucoin_intervals:
                logger.error(f"Geçersiz aralık {interval} KuCoin için. 😞")
                return {'data': []}
            symbol_kucoin = symbol.replace('USDT', '-USDT')
            url = f"{self.base_url}/api/v1/market/candles?type={kucoin_intervals[interval]}&symbol={symbol_kucoin}"
            async with self.session.get(url) as response:
                logger.info(f"Requesting KuCoin URL: {url}")
                if response.status == 200:
                    response_data = await response.json()
                    logger.info(f"Raw KuCoin response: {response_data}")
                    if response_data['code'] == '200000' and response_data['data']:
                        data = [
                            [int(candle[0]) * 1000, float(candle[1]), float(candle[2]), float(candle[3]),
                             float(candle[4]), float(candle[5]), int(candle[0]) * 1000, float(candle[6])]
                            for candle in response_data['data']
                        ][:count]
                        df = pd.DataFrame(data, columns=['timestamp', 'open', 'close', 'high', 'low', 'volume', 'close_time', 'quote_volume'])
                        df = validate_data(df)
                        if df.empty:
                            logger.warning(f"Geçersiz veya boş veri sonrası DataFrame boş: {symbol} ({interval}) 😕")
                            return {'data': []}
                        logger.info(f"KuCoin kline response for {symbol} ({interval}): {df.head().to_dict()}")
                        return {'data': df.values.tolist()}
                    else:
                        logger.warning(f"No KuCoin kline data for {symbol} ({interval}): {response_data}")
                        return {'data': []}
                else:
                    logger.error(f"Failed to fetch KuCoin kline data for {symbol} ({interval}): {response.status} 😢")
                    return {'data': []}
        except Exception as e:
            logger.error(f"Error fetching KuCoin kline data for {symbol} ({interval}): {e} 😞")
            return {'data': []}
        finally:
            await asyncio.sleep(0.5)

    async def fetch_order_book(self, symbol):
        await self.initialize()
        try:
            symbol_kucoin = symbol.replace('USDT', '-USDT')
            url = f"{self.base_url}/api/v1/market/orderbook/level2_20?symbol={symbol_kucoin}"
            async with self.session.get(url) as response:
                if response.status == 200:
                    response_data = await response.json()
                    logger.info(f"Raw KuCoin order book response for {symbol}: {response_data}")
                    if response_data['code'] == '200000' and response_data['data']:
                        order_book = {
                            'bids': [[str(bid[0]), str(bid[1])] for bid in response_data['data']['bids']],
                            'asks': [[str(ask[0]), str(ask[1])] for ask in response_data['data']['asks']],
                            'timestamp': int(response_data['data']['time'])
                        }
                        logger.info(f"Order book response for {symbol}: {order_book}")
                        return order_book
                    else:
                        logger.warning(f"No KuCoin order book data for {symbol} 😕")
                        return {'bids': [], 'asks': [], 'timestamp': 0}
                else:
                    logger.error(f"Failed to fetch KuCoin order book for {symbol}: {response.status} 😢")
                    return {'bids': [], 'asks': [], 'timestamp': 0}
        except Exception as e:
            logger.error(f"Error fetching KuCoin order book for {symbol}: {e} 😞")
            return {'bids': [], 'asks': [], 'timestamp': 0}
        finally:
            await asyncio.sleep(0.5)

    async def fetch_ticker(self, symbol):
        await self.initialize()
        try:
            symbol_kucoin = symbol.replace('USDT', '-USDT')
            url = f"{self.base_url}/api/v1/market/stats?symbol={symbol_kucoin}"
            async with self.session.get(url) as response:
                if response.status == 200:
                    response_data = await response.json()
                    logger.info(f"Raw KuCoin ticker response for {symbol}: {response_data}")
                    if response_data['code'] == '200000' and response_data['data']:
                        ticker = {'symbol': symbol, 'price': response_data['data']['last']}
                        logger.info(f"Ticker response for {symbol}: {ticker}")
                        return ticker
                    else:
                        logger.warning(f"No KuCoin ticker data for {symbol} 😕")
                        return {'symbol': symbol, 'price': '0.0'}
                else:
                    logger.error(f"Failed to fetch KuCoin ticker for {symbol}: {response.status} 😢")
                    return {'symbol': symbol, 'price': '0.0'}
        except Exception as e:
            logger.error(f"Error fetching KuCoin ticker for {symbol}: {e} 😞")
            return {'symbol': symbol, 'price': '0.0'}
        finally:
            await asyncio.sleep(0.5)

    async def fetch_24hr_ticker(self, symbol):
        await self.initialize()
        try:
            symbol_kucoin = symbol.replace('USDT', '-USDT')
            url = f"{self.base_url}/api/v1/market/stats?symbol={symbol_kucoin}"
            async with self.session.get(url) as response:
                if response.status == 200:
                    response_data = await response.json()
                    logger.info(f"Raw KuCoin 24hr ticker response for {symbol}: {response_data}")
                    if response_data['code'] == '200000' and response_data['data']:
                        ticker_24hr = {
                            'symbol': symbol,
                            'priceChange': response_data['data']['changePrice'],
                            'priceChangePercent': response_data['data']['changeRate'],
                            'prevClosePrice': str(float(response_data['data']['last']) - float(response_data['data']['changePrice'])),
                            'lastPrice': response_data['data']['last'],
                            'openPrice': response_data['data']['buy'],
                            'highPrice': response_data['data']['high'],
                            'lowPrice': response_data['data']['low'],
                            'volume': response_data['data']['vol'],
                            'quoteVolume': response_data['data']['volValue']
                        }
                        logger.info(f"24hr ticker response for {symbol}: {ticker_24hr}")
                        return ticker_24hr
                    else:
                        logger.warning(f"No KuCoin 24hr ticker data for {symbol} 😕")
                        return {'priceChangePercent': '0.0'}
                else:
                    logger.error(f"Failed to fetch KuCoin 24hr ticker for {symbol}: {response.status} 😢")
                    return {'priceChangePercent': '0.0'}
        except Exception as e:
            logger.error(f"Error fetching KuCoin 24hr ticker for {symbol}: {e} 😞")
            return {'priceChangePercent': '0.0'}
        finally:
            await asyncio.sleep(0.5)

    async def validate_symbol(self, symbol):
        await self.initialize()
        try:
            symbol_kucoin = symbol.replace('USDT', '-USDT')
            url = f"{self.base_url}/api/v1/market/stats?symbol={symbol_kucoin}"
            async with self.session.get(url) as response:
                response_data = await response.json()
                logger.info(f"Validate symbol response for {symbol}: {response_data}")
                return response.status == 200 and response_data['code'] == '200000' and 'last' in response_data['data']
        except Exception as e:
            logger.error(f"Error validating symbol {symbol}: {e} 😞")
            return False
        finally:
            await asyncio.sleep(0.5)

    async def close(self):
        if self.session and not self.session.closed:
            await self.session.close()
            self.session = None
            logger.info("KuCoin session kapatıldı. 🛑")

class DeepSeekClient:
    """DeepSeek API ile analiz yapar ve doğal dil işleme sağlar. 🧠✨"""
    def __init__(self):
        self.client = AsyncOpenAI(api_key=os.getenv('DEEPSEEK_API_KEY'), base_url="https://api.deepseek.com")

    async def analyze_coin(self, symbol, data):
        fib_levels = data['indicators'].get('fibonacci_levels', [0.0, 0.0, 0.0, 0.0, 0.0])

        raw_data = {}
        for interval in TIMEFRAMES:
            raw_data[interval] = data['indicators'].get(f'raw_data_{interval}', {'high': 0.0, 'low': 0.0, 'close': 0.0})

        indicators_formatted = []
        for interval in TIMEFRAMES:
            ma50 = data['indicators'][f'ma_{interval}']['ma50']
            rsi = data['indicators'][f'rsi_{interval}']
            atr = data['indicators'][f'atr_{interval}']
            macd = data['indicators'][f'macd_{interval}']['macd']
            signal = data['indicators'][f'macd_{interval}']['signal']
            bb_upper = data['indicators'][f'bbands_{interval}']['upper']
            bb_lower = data['indicators'][f'bbands_{interval}']['lower']
            stoch_k = data['indicators'][f'stoch_{interval}']['k']
            stoch_d = data['indicators'][f'stoch_{interval}']['d']
            obv = data['indicators'][f'obv_{interval}']
            indicators_formatted.append(
                f"⏰ {interval} Göstergeleri:\n"
                f"  📈 MA50: {ma50:.2f}\n"
                f"  📊 RSI: {rsi:.2f}\n"
                f"  ⚡ ATR: {atr:.2f}%\n"
                f"  📉 MACD: {macd:.2f}, Sinyal: {signal:.2f}\n"
                f"  🎢 Bollinger: Üst={bb_upper:.2f}, Alt={bb_lower:.2f}\n"
                f"  🚀 Stochastic: %K={stoch_k:.2f}, %D={stoch_d:.2f}\n"
                f"  📦 OBV: {obv:.2f}\n"
            )

        raw_data_formatted = []
        for interval in raw_data:
            high = raw_data[interval]['high']
            low = raw_data[interval]['low']
            close = raw_data[interval]['close']
            raw_data_formatted.append(f"{interval}: High=${high:.2f}, Low=${low:.2f}, Close=${close:.2f}")

        prompt = (
            f"{symbol} için vadeli işlem analizi yap (spot piyasa verilerine dayalı). Yanıt tamamen Türkçe, detaylı ama kısa (maks 3000 karakter) olmalı. 😎 "
            f"KALIN YAZI İÇİN ** KULLANMA, bunun yerine düz metin veya emoji kullan. 🚫 "
            f"Sadece tek bir long ve short pozisyon önerisi sun (giriş fiyatı, take-profit, stop-loss, kaldıraç, risk/ödül oranı ve trend tahmini). "
            f"Değerler tamamen senin analizine dayansın, kodda hesaplama yapılmasın. 🧠 "
            f"Toplu değerlendirme (yorum) detaylı, emoji dolu ve samimi olsun, ama özlü yaz (maks 1500 karakter). 🎉 "
            f"ATR > %5 veya BTC/ETH korelasyonu > 0.8 ise yatırımdan uzak dur uyarısı ekle, ancak teorik pozisyon parametrelerini sağla. ⚠️ "
            f"Spot verilerini vadeli işlem için uyarla. Doğal, profesyonel ama samimi bir üslup kullan. 😄 "
            f"Giriş, take-profit ve stop-loss’u nasıl belirlediğini, hangi göstergelere (MA50, RSI, MACD, Bollinger, Stochastic, OBV) dayandığını kısaca açıkla. "
            f"Tüm veriler KuCoin’den alındı. Uzun vadeli veri eksikse, kısa vadeli verilere odaklan ve belirt. 📊\n\n"
            f"### Destek ve Direnç Hesaplama\n"
            f"Destek ve direnç seviyelerini pivot nokta yöntemiyle hesapla:\n"
            f"- Pivot = (High + Low + Close) / 3\n"
            f"- Range = High - Low\n"
            f"- Destek Seviyeleri: [Pivot - Range * 0.5, Pivot - Range * 0.618, Pivot - Range]\n"
            f"- Direnç Seviyeleri: [Pivot + Range * 0.5, Pivot + Range * 0.618, Pivot + Range]\n"
            f"Seviyeleri analizde kullan ve karşılaştırma yap. Eğer ham veriler eksikse, durumu yorumda belirt. 🔍\n\n"
            f"### Ham Veriler\n"
            f"{', '.join(raw_data_formatted)}\n\n"
            f"### Diğer Veriler\n"
            f"- Mevcut Fiyat: {data['price']:.2f} USDT 💰\n"
            f"- 24 Saatlik Değişim: {data.get('price_change_24hr', 0.0):.2f}% 📈\n"
            f"- Göstergeler:\n"
            f"{''.join(indicators_formatted)}\n"
            f"- Fibonacci Seviyeleri: {', '.join([f'${x:.2f}' for x in fib_levels])} 📏\n"
            f"- BTC Korelasyonu: {data['indicators']['btc_correlation']:.2f} 🤝\n"
            f"- ETH Korelasyonu: {data['indicators']['eth_correlation']:.2f} 🤝\n\n"
            f"Çıktı formatı:\n"
            f"{symbol} Vadeli Analiz ({datetime.now().strftime('%Y-%m-%d %H:%M')}) ⏰\n"
            f"Zaman Dilimleri: {', '.join(TIMEFRAMES)} 🕒\n"
            f"Long Pozisyon:\n"
            f"- Giriş: $X 💵\n"
            f"- Take-Profit: $Y 🎯\n"
            f"- Stop-Loss: $Z 🛑\n"
            f"- Kaldıraç: Nx ⚙️\n"
            f"- Risk/Ödül: A:B 📊\n"
            f"- Trend: [Yükseliş/Düşüş/Nötr] 🚀📉\n"
            f"Short Pozisyon:\n"
            f"- Giriş: $X 💵\n"
            f"- Take-Profit: $Y 🎯\n"
            f"- Stop-Loss: $Z 🛑\n"
            f"- Kaldıraç: Nx ⚙️\n"
            f"- Risk/Ödül: A:B 📊\n"
            f"- Trend: [Yükseliş/Düşüş/Nötr] 🚀📉\n"
            f"Destek: [Hesaplanan seviyeler] 🛡️\n"
            f"Direnç: [Hesaplanan seviyeler] 🏰\n"
            f"Fibonacci: {', '.join([f'${x:.2f}' for x in fib_levels])} 📏\n"
            f"Volatilite: {data['indicators']['atr_5m']:.2f}% ({'Yüksek, uzak dur! 😱' if data['indicators']['atr_5m'] > 5 else 'Normal 😎'}) ⚡\n"
            f"BTC Korelasyonu: {data['indicators']['btc_correlation']:.2f} ({'Yüksek, dikkat! ⚠️' if data['indicators']['btc_correlation'] > 0.8 else 'Normal 😎'}) 🤝\n"
            f"ETH Korelasyonu: {data['indicators']['eth_correlation']:.2f} ({'Yüksek, dikkat! ⚠️' if data['indicators']['eth_correlation'] > 0.8 else 'Normal 😎'}) 🤝\n"
            f"Yorum: [Kısa, öz ama detaylı açıkla, hangi göstergelere dayandığını, giriş/take-profit/stop-loss seçim gerekçesini, yüksek korelasyon veya volatilite varsa neden yatırımdan uzak durulmalı belirt, emoji kullan, samimi ol! 🎉 Maks 1500 karakter. KALIN YAZI İÇİN ** KULLANMA! 🚫]\n"
        )
        try:
            response = await asyncio.wait_for(
                self.client.chat.completions.create(
                    model="deepseek-chat",
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=3000,
                    stream=False
                ),
                timeout=180.0
            )
            analysis_text = response.choices[0].message.content
            logger.info(f"DeepSeek raw response for {symbol}: {analysis_text} 📜")
            required_fields = ['Long Pozisyon', 'Short Pozisyon', 'Destek', 'Direnç', 'Yorum']
            missing_fields = []
            for field in required_fields:
                if field == 'Yorum':
                    if not analysis_text.strip() or 'Yorum:' not in analysis_text:
                        missing_fields.append(field)
                elif field not in analysis_text:
                    missing_fields.append(field)
            if missing_fields:
                raise ValueError(f"DeepSeek yanıtı eksik: {', '.join(missing_fields)} 😞")
            return {'analysis_text': analysis_text}
        except (asyncio.TimeoutError, ValueError, Exception) as e:
            logger.error(f"DeepSeek API error for {symbol}: {e} 😢")
            raise Exception(f"DeepSeek API'den veri alınamadı: {str(e)} 😞")

    async def generate_natural_response(self, user_message, context_info, symbol=None):
        prompt = (
            f"Türkçe, ultra samimi ve esprili bir şekilde yanıt ver. Kullanıcıya 'kanka' diye hitap et, hafif argo kullan ama abartma. 😎 "
            f"KALIN YAZI İÇİN ** KULLANMA, bunun yerine düz metin veya emoji kullan. 🚫 "
            f"Mesajına uygun, akıcı ve doğal bir muhabbet kur. Eğer sembol ({symbol}) varsa, bağlama uygun şekilde atıfta bulun ve BTC/ETH korelasyonlarını vurgula. 🤝 "
            f"Konuşma geçmişini ve son analizi dikkate al. Emoji kullan, özgürce yaz! 🎉 Yanıt maks 1500 karakter olsun.\n\n"
            f"Kullanıcı mesajı: {user_message}\n"
            f"Bağlam: {context_info}\n"
        )
        try:
            response = await asyncio.wait_for(
                self.client.chat.completions.create(
                    model="deepseek-chat",
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=1000,
                    stream=False
                ),
                timeout=60.0
            )
            return response.choices[0].message.content
        except asyncio.TimeoutError:
            logger.error(f"DeepSeek API timeout for natural response 😢")
            return "Kanka, internet nazlandı, bi’ daha sor bakalım! 😜"
        except Exception as e:
            logger.error(f"DeepSeek natural response error: {e} 😞")
            return "Kanka, neyi kastediyosun, bi’ açar mısın? Hadi, muhabbet edelim! 😄"

class Storage:
    def __init__(self):
        url = urlparse(os.environ["DATABASE_URL"])
        self.conn = psycopg2.connect(
            database=url.path[1:],
            user=url.username,
            password=url.password,
            host=url.hostname,
            port=url.port
        )
        self.init_db()
        logger.info("PostgreSQL veritabanı başlatıldı. 🗄️")

    def init_db(self):
        """PostgreSQL tablolarını oluştur."""
        try:
            with self.conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS analyses (
                        id SERIAL PRIMARY KEY,
                        symbol TEXT,
                        timestamp TEXT,
                        indicators TEXT,
                        analysis_text TEXT
                    )
                """)
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS conversations (
                        id SERIAL PRIMARY KEY,
                        chat_id BIGINT,
                        user_message TEXT,
                        bot_response TEXT,
                        timestamp TEXT,
                        symbol TEXT
                    )
                """)
                self.conn.commit()
                logger.info("PostgreSQL tabloları oluşturuldu. ✅")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL tablo oluşturma hatası: {e} 😞")
            self.conn.rollback()

    def save_analysis(self, symbol, data):
        """Analizleri PostgreSQL’e kaydet."""
        try:
            with self.conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO analyses (symbol, timestamp, indicators, analysis_text)
                    VALUES (%s, %s, %s, %s)
                """, (
                    symbol,
                    datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    json.dumps(data['indicators']),
                    data['deepseek_analysis']['analysis_text']
                ))
                self.conn.commit()
                logger.info(f"{symbol} için analiz kaydedildi. 💾")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL analiz kaydetme hatası: {e} 😞")
            self.conn.rollback()

    def save_conversation(self, chat_id, user_message, bot_response, symbol=None):
        """Konuşmaları PostgreSQL’e kaydet."""
        try:
            with self.conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO conversations (chat_id, user_message, bot_response, timestamp, symbol)
                    VALUES (%s, %s, %s, %s, %s)
                """, (
                    chat_id,
                    user_message,
                    bot_response,
                    datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    symbol
                ))
                # Son 100 konuşmayı sakla
                cur.execute("""
                    DELETE FROM conversations
                    WHERE id NOT IN (
                        SELECT id FROM conversations
                        WHERE chat_id = %s
                        ORDER BY timestamp DESC
                        LIMIT 100
                    ) AND chat_id = %s
                """, (chat_id, chat_id))
                self.conn.commit()
                logger.info(f"Konuşma kaydedildi (chat_id: {chat_id}). 💬")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL konuşma kaydetme hatası: {e} 😞")
            self.conn.rollback()

    def get_previous_analysis(self, symbol):
        """Önceki analizi getir."""
        try:
            with self.conn.cursor() as cur:
                cur.execute("""
                    SELECT * FROM analyses WHERE symbol = %s ORDER BY timestamp DESC LIMIT 1
                """, (symbol,))
                result = cur.fetchone()
                if result:
                    columns = [desc[0] for desc in cur.description]
                    logger.info(f"{symbol} için önceki analiz bulundu. 📜")
                    return dict(zip(columns, result))
                logger.warning(f"{symbol} için önceki analiz bulunamadı. 😕")
                return None
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL analiz alma hatası: {e} 😞")
            return None

    def get_latest_analysis(self, symbol):
        """Son analizi getir."""
        try:
            with self.conn.cursor() as cur:
                cur.execute("""
                    SELECT analysis_text FROM analyses WHERE symbol = %s ORDER BY timestamp DESC LIMIT 1
                """, (symbol,))
                result = cur.fetchone()
                logger.info(f"{symbol} için son analiz alındı. 📜")
                return result[0] if result else None
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL son analiz alma hatası: {e} 😞")
            return None

    def get_conversation_history(self, chat_id, limit=100):
        """Konuşma geçmişini getir."""
        try:
            with self.conn.cursor() as cur:
                cur.execute("""
                    SELECT user_message, bot_response, timestamp, symbol 
                    FROM conversations 
                    WHERE chat_id = %s 
                    ORDER BY timestamp DESC 
                    LIMIT %s
                """, (chat_id, limit))
                results = cur.fetchall()
                logger.info(f"Konuşma geçmişi alındı (chat_id: {chat_id}). 💬")
                return [{'user_message': row[0], 'bot_response': row[1], 'timestamp': row[2], 'symbol': row[3]} for row in results]
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL konuşma geçmişi alma hatası: {e} 😞")
            return []

    def get_last_symbol(self, chat_id):
        """Son kullanılan sembolü getir."""
        try:
            with self.conn.cursor() as cur:
                cur.execute("""
                    SELECT symbol FROM conversations 
                    WHERE chat_id = %s AND symbol IS NOT NULL 
                    ORDER BY timestamp DESC 
                    LIMIT 1
                """, (chat_id,))
                result = cur.fetchone()
                logger.info(f"Son sembol alındı (chat_id: {chat_id}): {result[0] if result else None}")
                return result[0] if result else None
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL son sembol alma hatası: {e} 😞")
            return None

    def clean_old_data(self, days=7):
        """Eski verileri temizle."""
        try:
            with self.conn.cursor() as cur:
                cutoff = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
                cur.execute("DELETE FROM analyses WHERE timestamp < %s", (cutoff,))
                self.conn.commit()
                logger.info("Eski analiz verileri temizlendi. 🧹")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL veri temizleme hatası: {e} 😞")
            self.conn.rollback()

    def __del__(self):
        """Bağlantıyı kapat."""
        try:
            if self.conn and not self.conn.closed:
                self.conn.close()
                logger.info("PostgreSQL bağlantısı kapatıldı. 🛑")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL bağlantı kapatma hatası: {e} 😞")

def calculate_indicators(kline_data, order_book, btc_data, eth_data, symbol):
    indicators = {}
    
    def safe_ema(series, period):
        try:
            weights = np.exp(np.linspace(-1.0, 0.0, period))
            weights /= weights.sum()
            result = np.convolve(series, weights, mode='valid')
            result = np.pad(result, (period - 1, 0), mode='constant', constant_values=np.nan)
            return pd.Series(result, index=series.index)
        except Exception as e:
            logger.error(f"{symbol} için EMA hatası: {e} 😞")
            return pd.Series([0.0] * len(series), index=series.index)

    for interval in TIMEFRAMES:
        kline = kline_data.get(interval, {}).get('data', [])
        if not kline or len(kline) < 2:
            logger.warning(f"{symbol} için {interval} aralığında veri yok veya yetersiz 😕")
            indicators.update({
                f'ma_{interval}': {'ma50': 0.0},
                f'rsi_{interval}': 50.0,
                f'atr_{interval}': 0.0,
                f'macd_{interval}': {'macd': 0.0, 'signal': 0.0},
                f'bbands_{interval}': {'upper': 0.0, 'lower': 0.0},
                f'stoch_{interval}': {'k': 0.0, 'd': 0.0},
                f'obv_{interval}': 0.0,
                f'raw_data_{interval}': {'high': 0.0, 'low': 0.0, 'close': 0.0}
            })
            continue

        try:
            df = pd.DataFrame(kline, columns=['timestamp', 'open', 'close', 'high', 'low', 'volume', 'close_time', 'quote_volume'])
            logger.info(f"{symbol} için {interval} aralığında DataFrame: {df.head().to_dict()} 📊")
            
            df[['open', 'close', 'high', 'low', 'volume']] = df[['open', 'close', 'high', 'low', 'volume']].astype(float)
            df = df.dropna()
            if df.empty:
                logger.warning(f"{symbol} için {interval} aralığında geçerli veri yok 😕")
                indicators.update({
                    f'ma_{interval}': {'ma50': 0.0},
                    f'rsi_{interval}': 50.0,
                    f'atr_{interval}': 0.0,
                    f'macd_{interval}': {'macd': 0.0, 'signal': 0.0},
                    f'bbands_{interval}': {'upper': 0.0, 'lower': 0.0},
                    f'stoch_{interval}': {'k': 0.0, 'd': 0.0},
                    f'obv_{interval}': 0.0,
                    f'raw_data_{interval}': {'high': 0.0, 'low': 0.0, 'close': 0.0}
                })
                continue

            if (df['high'] < df['low']).any():
                logger.warning(f"{symbol} için {interval} aralığında hatalı veri: high < low 😞")
                df['high'], df['low'] = df[['high', 'low']].max(axis=1), df[['high', 'low']].min(axis=1)

            last_row = df.iloc[-1]
            indicators[f'raw_data_{interval}'] = {
                'high': float(last_row['high']) if pd.notnull(last_row['high']) else 0.0,
                'low': float(last_row['low']) if pd.notnull(last_row['low']) else 0.0,
                'close': float(last_row['close']) if pd.notnull(last_row['close']) else 0.0
            }

            try:
                if len(df) >= 50:
                    sma_50 = ta.sma(df['close'], length=50, fillna=0.0)
                    logger.info(f"{symbol} için {interval} aralığında MA50 hesaplandı: {sma_50.iloc[-1]} 📈")
                elif len(df) >= 30:
                    logger.warning(f"{symbol} için {interval} aralığında MA50 için yetersiz veri ({len(df)} < 50), MA30 hesaplanıyor ⚠️")
                    sma_50 = ta.sma(df['close'], length=30, fillna=0.0)
                    logger.info(f"{symbol} için {interval} aralığında MA30 hesaplandı: {sma_50.iloc[-1]} 📈")
                else:
                    logger.warning(f"{symbol} için {interval} aralığında MA50/MA30 için yetersiz veri ({len(df)} < 30) 😕")
                    sma_50 = pd.Series([0.0] * len(df))
                indicators[f'ma_{interval}'] = {
                    'ma50': float(sma_50.iloc[-1]) if not sma_50.empty and pd.notnull(sma_50.iloc[-1]) else 0.0
                }
            except Exception as e:
                logger.error(f"{symbol} için {interval} aralığında SMA hatası: {e} 😞")
                indicators[f'ma_{interval}'] = {'ma50': 0.0}

            try:
                rsi = ta.rsi(df['close'], length=14, fillna=50.0) if len(df) >= 14 else pd.Series([50.0] * len(df))
                logger.info(f"{symbol} için {interval} aralığında RSI hesaplandı: {rsi.iloc[-1]} 📊")
                indicators[f'rsi_{interval}'] = float(rsi.iloc[-1]) if not rsi.empty and pd.notnull(rsi.iloc[-1]) else 50.0
            except Exception as e:
                logger.error(f"{symbol} için {interval} aralığında RSI hatası: {e} 😞")
                indicators[f'rsi_{interval}'] = 50.0

            try:
                atr = ta.atr(df['high'], df['low'], df['close'], length=14, fillna=0.0) if len(df) >= 14 else pd.Series([0.0] * len(df))
                logger.info(f"{symbol} için {interval} aralığında ATR hesaplandı: {atr.iloc[-1]} ⚡")
                indicators[f'atr_{interval}'] = (float(atr.iloc[-1]) / float(df['close'].iloc[-1]) * 100) if not atr.empty and pd.notnull(atr.iloc[-1]) and df['close'].iloc[-1] != 0 else 0.0
            except Exception as e:
                logger.error(f"{symbol} için {interval} aralığında ATR hatası: {e} 😞")
                indicators[f'atr_{interval}'] = 0.0

            try:
                if len(df) >= 26:
                    ema_12 = safe_ema(df['close'], 12)
                    ema_26 = safe_ema(df['close'], 26)
                    macd_line = ema_12 - ema_26
                    signal_line = safe_ema(macd_line, 9) if not macd_line.isna().all() else pd.Series([0.0] * len(df))
                    indicators[f'macd_{interval}'] = {
                        'macd': float(macd_line.iloc[-1]) if pd.notnull(macd_line.iloc[-1]) else 0.0,
                        'signal': float(signal_line.iloc[-1]) if pd.notnull(signal_line.iloc[-1]) else 0.0
                    }
                    logger.info(f"{symbol} için {interval} aralığında MACD hesaplandı: macd={macd_line.iloc[-1]}, signal={signal_line.iloc[-1]} 📉")
                else:
                    logger.warning(f"{symbol} için {interval} aralığında MACD için yetersiz veri ({len(df)} < 26) 😕")
                    indicators[f'macd_{interval}'] = {'macd': 0.0, 'signal': 0.0}
            except Exception as e:
                logger.error(f"{symbol} için {interval} aralığında MACD hatası: {e} 😞")
                indicators[f'macd_{interval}'] = {'macd': 0.0, 'signal': 0.0}

            try:
                bbands = ta.bbands(df['close'], length=20, std=2, fillna=0.0) if len(df) >= 20 else None
                if bbands is not None:
                    logger.info(f"{symbol} için {interval} aralığında BBands hesaplandı: upper={bbands['BBU_20_2.0'].iloc[-1]}, lower={bbands['BBL_20_2.0'].iloc[-1]} 🎢")
                indicators[f'bbands_{interval}'] = {
                    'upper': float(bbands['BBU_20_2.0'].iloc[-1]) if bbands is not None and not bbands.empty and pd.notnull(bbands['BBU_20_2.0'].iloc[-1]) else 0.0,
                    'lower': float(bbands['BBL_20_2.0'].iloc[-1]) if bbands is not None and not bbands.empty and pd.notnull(bbands['BBL_20_2.0'].iloc[-1]) else 0.0
                }
            except Exception as e:
                logger.error(f"{symbol} için {interval} aralığında BBands hatası: {e} 😞")
                indicators[f'bbands_{interval}'] = {'upper': 0.0, 'lower': 0.0}

            try:
                stoch = ta.stoch(df['high'], df['low'], df['close'], k=14, d=3, smooth_k=3, fillna=0.0) if len(df) >= 14 else None
                if stoch is not None:
                    logger.info(f"{symbol} için {interval} aralığında Stoch hesaplandı: k={stoch['STOCHk_14_3_3'].iloc[-1]}, d={stoch['STOCHd_14_3_3'].iloc[-1]} 🚀")
                indicators[f'stoch_{interval}'] = {
                    'k': float(stoch['STOCHk_14_3_3'].iloc[-1]) if stoch is not None and not stoch.empty and pd.notnull(stoch['STOCHk_14_3_3'].iloc[-1]) else 0.0,
                    'd': float(stoch['STOCHd_14_3_3'].iloc[-1]) if stoch is not None and not stoch.empty and pd.notnull(stoch['STOCHd_14_3_3'].iloc[-1]) else 0.0
                }
            except Exception as e:
                logger.error(f"{symbol} için {interval} aralığında Stoch hatası: {e} 😞")
                indicators[f'stoch_{interval}'] = {'k': 0.0, 'd': 0.0}

            try:
                obv = ta.obv(df['close'], df['volume'], fillna=0.0) if len(df) >= 1 else pd.Series([0.0] * len(df))
                logger.info(f"{symbol} için {interval} aralığında OBV hesaplandı: {obv.iloc[-1]} 📦")
                indicators[f'obv_{interval}'] = float(obv.iloc[-1]) if not obv.empty and pd.notnull(obv.iloc[-1]) else 0.0
            except Exception as e:
                logger.error(f"{symbol} için {interval} aralığında OBV hatası: {e} 😞")
                indicators[f'obv_{interval}'] = 0.0

        except Exception as e:
            logger.error(f"{symbol} için {interval} aralığında göstergeler hesaplanırken hata: {e} 😞")
            indicators.update({
                f'ma_{interval}': {'ma50': 0.0},
                f'rsi_{interval}': 50.0,
                f'atr_{interval}': 0.0,
                f'macd_{interval}': {'macd': 0.0, 'signal': 0.0},
                f'bbands_{interval}': {'upper': 0.0, 'lower': 0.0},
                f'stoch_{interval}': {'k': 0.0, 'd': 0.0},
                f'obv_{interval}': 0.0,
                f'raw_data_{interval}': {'high': 0.0, 'low': 0.0, 'close': 0.0}
            })

    for interval in TIMEFRAMES:
        kline = kline_data.get(interval, {}).get('data', [])
        if kline and len(kline) >= 30:
            df = pd.DataFrame(kline, columns=['timestamp', 'open', 'close', 'high', 'low', 'volume', 'close_time', 'quote_volume'])
            df[['high', 'low']] = df[['high', 'low']].astype(float)
            df = df.dropna()
            if not df.empty:
                try:
                    high = df['high'].tail(30).max()
                    low = df['low'].tail(30).min()
                    if pd.notnull(high) and pd.notnull(low) and high >= low:
                        diff = high - low
                        indicators['fibonacci_levels'] = [
                            float(low + diff * 0.236),
                            float(low + diff * 0.382),
                            float(low + diff * 0.5),
                            float(low + diff * 0.618),
                            float(low + diff * 0.786)
                        ]
                        logger.info(f"{symbol} için {interval} aralığında Fibonacci seviyeleri hesaplandı: {indicators['fibonacci_levels']} 📏")
                    else:
                        indicators['fibonacci_levels'] = [0.0, 0.0, 0.0, 0.0, 0.0]
                except Exception as e:
                    logger.error(f"{symbol} için {interval} aralığında Fibonacci hatası: {e} 😞")
                    indicators['fibonacci_levels'] = [0.0, 0.0, 0.0, 0.0, 0.0]
                break
        else:
            logger.warning(f"{symbol} için Fibonacci için yetersiz veri ({len(kline)} < 30) 😕")
            indicators['fibonacci_levels'] = [0.0, 0.0, 0.0, 0.0, 0.0]

    if order_book.get('bids') and order_book.get('asks'):
        try:
            bid_volume = sum(float(bid[1]) for bid in order_book['bids'])
            ask_volume = sum(float(ask[1]) for ask in order_book['asks'])
            indicators['bid_ask_ratio'] = bid_volume / ask_volume if ask_volume > 0 else 0.0
            logger.info(f"{symbol} için sipariş defteri oranı hesaplandı: {indicators['bid_ask_ratio']} 📚")
        except Exception as e:
            logger.error(f"{symbol} için sipariş defteri oranı hatası: {e} 😞")
            indicators['bid_ask_ratio'] = 0.0
    else:
        indicators['bid_ask_ratio'] = 0.0
        logger.warning(f"{symbol} için sipariş defterinde bid veya ask verisi yok 😕")

    if btc_data.get('data') and len(btc_data['data']) > 1:
        try:
            btc_df = pd.DataFrame(btc_data['data'], columns=['timestamp', 'open', 'close', 'high', 'low', 'volume', 'close_time', 'quote_volume'])
            btc_df['close'] = btc_df['close'].astype(float)
            btc_df = btc_df.dropna()
            if kline_data.get('5m', {}).get('data') and len(kline_data['5m']['data']) > 1:
                coin_df = pd.DataFrame(kline_data['5m']['data'], columns=['timestamp', 'open', 'close', 'high', 'low', 'volume', 'close_time', 'quote_volume'])
                coin_df['close'] = coin_df['close'].astype(float)
                coin_df = coin_df.dropna()
                if len(coin_df) == len(btc_df):
                    correlation = coin_df['close'].corr(btc_df['close'])
                    indicators['btc_correlation'] = float(correlation) if not np.isnan(correlation) else 0.0
                    logger.info(f"{symbol} için BTC korelasyonu hesaplandı: {indicators['btc_correlation']} 🤝")
                else:
                    logger.warning(f"{symbol} için BTC korelasyonu: Veri uzunlukları uyuşmuyor ({len(coin_df)} vs {len(btc_df)}) 😕")
                    indicators['btc_correlation'] = 0.0
            else:
                indicators['btc_correlation'] = 0.0
        except Exception as e:
            logger.error(f"{symbol} için BTC korelasyon hatası: {e} 😞")
            indicators['btc_correlation'] = 0.0
    else:
        indicators['btc_correlation'] = 0.0

    if eth_data.get('data') and len(eth_data['data']) > 1:
        try:
            eth_df = pd.DataFrame(eth_data['data'], columns=['timestamp', 'open', 'close', 'high', 'low', 'volume', 'close_time', 'quote_volume'])
            eth_df['close'] = eth_df['close'].astype(float)
            eth_df = eth_df.dropna()
            if kline_data.get('5m', {}).get('data') and len(kline_data['5m']['data']) > 1:
                coin_df = pd.DataFrame(kline_data['5m']['data'], columns=['timestamp', 'open', 'close', 'high', 'low', 'volume', 'close_time', 'quote_volume'])
                coin_df['close'] = coin_df['close'].astype(float)
                coin_df = coin_df.dropna()
                if len(coin_df) == len(eth_df):
                    correlation = coin_df['close'].corr(eth_df['close'])
                    indicators['eth_correlation'] = float(correlation) if not np.isnan(correlation) else 0.0
                    logger.info(f"{symbol} için ETH korelasyonu hesaplandı: {indicators['eth_correlation']} 🤝")
                else:
                    logger.warning(f"{symbol} için ETH korelasyonu: Veri uzunlukları uyuşmuyor ({len(coin_df)} vs {len(eth_df)}) 😕")
                    indicators['eth_correlation'] = 0.0
            else:
                indicators['eth_correlation'] = 0.0
        except Exception as e:
            logger.error(f"{symbol} için ETH korelasyon hatası: {e} 😞")
            indicators['eth_correlation'] = 0.0
    else:
        indicators['eth_correlation'] = 0.0

    return indicators

class TelegramBot:
    def __init__(self):
        self.group_id = int(os.getenv('TELEGRAM_GROUP_ID', '-1002869335730'))
        self.storage = Storage()
        self.kucoin = KuCoinClient()
        self.deepseek = DeepSeekClient()
        bot_token = os.getenv('TELEGRAM_BOT_TOKEN')
        self.app = Application.builder().token(bot_token).build()
        self.app.add_handler(CommandHandler("start", self.start))
        self.app.add_handler(CallbackQueryHandler(self.button))
        self.app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.handle_text_message))
        self.active_analyses = {}
        self.shutdown_event = asyncio.Event()
        self.is_running = False
        self.analysis_lock = asyncio.Lock()

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        keyboard = [
            [InlineKeyboardButton("BTCUSDT", callback_data="analyze_BTCUSDT"), InlineKeyboardButton("ETHUSDT", callback_data="analyze_ETHUSDT")],
            *[[InlineKeyboardButton(coin, callback_data=f"analyze_{coin}")] for coin in COINS.keys() if coin not in ["BTCUSDT", "ETHUSDT"]]
        ]
        response = (
            "Kanka, hadi bakalım! Coin analizi mi yapalım, yoksa başka muhabbet mi çevirelim? 😎\n"
            "Örnek: 'ADA analiz', 'nasılsın', 'geçmiş', 'BTC korelasyonu'.\n"
        )
        await update.message.reply_text(response, reply_markup=InlineKeyboardMarkup(keyboard))
        self.storage.save_conversation(update.effective_chat.id, update.message.text, response)

    async def button(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        query = update.callback_query
        try:
            await query.answer()
        except Exception as e:
            logger.error(f"Error answering callback query: {e} 😞")
        symbol = query.data.replace("analyze_", "")
        analysis_key = f"{symbol}_futures_{update.effective_chat.id}"
        async with self.analysis_lock:
            if analysis_key in self.active_analyses:
                response = f"Kanka, {symbol} için analiz yapıyorum, az sabret! ⏳"
                await query.message.reply_text(response)
                self.storage.save_conversation(update.effective_chat.id, query.data, response, symbol)
                return
            self.active_analyses[analysis_key] = True
        try:
            if not await self.kucoin.validate_symbol(symbol):
                response = f"Kanka, {symbol} piyasada yok gibi. Başka coin mi bakalım? 🤔"
                await query.message.reply_text(response)
                self.storage.save_conversation(update.effective_chat.id, query.data, response, symbol)
                return
            response = f"{symbol} için analiz yapıyorum, hemen geliyor! 🚀"
            await query.message.reply_text(response)
            self.storage.save_conversation(update.effective_chat.id, query.data, response, symbol)
            task = self.process_coin(symbol, update.effective_chat.id)
            if task is not None:
                asyncio.create_task(task)
        finally:
            async with self.analysis_lock:
                del self.active_analyses[analysis_key]

    async def handle_text_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        text = update.message.text.lower()
        chat_id = update.effective_chat.id
        logger.info(f"Received message: {text} 📬")

        history = self.storage.get_conversation_history(chat_id, limit=100)
        context_info = f"Son konuşmalar: {history}"

        if "geçmiş" in text:
            history = self.storage.get_conversation_history(chat_id, limit=100)
            if not history:
                response = "Kanka, henüz muhabbet geçmişimiz yok. Hadi başlayalım! 😄"
            else:
                response = "Son muhabbetler:\n"
                for entry in history:
                    response += f"{entry['timestamp']}\nSen: {entry['user_message']}\nBen: {entry['bot_response']}\n"
                    if entry['symbol']:
                        response += f"Coin: {entry['symbol']}\n"
                    response += "\n"
            await update.message.reply_text(response)
            self.storage.save_conversation(chat_id, text, response)
            return

        symbol = None
        for coin, aliases in COINS.items():
            if any(alias in text for alias in aliases):
                symbol = coin
                break

        if not symbol:
            symbol = self.storage.get_last_symbol(chat_id)
            if symbol:
                logger.info(f"Using last symbol {symbol} from conversation history 📜")

        keywords = ['analiz', 'trend', 'long', 'short', 'destek', 'direnç', 'yorum', 'neden', 'korelasyon']
        matched_keyword = next((k for k in keywords if k in text), None)

        context_info += f"\nSon {symbol} analizi: {self.storage.get_latest_analysis(symbol) or 'Yok' if symbol else 'Yok'}"

        if matched_keyword == 'analiz' and symbol:
            analysis_key = f"{symbol}_futures_{chat_id}"
            async with self.analysis_lock:
                if analysis_key in self.active_analyses:
                    response = f"Kanka, {symbol} için analiz yapıyorum, az bekle! ⏳"
                    await update.message.reply_text(response)
                    self.storage.save_conversation(chat_id, text, response, symbol)
                    return
                self.active_analyses[analysis_key] = True
            try:
                if not await self.kucoin.validate_symbol(symbol):
                    response = f"Kanka, {symbol} piyasada yok gibi. Başka coin mi bakalım? 🤔"
                    await update.message.reply_text(response)
                    self.storage.save_conversation(chat_id, text, response, symbol)
                    return
                response = f"{symbol} için analiz yapıyorum, hemen geliyor! 🚀"
                await update.message.reply_text(response)
                self.storage.save_conversation(chat_id, text, response, symbol)
                task = self.process_coin(symbol, chat_id)
                if task is not None:
                    asyncio.create_task(task)
            finally:
                async with self.analysis_lock:
                    del self.active_analyses[analysis_key]
            return

        if matched_keyword == 'korelasyon' and symbol:
            current_analysis = self.storage.get_latest_analysis(symbol)
            response = await self.deepseek.generate_natural_response(text, context_info, symbol)
            if current_analysis:
                btc_corr = re.search(r'BTC Korelasyonu: (.*?)(?:\n|$)', current_analysis, re.DOTALL)
                eth_corr = re.search(r'ETH Korelasyonu: (.*?)(?:\n|$)', current_analysis, re.DOTALL)
                response += f"\nBTC Korelasyon: {btc_corr.group(1) if btc_corr else 'Bilinmiyor'} 🤝"
                response += f"\nETH Korelasyon: {eth_corr.group(1) if eth_corr else 'Bilinmiyor'} 🤝"
            else:
                response += f"\nKanka, {symbol} için analiz yok. Hemen yapayım mı? (örn: {symbol} analiz) 😄"
            await update.message.reply_text(response)
            self.storage.save_conversation(chat_id, text, response, symbol)
            return

        if symbol and matched_keyword:
            current_analysis = self.storage.get_latest_analysis(symbol)
            response = await self.deepseek.generate_natural_response(text, context_info, symbol)
            if current_analysis:
                if matched_keyword == 'trend':
                    long_trend = re.search(r'Trend: (.*?)(?:\n|$)', current_analysis, re.DOTALL)
                    response += f"\nTrend: {long_trend.group(1) if long_trend else 'Bilinmiyor'} 🚀📉"
                elif matched_keyword == 'long':
                    long_match = re.search(r'Long Pozisyon:(.*?)(?:Short|$)', current_analysis, re.DOTALL)
                    response += f"\nLong: {long_match.group(1).strip() if long_match else 'Bilinmiyor'} 📈"
                elif matched_keyword == 'short':
                    short_match = re.search(r'Short Pozisyon:(.*?)(?:Yorum|$)', current_analysis, re.DOTALL)
                    response += f"\nShort: {short_match.group(1).strip() if short_match else 'Bilinmiyor'} 📉"
                elif matched_keyword == 'destek':
                    support_match = re.search(r'Destek: (.*?)(?:\n|$)', current_analysis, re.DOTALL)
                    response += f"\nDestek: {support_match.group(1) if support_match else 'Bilinmiyor'} 🛡️"
                elif matched_keyword == 'direnç':
                    resistance_match = re.search(r'Direnç: (.*?)(?:\n|$)', current_analysis, re.DOTALL)
                    response += f"\nDirenç: {resistance_match.group(1) if resistance_match else 'Bilinmiyor'} 🏰"
                elif matched_keyword in ['yorum', 'neden']:
                    comment_match = re.search(r'Yorum:(.*)', current_analysis, re.DOTALL)
                    response += f"\nYorum: {comment_match.group(1).strip() if comment_match else 'Bilinmiyor'} 💬"
            else:
                response += f"\nKanka, {symbol} için analiz yok. Hemen yapayım mı? (örn: {symbol} analiz) 😄"
            await update.message.reply_text(response)
            self.storage.save_conversation(chat_id, text, response, symbol)
            return

        response = await self.deepseek.generate_natural_response(text, context_info, symbol)
        await update.message.reply_text(response)
        self.storage.save_conversation(chat_id, text, response, symbol)

    async def split_and_send_message(self, chat_id, message, symbol):
        """Mesajı 4096 karakter sınırına göre böl ve sırayla gönder."""
        max_length = 4096
        if len(message) <= max_length:
            await self.app.bot.send_message(chat_id=chat_id, text=message)
            self.storage.save_conversation(chat_id, symbol, message, symbol)
            return

        # Mesajı mantıklı bölümlere ayır
        sections = []
        current_section = ""
        lines = message.split('\n')
        for line in lines:
            if len(current_section) + len(line) + 1 > max_length:
                sections.append(current_section.strip())
                current_section = line + '\n'
            else:
                current_section += line + '\n'
        if current_section:
            sections.append(current_section.strip())

        # Bölümleri sırayla gönder
        for i, section in enumerate(sections, 1):
            part_message = f"{symbol} Analiz - Bölüm {i}/{len(sections)} ⏰\n{section}"
            await self.app.bot.send_message(chat_id=chat_id, text=part_message)
            self.storage.save_conversation(chat_id, symbol, part_message, symbol)
            await asyncio.sleep(0.5)  # Telegram rate limit için kısa bekleme

    async def process_coin(self, symbol, chat_id):
        try:
            data = await self.fetch_market_data(symbol)
            if not data or not any(data.get('klines', {}).get(interval, {}).get('data') for interval in TIMEFRAMES):
                response = f"Kanka, {symbol} için veri bulamadım. Başka coin mi bakalım? 🤔"
                await self.app.bot.send_message(chat_id=chat_id, text=response)
                self.storage.save_conversation(chat_id, symbol, response, symbol)
                return
            data['indicators'] = calculate_indicators(data['klines'], data['order_book'], data['btc_data'], data['eth_data'], symbol)
            data['deepseek_analysis'] = await self.deepseek.analyze_coin(symbol, data)
            message = data['deepseek_analysis']['analysis_text']
            await self.split_and_send_message(chat_id, message, symbol)
            self.storage.save_analysis(symbol, data)
            return data
        except Exception as e:
            logger.error(f"Error processing coin {symbol}: {e} 😞")
            response = f"Kanka, {symbol} analizi yaparken bi’ şeyler ters gitti. Tekrar deneyelim mi? 😅"
            await self.app.bot.send_message(chat_id=chat_id, text=response)
            self.storage.save_conversation(chat_id, symbol, response, symbol)
            return
        finally:
            data = None
            import gc
            gc.collect()

    async def fetch_market_data(self, symbol):
        await self.kucoin.initialize()
        try:
            klines = {}
            for interval in TIMEFRAMES:
                klines[interval] = await self.kucoin.fetch_kline_data(symbol, interval)
                await asyncio.sleep(0.5)

            order_book = await self.kucoin.fetch_order_book(symbol)
            ticker = await self.kucoin.fetch_ticker(symbol)
            ticker_24hr = await self.kucoin.fetch_24hr_ticker(symbol)
            btc_data = await self.kucoin.fetch_kline_data('BTCUSDT', '5m')
            eth_data = await self.kucoin.fetch_kline_data('ETHUSDT', '5m')

            return {
                'klines': klines,
                'order_book': order_book,
                'price': float(ticker.get('price', 0.0)),
                'funding_rate': 0.0,
                'price_change_24hr': float(ticker_24hr.get('priceChangePercent', 0.0)),
                'btc_data': btc_data,
                'eth_data': eth_data
            }
        except Exception as e:
            logger.error(f"Error fetching market data for {symbol}: {e} 😞")
            return None
        finally:
            await self.kucoin.close()

    async def run(self):
        try:
            logger.info("Starting application... 🚀")
            self.is_running = True
            await self.kucoin.initialize()
            await self.app.initialize()
            await self.app.start()
            webhook_url = f"https://{os.getenv('HEROKU_APP_NAME')}.herokuapp.com/webhook"
            current_webhook = await self.app.bot.get_webhook_info()
            if current_webhook.url != webhook_url:
                logger.info(f"Setting new webhook: {webhook_url}")
                await self.app.bot.set_webhook(url=webhook_url)
            else:
                logger.info("Webhook already set, skipping... ✅")
            web_app = web.Application()
            web_app.router.add_post('/webhook', self.webhook_handler)
            runner = web.AppRunner(web_app)
            await runner.setup()
            site = web.TCPSite(runner, '0.0.0.0', int(os.getenv('PORT', 8443)))
            await site.start()
            logger.info("Application started successfully 🎉")
            await self.shutdown_event.wait()
        except Exception as e:
            logger.error(f"Error starting application: {e} 😞")
        finally:
            logger.info("Shutting down application... 🛑")
            await self.kucoin.close()
            if self.is_running:
                try:
                    await self.app.stop()
                    await self.app.shutdown()
                    logger.info("Webhook preserved to avoid re-setting ✅")
                except Exception as e:
                    logger.error(f"Error during shutdown: {e} 😞")
                self.is_running = False
            logger.info("Application shut down 🏁")

    async def webhook_handler(self, request):
        try:
            raw_data = await request.json()
            update = Update.de_json(raw_data, self.app.bot)
            if update:
                await self.app.process_update(update)
            return web.Response(text="OK")
        except Exception as e:
            logger.error(f"Error handling webhook: {e} 😞")
            return web.Response(text="Error", status=500)

def main():
    bot = TelegramBot()

    def handle_sigterm(*args):
        logger.info("Received SIGTERM, shutting down... 🛑")
        bot.shutdown_event.set()

    signal.signal(signal.SIGTERM, handle_sigterm)
    asyncio.run(bot.run())

if __name__ == "__main__":
    main()
