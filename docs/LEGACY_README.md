# PaperTrade — Financial Investment & Portfolio Management System

A production-quality paper trading platform built with **Oracle 21c XE**, **Python Flask**, and **React**. Practice stock trading with $1,000,000 in virtual cash, real-time prices via Yahoo Finance, multi-currency support, and a clean Zerodha Kite-inspired UI.

---

## Features

### Core Trading
- **Authentication** — Register/login with bcrypt-hashed passwords and JWT sessions
- **Stock Search** — Debounced autocomplete with live prices from Yahoo Finance; `TickerInput` component reused across Alerts, Watchlist, and Dashboard for consistent ticker entry
- **Real-Time Quotes** — Open/High/Low/Close, % change, market cap, P/E ratio
- **Paper Trading** — Buy and sell stocks; PL/SQL triggers enforce all business rules
- **Portfolio Dashboard** — Live P&L, holdings table, portfolio growth chart

### New Features (v2)
- **Pending / Limit Orders** — Place Limit, Stop, and Stop-Limit orders that auto-fill when the market price hits your target; cancel open orders at any time
- **Price Alerts** — Set ABOVE/BELOW price alerts on any ticker; alerts fire automatically via the background scheduler and generate in-app notifications
- **Notifications** — In-app notification feed; unread count badge in the header; mark-as-read support
- **Trading Notes** — Create, edit, and delete personal notes optionally linked to a specific ticker
- **Analytics Dashboard** — Portfolio growth chart (7D/1M/3M/6M/1Y), sector allocation pie, cash vs. holdings donut, P/L bar chart per holding, top/bottom performer cards
- **Watchlist Folders** — Organise watchlist items into named folders; same ticker can appear in multiple lists; "All" tab shows every watched stock across all lists; add directly to a folder from the add form
- **Multi-Currency / Region Support** — Display all prices and P&L in USD, INR, GBP, EUR, JPY, or HKD; live FX rates fetched daily from Yahoo Finance with hardcoded fallbacks
- **Background Price Scheduler** — Daemon thread (`PriceScheduler`) refreshes active portfolio/watchlist/alert prices every **15 seconds**; checks pending orders and alerts on each tick; saves periodic portfolio snapshots every ~6 minutes
- **Full-Catalogue Price Refresh** — Secondary daemon (`price_refresh`) keeps the entire stock catalogue fresh every **300 seconds** and persists prices to the DB
- **Thread-Safe In-Memory Cache** — `PriceCache` with separate TTLs (30 s price, 60 s full quote); deduplication prevents parallel fetches for the same ticker
- **Health Check Endpoint** — `GET /api/health` returns service status and cache size
- **Watchlist** — Add/remove stocks, track price changes; organised into folders
- **Order History** — Paginated, immutable transaction ledger
- **Charts** — Line and candlestick charts across 7 time periods
- **Dark / Light Theme** — Toggleable, persisted across sessions
- **Responsive UI** — Collapsible sidebar on mobile

---

## Tech Stack

| Layer       | Technology                                      |
|-------------|-------------------------------------------------|
| Database    | Oracle 21c XE (SQL + PL/SQL)                    |
| Backend     | Python 3.12, Flask, oracledb                    |
| Auth        | JWT (flask-jwt-extended), bcrypt                |
| Market Data | yfinance (Yahoo Finance)                        |
| FX Rates    | yfinance Forex tickers (USDINR=X, etc.)         |
| Frontend    | React 18, React Router v6, Vite                 |
| Charts      | Recharts                                        |
| Icons       | Lucide React                                    |
| Dev Infra   | Docker, Docker Compose                          |

---

## Project Structure

