CREATE TABLE public.instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL CHECK (length(symbol) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 256),
  exchange text NOT NULL CHECK (length(exchange) BETWEEN 1 AND 64),
  currency text NOT NULL CHECK (currency IN ('INR','USD','GBP','EUR','JPY','HKD')),
  multiplier numeric(20,8) NOT NULL CHECK (multiplier IN (1,0.01)),
  kind text NOT NULL CHECK (kind IN ('EQUITY','INDEX')),
  tradable boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  provider text NOT NULL,
  unavailable_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  refresh_attempted_at timestamptz NOT NULL DEFAULT '-infinity',
  UNIQUE (provider,symbol),
  CHECK (kind <> 'INDEX' OR NOT tradable)
);
CREATE TABLE public.latest_quotes (
  instrument_id uuid PRIMARY KEY REFERENCES public.instruments(id),
  price numeric(20,8) NOT NULL CHECK (price > 0 AND price <> 'NaN'),
  observed_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  session text NOT NULL CHECK (session IN ('REGULAR','CLOSED','UNKNOWN')),
  raw_currency text NOT NULL CHECK (raw_currency IN ('INR','USD','GBP','GBp','EUR','JPY','HKD')),
  raw_price numeric NOT NULL CHECK (raw_price > 0 AND raw_price < 1e20),
  action_key text NOT NULL CHECK (length(action_key) BETWEEN 1 AND 256),
  provider text NOT NULL
);
CREATE TABLE public.latest_fx_rates (
  currency text PRIMARY KEY CHECK (currency IN ('INR','USD','GBP','EUR','JPY','HKD')),
  rate numeric(24,12) NOT NULL CHECK (rate > 0 AND rate <> 'NaN'),
  observed_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  provider text NOT NULL,
  CHECK (currency <> 'INR' OR rate = 1)
);
REVOKE ALL ON public.instruments,public.latest_quotes,public.latest_fx_rates FROM PUBLIC,paper_app;
GRANT SELECT,INSERT ON public.instruments TO paper_app;
GRANT UPDATE (name,exchange,tradable,paused,unavailable_reason,refresh_attempted_at) ON public.instruments TO paper_app;
GRANT SELECT,INSERT,UPDATE ON public.latest_quotes,public.latest_fx_rates TO paper_app;
CREATE INDEX instruments_refresh_attempted ON public.instruments(provider,refresh_attempted_at,id);
