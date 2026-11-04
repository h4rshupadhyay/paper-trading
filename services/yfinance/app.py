"""Internal yfinance adapter. Prices cross this boundary as unadjusted decimals."""
import copy
import json
import os
import re
import signal
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

import yfinance as yf

from streaming import StreamHub

# yfinance 1.7 exposes errors through config; raise_errors is deprecated.
yf.config.debug.hide_exceptions = False

CURRENCIES = {'INR', 'USD', 'GBP', 'EUR', 'JPY', 'HKD'}
PERIODS = {'1d', '5d', '1mo', '3mo', '6mo', '1y', '5y'}
INTERVALS = {'5m', '15m', '1d', '1wk', '1mo'}
BOOTSTRAP = ('AAPL', 'RELIANCE.NS', 'VOD.L', 'SAP.DE', '7203.T', '0700.HK')
SYMBOL = re.compile(r'[A-Za-z0-9^][A-Za-z0-9.^=\-]{0,39}\Z')
RAW = dict(auto_adjust=False, back_adjust=False, repair=False, rounding=False,
           prepost=False, timeout=1.5)


class Unavailable(Exception):
    """No validated observation is available."""


def symbol(value):
    if not isinstance(value, str) or not SYMBOL.fullmatch(value):
        raise ValueError('Invalid symbol')
    return value


def decimal(value, zero=False):
    if value is None or isinstance(value, bool):
        raise Unavailable('Missing number')
    try:
        result = Decimal(str(value))
        if not result.is_finite() or result < 0 or (not zero and result == 0):
            raise Unavailable('Invalid number')
        return format(result, 'f')
    except (InvalidOperation, ValueError, TypeError):
        raise Unavailable('Invalid number') from None


def volume(value):
    result = Decimal(decimal(value, zero=True))
    if result != result.to_integral_value():
        raise Unavailable('Nonintegral volume')
    return str(int(result))


def observed(value):
    try:
        if isinstance(value, datetime):
            if value.tzinfo is None:
                raise Unavailable('Missing timezone')
            result = value.astimezone(timezone.utc)
        else:
            seconds = Decimal(str(value))
            if not seconds.is_finite() or seconds != seconds.to_integral_value() or seconds <= 0:
                raise Unavailable('Invalid timestamp')
            result = datetime.fromtimestamp(int(seconds), timezone.utc)
        if result > datetime.now(timezone.utc) or result.timestamp() <= 0:
            raise Unavailable('Invalid timestamp')
        return result.isoformat().replace('+00:00', 'Z')
    except (InvalidOperation, ValueError, TypeError, OverflowError, OSError):
        raise Unavailable('Invalid timestamp') from None


def instrument(meta, expected):
    if meta.get('symbol') != expected:
        raise Unavailable('Instrument symbol mismatch')
    raw = meta.get('currency')
    currency = 'GBP' if raw == 'GBp' else raw
    kind = meta.get('instrumentType')
    exchange = meta.get('exchangeName')
    name = meta.get('longName') or meta.get('shortName') or expected
    if currency not in CURRENCIES or kind not in ('EQUITY', 'INDEX') or not isinstance(exchange, str) or not exchange or not isinstance(name, str):
        raise Unavailable('Unsupported instrument metadata')
    return dict(symbol=expected, name=name, exchange=exchange, currency=currency,
                multiplier='0.01' if raw == 'GBp' else '1', kind=kind,
                tradable=kind == 'EQUITY', unavailableReason='VIEW_ONLY_INDEX' if kind == 'INDEX' else None)


