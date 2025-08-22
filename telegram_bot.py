import os
import pandas as pd
import pandas_ta as ta
import logging
import asyncio
import aiohttp
import signal
import random
import gc
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes, MessageHandler, filters
from openai import AsyncOpenAI, RateLimitError
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
TIMEFRAMES = ['5m', '15m', '1h', '4h']

# Yetkili kullanıcı
AUTHORIZED_USER_ID = 1616739367

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
        df.loc[df['high'] < df['low'], ['high', 'low']] = df.loc[df['high'] < df['low'], ['low', 'high']].values
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
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60))  # 60 saniye timeout
            logger.info("KuCoin session başlatıldı. 🚀")

    async def fetch_kline_data(self, symbol, interval, count=50):
        await self.initialize()
        try:
            kucoin_intervals = {'5m': '5min', '15m': '15min', '1h': '1hour', '4h': '4hour'}
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
            gc.collect()

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
            gc.collect()

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
            gc.collect()

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
            gc.collect()

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
            gc.collect()

    async def close(self):
        if self.session and not self.session.closed:
            await self.session.close()
            self.session = None
            logger.info("KuCoin session kapatıldı. 🛑")
            gc.collect()

class GrokClient:
    """Grok 4 API ile analiz yapar ve doğal dil işleme sağlar. 🧠✨"""
    def __init__(self, kucoin_client):
        self.client = AsyncOpenAI(
            api_key=os.getenv('GROK_API_KEY'),
            base_url="https://api.x.ai/v1",
            timeout=60  # 60 saniye timeout
        )
        self.model = "grok-4-0709"
        self.kucoin = kucoin_client

    async def generate_natural_response(self, user_message, context_info, symbol=None, target_user=None, target_user_messages=None):
        logger.info(f"Generating natural response for message: {user_message}, target_user: {target_user}")
        prompt = (
            f"Türkçe, ultra samimi ve esprili bir şekilde yanıt ver. Kullanıcıya 'kanka' diye hitap et, hafif argo kullan ama abartma. 😎 "
            f"KALIN YAZI İÇİN ** KULLANMA, bunun yerine düz metin veya emoji kullan. 🚫 "
            f"Mesajına uygun, akıcı ve doğal bir muhabbet kur. Eğer sembol ({symbol}) varsa, bağlama uygun şekilde atıfta bulun. 🤝 "
            f"Eğer hedef kullanıcı ({target_user}) belirtilmişse, onun mesajlarına ({target_user_messages}) dayalı bir cevap ver. 🎯 "
            f"Konuşma geçmişini ve son analizi dikkate al. Veritabanındaki tüm konuşmaları ve grup mesajlarını gözden geçirerek orijinal bir cevap üret. 🗄️ "
            f"Emoji kullan, özgürce yaz! 🎉 Yanıt maks 1500 karakter olsun. Karakter sayısını yazma. 🚫\n\n"
            f"Kullanıcı mesajı: {user_message}\n"
            f"Bağlam: {context_info}\n"
            f"Hedef kullanıcı: {target_user or 'Yok'}\n"
            f"Hedef kullanıcının mesajları: {target_user_messages or 'Yok'}\n"
        )
        max_retries = 5
        for attempt in range(max_retries):
            try:
                logger.info(f"Attempt {attempt + 1}/{max_retries} for natural response, prompt length: {len(prompt)}")
                response = await self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": "Sen kanka gibi konuşan, samimi bir trading botusun. Türkçe, esprili ve doğal cevaplar ver. Veritabanındaki konuşma geçmişini ve grup mesajlarını dikkate al. Yanıt sonunda karakter sayısını yazma."},
                        {"role": "user", "content": prompt}
                    ],
                    max_tokens=1000,
                    stream=False
                )
                response_text = response.choices[0].message.content
                logger.info(f"Grok response for {user_message}: {response_text[:200]}...")
                return response_text
            except RateLimitError as e:
                if attempt == max_retries - 1:
                    logger.error(f"Grok 4 natural response error after {max_retries} retries: {e} 😞")
                    return "Kanka, API limitine takıldık. Bi’ süre sonra tekrar deneyelim mi? 😅"
                wait_time = (2 ** attempt) + random.uniform(0, 0.2)
                logger.info(f"Rate limit hit, retrying in {wait_time:.2f} seconds")
                await asyncio.sleep(wait_time)
            except aiohttp.ClientConnectionError as e:
                if attempt == max_retries - 1:
                    logger.error(f"Grok 4 connection error: {e} 😞")
                    return "Kanka, bağlantı koptu. Bi’ süre sonra tekrar deneyelim mi? 😅"
                wait_time = (2 ** attempt) + random.uniform(0, 0.2)
                logger.info(f"Connection error, retrying in {wait_time:.2f} seconds")
                await asyncio.sleep(wait_time)
            except asyncio.TimeoutError as e:
                if attempt == max_retries - 1:
                    logger.error(f"Grok 4 natural response timeout after {max_retries} retries: {e} 😞")
                    return "Kanka, API zaman aşımına uğradı. Bi’ süre sonra tekrar deneyelim mi? 😅"
                wait_time = (2 ** attempt) + random.uniform(0, 0.2)
                logger.info(f"Timeout error, retrying in {wait_time:.2f} seconds")
                await asyncio.sleep(wait_time)
            except Exception as e:
                logger.error(f"Grok 4 natural response error: {e} 😞")
                return "Kanka, neyi kastediyosun, bi’ açar mısın? Hadi, muhabbet edelim! 😄"
            finally:
                gc.collect()

    async def fetch_market_data(self, symbol):
        await self.kucoin.initialize()
        try:
            klines = {}
            for interval in TIMEFRAMES:
                klines[interval] = await self.kucoin.fetch_kline_data(symbol, interval)
                await asyncio.sleep(0.1)
            order_book = await self.kucoin.fetch_order_book(symbol)
            ticker = await self.kucoin.fetch_ticker(symbol)
            ticker_24hr = await self.kucoin.fetch_24hr_ticker(symbol)
            return {
                'klines': klines,
                'order_book': order_book,
                'price': float(ticker.get('price', 0.0)),
                'funding_rate': 0.0,
                'price_change_24hr': float(ticker_24hr.get('priceChangePercent', 0.0))
            }
        except Exception as e:
            logger.error(f"Error fetching market data for {symbol}: {e} 😞")
            return None
        finally:
            await self.kucoin.close()

    async def analyze_coin(self, symbol, chat_id):
        logger.info(f"Analyzing coin {symbol} for chat_id: {chat_id}")
        max_retries = 5
        for attempt in range(max_retries):
            try:
                market_data = await self.fetch_market_data(symbol)
                if not market_data:
                    return f"Kanka, {symbol} için veri çekemedim. Başka bi’ coin mi bakalım? 😕"

                prompt = self._create_analysis_prompt(market_data, symbol)
                logger.info(f"Attempt {attempt + 1}/{max_retries} for {symbol} analysis, prompt length: {len(prompt)}")
                response = await self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": "Sen bir kripto analiz botusun. Teknik analiz yap, samimi ve esprili bir dille Türkçe cevap ver. Grafik verilerini kullanıcıya anlat, trendleri belirt, alım-satım önerisi verme ama olasılıkları tartış. Analiz sonunda karakter sayısını yazma."},
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.7,
                    max_tokens=2000,
                    stream=False
                )
                response_text = response.choices[0].message.content
                logger.info(f"Grok analysis for {symbol}: {response_text[:200]}...")
                return response_text
            except RateLimitError as e:
                if attempt == max_retries - 1:
                    logger.error(f"Grok 4 coin analysis error after {max_retries} retries: {e} 😞")
                    return f"Kanka, {symbol} analizi yaparken API limitine takıldık. Bi’ süre sonra tekrar deneyelim mi? 😅"
                wait_time = (2 ** attempt) + random.uniform(0, 0.2)
                logger.info(f"Rate limit hit, retrying in {wait_time:.2f} seconds")
                await asyncio.sleep(wait_time)
            except aiohttp.ClientConnectionError as e:
                if attempt == max_retries - 1:
                    logger.error(f"Grok 4 connection error: {e} 😞")
                    return f"Kanka, {symbol} analizi yaparken bağlantı koptu. Bi’ süre sonra tekrar deneyelim mi? 😅"
                wait_time = (2 ** attempt) + random.uniform(0, 0.2)
                logger.info(f"Connection error, retrying in {wait_time:.2f} seconds")
                await asyncio.sleep(wait_time)
            except asyncio.TimeoutError as e:
                if attempt == max_retries - 1:
                    logger.error(f"Grok 4 coin analysis timeout after {max_retries} retries: {e} 😞")
                    return f"Kanka, {symbol} analizi yaparken API zaman aşımına uğradı. Tekrar deneyelim mi? 😅"
                wait_time = (2 ** attempt) + random.uniform(0, 0.2)
                logger.info(f"Timeout error, retrying in {wait_time:.2f} seconds")
                await asyncio.sleep(wait_time)
            except Exception as e:
                logger.error(f"Grok 4 coin analysis error: {e} 😞")
                return f"Kanka, {symbol} analizi yaparken bi’ şeyler ters gitti. Tekrar deneyelim mi? 😅"
            finally:
                gc.collect()

    def _create_analysis_prompt(self, market_data, symbol):
        indicators = calculate_indicators(market_data['klines'], market_data['order_book'], symbol)
        fib_levels = indicators.get('fibonacci_levels', [0.0, 0.0, 0.0, 0.0, 0.0])
        
        indicators_formatted = []
        for interval in TIMEFRAMES:
            ma50 = indicators.get(f'ma_{interval}', {}).get('ma50', 0.0)
            rsi = indicators.get(f'rsi_{interval}', 50.0)
            atr = indicators.get(f'atr_{interval}', 0.0)
            macd = indicators.get(f'macd_{interval}', {}).get('macd', 0.0)
            signal = indicators.get(f'macd_{interval}', {}).get('signal', 0.0)
            bb_upper = indicators.get(f'bbands_{interval}', {}).get('upper', 0.0)
            bb_lower = indicators.get(f'bbands_{interval}', {}).get('lower', 0.0)
            stoch_k = indicators.get(f'stoch_{interval}', {}).get('k', 0.0)
            stoch_d = indicators.get(f'stoch_{interval}', {}).get('d', 0.0)
            obv = indicators.get(f'obv_{interval}', 0.0)
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
        for interval in TIMEFRAMES:
            raw_data = indicators.get(f'raw_data_{interval}', {'high': 0.0, 'low': 0.0, 'close': 0.0})
            raw_data_formatted.append(f"{interval}: High=${raw_data['high']:.2f}, Low=${raw_data['low']:.2f}, Close=${raw_data['close']:.2f}")

        trend_summary = []
        for interval in TIMEFRAMES:
            rsi = indicators.get(f'rsi_{interval}', 50.0)
            macd = indicators.get(f'macd_{interval}', {}).get('macd', 0.0)
            signal = indicators.get(f'macd_{interval}', {}).get('signal', 0.0)
            trend = "Nötr"
            if rsi > 60 and macd > signal:
                trend = "Yükseliş"
            elif rsi < 40 and macd < signal:
                trend = "Düşüş"
            trend_summary.append(f"{interval}: {trend}")

        prompt = (
            f"{symbol} için vadeli işlem analizi yap (spot piyasa verilerine dayalı). Yanıt tamamen Türkçe, detaylı ama kısa (maks 3000 karakter) olmalı. 😎 "
            f"KALIN YAZI İÇİN ** KULLANMA, bunun yerine düz metin veya emoji kullan. 🚫 "
            f"Sadece tek bir long ve short pozisyon önerisi sun (giriş fiyatı, take-profit, stop-loss, kaldıraç, risk/ödül oranı ve trend tahmini). "
            f"Değerler tamamen senin analizine dayansın, kodda hesaplama yapılmasın. 🧠 "
            f"Toplu değerlendirme (yorum) detaylı, emoji dolu ve samimi olsun, ama özlü yaz (maks 1500 karakter). 🎉 "
            f"ATR > %5 ise yatırımdan uzak dur uyarısı ekle, ancak teorik pozisyon parametrelerini sağla. ⚠️ "
            f"Spot verilerini vadeli işlem için uyarla. Doğal, profesyonel ama samimi bir üslup kullan. 😄 "
            f"Giriş, take-profit ve stop-loss’u nasıl belirlediğini, hangi göstergelere (MA50, RSI, MACD, Bollinger, Stochastic, OBV) dayandığını kısaca açıkla. "
            f"Eğer veri eksikse (örn. MACD veya Fibonacci), mevcut verilere dayanarak kısa vadeli trend tahmini yap. 📉 "
            f"Tüm veriler KuCoin’den alındı. Uzun vadeli veri eksikse, kısa vadeli verilere odaklan ve belirt. 📊\n\n"
            f"### Çoklu Zaman Dilimi Trendi\n"
            f"{', '.join(trend_summary)}\n\n"
            f"### Destek ve Direnç Hesaplama\n"
            f"Destek ve direnç seviyelerini pivot nokta yöntemiyle hesapla:\n"
            f"- Pivot = (High + Low + Close) / 3\n"
            f"- Range = High - Low\n"
            f"- Destek Seviyeleri: [Pivot - Range * 0.5, Pivot - Range * 0.618, Pivot - Range]\n"
            f"- Direnç Seviyeleri: [Pivot + Range * 0.5, Pivot + Range * 0.618, Pivot + Range]\n"
            f"Stop-loss için son kapanış fiyatından ATR’nin %50’sini düşerek veya en yakın destek seviyesini kullan. 🛑 "
            f"Seviyeleri analizde kullan ve karşılaştırma yap. Eğer ham veriler eksikse, durumu yorumda belirt. 🔍\n\n"
            f"### Ham Veriler\n"
            f"{', '.join(raw_data_formatted)}\n\n"
            f"### Diğer Veriler\n"
            f"- Mevcut Fiyat: {market_data['price']:.2f} USDT 💰\n"
            f"- 24 Saatlik Değişim: {market_data.get('price_change_24hr', 0.0):.2f}% 📈\n"
            f"- Göstergeler:\n"
            f"{''.join(indicators_formatted)}\n"
            f"- Fibonacci Seviyeleri: {', '.join([f'${x:.2f}' for x in fib_levels])} 📏\n"
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
            f"Volatilite: {indicators.get('atr_1h', 0.0):.2f}% ({'Yüksek, uzak dur! 😱' if indicators.get('atr_1h', 0.0) > 5 else 'Normal 😎'}) ⚡\n"
            f"Yorum: [Kısa, öz ama detaylı açıkla, hangi göstergelere dayandığını, giriş/take-profit/stop-loss seçim gerekçesini, yüksek volatilite varsa neden yatırımdan uzak durulmalı belirt, emoji kullan, samimi ol! 🎉 Maks 1500 karakter. Karakter sayısını yazma. 🚫]\n"
        )
        return prompt

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
        """PostgreSQL tablolarını oluştur. Yeni group_messages tablosu eklendi."""
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
                # Yeni tablo: Grup mesajlarını kaydetmek için
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS group_messages (
                        id SERIAL PRIMARY KEY,
                        chat_id BIGINT,
                        user_id BIGINT,
                        username TEXT,
                        message TEXT,
                        timestamp TEXT
                    )
                """)
                self.conn.commit()
                logger.info("PostgreSQL tabloları oluşturuldu. ✅")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL tablo oluşturma hatası: {e} 😞")
            self.conn.rollback()
        finally:
            gc.collect()

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
                    data['grok_analysis']
                ))
                self.conn.commit()
                logger.info(f"{symbol} için analiz kaydedildi. 💾")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL analiz kaydetme hatası: {e} 😞")
            self.conn.rollback()
        finally:
            gc.collect()

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
                self.conn.commit()
                logger.info(f"Konuşma kaydedildi (chat_id: {chat_id}). 💬")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL konuşma kaydetme hatası: {e} 😞")
            self.conn.rollback()
        finally:
            gc.collect()

    def save_group_message(self, chat_id, user_id, username, message):
        """Grup mesajlarını PostgreSQL’e kaydet."""
        try:
            with self.conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO group_messages (chat_id, user_id, username, message, timestamp)
                    VALUES (%s, %s, %s, %s, %s)
                """, (
                    chat_id,
                    user_id,
                    username or 'Bilinmeyen',
                    message,
                    datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                ))
                self.conn.commit()
                logger.info(f"Grup mesajı kaydedildi (chat_id: {chat_id}, user_id: {user_id}). 💬")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL grup mesajı kaydetme hatası: {e} 😞")
            self.conn.rollback()
        finally:
            gc.collect()

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
        finally:
            gc.collect()

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
        finally:
            gc.collect()

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
        finally:
            gc.collect()

    def get_group_messages(self, chat_id, username=None, limit=100):
        """Grup mesajlarını getir, isteğe bağlı olarak kullanıcı adına göre filtrele."""
        try:
            with self.conn.cursor() as cur:
                if username:
                    cur.execute("""
                        SELECT user_id, username, message, timestamp 
                        FROM group_messages 
                        WHERE chat_id = %s AND username = %s 
                        ORDER BY timestamp DESC 
                        LIMIT %s
                    """, (chat_id, username, limit))
                else:
                    cur.execute("""
                        SELECT user_id, username, message, timestamp 
                        FROM group_messages 
                        WHERE chat_id = %s 
                        ORDER BY timestamp DESC 
                        LIMIT %s
                    """, (chat_id, limit))
                results = cur.fetchall()
                logger.info(f"Grup mesajları alındı (chat_id: {chat_id}, username: {username or 'Tümü'}). 💬")
                return [{'user_id': row[0], 'username': row[1], 'message': row[2], 'timestamp': row[3]} for row in results]
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL grup mesajları alma hatası: {e} 😞")
            return []
        finally:
            gc.collect()

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
        finally:
            gc.collect()

    async def clear_7days(self, chat_id):
        """7 günden eski verileri sil."""
        if chat_id != AUTHORIZED_USER_ID:
            return "Kanka, bu komutu sadece patron kullanabilir! 😎"
        try:
            with self.conn.cursor() as cur:
                cutoff = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d %H:%M:%S')
                cur.execute("DELETE FROM analyses WHERE timestamp < %s", (cutoff,))
                cur.execute("DELETE FROM conversations WHERE timestamp < %s", (cutoff,))
                cur.execute("DELETE FROM group_messages WHERE timestamp < %s", (cutoff,))
                self.conn.commit()
                logger.info("7 günden eski veriler temizlendi. 🧹")
                return "Kanka, 7 günden eski veriler silindi, yer açtık! 🚀"
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL 7 günlük veri temizleme hatası: {e} 😞")
            self.conn.rollback()
            return "Kanka, bi’ şeyler ters gitti, veriler silinemedi. 😅 Tekrar deneyelim mi?"
        finally:
            gc.collect()

    async def clear_3days(self, chat_id):
        """3 günden eski verileri sil."""
        if chat_id != AUTHORIZED_USER_ID:
            return "Kanka, bu komutu sadece patron kullanabilir! 😎"
        try:
            with self.conn.cursor() as cur:
                cutoff = (datetime.now() - timedelta(days=3)).strftime('%Y-%m-%d %H:%M:%S')
                cur.execute("DELETE FROM analyses WHERE timestamp < %s", (cutoff,))
                cur.execute("DELETE FROM conversations WHERE timestamp < %s", (cutoff,))
                cur.execute("DELETE FROM group_messages WHERE timestamp < %s", (cutoff,))
                self.conn.commit()
                logger.info("3 günden eski veriler temizlendi. 🧹")
                return "Kanka, 3 günden eski veriler silindi, tertemiz oldu! 🚀"
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL 3 günlük veri temizleme hatası: {e} 😞")
            self.conn.rollback()
            return "Kanka, bi’ şeyler ters gitti, veriler silinemedi. 😅 Tekrar deneyelim mi?"
        finally:
            gc.collect()

    async def clear_all(self, chat_id):
        """Tüm veritabanını sıfırla."""
        if chat_id != AUTHORIZED_USER_ID:
            return "Kanka, bu komutu sadece patron kullanabilir! 😎"
        try:
            with self.conn.cursor() as cur:
                cur.execute("DELETE FROM analyses")
                cur.execute("DELETE FROM conversations")
                cur.execute("DELETE FROM group_messages")
                self.conn.commit()
                logger.info("Tüm veritabanı sıfırlandı. 🧹")
                return "Kanka, veritabanı komple sıfırlandı, sıfırdan başlıyoruz! 🚀"
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL tüm veri sıfırlama hatası: {e} 😞")
            self.conn.rollback()
            return "Kanka, bi’ şeyler ters gitti, veritabanı sıfırlanamadı. 😅 Tekrar deneyelim mi?"
        finally:
            gc.collect()

    def __del__(self):
        """Bağlantıyı kapat."""
        try:
            if self.conn and not self.conn.closed:
                self.conn.close()
                logger.info("PostgreSQL bağlantısı kapatıldı. 🛑")
        except psycopg2.Error as e:
            logger.error(f"PostgreSQL bağlantı kapatma hatası: {e} 😞")
        finally:
            gc.collect()

