# Frontend surface inventory (observed)

This is a factual inventory of the four inspected files only. API paths below are relative to the Axios base URL `/api` (api.js lines 6–11). No future contract or implementation is inferred.

## Routed pages

| Page component | Browser path | Access | Source |
|---|---|---|---|
| Login | `/login` | Public | `frontend/src/App.jsx:58-62` |
| Register | `/register` | Public | `frontend/src/App.jsx:58-62` |
| Dashboard | `/dashboard` | Protected | `frontend/src/App.jsx:64-67` |
| StockDetail | `/stocks/:ticker` | Protected | `frontend/src/App.jsx:64-68` |
| Orders | `/orders` | Protected | `frontend/src/App.jsx:64-69` |
| Watchlist | `/watchlist` | Protected | `frontend/src/App.jsx:64-70` |
| PendingOrders | `/pending-orders` | Protected | `frontend/src/App.jsx:64-71` |
| Alerts | `/alerts` | Protected | `frontend/src/App.jsx:64-72` |
| Notes | `/notes` | Protected | `frontend/src/App.jsx:64-73` |
| Analytics | `/analytics` | Protected | `frontend/src/App.jsx:64-74` |

Access classification follows the nesting under `PublicLayout` and `ProtectedLayout`. Protected routes wait during auth loading and redirect unauthenticated users to `/login`; public routes wait and redirect logged-in users to `/dashboard`. The catch-all redirects to `/dashboard`. Source: `frontend/src/App.jsx:19-49, 76-78`.

## Exported HTTP wrappers

“Inputs” lists declared function arguments and the request data/query/path placement visible in `api.js`. Paths are relative to `/api`. No headers beyond the shared interceptor are repeated here.

| Exported wrapper | Method | Path | Declared request inputs | Source |
|---|---|---|---|---|
| `authAPI.register` | POST | `/register` | Body `{username, email, password}`; args `username, email, password` | `frontend/src/services/api.js:36-38` |
| `authAPI.login` | POST | `/login` | Body `{username, password}`; args `username, password` | `frontend/src/services/api.js:39-40` |
| `authAPI.me` | GET | `/me` | None | `frontend/src/services/api.js:41` |
| `authAPI.logout` | POST | `/logout` | None | `frontend/src/services/api.js:42` |
| `stocksAPI.search` | GET | `/stocks/search` | Query `q` | `frontend/src/services/api.js:46-47` |
| `stocksAPI.quote` | GET | `/stocks/${ticker}` | Path `ticker` | `frontend/src/services/api.js:48` |
| `stocksAPI.history` | GET | `/stocks/${ticker}/history` | Path `ticker`; query `period='1mo'`, `interval='1d'` | `frontend/src/services/api.js:49-50` |
| `stocksAPI.indexQuote` | GET | `/stocks/index/${ticker}` | Path `ticker` | `frontend/src/services/api.js:51` |
| `currencyAPI.rates` | GET | `/currency/rates` | None | `frontend/src/services/api.js:54-56` |
| `tradingAPI.buy` | POST | `/buy` | Body `{ticker, quantity, price}`; same args | `frontend/src/services/api.js:59-61` |
| `tradingAPI.sell` | POST | `/sell` | Body `{ticker, quantity, price}`; same args | `frontend/src/services/api.js:62-63` |
| `tradingAPI.orders` | GET | `/orders` | Query `page=1`, `per_page=20` | `frontend/src/services/api.js:64-65` |
| `portfolioAPI.get` | GET | `/portfolio` | None | `frontend/src/services/api.js:69-70` |
| `portfolioAPI.snapshots` | GET | `/portfolio/snapshots` | Query `days=30` | `frontend/src/services/api.js:71-72` |
| `watchlistAPI.get` | GET | `/watchlist` | None | `frontend/src/services/api.js:76-77` |
| `watchlistAPI.add` | POST | `/watchlist` | Body `{ticker, folder_id}`; `folder_id=null` default | `frontend/src/services/api.js:78` |
| `watchlistAPI.remove` | DELETE | `/watchlist/${ticker}` | Path `ticker` | `frontend/src/services/api.js:79` |
| `watchlistAPI.removeItem` | DELETE | `/watchlist/item/${watchlist_id}` | Path `watchlist_id` | `frontend/src/services/api.js:80` |
| `watchlistAPI.createFolder` | POST | `/watchlist/folders` | Body `{name}` | `frontend/src/services/api.js:81` |
| `watchlistAPI.renameFolder` | PATCH | `/watchlist/folders/${id}` | Path `id`; body `{name}` | `frontend/src/services/api.js:82` |
| `watchlistAPI.deleteFolder` | DELETE | `/watchlist/folders/${id}` | Path `id` | `frontend/src/services/api.js:83` |
| `watchlistAPI.moveItem` | PATCH | `/watchlist/${watchlist_id}/folder` | Path `watchlist_id`; body `{folder_id}` | `frontend/src/services/api.js:84-85` |
| `notesAPI.list` | GET | `/notes` | Optional query `ticker`; omitted/empty when falsy | `frontend/src/services/api.js:89-90` |
| `notesAPI.get` | GET | `/notes/${id}` | Path `id` | `frontend/src/services/api.js:91` |
| `notesAPI.create` | POST | `/notes` | Body `{title, body, ticker}` | `frontend/src/services/api.js:92` |
| `notesAPI.update` | PUT | `/notes/${id}` | Path `id`; body `{title, body}` | `frontend/src/services/api.js:93` |
| `notesAPI.delete` | DELETE | `/notes/${id}` | Path `id` | `frontend/src/services/api.js:94` |
| `pendingOrdersAPI.list` | GET | `/orders/pending` | Query `status='OPEN'` | `frontend/src/services/api.js:98-99` |
| `pendingOrdersAPI.place` | POST | `/orders/pending` | Forwards argument `data` as body; its shape is not established | `frontend/src/services/api.js:100` |
| `pendingOrdersAPI.cancel` | DELETE | `/orders/pending/${id}` | Path `id` | `frontend/src/services/api.js:101` |
| `alertsAPI.list` | GET | `/alerts` | None | `frontend/src/services/api.js:105-106` |
| `alertsAPI.create` | POST | `/alerts` | Body `{ticker, condition, target_price}` | `frontend/src/services/api.js:107-108` |
| `alertsAPI.delete` | DELETE | `/alerts/${id}` | Path `id` | `frontend/src/services/api.js:109` |
| `alertsAPI.notifications` | GET | `/notifications` | Query `unread_only=true` | `frontend/src/services/api.js:110-111` |
| `alertsAPI.markRead` | POST | `/notifications/read` | Body `{ids}` | `frontend/src/services/api.js:112` |

## Build and proxy configuration

| Item | Observed value | Source |
|---|---|---|
| `dev` script | `vite` | `frontend/package.json:6-7` |
| `build` script | `vite build` | `frontend/package.json:8` |
| `preview` script | `vite preview` | `frontend/package.json:9` |
| Dev server port / host | `3000` / `0.0.0.0` | `frontend/vite.config.js:6-8` |
| `/api` proxy target | `process.env.VITE_API_TARGET || 'http://localhost:5000'` | `frontend/vite.config.js:9-13` |

## Bearer token and 401 behavior

The Axios instance uses base URL `/api` and JSON content type. Before each request it reads `localStorage.token`; when present, it sets `Authorization: Bearer <token>`. On response status 401, it removes `token` and `user` from local storage, sets `window.location.href` to `/login`, then rejects the promise. What the server returns or whether any endpoints require authentication is not established by these four files. Source: `frontend/src/services/api.js:6-11, 13-33`.
