# Interaction and failure inventory

Scope: active React/Express/PostgreSQL application, market-data sidecar, worker and local Compose deployment as of 4 November 2026. This is a finite behavior catalogue and test map, not a claim of exhaustive input or concurrency coverage. See [execution results](RESULTS_2026-11-04.md), [browser case detail](UI_INTERACTIONS.md), and [seeded logic cases](LOGIC_CASES.md).

The later [internal API refresh follow-up](INTERNAL_API_REFRESH_2026-11-04.md) adds UI-029–UI-034 for immediate confirmed writes, notification synchronisation, quieter visible-tab polling and response-order protection.

The [same-app demo seed](DEMO_USER_2026-11-04.md) adds an explicit idempotent demo-user command, isolated financial fixtures and UI-035 normal-login coverage. Its synthetic history never replaces shared market observations.

## How to read the map

`B` = browser interaction with real application/database; `H` = HTTP integration; `L` = service/database logic; `P` = Python sidecar; `D` = real Docker/Compose interface. Existing browser suites deliberately delay or fail selected HTTP responses to cover recovery/races. Those injected responses do not establish real Yahoo availability. The older `completeness.audit.ts` confirms historical defects and is **not** a correctness gate; `completeness.browser.e2e.ts` contains the repaired-behavior regressions.

## User journeys

| Area / interaction | States and points of failure | Automated evidence |
| --- | --- | --- |
| Public routes, login/register redirects, unknown route | No session, valid session, expired/revoked session; unauthenticated access must not reveal owned data | B `browser.e2e.ts`; H `http.test.ts`, `sessions.test.ts` |
| Register | Trim/case normalization; username/email format and uniqueness; password UTF-8 byte limits; duplicate concurrent attempts; bcrypt failure; transaction rollback; initial INR cash and Default folder | H/L `identity-input`, `registration`, `schema`, `foundation.acceptance`; B registration journey |
| Login/logout | Wrong password, inactive/missing user, session rotation, cookie attributes, persisted expiry, CSRF binding, rate limit and reset; logout revokes session | H `http`, `sessions`; B `browser` |
| Global navigation and sidebar | All ten routes, active page, collapsed/narrow viewport, keyboard activation; back navigation | B `browser`; `interactions` UI-007/UI-008 |
| Search | Empty/search terms, keyboard arrows/Enter/Escape, selection, no results, rejected request, old result arriving late, region change, shared catalogue loading/retry | B `catalogue`, `audit`, `interactions` UI-008; H `market-http` |
| Region and theme | INR/US region selection retained after reload, dark/light, narrow desktop/mobile layouts; missing/expired FX cannot silently convert. All six currencies covered by logic fixtures, not every region picker journey | B `browser`, `interactions` UI-008; L frontend `contracts.test.js`, LOGIC-004 |
| Header index and notifications | Missing movement stays unavailable; unread/read transition, empty list, failed request; mark-read batches >100, failed batch retains retry work | B `completeness`, `browser`, `audit`; Alerts-page read controls in `interactions` UI-004; H `tools`; frontend `api.test.js` |
| Stock detail and first search | Canonical metadata, initial statistics join, quote poll, partial/missing statistics, provider error, cached/stale data, late prior-stock response, unavailable FX; loading and retry | B `audit`, `completeness`, `yfinance`; H/L `market-snapshot`, `market-http`, frontend `contracts` |
| Ten key statistics / About | Optional metrics remain null rather than zero; actual zero and signed P/E retained; pence monetary normalization, volume unitless; stale values and source dates | H/L `market-snapshot`, `yfinance-provider`; P `test_app`; B `completeness` |
| Price chart | All seven periods and exact period/interval requests, line/candle renderers, refresh retaining controls; empty history, load failure, candle geometry, partial history; preserved raw provider options | B `interactions` UI-027, `browser`, `audit`, `yfinance`; H/L `market`, `market-provider`, `yfinance-provider`; P `test_app` |
| Stock Watch / folder picker | Default add/remove, folder-specific atomic add, committed write followed by refresh failure, duplicate instrument across folders, default folder protected | B `audit`, `completeness`, `interactions` UI-001/UI-002; H/L `tools`, LOGIC-009 |
| Watchlist folders and entries | Create, rename, cancel delete, confirm delete, move, duplicate, merge-to-default on folder deletion, empty/all/folder views; UUID values, ownership, resource caps, concurrent deletion | B `interactions` UI-001/UI-002; H/L `tools`, `schema`, LOGIC-009 |
| Notes | Form create with ticker, blank title, edit, saved-editor close/reopen, delete confirm/cancel; failed save retains draft and late response cannot replace selected note. API covers creation without ticker and explicit ticker removal; saved ticker has no editable UI control | B `interactions` UI-003, `audit`; H/L `tools`. Unsaved close and all invalid note-ticker paths remain separate browser cases |
| Alerts | Above/below creation, inclusive threshold, validation, delete, triggered timestamp, inactive state, notification read, no duplicate/rearm; stale/missing quote and disabled account | B `interactions` UI-004; H/L `tools`, `yfinance-trading`, LOGIC-009 |
| Trade modal | Open/close, BUY/SELL switch, quantity, four order types, applicable limit/stop inputs, More options/expiry; zero quantity, past expiry, unavailable data; actionable rejection and retained draft | B `browser`, `interactions` UI-005/UI-009; H `trading-http`; L `trading`, LOGIC-003/005 |
| Market order | Exact fill, insufficient cash/shares, idempotent replay versus intent conflict, response lost then retry; accepted trade with account refresh failure | H/L `trading`, `trading-http`; B `audit`; LOGIC-001/002/004/006 |
| Pending orders | OPEN/TRIGGERED and terminal states; LIMIT/STOP/STOP_LIMIT BUY/SELL inclusive crossing, stop-limit gap, expiry, cancellation/worker race, stale/missing data, insufficient resources at fill, no reservations | B `interactions` UI-005/UI-006, `completeness` filter race; L `trading`, `worker`, LOGIC-003/007/008 |
| Order and execution history | Status, exact displayed price/currency/time, empty state, >20 row pagination, stable cursor/ownership, load failure | B `interactions` UI-007, `audit`; H `trading-http` |
| Dashboard | Cash/holdings/unrealized P/L, no positions versus unpriced positions, chart, holdings/history refresh, independent portfolio/history errors, retry clears correct error | B `interactions` UI-028, `browser`, `completeness`; L `portfolio`, frontend `contracts` |
| Analytics | All five ranges and exact days queries, refresh, composition chart, range switch and late success/failure, snapshot pagination, exact holdings count when valuation incomplete, profitable-holdings semantics, currency selection | B `interactions` UI-028, `completeness`, `browser`; H `portfolio` routes; frontend `api` and `contracts` |

