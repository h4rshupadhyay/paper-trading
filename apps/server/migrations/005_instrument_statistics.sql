ALTER TABLE public.instruments ADD COLUMN statistics_attempted_at timestamptz;
GRANT UPDATE(statistics_attempted_at) ON public.instruments TO paper_app;
CREATE TABLE public.latest_instrument_statistics (
  instrument_id uuid PRIMARY KEY REFERENCES public.instruments(id),
  open numeric(40,8), day_high numeric(40,8), day_low numeric(40,8), previous_close numeric(40,8),
  volume numeric(20,0), average_volume numeric(20,0), market_cap numeric(40,8), trailing_pe numeric(40,8),
  fifty_two_week_high numeric(40,8), fifty_two_week_low numeric(40,8),
  sector text, industry text, description text,
  provider text NOT NULL, fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (open>=0 AND day_high>=0 AND day_low>=0 AND previous_close>=0 AND volume>=0 AND average_volume>=0 AND market_cap>=0 AND fifty_two_week_high>=0 AND fifty_two_week_low>=0),
  CHECK (length(sector)<=256 AND length(industry)<=256 AND length(description)<=20000)
);
REVOKE ALL ON public.latest_instrument_statistics FROM PUBLIC,paper_app;
GRANT SELECT,INSERT,UPDATE ON public.latest_instrument_statistics TO paper_app;
