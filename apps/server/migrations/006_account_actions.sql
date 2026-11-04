CREATE TABLE public.account_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  instrument_id uuid NOT NULL REFERENCES public.instruments(id),
  kind text NOT NULL CHECK(kind IN ('SPLIT','DIVIDEND')),
  source_date date NOT NULL,
  effective_at timestamptz NOT NULL,
  quantity_before numeric(20,4) NOT NULL CHECK(quantity_before>0),
  quantity_delta numeric(20,4) NOT NULL,
  factor numeric(20,8) NOT NULL CHECK(factor>0 AND factor<>'NaN'),
  per_share numeric(20,8) NOT NULL CHECK(per_share>=0 AND per_share<>'NaN'),
  native_amount numeric(28,8) NOT NULL CHECK(native_amount>=0 AND native_amount<>'NaN'),
  fx_rate numeric(24,12) NOT NULL CHECK(fx_rate>0 AND fx_rate<>'NaN'),
  base_amount numeric(20,2) NOT NULL CHECK(base_amount>=0 AND base_amount<>'NaN'),
  fx_observed_at timestamptz NOT NULL,
  provider text NOT NULL CHECK(provider='yfinance'),
  UNIQUE(account_id,instrument_id,source_date,kind),
  CHECK ((kind='SPLIT' AND factor<>1 AND per_share=0 AND native_amount=0 AND base_amount=0 AND quantity_before+quantity_delta>0)
    OR (kind='DIVIDEND' AND factor=1 AND quantity_delta=0 AND per_share>0 AND native_amount>0 AND base_amount>0))
);
ALTER TABLE public.cash_movements ADD COLUMN action_id uuid UNIQUE REFERENCES public.account_actions(id);
ALTER TABLE public.cash_movements DROP CONSTRAINT valid_cash_movement;
ALTER TABLE public.cash_movements ADD CONSTRAINT valid_cash_movement CHECK (amount<>'NaN' AND resulting_balance BETWEEN 0 AND 999999999999999999.99 AND (
  (reason='OPENING_CREDIT' AND account_sequence=1 AND amount=1000000.00 AND resulting_balance=1000000.00 AND execution_id IS NULL AND action_id IS NULL)
  OR (reason='BUY' AND account_sequence>1 AND amount<0 AND execution_id IS NOT NULL AND action_id IS NULL)
  OR (reason='SELL' AND account_sequence>1 AND amount>0 AND execution_id IS NOT NULL AND action_id IS NULL)
  OR (reason='DIVIDEND' AND account_sequence>1 AND amount>0 AND execution_id IS NULL AND action_id IS NOT NULL)
));
CREATE TABLE public.demo_history_versions (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id),
  version integer NOT NULL CHECK(version>=3),
  source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
  accounting_digest text NOT NULL CHECK(accounting_digest ~ '^[0-9a-f]{64}$'),
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.account_actions,public.demo_history_versions FROM PUBLIC,paper_app;
GRANT SELECT,INSERT ON public.account_actions,public.demo_history_versions TO paper_app;
CREATE INDEX account_actions_history ON public.account_actions(account_id,effective_at,id);