The detailed browser catalogue records which actions are driven through visible controls and which prerequisite records are seeded through the API/SQL. API setup is not counted as form coverage. Browser smoke coverage of a chart control does not prove every period/interval × currency × chart-type combination.

## HTTP surface and guards

Every protected method below participates in the new `http-contract-matrix.test.ts` sweep: anonymous requests return 401; mutations also reject absent/foreign Origin and absent/forged CSRF with 403 before writes. Errors carry a request ID and `Cache-Control: no-store`; response bodies must not leak SQL, hashes or stacks. All mutations use the session's identity rather than a caller-supplied owner. Detailed foreign-resource assertions live in `tools.test.ts` and `trading-http.test.ts`.

| Methods / path under `/api` | Input and failure boundaries | Additional evidence |
| --- | --- | --- |
| POST `/auth/register`, `/auth/login` (public) | Exact Origin, strict body, normalized identities, bcrypt byte length; 20 attempts/IP/15min independently; 400/409/429; no login on registration | `http`, `identity-input`, `registration`, `sessions` |
| GET `/auth/me`, `/auth/csrf`; POST `/auth/logout` | Session validity, CSRF/session binding, rotation and revocation | `http`, `sessions` |
| GET `/account`, `/account/reconciliation` | No query overrides, own account only; incomplete schema/connection refusal becomes safe 503 | `http`, `reconciliation` |
| GET `/instruments?q=` | One string <=80 chars, no C0 controls, no unknown parameters; discovery debounce/race and bounded catalogue | `market-http`, `catalogue` |
| GET `/instruments/:id` | UUID/instrument lookup; unknown or absent instrument must not fabricate metadata | `market-http`, `market` |
| GET `/instruments/:id/{quote,statistics,snapshot}` | No extra query keys; receipt/source timestamps, freshness, provider/unit consistency; cold statistics joins work; failed refresh preserves stored observation | `market-snapshot`, `market`, `yfinance-provider` |
| GET `/instruments/:id/history` | Period `1d/5d/1mo/3mo/6mo/1y/5y`; interval `5m/15m/1d/1wk/1mo`; reject arrays and other options | `market-http`, `yfinance-provider`, Python |
| GET `/fx-rates` | No unknown queries; expected source/target units, provider/time validation, unavailable conversion distinct from identity FX | `market`, `yfinance-provider`, `yfinance-trading` |
| POST `/orders` | Strict order intent; UUID; positive decimal strings; quantity <=4 fractional digits, prices <=8; type-specific prices; future ISO expiry; printable 8–128 byte idempotency key; canonical intent replay | `trading-http`, `trading`, LOGIC-003/006 |
| GET `/orders`; GET `/orders/:id` | Limit 1–100, known statuses; owned UUID cursor and order; 400 for invalid cursor, 404 for missing/foreign order | `trading-http` |
| POST `/orders/:id/cancel` | Own cancellable order, empty body; terminal state conflict and concurrent execution | `trading-http`, `trading`, LOGIC-007 |
| GET `/executions` | Limit 1–100 and owned UUID cursor; decimal strings and immutable facts | `trading-http`, `schema` |
| GET `/portfolio`; GET `/portfolio/snapshots` | No account override; snapshots limit 1–100, owned UUID cursor, integer days 1–1825; unknown/multivalued params rejected | `portfolio`, `trading-http`, frontend `api` |
| GET `/watchlists` | Aggregate bounded at 100 folders / 1000 entries; explicit limit error rather than partial aggregate | `tools` |
| GET/POST `/watchlists/folders`; PATCH/DELETE `/watchlists/folders/:id` | Trimmed name 1–80, no controls; strict body, owned folder, protected Default; deletion atomic merge/dedup | `tools`, LOGIC-009 |
| GET/POST `/watchlists/entries`; PATCH/DELETE `/watchlists/entries/:id` | Owned folder and entry UUID, valid instrument, duplicate 409; creation/move atomic | `tools`, LOGIC-009 |
| GET/POST `/notes`; GET/PATCH/DELETE `/notes/:id` | Title 1–200 without controls; body <=10000, tabs/newlines allowed; nullable instrument; nonempty strict patch; owned resources | `tools` |
| GET/POST `/alerts`; DELETE `/alerts/:id` | ABOVE/BELOW, positive decimal target <=12 integer/8 fraction digits; owned alert and supported instrument | `tools`, LOGIC-009 |
| GET `/notifications`; POST `/notifications/read` | `unread=true/false`; 1–100 unique owned UUIDs per read batch; transaction rejects foreign IDs | `tools`, frontend `api` |
| GET paged tools lists | Limit 1–100, canonical base64url UUID cursor; entries optional owned folderId; strict query keys, no arrays | `tools`, HTTP-MATRIX |
| GET `/health/live`, `/health/ready` (public) | Liveness survives DB outage; readiness requires expected schema and reachable DB; no migration side effect | `http`, `platform` |
| Unknown path, malformed JSON, >16KiB JSON | Safe 404 / 400 INVALID_JSON / 413 BODY_TOO_LARGE; no data/stack leak | `http` |