class MarketData:
    def __init__(self):
        self.cache = {}
        self.stream_currencies = {}
        self.inflight = {}
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(2)
        self.executor = ThreadPoolExecutor(max_workers=2)

    def submit(self, fn):
        # No unbounded executor queue: timed-out upstream calls still own a slot.
        if not self.slots.acquire(blocking=False):
            raise Unavailable('Provider busy')
        try:
            future = self.executor.submit(fn)
        except Exception:
            self.slots.release()
            raise
        future.add_done_callback(lambda _: self.slots.release())
        return future

    def wait(self, future, timeout=5.5):
        try:
            return future.result(timeout=timeout)
        except Exception:
            raise Unavailable('Provider unavailable') from None

    def cached(self, key, fetch):
        with self.lock:
            entry = self.cache.get(key)
            if entry and time.monotonic() - entry[0] < 15:
                return copy.deepcopy(entry[1])
            pending = self.inflight.get(key)
            owner = pending is None
            if owner:
                pending = Future()
                self.inflight[key] = pending
        if not owner:
            # Waiting callers share work without occupying another upstream slot.
            return copy.deepcopy(self.wait(pending, 20))
        try:
            result = fetch()
            with self.lock:
                if len(self.cache) >= 256:
                    self.cache.clear()
                self.cache[key] = (time.monotonic(), copy.deepcopy(result))
            pending.set_result(copy.deepcopy(result))
            return result
        except Exception as error:
            pending.set_exception(error)
            raise
        finally:
            with self.lock:
                self.inflight.pop(key, None)

    def load(self, requested, period='5d', interval='1d'):
        ticker = yf.Ticker(requested)
        frame = ticker.history(period=period, interval=interval, **RAW)
        # Metadata is from this same raw history fetch, never fast_info or info.
        meta = dict(ticker.get_history_metadata(repair=False))
        return meta, frame

    def metadata(self, requested):
        return self.cached(('meta', requested), lambda: self.wait(self.submit(lambda: self.load(requested)))[0])

    def quote(self, requested):
        symbol(requested)
        meta = self.metadata(requested)
        canonical = instrument(meta, requested)
        result = dict(instrument=canonical, quote=dict(rawPrice=decimal(meta.get('regularMarketPrice')),
                    rawCurrency=meta['currency'], observedAt=observed(meta.get('regularMarketTime')),
                    session='UNKNOWN', actionKey='yfinance-raw'))
        with self.lock:
            entry = self.cache.get(('meta', requested))
            if entry:
                self.stream_currencies = {name:value for name,value in self.stream_currencies.items() if time.monotonic()-value[0] < 90}
                if len(self.stream_currencies) >= 256:
                    self.stream_currencies.clear()
                self.stream_currencies[requested] = (entry[0], meta['currency'])
        return result

    def currency_for_stream(self, requested):
        with self.lock:
            entry = self.stream_currencies.get(requested)
            return entry[1] if entry and time.monotonic()-entry[0] < 90 else None

    def history(self, requested, period='3mo', interval='1d'):
        symbol(requested)
        if period not in PERIODS or interval not in INTERVALS:
            raise ValueError('Invalid history options')
        def fetch():
            meta, frame = self.wait(self.submit(lambda: self.load(requested, period, interval)))
            canonical = instrument(meta, requested)
            bars = []
            # Iterate actual rows (not independently sliced columns) to retain offsets.
            for row in frame.tail(2000).itertuples():
                timestamp = row.Index
                try:
                    bars.append(dict(observedAt=observed(timestamp), open=decimal(getattr(row, 'Open')),
                                     high=decimal(getattr(row, 'High')), low=decimal(getattr(row, 'Low')),
                                     close=decimal(getattr(row, 'Close')), volume=volume(getattr(row, 'Volume'))))
                except (Unavailable, AttributeError, KeyError, TypeError):
                    continue
            if not bars:
                raise Unavailable('History unavailable')
            return dict(instrument=canonical, items=bars)
        return self.cached(('history', requested, period, interval), fetch)

    def demo_history(self, now=None, period='1mo'):
        """Fixed, bounded maintenance export; never write these as live observations.

        Daily dates are not observation timestamps. A bar is usable only after
        the next exchange-local midnight. Reference times are regular session
        ends (conservative on early-close days); FX uses next local midnight.
        """
        if period not in ('1mo', '5y'):
            raise ValueError('Invalid demo history period')
        now = now or datetime.now(timezone.utc)
        if now.tzinfo is None:
            raise Unavailable('Missing retrieval timezone')
        now = now.astimezone(timezone.utc)
        series = {}
        for requested, currency, zone, close_hour, close_minute in (
            ('AAPL', 'USD', 'America/New_York', 16, 0),
            ('MSFT', 'USD', 'America/New_York', 16, 0),
            ('RELIANCE.NS', 'INR', 'Asia/Kolkata', 15, 30),
            ('USDINR=X', 'INR', 'Europe/London', 0, 0),
        ):
            meta, frame = self.wait(self.submit(lambda s=requested: self.load(s, period, '1d')))
            if meta.get('symbol') != requested or meta.get('currency') != currency or meta.get('instrumentType') != ('CURRENCY' if requested == 'USDINR=X' else 'EQUITY'):
                raise Unavailable('Demo history metadata mismatch')
            if not {'Close', 'Dividends', 'Stock Splits'}.issubset(frame.columns):
                raise Unavailable('Demo action history missing')
            if period == '5y':
                series[requested] = dict(currency=currency, items=self.demo_five_year_items(
                    frame, requested, zone, close_hour, close_minute, now))
                continue
            items = []
            for row in frame.tail(40).itertuples(name=None):
                values = dict(zip(frame.columns, row[1:]))
                stamp = row[0]
                if getattr(stamp, 'tzinfo', None) is None or str(stamp.tzinfo) != zone:
                    raise Unavailable('Demo history timezone mismatch')
                start = datetime.combine(stamp.date(), datetime.min.time(), ZoneInfo(zone))
                available = start + timedelta(days=1)
                # A current-session split can already alter past Yahoo bars.
                # Inspect actions before excluding the incomplete price bar.
                if Decimal(decimal(values['Dividends'], zero=True)) != 0 or Decimal(decimal(values['Stock Splits'], zero=True)) != 0:
                    raise Unavailable('Demo window contains unsupported corporate actions')
                if available > now:
                    continue
                closed = available if requested == 'USDINR=X' else start.replace(hour=close_hour, minute=close_minute)
                if requested != 'USDINR=X' and start.weekday() >= 5:
                    raise Unavailable('Unexpected weekend equity session')
                price = Decimal(decimal(values['Close'])).quantize(Decimal('0.00000001') if requested == 'USDINR=X' else Decimal('0.01'), rounding=ROUND_HALF_UP)
                items.append(dict(sessionDate=start.date().isoformat(), closedAt=observed(closed), availableAt=observed(available), close=decimal(price)))
            if not items:
                raise Unavailable('Demo history unavailable')
            series[requested] = dict(currency=currency, items=items)
        if period == '5y':
            result = dict(version=3, source='yfinance', priceBasis='contemporaneous',
                          fetchedAt=now.isoformat().replace('+00:00', 'Z'), series=series)
            if len(json.dumps(result, allow_nan=False).encode()) > 2_000_000:
                raise Unavailable('Demo history too large')
            return result
        return dict(source='yfinance', fetchedAt=now.isoformat().replace('+00:00', 'Z'), corporateActions='none', series=series)

    def demo_five_year_items(self, frame, requested, zone, close_hour, close_minute, now):
        # Yahoo's Close and cash dividends are split-normalized even with
        # auto_adjust=False. Undo only later splits; the ex-date row already
        # uses post-split share units. Never use Adj Close (dividend-adjusted).
        if not 0 < len(frame) <= 1400 or not frame.index.is_monotonic_increasing or not frame.index.is_unique:
            raise Unavailable('Invalid demo history rows')
        supported = {'Open', 'High', 'Low', 'Close', 'Adj Close', 'Volume', 'Dividends', 'Stock Splits', 'Capital Gains'}
        if not frame.columns.is_unique or set(frame.columns) - supported:
            raise Unavailable('Unsupported history fields')
        rows = []
        for row in frame.itertuples(name=None):
            values = dict(zip(frame.columns, row[1:]))
            stamp = row[0]
            if getattr(stamp, 'tzinfo', None) is None or str(stamp.tzinfo) != zone:
                raise Unavailable('Demo history timezone mismatch')
            start = datetime.combine(stamp.date(), datetime.min.time(), ZoneInfo(zone))
            if stamp != start or start.date() > now.astimezone(ZoneInfo(zone)).date():
                raise Unavailable('Invalid source session date')
            dividend = Decimal(decimal(values['Dividends'], zero=True))
            raw_split = Decimal(decimal(values['Stock Splits'], zero=True))
            split = raw_split or Decimal(1)
            if dividend >= Decimal('1e12') or not Decimal('0.000001') <= split <= Decimal('1e6'):
                raise Unavailable('Invalid corporate action')
            if 'Capital Gains' in values and Decimal(decimal(values['Capital Gains'], zero=True)) != 0:
                raise Unavailable('Unsupported capital gains')
            if requested == 'USDINR=X' and (dividend != 0 or split != 1):
                raise Unavailable('Unexpected FX action')
            # A live post-action quote cannot match a replay that omits that
            # unfinished session's action. Wait until its daily fact is usable.
            if start + timedelta(days=1) > now and (dividend != 0 or raw_split != 0):
                raise Unavailable('Unfinished source session contains corporate actions')
            rows.append((start, values['Close'], dividend, split))
        items = []
        future_splits = Decimal(1)
        for start, raw_close, dividend, split in reversed(rows):
            available = start + timedelta(days=1)
            if available <= now:
                closed = available if requested == 'USDINR=X' else start.replace(hour=close_hour, minute=close_minute)
                price = Decimal(decimal(raw_close)) * future_splits
                dividend *= future_splits
                if price >= Decimal('1e12') or dividend >= Decimal('1e12'):
                    raise Unavailable('Invalid contemporaneous amount')
                price = price.quantize(Decimal('0.00000001'), rounding=ROUND_HALF_UP)
                dividend = dividend.quantize(Decimal('0.00000001'), rounding=ROUND_HALF_UP)
                # Retain eight decimals before entitlement multiplication;
                # rounding per-share dividends to cents changes cash credits.
                items.append(dict(sessionDate=start.date().isoformat(), closedAt=observed(closed),
                                  availableAt=observed(available), close=decimal(price),
                                  dividend=decimal(dividend, zero=True) if dividend else '0', split=decimal(split)))
            future_splits *= split
            if not Decimal('1e-12') <= future_splits <= Decimal('1e12'):
                raise Unavailable('Invalid cumulative split factor')
        if not items:
            raise Unavailable('Demo history unavailable')
        return list(reversed(items))

    def statistics(self, requested):
        symbol(requested)
        def fetch():
            info = self.wait(self.submit(lambda: yf.Ticker(requested).info))
            if not isinstance(info, dict) or info.get('symbol') != requested or info.get('currency') not in CURRENCIES | {'GBp'}:
                raise Unavailable('Invalid statistics metadata')
            fields = dict(open='open', dayHigh='dayHigh', dayLow='dayLow', previousClose='previousClose',
                          volume='volume', averageVolume='averageVolume', marketCap='marketCap',
                          trailingPE='trailingPE', fiftyTwoWeekHigh='fiftyTwoWeekHigh', fiftyTwoWeekLow='fiftyTwoWeekLow')
            values = {}
            for field, key in fields.items():
                value = info.get(key)
                try:
                    if field == 'trailingPE':
                        if value is None or isinstance(value, bool):
                            raise Unavailable('Missing ratio')
                        number = Decimal(str(value))
                        if not number.is_finite() or abs(number) >= Decimal('1e20'):
                            raise Unavailable('Invalid ratio')
                        values[field] = format(number, 'f')
                    else:
                        values[field] = volume(value) if field in ('volume', 'averageVolume') else decimal(value, zero=True)
                except (Unavailable, InvalidOperation, ValueError, TypeError):
                    values[field] = None
            if not any(value is not None for value in values.values()):
                raise Unavailable('Statistics unavailable')
            text = lambda key, limit: info[key] if isinstance(info.get(key), str) and len(info[key]) <= limit else None
            return dict(symbol=requested, rawCurrency=info['currency'], statistics=values,
                        sector=text('sector', 256), industry=text('industry', 256), description=text('longBusinessSummary', 20000))
        return self.cached(('statistics', requested), fetch)

    def fx(self, currency):
        if currency not in CURRENCIES:
            raise ValueError('Invalid currency')
        if currency == 'INR':
            return dict(currency='INR', rate='1', observedAt=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'))
        expected = currency + 'INR=X'
        meta = self.metadata(expected)
        if meta.get('symbol') != expected or meta.get('currency') != 'INR':
            raise Unavailable('Invalid FX direction')
        return dict(currency=currency, rate=decimal(meta.get('regularMarketPrice')),
                    observedAt=observed(meta.get('regularMarketTime')))

    def search(self, query):
        if not isinstance(query, str) or len(query) > 80 or any(ord(c) < 32 for c in query):
            raise ValueError('Invalid search query')
        query = query.strip()
        def fetch():
            if query:
                quotes = self.wait(self.submit(lambda: yf.Search(query, max_results=4, news_count=0, timeout=1.5).quotes), 4.5)
                requested = []
                for item in quotes[:4]:
                    if item.get('quoteType') in ('EQUITY', 'INDEX'):
                        try:
                            candidate = symbol(item.get('symbol'))
                            if candidate not in requested:
                                requested.append(candidate)
                        except ValueError:
                            continue
                if not requested:
                    raise Unavailable('Search unavailable')
            else:
                requested = list(BOOTSTRAP)
            results = []
            deadline = time.monotonic() + 14
            for offset in range(0, len(requested), 2):
                futures = []
                for candidate in requested[offset:offset+2]:
                    try:
                        futures.append((candidate, self.submit(lambda s=candidate: self.load(s))))
                    except Unavailable:
                        continue
                for candidate, future in futures:
                    try:
                        meta, _ = self.wait(future, max(0, min(4.5, deadline-time.monotonic())))
                        results.append(instrument(meta, candidate))
                    except Unavailable:
                        continue
            if not results:
                raise Unavailable('Search unavailable')
            return results
        return self.cached(('search', query), fetch)


def route(service, target):
    try:
        if len(target) > 1024:
            raise ValueError('Request too long')
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc or parsed.fragment:
            raise ValueError('Invalid request target')
        params = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=8)
        allowed = {'/health': set(), '/search': {'q'}, '/quote': {'symbol'},
                   '/demo-history': {'period'}, '/history': {'symbol', 'period', 'interval'}, '/statistics': {'symbol'}, '/fx': {'currency'}}
        if parsed.path not in allowed:
            return 404, {'error': 'Not found'}
        if set(params) - allowed[parsed.path] or any(len(v) != 1 for v in params.values()):
            raise ValueError('Invalid parameters')
        values = {k: v[0] for k, v in params.items()}
        if parsed.path == '/health':
            return 200, {'ok': True}
        if parsed.path == '/demo-history':
            return 200, service.demo_history(period=values.get('period', '1mo'))
        if parsed.path == '/search':
            return 200, {'items': service.search(values.get('q', ''))}
        if parsed.path == '/quote':
            return 200, service.quote(symbol(values.get('symbol')))
        if parsed.path == '/statistics':
            return 200, service.statistics(symbol(values.get('symbol')))
        if parsed.path == '/history':
            return 200, service.history(symbol(values.get('symbol')), values.get('period', '3mo'), values.get('interval', '1d'))
        return 200, service.fx(values.get('currency'))
    except ValueError as error:
        return 400, {'error': str(error)}
    except Exception:
        return 503, {'error': 'Market data unavailable'}