def calculate_indicators(kline_data, order_book, symbol):
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
                elif len(df) >= 20:
                    logger.warning(f"{symbol} için {interval} aralığında MA50 için yetersiz veri ({len(df)} < 50), MA20 hesaplanıyor ⚠️")
                    sma_50 = ta.sma(df['close'], length=20, fillna=0.0)
                else:
                    logger.warning(f"{symbol} için {interval} aralığında MA50/MA20 için yetersiz veri ({len(df)} < 20) 😕")
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

    kline_4h = kline_data.get('4h', {}).get('data', [])
    if kline_4h and len(kline_4h) >= 10:
        df = pd.DataFrame(kline_4h, columns=['timestamp', 'open', 'close', 'high', 'low', 'volume', 'close_time', 'quote_volume'])
        df[['high', 'low']] = df[['high', 'low']].astype(float)
        df = df.dropna()
        if not df.empty:
            try:
                high = df['high'].tail(10).max()
                low = df['low'].tail(10).min()
                if pd.notnull(high) and pd.notnull(low) and high >= low:
                    diff = high - low
                    indicators['fibonacci_levels'] = [
                        float(low + diff * 0.236),
                        float(low + diff * 0.382),
                        float(low + diff * 0.5),
                        float(low + diff * 0.618),
                        float(low + diff * 0.786)
                    ]
                    logger.info(f"{symbol} için 4h aralığında Fibonacci seviyeleri hesaplandı: {indicators['fibonacci_levels']} 📏")
                else:
                    indicators['fibonacci_levels'] = [0.0, 0.0, 0.0, 0.0, 0.0]
            except Exception as e:
                logger.error(f"{symbol} için 4h aralığında Fibonacci hatası: {e} 😞")
                indicators['fibonacci_levels'] = [0.0, 0.0, 0.0, 0.0, 0.0]
    else:
        logger.warning(f"{symbol} için Fibonacci için yetersiz veri (4h, {len(kline_4h)} < 10) 😕")
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

    return indicators