```
paper-trading/
├── docker-compose.yml         Single command to start DB + backend + frontend
├── database/
│   ├── setup.sql              Master script — runs all four files in order
│   ├── 01_schema.sql          Tables, indexes, constraints (3NF)
│   ├── 02_triggers.sql        Business-rule enforcement triggers
│   ├── 03_procedures.sql      PL/SQL packages, functions, views
│   └── 04_sample_data.sql     25 stock seeds + demo user
│
├── backend/
│   ├── Dockerfile
│   ├── entrypoint.sh          Docker container startup script
│   ├── scripts/
│   │   └── seed_demo.py       Seed demo user + sample portfolio data
│   ├── app.py                 Flask application factory (v2: scheduler, migrations)
│   ├── config.py              Configuration (env vars, starting balance = $1,000,000)
│   ├── utils.py               Shared helpers (get_uid, scalar_out)
│   ├── requirements.txt
│   ├── .env.example
│   ├── db/
│   │   ├── connection.py      Oracle connection pool + DBCursor context manager
│   │   ├── schema_cache.sql   Cache table DDL
│   │   └── migrations/
│   │       ├── 001_notes.sql           NOTES table
│   │       ├── 002_watchlist_folders.sql  WATCHLIST_FOLDERS + folder_id column
│   │       ├── 003_pending_orders.sql  PENDING_ORDERS table
│   │       └── 004_alerts.sql          PRICE_ALERTS + NOTIFICATIONS tables
│   ├── routes/
│   │   ├── auth.py            /register  /login  /me  /logout
│   │   ├── stocks.py          /stocks/search  /stocks/<ticker>  /history
│   │   ├── trading.py         /buy  /sell  /orders
│   │   ├── portfolio.py       /portfolio  /portfolio/snapshots
│   │   ├── watchlist.py       /watchlist  /watchlist/folders  (CRUD + folder ops)
│   │   ├── notes.py           /notes  (CRUD)
│   │   ├── pending_orders.py  /orders/pending  (place, list, cancel)
│   │   └── alerts.py          /alerts  /notifications  (CRUD + mark-read)
│   └── services/
│       ├── auth_service.py
│       ├── stock_service.py
│       ├── trading_service.py
│       ├── portfolio_service.py
│       ├── watchlist_service.py
│       ├── notes_service.py
│       ├── pending_order_service.py   (+ check_and_fill / check_and_fill_all)
│       ├── alert_service.py           (+ check_alerts)
│       ├── cache.py                   PriceCache (thread-safe, TTL-aware)
│       ├── scheduler.py               PriceScheduler daemon (15 s tick)
│       ├── price_refresh.py           Full-catalogue refresh daemon (300 s)
│       ├── market_data.py             yfinance wrapper + batch refresh
│       └── fx_service.py              Daily FX rates (USD/INR/GBP/EUR/JPY/HKD)
│
└── frontend/
    ├── Dockerfile
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx             Router + auth guards
        ├── services/api.js     Axios instance + all API calls
        ├── context/
        │   ├── AuthContext.jsx
        │   ├── ThemeContext.jsx
        │   └── RegionContext.jsx      ← NEW: currency/region state + formatters
        ├── hooks/
        │   ├── useDebounce.js
        │   └── useLocalStorage.js
        ├── components/
        │   ├── Sidebar.jsx
        │   ├── Header.jsx             (notification bell + unread badge)
        │   ├── StockSearch.jsx
        │   ├── TickerInput.jsx        ← NEW: autocomplete ticker search input
        │   ├── PriceChart.jsx
        │   ├── OrderForm.jsx
        │   └── LoadingSkeleton.jsx
        └── pages/
            ├── Login.jsx
            ├── Register.jsx
            ├── Dashboard.jsx
            ├── StockDetail.jsx
            ├── Orders.jsx
            ├── Watchlist.jsx          (+ folder management)
            ├── PendingOrders.jsx      ← NEW
            ├── Alerts.jsx             ← NEW
            ├── Notes.jsx              ← NEW
            └── Analytics.jsx          ← NEW
```

---

## Database Schema

### Core Tables (01_schema.sql)