class Handler(BaseHTTPRequestHandler):
    service = None
    hub = None

    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    def respond_json(self, status, result):
        body = json.dumps(result, allow_nan=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/subscriptions':
            return self.respond_json(400 if self.path.startswith('/subscriptions?') else 404, {'error': 'Invalid request'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192 or self.headers.get('Transfer-Encoding') or self.headers.get_content_type() != 'application/json':
                raise ValueError('Invalid body')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict) or set(payload) != {'symbols'}:
                raise ValueError('Invalid body')
            self.hub.replace(payload['symbols'])
        except (ValueError, TypeError, UnicodeError):
            self.close_connection = True
            return self.respond_json(400, {'error': 'Invalid subscriptions'})
        return self.respond_json(200, {'ok': True})

    def stream(self):
        try:
            client = self.hub.register()
        except ValueError:
            return self.respond_json(503, {'error': 'Stream consumer limit reached'})
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Accel-Buffering', 'no')
            self.end_headers()
            self.wfile.write(b': heartbeat\n\n')
            self.wfile.flush()
            while not client.closed:
                item = client.get(self.hub.heartbeat_seconds)
                frame = ('event: quote\ndata: ' + json.dumps(item, allow_nan=False, separators=(',', ':')) + '\n\n').encode() if item else b': heartbeat\n\n'
                self.wfile.write(frame)
                self.wfile.flush()
        except (OSError, ValueError):
            pass
        finally:
            self.hub.unregister(client)

    def do_GET(self):
        if self.path == '/stream':
            return self.stream()
        if self.path.startswith('/stream?'):
            return self.respond_json(400, {'error': 'Invalid parameters'})
        status, result = route(self.service, self.path)
        body = json.dumps(result, allow_nan=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Do not log user search queries or untrusted request targets.
        pass


if __name__ == '__main__':
    yf.set_tz_cache_location(os.environ.get('YFINANCE_CACHE_DIR', '/tmp/yfinance-cache'))
    Handler.service = MarketData()
    Handler.hub = StreamHub(currency_for_symbol=Handler.service.currency_for_stream)
    server = ThreadingHTTPServer((os.environ.get('HOST', '127.0.0.1'), int(os.environ.get('PORT', '8000'))), Handler)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever()
    finally:
        Handler.hub.stop()
        server.server_close()
        Handler.service.executor.shutdown(wait=False, cancel_futures=True)
