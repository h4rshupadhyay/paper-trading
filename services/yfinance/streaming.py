"""Bounded shared raw quote feed. No upstream connection is made on import."""
import asyncio
import json
from collections import OrderedDict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import random
import re
import threading
import time

SYMBOL = re.compile(r'[A-Za-z0-9^][A-Za-z0-9.^=\-]{0,39}\Z')
CURRENCIES = {'INR', 'USD', 'GBp', 'EUR', 'JPY', 'HKD'}


def normalize_tick(tick, now_ms=None):
    """Yahoo GBP is ambiguous for LSE equities; only explicit GBp is usable.

    Decimal quantization removes protobuf float noise using the provider hint.
    Values exceeding the decimal context precision are rejected, never truncated.
    """
    if not isinstance(tick, dict):
        return None
    name, currency, hint, stamp, value = (tick.get(k) for k in ('id', 'currency', 'price_hint', 'time', 'price'))
    # Protobuf JSON encodes int64 fields, including price_hint, as strings.
    if isinstance(hint, str) and re.fullmatch(r'[0-8]', hint):
        hint = int(hint)
    if not isinstance(name, str) or not SYMBOL.fullmatch(name) or not isinstance(currency, str) or currency not in CURRENCIES:
        return None
    if type(hint) is not int or not 0 <= hint <= 8 or isinstance(stamp, bool) or isinstance(value, bool):
        return None
    try:
        milliseconds, price = Decimal(str(stamp)), Decimal(str(value))
        if not milliseconds.is_finite() or milliseconds < 1_000_000_000_000 or milliseconds != milliseconds.to_integral_value():
            return None
        if milliseconds > (time.time()*1000 if now_ms is None else now_ms) + 5000:
            return None
        if not price.is_finite() or price <= 0:
            return None
        price = price.quantize(Decimal(1).scaleb(-hint))
        if price <= 0:
            return None
        stamp = datetime.fromtimestamp(int(milliseconds)//1000, timezone.utc).replace(microsecond=int(milliseconds)%1000*1000)
        return dict(symbol=name, quote=dict(rawPrice=format(price, 'f'), rawCurrency=currency,
                    observedAt=stamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                    session='UNKNOWN', actionKey='yfinance-raw'))
    except (InvalidOperation, ValueError, TypeError, OverflowError, OSError):
        return None


class LatestQueue:
    def __init__(self):
        self.condition = threading.Condition()
        self.items = OrderedDict()
        self.closed = False

    def put(self, item):
        with self.condition:
            if not self.closed:
                self.items[item['symbol']] = item
                self.condition.notify()

    def retain(self, symbols):
        with self.condition:
            self.items = OrderedDict((k, v) for k, v in self.items.items() if k in symbols)

    def get(self, timeout):
        with self.condition:
            self.condition.wait_for(lambda: self.items or self.closed, timeout)
            return self.items.popitem(last=False)[1] if self.items else None

    def close(self):
        with self.condition:
            self.closed = True
            self.items.clear()
            self.condition.notify_all()


class StreamHub:
    def __init__(self, socket_factory=None, lease_seconds=45, heartbeat_seconds=15, reconnect_base=1, currency_for_symbol=None):
        self.socket_factory = socket_factory or self._new_socket
        self.lease_seconds = lease_seconds
        self.heartbeat_seconds = heartbeat_seconds
        self.reconnect_base = reconnect_base
        self.currency_for_symbol = currency_for_symbol
        self.lock = threading.Lock()
        self.clients = set()
        self.symbols = set()
        self.latest = {}
        self.expires = 0
        self.stopped = threading.Event()
        self.thread = None
        self.loop = None
        self.task = None

    @staticmethod
    def _new_socket():
        import yfinance as yf
        class ManagedSocket(yf.AsyncWebSocket):
            async def listen(self, message_handler):
                # Pinned yfinance 1.8.0 listen() loops over a closed transport and
                # owns hidden retries. Keep its connection, subscriptions and
                # protobuf decoder, but let this hub recreate clients on EOF.
                await self._connect()
                async for message in self._ws:
                    payload = json.loads(message)
                    message_handler(self._decode_message(payload.get('message', '')))
        return ManagedSocket(verbose=False)

    @property
    def client_count(self):
        with self.lock:
            return len(self.clients)

    def replace(self, symbols):
        if not isinstance(symbols, list) or len(symbols) > 100 or any(not isinstance(s, str) or not SYMBOL.fullmatch(s) for s in symbols):
            raise ValueError('Invalid symbols (maximum 100)')
        with self.lock:
            if self.stopped.is_set():
                raise ValueError('Stream stopped')
            self.symbols = set(symbols)
            self.expires = time.monotonic() + self.lease_seconds
            self.latest = {k:v for k,v in self.latest.items() if k in self.symbols}
            for client in self.clients:
                client.retain(self.symbols)
            if self.thread is None:
                self.thread = threading.Thread(target=lambda: asyncio.run(self._run()), daemon=True)
                self.thread.start()

    def register(self):
        with self.lock:
            if self.stopped.is_set() or len(self.clients) >= 8:
                raise ValueError('Stream consumer limit reached')
            client = LatestQueue()
            self.clients.add(client)
            return client

    def unregister(self, client):
        with self.lock:
            self.clients.discard(client)
        client.close()

    def publish(self, tick):
        if isinstance(tick, dict) and 'currency' not in tick and self.currency_for_symbol is not None:
            # Some exchanges omit currency on the wire. Only independently
            # verified, unexpired HTTP metadata may supply the missing unit.
            try:
                currency = self.currency_for_symbol(tick.get('id'))
            except Exception:
                return
            if currency is not None:
                tick = dict(tick, currency=currency)
        item = normalize_tick(tick)
        if item is None:
            return
        with self.lock:
            name = item['symbol']
            if self.stopped.is_set() or time.monotonic() >= self.expires or name not in self.symbols:
                return
            stamp = int(Decimal(str(tick['time'])))
            if stamp <= self.latest.get(name, 0):
                return
            self.latest[name] = stamp
            for client in self.clients:
                client.put(item)

    def _desired(self):
        with self.lock:
            if time.monotonic() >= self.expires:
                self.symbols.clear()
                self.latest.clear()
                for client in self.clients:
                    client.retain(set())
            return set(self.symbols)

    async def _run(self):
        self.loop = asyncio.get_running_loop()
        self.task = asyncio.current_task()
        failures = 0
        retry_at = 0
        client = listener = None
        subscribed = set()
        async def close():
            nonlocal client, listener, subscribed
            if listener is not None:
                listener.cancel()
                await asyncio.gather(listener, return_exceptions=True)
            if client is not None:
                try:
                    await asyncio.wait_for(client.close(), 2)
                except Exception:
                    pass
            client = listener = None
            subscribed = set()
        try:
            while not self.stopped.is_set():
                desired = self._desired()
                try:
                    if not desired:
                        await close()
                        failures = 0
                    elif client is None and time.monotonic() >= retry_at:
                        client = self.socket_factory()
                        await asyncio.wait_for(client.subscribe(sorted(desired)), 5)
                        subscribed = desired
                        listener = asyncio.create_task(client.listen(self.publish))
                    elif client is not None:
                        if listener.done():
                            listener.result()
                            raise OSError('Stream ended')
                        if subscribed - desired:
                            await asyncio.wait_for(client.unsubscribe(sorted(subscribed - desired)), 5)
                        if desired - subscribed:
                            await asyncio.wait_for(client.subscribe(sorted(desired - subscribed)), 5)
                        subscribed = desired
                except Exception:
                    await close()
                    failures = min(failures + 1, 6)
                    retry_at = time.monotonic() + min(30, self.reconnect_base * 2**(failures-1)) * random.uniform(.75, 1.25)
                await asyncio.sleep(.05)
        except asyncio.CancelledError:
            pass
        finally:
            await close()

    def stop(self):
        self.stopped.set()
        with self.lock:
            for client in self.clients:
                client.close()
            self.clients.clear()
        if self.loop is not None and self.task is not None and not self.task.done():
            try:
                self.loop.call_soon_threadsafe(self.task.cancel)
            except RuntimeError:
                pass
        if self.thread is not None:
            self.thread.join(timeout=3)
