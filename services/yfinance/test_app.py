import copy
import importlib.util
import pathlib
import threading
from concurrent.futures import ThreadPoolExecutor
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import patch

import pandas as pd

spec = importlib.util.spec_from_file_location('sidecar', pathlib.Path(__file__).with_name('app.py'))
app = importlib.util.module_from_spec(spec) if spec else None
if spec and spec.loader and pathlib.Path(__file__).with_name('app.py').exists():
    spec.loader.exec_module(app)

META = dict(symbol='VOD.L', longName='Vodafone', exchangeName='LSE', currency='GBp', instrumentType='EQUITY', regularMarketPrice=Decimal('123.123456789012345678901'), regularMarketTime=1700000000)

class FakeTicker:
    metadata = META
    frame = pd.DataFrame({'Open':[100.0], 'High':[125.0], 'Low':[99.0], 'Close':[123.0], 'Volume':[100]}, index=pd.to_datetime(['2023-11-14T00:00:00Z']))
    def __init__(self, symbol): self.symbol = symbol
    def history(self, **kwargs):
        # Changing any raw-price option must fail before prices reach consumers.
        for key in ('auto_adjust', 'back_adjust', 'repair', 'rounding', 'prepost'):
            if kwargs.get(key) is not False: raise AssertionError(key)
        if 'raise_errors' in kwargs: raise AssertionError('deprecated raise_errors')
        if app.yf.config.debug.hide_exceptions or kwargs.get('timeout', 99) > 2: raise AssertionError('history exceptions hidden or timeout unbounded')
        return self.frame.copy()
    def get_history_metadata(self, repair):
        if repair is not False: raise AssertionError('repair')
        return copy.deepcopy(self.metadata)

