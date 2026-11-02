-- Production provisions paper_owner and paper_app separately; migrations run as paper_owner.
-- Keep runtime DDL and financial-history mutation outside the application role.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO paper_app;

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,32}$'),
  email text NOT NULL UNIQUE CHECK (
    email = lower(btrim(email)) AND length(email) <= 254 AND email ~ '^[!-~]+@[!-~]+$'
  ),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users(id),
  base_currency text NOT NULL DEFAULT 'INR' CHECK (base_currency = 'INR'),
  cash_balance numeric(20,2) NOT NULL CHECK (cash_balance >= 0 AND cash_balance <= 999999999999999999.99),
  cash_sequence bigint NOT NULL CHECK (cash_sequence > 0),
  valuation_dirty boolean NOT NULL DEFAULT false
);

CREATE TABLE public.cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  account_sequence bigint NOT NULL CHECK (account_sequence > 0),
  amount numeric(20,2) NOT NULL,
  resulting_balance numeric(20,2) NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, account_sequence),
  -- This first slice permits only the single opening settlement. A trading
  -- migration must deliberately extend these constraints before adding trades.
  CONSTRAINT opening_credit_only CHECK (
    reason = 'OPENING_CREDIT' AND account_sequence = 1
    AND amount = 1000000.00 AND resulting_balance = 1000000.00
  )
);
CREATE UNIQUE INDEX cash_movements_one_opening ON public.cash_movements(account_id)
  WHERE reason = 'OPENING_CREDIT';

CREATE TABLE public.watchlist_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  is_default boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, name),
  UNIQUE (user_id, id)
);
CREATE UNIQUE INDEX watchlist_folders_one_default ON public.watchlist_folders(user_id) WHERE is_default;

CREATE FUNCTION public.protect_watchlist_folder() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_default THEN
      RAISE EXCEPTION 'Default folder cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.is_default IS DISTINCT FROM OLD.is_default THEN
    RAISE EXCEPTION 'Folder owner and default flag cannot be reassigned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_watchlist_folder() FROM PUBLIC;
CREATE TRIGGER protect_watchlist_folder BEFORE DELETE OR UPDATE ON public.watchlist_folders
  FOR EACH ROW EXECUTE FUNCTION public.protect_watchlist_folder();

CREATE TABLE public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id ON public.sessions(user_id);

REVOKE ALL ON TABLE public.users, public.accounts, public.cash_movements,
  public.watchlist_folders, public.sessions, public.schema_migrations FROM PUBLIC, paper_app;
GRANT SELECT, INSERT ON public.users, public.accounts, public.cash_movements TO paper_app;
GRANT SELECT, INSERT, DELETE ON public.watchlist_folders TO paper_app;
GRANT UPDATE (name) ON public.watchlist_folders TO paper_app;
GRANT SELECT, INSERT ON public.sessions TO paper_app;
GRANT UPDATE (revoked_at) ON public.sessions TO paper_app;
GRANT SELECT ON public.schema_migrations TO paper_app;
