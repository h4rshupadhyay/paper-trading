ALTER TABLE public.accounts ADD COLUMN valuation_checked_at timestamptz NOT NULL DEFAULT '-infinity';
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  instrument_id uuid NOT NULL REFERENCES public.instruments(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 128),
  intent_fingerprint text NOT NULL CHECK(intent_fingerprint ~ '^[0-9a-f]{64}$'),
  side text NOT NULL CHECK(side IN ('BUY','SELL')),
  type text NOT NULL CHECK(type IN ('MARKET','LIMIT','STOP','STOP_LIMIT')),
  quantity numeric(20,4) NOT NULL CHECK(quantity>0 AND quantity<>'NaN'),
  limit_price numeric(20,8) CHECK(limit_price>0 AND limit_price<>'NaN'),
  stop_price numeric(20,8) CHECK(stop_price>0 AND stop_price<>'NaN'),
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','TRIGGERED','FILLED','REJECTED','CANCELLED','EXPIRED')),
  rejection_reason text,
  triggered_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evaluated_at timestamptz NOT NULL DEFAULT '-infinity',
  UNIQUE(account_id,idempotency_key),
  CHECK ((type IN ('LIMIT','STOP_LIMIT'))=(limit_price IS NOT NULL)),
  CHECK ((type IN ('STOP','STOP_LIMIT'))=(stop_price IS NOT NULL)),
  CHECK ((status='REJECTED')=(rejection_reason IS NOT NULL))
);
CREATE INDEX orders_live ON public.orders(account_id,evaluated_at,created_at,id) WHERE status IN ('OPEN','TRIGGERED');
CREATE TABLE public.executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  instrument_id uuid NOT NULL REFERENCES public.instruments(id),
  side text NOT NULL CHECK(side IN ('BUY','SELL')),
  quantity numeric(20,4) NOT NULL CHECK(quantity>0 AND quantity<>'NaN'),
  price numeric(20,8) NOT NULL CHECK(price>0 AND price<>'NaN'),
  currency text NOT NULL,
  native_amount numeric(28,8) NOT NULL CHECK(native_amount>0 AND native_amount<>'NaN'),
  fx_rate numeric(24,12) NOT NULL CHECK(fx_rate>0 AND fx_rate<>'NaN'),
  settlement numeric(20,2) NOT NULL CHECK(settlement>0 AND settlement<>'NaN'),
  allocated_native_cost numeric(28,8) NOT NULL CHECK(allocated_native_cost>=0 AND allocated_native_cost<>'NaN'),
  allocated_base_cost numeric(28,8) NOT NULL CHECK(allocated_base_cost>=0 AND allocated_base_cost<>'NaN'),
  realized_pl numeric(28,8) NOT NULL CHECK(realized_pl<>'NaN'),
  quote_observed_at timestamptz NOT NULL,
  fx_observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX executions_account ON public.executions(account_id,created_at DESC,id DESC);
CREATE TABLE public.positions (
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  instrument_id uuid NOT NULL REFERENCES public.instruments(id),
  quantity numeric(20,4) NOT NULL CHECK(quantity>0 AND quantity<>'NaN'),
  native_cost numeric(28,8) NOT NULL CHECK(native_cost>=0 AND native_cost<>'NaN'),
  base_cost numeric(28,8) NOT NULL CHECK(base_cost>=0 AND base_cost<>'NaN'),
  PRIMARY KEY(account_id,instrument_id)
);
ALTER TABLE public.cash_movements ADD COLUMN execution_id uuid UNIQUE REFERENCES public.executions(id);
ALTER TABLE public.cash_movements DROP CONSTRAINT opening_credit_only;
ALTER TABLE public.cash_movements ADD CONSTRAINT valid_cash_movement CHECK (amount<>'NaN' AND resulting_balance BETWEEN 0 AND 999999999999999999.99 AND (
  (reason='OPENING_CREDIT' AND account_sequence=1 AND amount=1000000.00 AND resulting_balance=1000000.00 AND execution_id IS NULL)
  OR (reason='BUY' AND account_sequence>1 AND amount<0 AND execution_id IS NOT NULL)
  OR (reason='SELL' AND account_sequence>1 AND amount>0 AND execution_id IS NOT NULL)
));
CREATE TABLE public.portfolio_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  account_sequence bigint NOT NULL,
  sample_bucket timestamptz NOT NULL,
  sampled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cash_balance numeric(20,2) NOT NULL CHECK(cash_balance>=0 AND cash_balance<>'NaN'),
  holdings_value numeric(28,2) NOT NULL CHECK(holdings_value>=0 AND holdings_value<>'NaN'),
  total_value numeric(28,2) NOT NULL CHECK(total_value>=0 AND total_value<>'NaN'),
  unrealized_pl numeric(28,8) NOT NULL CHECK(unrealized_pl<>'NaN'),
  quality text NOT NULL CHECK(quality IN ('fresh','stale','review')),
  observed_from timestamptz,
  observed_to timestamptz,
  UNIQUE(account_id,sample_bucket)
);
CREATE INDEX portfolio_snapshots_account ON public.portfolio_snapshots(account_id,sampled_at DESC,id DESC);
CREATE TABLE public.worker_status (
  id text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  refresh_success_at timestamptz,
  pending_success_at timestamptz,
  alerts_success_at timestamptz,
  snapshots_success_at timestamptz,
  last_error text,
  incomplete_accounts integer NOT NULL DEFAULT 0
);
REVOKE ALL ON public.orders,public.positions,public.executions,public.portfolio_snapshots,public.worker_status FROM PUBLIC,paper_app;
GRANT SELECT,INSERT,UPDATE ON public.orders TO paper_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.positions TO paper_app;
GRANT SELECT,INSERT ON public.executions,public.portfolio_snapshots TO paper_app;
GRANT UPDATE(account_sequence,sampled_at,cash_balance,holdings_value,total_value,unrealized_pl,quality,observed_from,observed_to) ON public.portfolio_snapshots TO paper_app;
GRANT SELECT,INSERT,UPDATE ON public.worker_status TO paper_app;
GRANT UPDATE(cash_balance,cash_sequence,valuation_dirty,valuation_checked_at) ON public.accounts TO paper_app;