```
USERS               — Registered users with paper-money balance ($1,000,000 default)
STOCKS              — Stock catalogue (populated on first search/trade)
TRANSACTIONS        — Immutable trade ledger (BUY / SELL)
HOLDINGS            — Live open positions per user (maintained by trigger)
WATCHLIST           — User-specific stock watchlist
PORTFOLIO_SNAPSHOTS — Periodic portfolio valuations for growth chart
```

### Migration Tables (auto-applied at startup)

```
NOTES               — User trading journal entries, optionally linked to a ticker
WATCHLIST_FOLDERS   — Named folders for organising watchlist items
PENDING_ORDERS      — Limit / Stop / Stop-Limit orders awaiting execution
PRICE_ALERTS        — Price threshold alerts (ABOVE / BELOW) per user/ticker
NOTIFICATIONS       — In-app notifications generated when an alert triggers
005 (index)         — Replaces UNIQUE(user_id, stock_id) with UNIQUE(user_id, stock_id, NVL(folder_id,-1))
                      allowing the same ticker in multiple watchlist folders
```

### PL/SQL Objects

| Object | Type | Purpose |
|---|---|---|
| `trg_validate_trade` | BEFORE INSERT trigger | Blocks oversells; checks cash balance; sets `total_amount` |
| `trg_update_holdings` | AFTER INSERT trigger | Upserts holdings with VWAP cost basis; deletes zero-qty rows |
| `trg_update_user_balance` | AFTER INSERT trigger | Deducts cash on BUY, credits on SELL |
| `trg_stocks_upper_ticker` | BEFORE INSERT/UPDATE trigger | Forces tickers to uppercase |
| `pkg_trading.execute_buy` | Procedure | Validates, resolves stock, inserts transaction |
| `pkg_trading.execute_sell` | Procedure | Validates, inserts transaction |
| `pkg_trading.upsert_stock` | Function | Inserts stock if not in catalogue; returns stock_id |
| `pkg_portfolio.get_portfolio_value` | Function | Returns user's cash balance |
| `pkg_portfolio.save_snapshot` | Procedure | Saves a portfolio valuation snapshot |
| `pkg_portfolio.get_holding_pl` | Function | Calculates P&L for one holding |
| `fn_user_total_invested` | Function | Sum of all open cost bases |
| `vw_user_holdings_detail` | View | Holdings joined with stock info |
| `vw_transaction_history` | View | Transactions joined with stock info |

---

## Setup & Installation

### Option A — Docker Compose (recommended)

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)

```bash
# First run — builds images and initialises the database (~2–3 min)
docker compose up --build

# Subsequent runs
docker compose up
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:5000 |
| Oracle | localhost:1521 (XEPDB1) |

The SQL init scripts (`01_schema.sql` → `04_sample_data.sql`) run automatically on first boot. Migration scripts (`001_notes.sql` → `005_watchlist_multi_folder.sql`) are applied automatically every time the backend starts — they are idempotent and safe to re-run. Database state persists in a named Docker volume (`oracle_data`) between restarts.

**Useful commands:**

```bash
# Stop all services
docker compose down

# Stop and wipe the database volume (full reset)
docker compose down -v

