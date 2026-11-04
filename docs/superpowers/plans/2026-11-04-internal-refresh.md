# Internal API refresh responsiveness

User direction: internal APIs should feel immediate and avoid excessive polling; continue implementation.

Use the existing React/API architecture. Successful writes update visible state from their responses. Notification reads synchronise the bell and Alerts page through an in-page event after each committed batch. Keep the API's session and CSRF checks and financial correctness. No artificial request delays, optimistic financial writes, new dependencies or server push infrastructure.

- [x] Add browser regressions for immediate notification synchronisation, no 15/30-second internal polling, and writes independent of a second list read; verify baseline failures.
- [x] Replace internal alert/notification intervals with one-minute, visible-tab-only, non-overlapping refresh; refresh immediately on return to a visible tab. Keep existing market quote/index/FX intervals.
- [x] Apply notification read events immediately in both views; invalidate superseded list responses, retain errors and retries, keep old lists visible during background refresh.
- [x] Render note creation and watchlist entry/folder creation/rename from successful response data, avoiding redundant blocking list reads. Protect against stale initial reads and duplicate records observed before a POST response arrives.
- [x] Run frontend, typecheck, build, full browser and foundation checks; document intervals, measured network behavior, and limits. See `docs/testing/INTERNAL_API_REFRESH_2026-11-04.md`: 17 frontend, 428 backend tests and all six browser scripts passed; interaction suite 25/25.

No persistent client cache or cross-user shared data is introduced. Worker-created notifications remain eventually visible through background checks, bell open, or return-to-tab refresh. This change does not promise zero network latency or instantaneous worker updates.
