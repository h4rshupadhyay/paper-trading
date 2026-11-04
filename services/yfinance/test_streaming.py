import asyncio
import http.client
import importlib.util
import json
import pathlib
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('streaming', pathlib.Path(__file__).with_name('streaming.py'))
streaming = None
if spec and spec.loader and pathlib.Path(spec.origin).exists():
    streaming = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(streaming)


def eventually(predicate, timeout=2):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if predicate(): return
        time.sleep(.01)
    raise AssertionError('condition not reached')


class FakeSocket:
    instances = []
    def __init__(self):
        self.symbols = set()
        self.closed = False
        self.fail = False
        self.handler = None
        self.instances.append(self)
    async def subscribe(self, symbols): self.symbols.update(symbols)
    async def unsubscribe(self, symbols): self.symbols.difference_update(symbols)
    async def listen(self, handler):
        self.handler = handler
        while not self.fail: await asyncio.sleep(.01)
        raise OSError('disconnected')
    async def close(self): self.closed = True


class StreamingTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(streaming, 'Python streaming boundary is not implemented')
        FakeSocket.instances = []
        self.hub = streaming.StreamHub(socket_factory=FakeSocket, lease_seconds=.25, heartbeat_seconds=.05, reconnect_base=.01)
        self.addCleanup(self.hub.stop)
    def tick(self, **overrides):
        return dict(id='AAPL', price=123.45000457763672, currency='USD', price_hint=2, time=int(time.time()*1000), **overrides)
    def test_decimal_time_and_raw_pence(self):
        tick = self.tick()
        quote = streaming.normalize_tick(tick, now_ms=tick['time'])
        self.assertEqual(quote['quote']['rawPrice'], '123.45')
        self.assertTrue(quote['quote']['observedAt'].endswith('Z'))
        self.assertEqual(streaming.normalize_tick(dict(tick, currency='GBp'), now_ms=tick['time'])['quote']['rawCurrency'], 'GBp')
        for key, value in [('price',0),('price',True),('price','NaN'),('price_hint',9),('price_hint',True),('time',0),('time',int(tick['time']/1000)),('time',1.1),('time',True),('time',tick['time']+5001),('currency',None),('currency','CAD'),('currency','GBP'),('currency',[]),('price','1e100')]:
            with self.subTest(key=key,value=value):
                self.assertIsNone(streaming.normalize_tick(dict(tick, **{key:value}), now_ms=tick['time']))
    def test_normalizes_actual_protobuf_json_integer_strings(self):
        import base64
        from yfinance.pricing_pb2 import PricingData
        from yfinance import AsyncWebSocket
        timestamp = int(time.time()*1000)
        payload = PricingData(id='AAPL',price=123.45,currency='USD',price_hint=2,time=timestamp)
        decoded = AsyncWebSocket(verbose=False)._decode_message(base64.b64encode(payload.SerializeToString()).decode())
        self.assertEqual(decoded['price_hint'], '2')
        normalized = streaming.normalize_tick(decoded, now_ms=timestamp)
        self.assertIsNotNone(normalized)
        self.assertEqual(normalized['quote']['rawPrice'], '123.45')
    def test_missing_wire_currency_requires_verified_metadata(self):
        self.hub.currency_for_symbol = lambda name: 'INR' if name == 'AAPL' else None
        self.hub.replace(['AAPL','OTHER'])
        client = self.hub.register()
        tick = self.tick();del tick['currency']
        self.hub.publish(tick)
        result = client.get(.1)
        self.assertIsNotNone(result)
        self.assertEqual(result['quote']['rawCurrency'], 'INR')
        self.hub.publish(dict(tick,id='OTHER'))
        self.assertIsNone(client.get(.01))
        self.hub.publish(dict(tick,currency=None,time=tick['time']+1))
        self.assertIsNone(client.get(.01))

    def test_currency_metadata_expires_without_revalidation(self):
        from unittest.mock import patch
        import app
        class Ticker:
            def __init__(self, name): pass
            def history(self, **kwargs): return None
            def get_history_metadata(self, **kwargs):
                return dict(symbol='AAPL',currency='USD',instrumentType='EQUITY',exchangeName='NMS',longName='Apple',regularMarketPrice=123,regularMarketTime=int(time.time()))
        service=app.MarketData();self.addCleanup(service.executor.shutdown,wait=True)
        with patch.object(app.yf,'Ticker',Ticker),patch('app.time.monotonic',return_value=1000):
            service.quote('AAPL')
            self.assertEqual(service.currency_for_stream('AAPL'),'USD')
        with patch('app.time.monotonic',return_value=1091):
            self.assertIsNone(service.currency_for_stream('AAPL'))
    def test_shared_connection_churn_latest_queue_and_replay(self):
        self.hub.replace(['AAPL','VOD.L'])
        first, second = self.hub.register(), self.hub.register()
        eventually(lambda: FakeSocket.instances and FakeSocket.instances[0].handler)
        tick = self.tick()
        self.hub.publish(tick)
        self.hub.publish(dict(tick, price=999))
        self.hub.publish(dict(tick, id='OTHER'))
        self.hub.publish(dict(tick, price=124, time=tick['time']+1))
        self.assertEqual(first.get(.1)['quote']['rawPrice'],'124.00')
        self.assertEqual(second.get(.1)['quote']['rawPrice'],'124.00')
        self.assertIsNone(first.get(.01))
        self.assertEqual(len(FakeSocket.instances),1)
        self.hub.replace(['VOD.L'])
        eventually(lambda: FakeSocket.instances[0].symbols == {'VOD.L'})
        self.hub.unregister(first)
        self.hub.unregister(second)
    def test_lease_expiry_and_fresh_reconnect_and_stop(self):
        self.hub.register()
        self.hub.replace(['AAPL'])
        eventually(lambda: FakeSocket.instances and FakeSocket.instances[0].handler)
        FakeSocket.instances[0].fail = True
        eventually(lambda: len(FakeSocket.instances)==2)
        self.assertTrue(FakeSocket.instances[0].closed)
        eventually(lambda: FakeSocket.instances[-1].closed)
        self.hub.replace(['AAPL'])
        eventually(lambda: len(FakeSocket.instances)==3)
        self.hub.stop()
        self.assertTrue(FakeSocket.instances[-1].closed)
    def test_numeric_timestamp_serialization_cannot_crash_publisher(self):
        self.hub.replace(['AAPL'])
        client = self.hub.register()
        tick = self.tick()
        tick['time'] = str(tick['time']) + '.0'
        self.hub.publish(tick)
        self.assertIsNotNone(client.get(.1))

    def test_stop_cancels_an_inflight_connect_promptly(self):
        class ConnectingSocket(FakeSocket):
            async def subscribe(self, symbols):
                await asyncio.sleep(60)
        self.hub.socket_factory = ConnectingSocket
        self.hub.replace(['AAPL'])
        eventually(lambda: bool(FakeSocket.instances))
        started = time.monotonic()
        self.hub.stop()
        self.assertLess(time.monotonic()-started, .5)
        self.assertTrue(FakeSocket.instances[0].closed)

    def test_yahoo_clean_close_returns_for_reconnection(self):
        import yfinance as yf
        yf.config.debug.hide_exceptions = False
        class ClosedTransport:
            passes = 0
            def __aiter__(self):
                self.passes += 1
                if self.passes > 1:
                    raise AssertionError('closed transport was reused')
                return self
            async def __anext__(self):
                raise StopAsyncIteration
        async def run():
            client = streaming.StreamHub._new_socket()
            async def connected(): pass
            client._connect = connected
            client._ws = ClosedTransport()
            try:
                await client.listen(lambda tick: None)
            finally:
                if client._heartbeat_task:
                    client._heartbeat_task.cancel()
                    await asyncio.gather(client._heartbeat_task, return_exceptions=True)
        asyncio.run(run())

    def test_bounds_and_validation(self):
        for values in [None,'AAPL',['bad/'],['AAPL']*101,[True]]:
            with self.assertRaises(ValueError): self.hub.replace(values)
        clients=[self.hub.register() for _ in range(8)]
        with self.assertRaises(ValueError): self.hub.register()
        self.hub.unregister(clients[0])
        self.hub.register()
    def test_http_validation_stream_and_disconnect(self):
        import app
        class Handler(app.Handler): pass
        Handler.hub=self.hub
        server=app.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        def post(body, path='/subscriptions'):
            conn=http.client.HTTPConnection(*server.server_address,timeout=2)
            conn.request('POST',path,body,{'Content-Type':'application/json'})
            response=conn.getresponse(); status=response.status; response.read();conn.close();return status
        self.assertEqual(post('{"symbols":["AAPL"]}'),200)
        for body in ['{}','{"symbols":["bad/"]}','{"symbols":[],"extra":1}','{']:
            self.assertEqual(post(body),400)
        self.assertEqual(post('{"symbols":[]}', '/subscriptions?x=1'),400)
        conn=http.client.HTTPConnection(*server.server_address,timeout=2)
        conn.request('GET','/stream');response=conn.getresponse()
        self.assertEqual(response.status,200)
        self.assertEqual(response.readline(),b': heartbeat\n')
        response.readline()
        self.hub.publish(self.tick())
        self.assertEqual(response.readline(),b'event: quote\n')
        self.assertEqual(json.loads(response.readline()[6:])['symbol'],'AAPL')
        response.close();conn.close()
        eventually(lambda: self.hub.client_count == 0)