HTTP-MATRIX contributes **157 endpoint/input cases**. This complements successful authorized workflows and foreign-owner checks; a rejected request alone does not establish successful behavior.

## Financial state, data and worker failure model

| Concern | Expected invariant and failure probes | Evidence |
| --- | --- | --- |
| Financial arithmetic | Integer/rational model independent of production helpers; settlements half up to cents, costs to eight places; no zero/overflow/nonfinite fills; four-place quantities | LOGIC-001/002/004/005; `parser`, `schema`, `trading` |
| Cash ledger | Initial credit plus execution settlements equals cash; sequence contiguous, running balance correct; one ledger debit/credit per execution; no unauthorized mutation | LOGIC-001/006; `reconciliation`, `schema`, `platform` |
| Position cost | Weighted partial allocation, full liquidation consumes final remainder, no negative shares; reentry resets cost; native and base costs reconcile including FX P/L | LOGIC-001/002/004; `trading`, `reconciliation` |
| Transactions and retries | Execution, order, cash and position commit together; forced faults roll back all; same normalized key replays across provider outage; changed intent conflicts | LOGIC-003/006; `trading`, `registration`, `tools` |
| Concurrency | Account row lock serializes competing writes; simultaneous first position; active-user lock; competing evaluators, cancel/fill/expiry; no duplicate notification or fill | LOGIC-003/006/007/009; `trading`, `worker`, `tools` |
| Market gates | Unsupported currency/provider/units, view-only index, paused instrument, disabled owner, stale/future/missing price or FX fail closed; production rejects fixture execution | LOGIC-008; `market`, `provider-validation`, `yfinance-trading`, `trading` |
| Provider-specific freshness | Strict provider requires valid session/source age. Intentional yfinance paper policy permits older source time/UNKNOWN session if receipt is recent (quote <=60s, FX <=24h); this is a product policy, not a live exchange guarantee | `yfinance-trading`, frontend `contracts` |
| Snapshot consistency | One account version, observed quote/FX range, same-bucket replacement ordered by real sample time; concurrent trade stays dirty; incomplete valuation nulls totals and preserves last durable sample | LOGIC-010; `portfolio`, `trading` |
| Worker lifecycle | Sequential bounded loop; refresh failure does not stop it; advisory lock excludes competing batches; fairness past unfillable orders/accounts; heartbeat and graceful SIGTERM; persisted trigger survives restart | `worker`, `trading`, `portfolio` |
| Market requests | Validated decimal/source/currency data, no synthetic outage fallback; bounded concurrency/admission, timeout/capacity recovery, coherent quote/statistics snapshot; stale cache distinct from missing | `market-provider`, `yfinance-provider`, `market-snapshot`; Python `test_app` |
| Python boundary | Allowlist symbols/options; malformed JSON/provider payload, timeout, rate limit, partial/empty history, zero/negative/nonfinite values, currency/pence mismatch; upstream queue/capacity limits | `services/yfinance/test_app.py`; TS `yfinance-provider` |
| Schema and permissions | Fresh migrations and upgrade; constraints independent of HTTP, immutable financial history; runtime role lacks migration/owner capabilities; guarded test harness rejects live URL | `schema`, `upgrade`, `platform`, `harness`, `foundation.acceptance` |

