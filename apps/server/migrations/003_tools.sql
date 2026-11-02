-- Owned user tools.
ALTER TABLE public.watchlist_folders ADD CONSTRAINT watchlist_folder_name_bound CHECK (length(name) <= 80);

CREATE TABLE public.watchlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  folder_id uuid NOT NULL,
  instrument_id uuid NOT NULL REFERENCES public.instruments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,folder_id) REFERENCES public.watchlist_folders(user_id,id),
  UNIQUE (folder_id,instrument_id)
);
CREATE INDEX watchlist_entries_owner ON public.watchlist_entries(user_id,id);

CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  instrument_id uuid REFERENCES public.instruments(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_owner ON public.notes(user_id,id);

CREATE TABLE public.price_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  instrument_id uuid NOT NULL REFERENCES public.instruments(id),
  condition text NOT NULL CHECK (condition IN ('ABOVE','BELOW')),
  target_price numeric(20,8) NOT NULL CHECK (target_price > 0 AND target_price <> 'NaN'),
  active boolean NOT NULL DEFAULT true,
  triggered_at timestamptz,
  triggered_observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id,id),
  CHECK ((active AND triggered_at IS NULL AND triggered_observed_at IS NULL)
    OR (NOT active AND triggered_at IS NOT NULL AND triggered_observed_at IS NOT NULL))
);
CREATE INDEX price_alerts_owner ON public.price_alerts(user_id,id);
CREATE INDEX price_alerts_active ON public.price_alerts(id) WHERE active;

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  alert_id uuid UNIQUE,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,alert_id) REFERENCES public.price_alerts(user_id,id) ON DELETE SET NULL (alert_id)
);
CREATE INDEX notifications_owner ON public.notifications(user_id,id);

REVOKE ALL ON public.watchlist_entries,public.notes,public.price_alerts,public.notifications FROM PUBLIC,paper_app;
GRANT SELECT,INSERT,DELETE ON public.watchlist_entries,public.notes,public.price_alerts TO paper_app;
GRANT UPDATE (folder_id) ON public.watchlist_entries TO paper_app;
GRANT UPDATE (title,body,instrument_id,updated_at) ON public.notes TO paper_app;
GRANT UPDATE (active,triggered_at,triggered_observed_at) ON public.price_alerts TO paper_app;
GRANT SELECT,INSERT ON public.notifications TO paper_app;
GRANT UPDATE (read_at) ON public.notifications TO paper_app;