class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(app, 'MarketData'), 'MarketData sidecar is not implemented')
        self.service = app.MarketData()
        self.patcher = patch.object(app.yf, 'Ticker', FakeTicker)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.addCleanup(self.service.executor.shutdown, wait=True)
        FakeTicker.metadata = copy.deepcopy(META)
    def test_pence_quote_preserves_decimal_and_observation_on_cache_hit(self):
        result = self.service.quote('VOD.L')
        self.assertEqual(result['instrument'], dict(symbol='VOD.L',name='Vodafone',exchange='LSE',currency='GBP',multiplier='0.01',kind='EQUITY',tradable=True,unavailableReason=None))
        self.assertEqual(result['quote'], dict(rawPrice='123.123456789012345678901', rawCurrency='GBp',observedAt='2023-11-14T22:13:20Z',session='UNKNOWN',actionKey='yfinance-raw'))
        FakeTicker.metadata['regularMarketPrice'] = 999
        self.assertEqual(self.service.quote('VOD.L'), result)
    def test_missing_nan_nonpositive_or_future_quote_is_unavailable(self):
        for field, value in [('regularMarketPrice', None), ('regularMarketPrice', float('nan')), ('regularMarketPrice', 0), ('regularMarketTime', 9999999999), ('regularMarketTime', None), ('currency', 'AUD'), ('symbol', 'OTHER'), ('instrumentType','ETF')]:
            with self.subTest(field=field, value=value):
                self.service.cache.clear()
                FakeTicker.metadata = {**META, field:value}
                with self.assertRaises(app.Unavailable): self.service.quote('VOD.L')
    def test_indices_are_view_only(self):
        FakeTicker.metadata = {**META,'instrumentType':'INDEX'}
        result = self.service.quote('VOD.L')['instrument']
        self.assertFalse(result['tradable'])
        self.assertEqual(result['unavailableReason'], 'VIEW_ONLY_INDEX')
    def test_history_keeps_row_alignment_and_raw_units(self):
        count = 2003
        frame = pd.DataFrame({'Open':range(1,count+1),'High':range(2,count+2),'Low':range(1,count+1),'Close':range(1,count+1),'Volume':range(count)},index=pd.date_range('2020-01-01',periods=count,tz='UTC'))
        frame.iloc[5,frame.columns.get_loc('Close')] = float('nan')
        with patch.object(FakeTicker,'frame',frame):
            result = self.service.history('VOD.L','5y','1d')
        self.assertLessEqual(len(result['items']),2000)
        self.assertEqual(result['items'][-1]['open'],'2003')
        self.assertEqual(result['items'][-1]['volume'],'2002')
        self.assertEqual(result['instrument']['multiplier'],'0.01')
        self.assertNotIn('NaN',str(result))
    def test_fx_validates_exact_direction_and_requires_source_observation(self):
        FakeTicker.metadata = {**META,'symbol':'USDINR=X','currency':'INR','instrumentType':'CURRENCY','regularMarketPrice':Decimal('83.987654321')}
        self.assertEqual(self.service.fx('USD'),dict(currency='USD',rate='83.987654321',observedAt='2023-11-14T22:13:20Z'))
        self.service.cache.clear()
        FakeTicker.metadata['symbol']='INRUSD=X'
        with self.assertRaises(app.Unavailable): self.service.fx('USD')
        identity=self.service.fx('INR')
        self.assertEqual(identity['rate'],'1')
        self.assertLess(abs((datetime.now(timezone.utc)-datetime.fromisoformat(identity['observedAt'].replace('Z','+00:00'))).total_seconds()),2)
    def test_search_metadata_validates_units_and_unavailable_does_not_become_empty_success(self):
        with patch.object(app.yf,'Search') as search:
            search.return_value.quotes=[{'symbol':'VOD.L','quoteType':'EQUITY'}]
            self.assertEqual(self.service.search('vod')[0]['multiplier'],'0.01')
        self.service.cache.clear()
        FakeTicker.metadata={}
        with self.assertRaises(app.Unavailable): self.service.search('')
    def test_large_integer_volume_is_not_rounded_by_row_coercion(self):
        frame = pd.DataFrame({'Open':[123.5], 'High':[125.5], 'Low':[120.5], 'Close':[124.5], 'Volume':[9007199254740993]}, index=pd.to_datetime(['2023-11-14T00:00:00Z']))
        with patch.object(FakeTicker,'frame',frame):
            result=self.service.history('VOD.L','1mo','15m')
        self.assertEqual(result['items'][0]['volume'],'9007199254740993')
        self.assertEqual(result['items'][0]['open'],'123.5')
    def test_concurrent_quotes_share_one_pending_provider_observation(self):
        entered = threading.Event()
        duplicate = threading.Event()
        release = threading.Event()
        follower_started = threading.Event()
        calls = []
        original = FakeTicker.history

        def pending(ticker, **kwargs):
            calls.append(ticker.symbol)
            if len(calls) > 1:
                duplicate.set()
            entered.set()
            if not release.wait(2):
                raise RuntimeError('test provider was not released')
            return original(ticker, **kwargs)

        def follower():
            follower_started.set()
            return self.service.quote('VOD.L')

        with patch.object(FakeTicker, 'history', pending), ThreadPoolExecutor(max_workers=2) as clients:
            first = clients.submit(self.service.quote, 'VOD.L')
            try:
                self.assertTrue(entered.wait(1))
                second = clients.submit(follower)
                self.assertTrue(follower_started.wait(1))
                self.assertFalse(duplicate.wait(0.1), 'same quote occupied both provider slots')
            finally:
                release.set()
            first_quote = first.result(timeout=1)
            second_quote = second.result(timeout=1)
        self.assertEqual(second_quote, first_quote)
        self.assertEqual(first_quote['quote']['rawPrice'], '123.123456789012345678901')
        self.assertEqual(calls, ['VOD.L'])

    def test_pending_quote_leaves_capacity_for_another_instrument(self):
        entered = threading.Event()
        release = threading.Event()
        follower_started = threading.Event()
        original = FakeTicker.history

        def pending(ticker, **kwargs):
            if ticker.symbol == 'VOD.L':
                entered.set()
                if not release.wait(2):
                    raise RuntimeError('test provider was not released')
            return original(ticker, **kwargs)

        def metadata(ticker, repair):
            return {**META, 'symbol': ticker.symbol}

        def follower():
            follower_started.set()
            return self.service.quote('VOD.L')

        with patch.object(FakeTicker, 'history', pending), patch.object(FakeTicker, 'get_history_metadata', metadata), ThreadPoolExecutor(max_workers=2) as clients:
            first = clients.submit(self.service.quote, 'VOD.L')
            try:
                self.assertTrue(entered.wait(1))
                second = clients.submit(follower)
                self.assertTrue(follower_started.wait(1))
                other = self.service.quote('AAPL')
                self.assertEqual(other['instrument']['symbol'], 'AAPL')
            finally:
                release.set()
            self.assertEqual(first.result(timeout=1), second.result(timeout=1))

    def test_failed_shared_quote_returns_503_to_waiters_and_can_retry(self):
        entered = threading.Event()
        duplicate = threading.Event()
        release = threading.Event()
        follower_started = threading.Event()
        attempts = []

        def failing(ticker, **kwargs):
            attempts.append(ticker.symbol)
            if len(attempts) > 1:
                duplicate.set()
            entered.set()
            if not release.wait(2):
                raise RuntimeError('test provider was not released')
            raise RuntimeError('provider unavailable')

        def follower():
            follower_started.set()
            return app.route(self.service, '/quote?symbol=VOD.L')

        with patch.object(FakeTicker, 'history', failing), ThreadPoolExecutor(max_workers=2) as clients:
            first = clients.submit(app.route, self.service, '/quote?symbol=VOD.L')
            try:
                self.assertTrue(entered.wait(1))
                second = clients.submit(follower)
                self.assertTrue(follower_started.wait(1))
                self.assertFalse(duplicate.wait(0.1))
            finally:
                release.set()
            self.assertEqual(first.result(timeout=1)[0], 503)
            self.assertEqual(second.result(timeout=1)[0], 503)
        self.assertEqual(attempts, ['VOD.L'])
        status, recovered = app.route(self.service, '/quote?symbol=VOD.L')
        self.assertEqual(status, 200)
        self.assertEqual(recovered['quote']['rawPrice'], '123.123456789012345678901')
        recovered['instrument']['name'] = 'changed by caller'
        recovered['quote']['rawPrice'] = '999'
        self.assertEqual(self.service.quote('VOD.L')['instrument']['name'], 'Vodafone')
        self.assertEqual(self.service.quote('VOD.L')['quote']['rawPrice'], '123.123456789012345678901')

    def test_upstream_capacity_rejects_requests_without_a_queue(self):
        import threading
        event=threading.Event()
        first=self.service.submit(lambda:event.wait(1))
        second=self.service.submit(lambda:event.wait(1))
        try:
            with self.assertRaises(app.Unavailable): self.service.quote('VOD.L')
        finally:
            event.set()
            first.result()
            second.result()
    def test_timeout_and_rate_limit_never_return_a_quote(self):
        import threading
        event=threading.Event()
        future=self.service.submit(lambda:event.wait(1))
        try:
            with self.assertRaises(app.Unavailable): self.service.wait(future,0.001)
        finally:
            event.set()
            future.result()
        with patch.object(FakeTicker,'history',side_effect=RuntimeError('rate limited')):
            self.assertEqual(app.route(self.service,'/quote?symbol=VOD.L')[0],503)
    def test_float_volume_becomes_integer_and_nonintegral_rows_are_rejected(self):
        frame = pd.DataFrame({'Open':[123.5,124.5,125.5], 'High':[126.5]*3, 'Low':[120.5]*3, 'Close':[124.5]*3, 'Volume':[123.0,123.5,0.0]}, index=pd.to_datetime(['2023-11-12T00:00:00Z','2023-11-13T00:00:00Z','2023-11-14T00:00:00Z']))
        with patch.object(FakeTicker,'frame',frame):
            result=self.service.history('VOD.L','1mo','15m')
        self.assertEqual([bar['volume'] for bar in result['items']],['123','0'])
        self.assertEqual([bar['observedAt'] for bar in result['items']],['2023-11-12T00:00:00Z','2023-11-14T00:00:00Z'])
    def test_current_yfinance_error_policy_returns_503_on_upstream_failure(self):
        def upstream_error(ticker, **kwargs):
            if 'raise_errors' in kwargs or app.yf.config.debug.hide_exceptions:
                return FakeTicker.frame.copy()
            raise RuntimeError('upstream failure with current config')
        with patch.object(FakeTicker,'history',upstream_error):
            self.assertEqual(app.route(self.service,'/quote?symbol=VOD.L')[0],503)

    def test_history_uses_requested_period_and_interval(self):
        original=FakeTicker.history
        def selected(ticker,**kwargs):
            if kwargs['period'] != '1mo' or kwargs['interval'] != '15m':
                raise RuntimeError('wrong history range')
            return original(ticker,**kwargs)
        with patch.object(FakeTicker,'history',selected):
            self.assertEqual(self.service.history('VOD.L','1mo','15m')['items'][0]['close'],'123.0')

    def test_http_contract_rejects_unknown_duplicate_oversized_and_invalid_parameters(self):
        for target in ['/quote','/quote?symbol=https://bad','/quote?symbol=AAPL&symbol=MSFT','/quote?symbol='+'A'*41,'/quote?symbol=AAPL&url=x','/history?symbol=AAPL&period=max','/fx?currency=AUD','/search?q='+'a'*81,'/search?q='+'%20'*81,'/search?q=%09']:
            with self.subTest(target=target):
                status, result=app.route(self.service,target)
                self.assertEqual(status,400)
                self.assertIn('error',result)
        self.assertEqual(app.route(self.service,'/health'),(200,{'ok':True}))
        self.assertEqual(app.route(self.service,'/missing')[0],404)
        FakeTicker.metadata={}
        self.assertEqual(app.route(self.service,'/quote?symbol=VOD.L')[0],503)

if __name__ == '__main__': unittest.main()