class TelegramBot:
    def __init__(self):
        self.group_id = int(os.getenv('GROUP_ID', '-1002869335730'))
        self.storage = Storage()
        self.kucoin = KuCoinClient()
        self.grok = GrokClient(self.kucoin)
        bot_token = os.getenv('TELEGRAM_TOKEN')
        self.app = Application.builder().token(bot_token).build()
        self.app.add_handler(CommandHandler("start", self.start))
        self.app.add_handler(CommandHandler("clear_7days", self.clear_7days))
        self.app.add_handler(CommandHandler("clear_3days", self.clear_3days))
        self.app.add_handler(CommandHandler("clear_all", self.clear_all))
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
            "Örnek: 'ADA analiz', 'nasılsın', 'geçmiş', 'falanca ne dedi?', 'ona ne cevap verirdin?'.\n"
            "Veritabanı temizleme için: /clear_7days, /clear_3days, /clear_all (sadece sen kullanabilirsin!).\n"
        )
        await update.message.reply_text(response, reply_markup=InlineKeyboardMarkup(keyboard))
        self.storage.save_conversation(update.effective_chat.id, update.message.text, response)

    async def clear_7days(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        response = await self.storage.clear_7days(update.effective_chat.id)
        await update.message.reply_text(response)
        self.storage.save_conversation(update.effective_chat.id, update.message.text, response)

    async def clear_3days(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        response = await self.storage.clear_3days(update.effective_chat.id)
        await update.message.reply_text(response)
        self.storage.save_conversation(update.effective_chat.id, update.message.text, response)

    async def clear_all(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        response = await self.storage.clear_all(update.effective_chat.id)
        await update.message.reply_text(response)
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
                if analysis_key in self.active_analyses:
                    del self.active_analyses[analysis_key]
            gc.collect()

    async def handle_text_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        # Grup mesajlarını kaydet
        chat_id = update.effective_chat.id
        user_id = update.effective_user.id
        username = update.effective_user.username or update.effective_user.first_name
        text = update.message.text.lower()
        logger.info(f"Received message: {text} from user_id: {user_id}, username: {username} 📬")

        # Grup mesajını kaydet (her kullanıcı için)
        if chat_id == self.group_id:
            self.storage.save_group_message(chat_id, user_id, username, update.message.text)

        # Sadece yetkili kullanıcıya (sana) cevap ver
        if user_id != AUTHORIZED_USER_ID:
            logger.info(f"Message from non-authorized user (user_id: {user_id}), ignoring response.")
            return

        history = self.storage.get_conversation_history(chat_id, limit=100)
        group_messages = self.storage.get_group_messages(chat_id, limit=100)
        context_info = f"Son konuşmalar: {history}\nGrup mesajları: {group_messages}"

        # "Hatırlat" veya geçmişle ilgili sorular
        if "hatırlat" in text or "geçmiş" in text:
            if "geçmiş" in text:
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
            else:
                response = await self.grok.generate_natural_response(text, context_info)
                await update.message.reply_text(response)
                self.storage.save_conversation(chat_id, text, response)
                return

        # "Falanca kişi ne dedi?" veya "Ona ne cevap verirsin?" tarzı sorular
        target_user = None
        if "ne diyor" in text or "ne cevap verirsin" in text or "ne dedi" in text:
            # Kullanıcı adını metinden çıkar
            match = re.search(r'(?:@(\w+)|(\w+))\s*(?:ne diyor|ne dedi|ona ne cevap|ona ne dersin)', text, re.IGNORECASE)
            if match:
                target_user = match.group(1) or match.group(2)
                target_user_messages = self.storage.get_group_messages(chat_id, username=target_user, limit=10)
                if not target_user_messages:
                    response = f"Kanka, @{target_user} grupta bi’ şey dememiş gibi, ya da ben kaçırmışım. 😅 Başka ne bakalım?"
                    await update.message.reply_text(response)
                    self.storage.save_conversation(chat_id, text, response)
                    return
                target_user_messages_str = "\n".join([f"{msg['timestamp']}: {msg['message']}" for msg in target_user_messages])
                response = await self.grok.generate_natural_response(
                    text, context_info, symbol=None, target_user=target_user, target_user_messages=target_user_messages_str
                )
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

        keywords = ['analiz', 'trend', 'long', 'short', 'destek', 'direnç', 'yorum', 'neden']
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
                    if analysis_key in self.active_analyses:
                        del self.active_analyses[analysis_key]
            return

        if matched_keyword and symbol:
            current_analysis = self.storage.get_latest_analysis(symbol)
            response = await self.grok.generate_natural_response(text, context_info, symbol)
            if current_analysis:
                if matched_keyword == 'trend':
                    trend_match = re.search(r'Trend: (.*?)(?:\n|$)', current_analysis, re.DOTALL)
                    response += f"\nTrend: {trend_match.group(1) if trend_match else 'Bilinmiyor'} 🚀📉"
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

        response = await self.grok.generate_natural_response(text, context_info, symbol)
        await update.message.reply_text(response)
        self.storage.save_conversation(chat_id, text, response, symbol)

        async def split_and_send_message(self, chat_id, message, symbol):
        """Mesajı 4096 karakter sınırına göre böl ve sırayla gönder."""
        max_length = 4096
        if not message or message.strip() == "":
            response = f"Kanka, {symbol} için analiz üretemedim, veri eksik olabilir. 😕 Tekrar deneyeyim mi?"
            await self.app.bot.send_message(chat_id=chat_id, text=response)
            self.storage.save_conversation(chat_id, symbol, response, symbol)
            return

        if len(message) <= max_length:
            await self.app.bot.send_message(chat_id=chat_id, text=message)
            self.storage.save_conversation(chat_id, symbol, message, symbol)
            logger.info(f"Tek parça mesaj gönderildi: {message[:200]}...")
            return

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

        for i, section in enumerate(sections, 1):
            part_message = f"{symbol} Analiz - Bölüm {i}/{len(sections)} ⏰\n{section}"
            await self.app.bot.send_message(chat_id=chat_id, text=part_message)
            self.storage.save_conversation(chat_id, symbol, part_message, symbol)
            logger.info(f"Mesaj bölümü {i}/{len(sections)} gönderildi: {part_message[:200]}...")
            await asyncio.sleep(0.5)  # Telegram rate limit için kısa bekleme

    async def process_coin(self, symbol, chat_id):
        """Coin analizi yap ve sonucu gönder."""
        try:
            data = await self.grok.fetch_market_data(symbol)
            if not data or not any(data.get('klines', {}).get(interval, {}).get('data') for interval in TIMEFRAMES):
                response = f"Kanka, {symbol} için veri bulamadım. Başka coin mi bakalım? 🤔"
                await self.app.bot.send_message(chat_id=chat_id, text=response)
                self.storage.save_conversation(chat_id, symbol, response, symbol)
                return

            indicators = calculate_indicators(data['klines'], data['order_book'], symbol)
            grok_analysis = await self.grok.analyze_coin(symbol, chat_id)
            if not grok_analysis:
                response = f"Kanka, {symbol} için analiz üretemedim, bi’ şeyler ters gitti. 😅 Tekrar deneyeyim mi?"
                await self.app.bot.send_message(chat_id=chat_id, text=response)
                self.storage.save_conversation(chat_id, symbol, response, symbol)
                return

            await self.split_and_send_message(chat_id, grok_analysis, symbol)
            self.storage.save_analysis(symbol, {'indicators': indicators, 'grok_analysis': grok_analysis})
            logger.info(f"{symbol} için analiz tamamlandı ve gönderildi. 🚀")
        except Exception as e:
            logger.error(f"{symbol} için analiz sırasında hata: {e} 😞")
            response = f"Kanka, {symbol} analizi yaparken bi’ hata oldu: {str(e)}. Tekrar deneyeyim mi? 😅"
            await self.app.bot.send_message(chat_id=chat_id, text=response)
            self.storage.save_conversation(chat_id, symbol, response, symbol)
        finally:
            gc.collect()

    async def run(self):
        """Botu başlat ve webhook ayarla."""
        try:
            webhook_url = os.getenv('WEBHOOK_URL', f"https://mexctrading95bot-61a7539d22a7.herokuapp.com/{os.getenv('TELEGRAM_TOKEN')}")
            logger.info(f"Setting webhook: {webhook_url}")
            await self.app.bot.set_webhook(url=webhook_url)
            port = int(os.environ.get('PORT', 8443))
            app = web.Application()
            app.router.add_post(f"/{os.getenv('TELEGRAM_TOKEN')}", self.handle_webhook)
            runner = web.AppRunner(app)
            await runner.setup()
            site = web.TCPSite(runner, '0.0.0.0', port)
            await site.start()
            logger.info(f"Bot running on port {port} with webhook {webhook_url} 🚀")
            self.is_running = True
            await self.shutdown_event.wait()
        except Exception as e:
            logger.error(f"Bot başlatma hatası: {e} 😞")
        finally:
            await self.kucoin.close()
            if self.storage.conn and not self.storage.conn.closed:
                self.storage.conn.close()
            logger.info("Bot durduruldu. 🛑")
            gc.collect()

    async def handle_webhook(self, request):
        """Webhook isteklerini işle."""
        try:
            update = await request.json()
            update = Update.de_json(update, self.app.bot)
            await self.app.process_update(update)
            return web.Response(status=200)
        except Exception as e:
            logger.error(f"Webhook işleme hatası: {e} 😞")
            return web.Response(status=500)

    def signal_handler(self, signum, frame):
        """Sinyal yakalayıcı."""
        logger.info(f"Sinyal alındı: {signum}, bot durduruluyor...")
        self.shutdown_event.set()

    def __del__(self):
        """Bot kaynaklarını temizle."""
        try:
            if self.storage.conn and not self.storage.conn.closed:
                self.storage.conn.close()
            logger.info("Bot kaynakları temizlendi. 🧹")
        except Exception as e:
            logger.error(f"Bot temizleme hatası: {e} 😞")
        finally:
            gc.collect()

if __name__ == "__main__":
    bot = TelegramBot()
    signal.signal(signal.SIGINT, bot.signal_handler)
    signal.signal(signal.SIGTERM, bot.signal_handler)
    asyncio.run(bot.run())