## Deployment and operations

| Interaction / fault | Evidence / limitation |
| --- | --- |
| Default Compose entry, existing volume name, explicit stack parity, missing required secrets | `deploy/pern/test/test_compose_entry.py` renders only dummy configuration. No application secrets are printed. |
| Container recovery after process exit | Compose restart-policy assertions for long-running services; migrate remains one-shot. This run does not crash/restart the live stack. |
| nginx direct connection versus explicitly trusted ingress | Real built nginx + isolated API probe verifies spoofed forwarding header cannot replace untrusted source, trusted /32 preserves client, wildcard/invalid CIDR fails startup. |
| Readiness, shutdown, DB timeout and migration mismatch | HTTP/platform/worker tests; no destructive live outage injection. |
| Backup/restore | Existing runbook and prior restore evidence in `docs/PERN_OPERATIONS.md`. Not a new disaster-recovery drill in this interaction run. |
| Hosted CI | Latest committed run and local fixes are recorded in the dated results. Local pass must not be described as a new hosted pass. |

## Remaining test dimensions

- Real Yahoo/yfinance correctness, licensing, rate limits, corporate-action changes and prolonged outages require observation against live sources; offline fixtures certify only the contracts tested.
- Firefox/WebKit, native mobile, every OS/locale/timezone, assistive-technology testing, full WCAG audit and every chart combination are not covered by Chromium workflows.
- Arbitrary adversarial input, full penetration/vulnerability audit, sustained load/soak, pool exhaustion under production traffic, disk-full, power loss, network partitions and all transaction interleavings are not certified.
- Backups, public TLS/DNS/ingress and recovery-point/recovery-time objectives need separate operational drills. Existing local deployment evidence does not certify public hosting.
- New features or policy changes must add rows and tests. Test totals alone do not establish correctness; case expectations, independent oracles and observed failures matter.