# View logs for one service
docker compose logs -f backend
```

> **Note:** The backend waits for the Oracle healthcheck to pass before starting, so the first `docker compose up` will appear to hang for ~2 minutes while Oracle initialises — this is normal.

---

### Option B — Manual Setup

**Prerequisites:**
- Oracle Database 19c or XE (with SQL Developer / SQL*Plus)
- Python 3.12 (3.11+ supported; 3.14 is not — `oracledb` wheels not yet available)
- Node.js 18+

#### 1. Database

Run the master setup script from the project root using SQL*Plus or SQLcl:

```bash
sqlplus your_user/your_pass@localhost:1521/XEPDB1 @database/setup.sql
```

Or open each script in SQL Developer and run them in order:

```sql
@database/01_schema.sql       -- Tables, indexes, constraints
@database/02_triggers.sql     -- Business-rule triggers
@database/03_procedures.sql   -- Packages, procedures, views
@database/04_sample_data.sql  -- 25 stock seeds + demo user
```

> **Note:** The demo user `demo_trader` in `04_sample_data.sql` has a placeholder password hash. Register a real account through the UI instead.
>
> The migration tables (`NOTES`, `WATCHLIST_FOLDERS`, `PENDING_ORDERS`, `PRICE_ALERTS`, `NOTIFICATIONS`) are created automatically when the Flask backend starts for the first time.

#### 2. Backend

```bash
cd backend
cp .env.example .env   # then edit .env with your Oracle credentials
```

```env
FLASK_DEBUG=1
SECRET_KEY=your-long-random-secret-key
ORACLE_USER=trader
ORACLE_PASSWORD=trader
ORACLE_DSN=localhost:1521/XEPDB1
JWT_SECRET_KEY=another-long-random-secret
JWT_ACCESS_TOKEN_EXPIRES=86400
```

```bash
pip install -r requirements.txt
python app.py
# API running at http://localhost:5000
```

> **Oracle Instant Client (thick mode):** uncomment and set `lib_dir` in [db/connection.py](backend/db/connection.py).

#### 3. Frontend

```bash
cd frontend
npm install
npm run dev
# UI running at http://localhost:3000
```

The Vite dev server proxies all `/api/*` requests to `http://localhost:5000`, so no CORS issues during development.

---

## REST API Reference

All endpoints (except `/register` and `/login`) require:
```
Authorization: Bearer <jwt_token>
```

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/register` | Create a new account |
| POST | `/api/login` | Login, returns JWT token |
| GET  | `/api/me` | Get current user profile |
| POST | `/api/logout` | Invalidate session (client-side) |

### Stocks
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stocks/search?q=AAPL` | Autocomplete search |
| GET | `/api/stocks/<ticker>` | Live quote + key stats |
| GET | `/api/stocks/<ticker>/history?period=1mo&interval=1d` | OHLCV history |

### Trading
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/buy` | Execute a market buy `{ticker, quantity, price}` |
| POST | `/api/sell` | Execute a market sell `{ticker, quantity, price}` |
| GET  | `/api/orders?page=1&per_page=20` | Paginated transaction history |

### Pending (Limit/Stop) Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST   | `/api/orders/pending` | Place a limit/stop order `{ticker, side, order_type, quantity, limit_price?, stop_price?, expires_at?}` |
| GET    | `/api/orders/pending?status=OPEN` | List pending orders (status: OPEN \| FILLED \| CANCELLED) |
| DELETE | `/api/orders/pending/<order_id>` | Cancel an open order |

### Portfolio
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/portfolio` | Holdings with live P&L |
| GET | `/api/portfolio/snapshots?days=30` | Portfolio growth history |

### Watchlist
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/watchlist` | Get all watchlist items with live prices + all folders |
| POST   | `/api/watchlist` | Add a ticker `{ticker, folder_id?}` — same ticker allowed in multiple folders |
| DELETE | `/api/watchlist/<ticker>` | Remove all entries for a ticker (full unwatch) |
| DELETE | `/api/watchlist/item/<watchlist_id>` | Remove a single list entry by ID |
| POST   | `/api/watchlist/folders` | Create a folder `{name}` |
| PATCH  | `/api/watchlist/folders/<folder_id>` | Rename a folder `{name}` |
| DELETE | `/api/watchlist/folders/<folder_id>` | Delete a folder |
| PATCH  | `/api/watchlist/<watchlist_id>/folder` | Move item to folder `{folder_id}` |

### Notes
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/notes?ticker=AAPL` | List notes (optional ticker filter) |
| GET    | `/api/notes/<note_id>` | Get a single note |
| POST   | `/api/notes` | Create a note `{title, body?, ticker?}` |
| PUT    | `/api/notes/<note_id>` | Update note `{title?, body?}` |
| DELETE | `/api/notes/<note_id>` | Delete a note |

### Alerts & Notifications
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET    | `/api/alerts` | List active price alerts |
| POST   | `/api/alerts` | Create an alert `{ticker, condition, target_price}` — condition: `ABOVE` or `BELOW` |
| DELETE | `/api/alerts/<alert_id>` | Delete an alert |
| GET    | `/api/notifications?unread_only=true` | List notifications |
| POST   | `/api/notifications/read` | Mark notifications as read `{ids: [...]}` |

### Health
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Service status + cache entry count |

---

## Pages

| Route | Page | Description |
|-------|------|-------------|
| `/login` | Login | Username + password sign-in |
| `/register` | Register | New account with $1,000,000 starting balance |
| `/dashboard` | Dashboard | Portfolio stats, growth chart, holdings table |
| `/stocks/:ticker` | Stock Detail | Live quote, key stats, interactive chart, trade button |
| `/watchlist` | Watchlist | Add/remove stocks; organise into folders; quick trade |
| `/orders` | Orders | Full paginated market order history |
| `/pending-orders` | Pending Orders | Limit/Stop orders — place, view status, cancel |
| `/alerts` | Alerts | Set and manage price alerts; view triggered notifications |
| `/notes` | Notes | Personal trading journal; filter by ticker |
| `/analytics` | Analytics | Portfolio analytics — growth chart, sector allocation, P/L breakdown |

---

## Business Rules

1. **Oversell prevention** — `trg_validate_trade` raises `ORA-20001` if sell quantity exceeds holdings
2. **Insufficient funds** — Same trigger raises `ORA-20002` if cash balance is too low
3. **Immutable ledger** — The `TRANSACTIONS` table is never updated or deleted; holdings are derived from it
4. **VWAP cost basis** — `trg_update_holdings` recalculates average buy price as a volume-weighted average on each new purchase
5. **Portfolio snapshots** — Saved after every trade and periodically every ~6 minutes by the scheduler for the growth chart; uses `NUMTODSINTERVAL` for correct date arithmetic on multi-day ranges
6. **Pending order auto-fill** — Every scheduler tick (~15 s), `check_and_fill_all` evaluates all OPEN pending orders against the current cached price and executes the trade when triggered; BUY SL-M triggers when price rises to/above stop; SELL SL-M triggers when price falls to/below stop
7. **Alert one-shot** — Once a price alert fires it is marked `is_active = 0`; a notification row is inserted and the user's unread count increments; alert tickers are included in the scheduler's active ticker list even if not held or watched
8. **Idempotent migrations** — Migration scripts use `CREATE TABLE … IF NOT EXISTS` equivalent patterns so they can be safely re-applied on restart

---

## Background Services

| Service | Class / Function | Interval | What it does |
|---------|-----------------|----------|--------------|
| Price Scheduler | `PriceScheduler` | 15 s | Fetches prices for active holdings + watchlist + alert tickers; checks pending orders; fires alerts; saves periodic portfolio snapshots every ~6 min |
| Price Refresh Daemon | `start_refresh_daemon` | 300 s | Refreshes the entire stock catalogue; persists prices to DB |
| FX Rate Service | `fx_service.get_rates()` | Daily | Fetches live forex rates from yfinance; used by the region/currency context |

---

## Multi-Currency Support

The frontend `RegionContext` lets users switch display currency. All monetary values are internally stored in the stock's native currency but converted on the fly using the FX service.

Supported regions/currencies:

| Region | Currency | Symbol |
|--------|----------|--------|
| US | USD | $ |
| India | INR | ₹ |
| UK | GBP | £ |
| Europe | EUR | € |
| Japan | JPY | ¥ |
| Hong Kong | HKD | HK$ |

> **Note:** Cash balance is stored in INR by default (based on `STARTING_BALANCE = 1,000,000`). The region context converts it to the selected display currency using live daily FX rates.

---

## Configuration Reference

| Variable | Default (manual) | Docker default | Description |
|----------|-----------------|----------------|-------------|
| `ORACLE_USER` | `system` | `trader` | Oracle DB username |
| `ORACLE_PASSWORD` | `oracle` | `trader` | Oracle DB password |
| `ORACLE_DSN` | `localhost:1521/XEPDB1` | `db:1521/XEPDB1` | Oracle connection string |
| `SECRET_KEY` | `dev-secret-change-me` | — | Flask secret (change in production) |
| `JWT_SECRET_KEY` | same as SECRET_KEY | — | JWT signing secret (change in production) |
| `JWT_ACCESS_TOKEN_EXPIRES` | `86400` | `86400` | Token lifetime in seconds (24 hours) |
| `FLASK_DEBUG` | `0` | `1` | Enable Flask debug mode |
| `PRICE_REFRESH_INTERVAL` | `300` | `300` | Full catalogue refresh interval (seconds) |
| `PRICE_STALE_SECONDS` | `600` | `600` | Age threshold before a cached price is considered stale |

When using Docker Compose, `ORACLE_DSN` is automatically overridden to `db:1521/XEPDB1` (using the `db` service name) regardless of what is set in `backend/.env`.

---

## Known Issues & Potential Bugs

> These are documented for awareness and future fixes.

### Backend

1. **`STARTING_BALANCE` mismatch** — `config.py` sets `STARTING_BALANCE = 1_000_000.00` but the README previously advertised $100,000. Ensure `04_sample_data.sql` and any seed `INSERT` statements use the same value, otherwise new accounts created via the UI and seeded demo accounts will have different balances.

2. **`alert_service.mark_read` SQL injection risk (low severity)** — The placeholders string is built via f-string with `len(notif_ids)`. Since the count, not the values, drives the f-string this is safe in practice, but the pattern is fragile. Prefer a fixed `IN (SELECT column_value FROM TABLE(:1))` binding.

3. **`price_cache` singleton shared between Flask workers** — If the backend is later scaled with multiple processes (e.g. gunicorn `--workers N`), each worker will have its own in-memory cache, leading to stale/inconsistent prices across workers. For multi-process deployments, migrate the cache to Redis.

### Frontend

5. **`PriceScheduler` ticker list refreshes every 60 s** — Stocks added to a watchlist or bought within the last 60 s may not be refreshed until the next ticker-list reload. This is by design but can cause temporarily stale prices on newly added items.

---

## Production Checklist

- [ ] Set strong `SECRET_KEY` and `JWT_SECRET_KEY` in `.env`
- [ ] Change the default `trader` / `oracle` database passwords
- [ ] Run backend with `gunicorn` (Linux/macOS) or `waitress` (Windows) — **not** `python app.py`
- [ ] Build frontend with `npm run build` and serve via Nginx or a static host
- [ ] Enable HTTPS — update `CORS_ORIGINS` in `config.py` accordingly
- [ ] Consider rate-limiting `/api/stocks/*` endpoints (Yahoo Finance has informal limits)
- [ ] For multi-process deployments, migrate `PriceCache` to Redis to share state across workers

---

## Screenshots

| Page | Description |
|------|-------------|
| Dashboard | Portfolio value, P&L stats, growth chart, holdings table |
| Stock Detail | Live price, candlestick chart, key statistics, trade modal |
| Watchlist | Live price tracking with folder organisation and quick-trade buttons |
| Orders | Full market order history with pagination |
| Pending Orders | Limit/Stop order management — status tracking, cancel |
| Alerts | Price alert setup and in-app notification feed |
| Notes | Trading journal with optional ticker tagging |
| Analytics | Sector allocation, cash vs. holdings, P/L breakdown, top/bottom performers |

---

## License

This project is for educational purposes as part of a **Database Systems Lab** demonstrating Oracle normalization, PL/SQL triggers, stored procedures, and real-time analytics.
