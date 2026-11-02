# Setup surface inventory

## Compose services and runtime

| Service | Image/build and runtime | Ports | Volumes | Startup dependency |
|---|---|---|---|---|
| `db` | `gvenzl/oracle-xe:21-slim` image; Oracle XE 21c per compose comment. [docker-compose.yml:3-5] | `0:1521` (host port is dynamically assigned). [docker-compose.yml:12-13] | Named `oracle_data:/opt/oracle/oradata`; `database/docker-init.sh` mounted at `/container-entrypoint-initdb.d/docker-init.sh`; `./database` at `/opt/db-scripts`. [docker-compose.yml:14-17,75-76] | No `depends_on` declared. Health check runs `healthcheck.sh` with 30s interval, 10s timeout, 15 retries, 120s start period. [docker-compose.yml:18-23] |
| `backend` | Builds `./backend`; Dockerfile installs requirements and runs `./entrypoint.sh`, which runs seed script then Flask app. [docker-compose.yml:31-34; backend/Dockerfile:5-12; backend/entrypoint.sh:4-8] | `5000:5000`. [docker-compose.yml:35-36] | `./backend:/app`. [docker-compose.yml:46-47] | Waits for `db` health status `service_healthy`. [docker-compose.yml:43-45] |
| `frontend` | Builds `./frontend`; Dockerfile installs npm packages and runs `npm run dev`. [docker-compose.yml:55-58; frontend/Dockerfile:5-12] | `3000:3000`. [docker-compose.yml:59-60] | `./frontend/src:/app/src`; `./frontend/public:/app/public`. [docker-compose.yml:65-67] | Depends on `backend` (no health condition specified). [docker-compose.yml:63-64] |

Compose configures backend `ORACLE_USER=trader`, `ORACLE_PASSWORD=trader`, `ORACLE_DSN=db:1521/XEPDB1`, and also loads `./backend/.env`; frontend gets `VITE_API_TARGET=http://backend:5000`. [docker-compose.yml:37-42,61-62] Resource limits/reservations are declared for all three services. [docker-compose.yml:24-29,48-53,68-73]

## Manual setup commands

1. In SQL Developer, connect to Oracle and run in order: `database/01_schema.sql`, `02_triggers.sql`, `03_procedures.sql`, `04_sample_data.sql`. [MANUAL_SETUP.md:5-16]
2. In `backend`, copy `.env.example` to `.env`; set `ORACLE_USER`, `ORACLE_PASSWORD`, `ORACLE_DSN` (example DSN: `localhost:1521/XEPDB1`). [MANUAL_SETUP.md:18-26]
3. Install backend dependencies with `cd backend` then `pip install -r requirements.txt`; frontend with `cd frontend` then `npm install`. [MANUAL_SETUP.md:28-38]
4. For each run, in separate terminals run `cd backend; python app.py` and `cd frontend; npm run dev`; browse to `http://localhost:3000`. [MANUAL_SETUP.md:42-64]

## File-to-runtime map

| File or file group | Observed role | Classification |
|---|---|---|
| `backend/Dockerfile`, `backend/entrypoint.sh`, `backend/requirements.txt` | Python 3.12 image, pip install, entrypoint, Flask/Oracle and other Python packages. [backend/Dockerfile:1-12; backend/entrypoint.sh:1-8; backend/requirements.txt:1-9] | Python-specific backend runtime; Oracle driver dependency `oracledb` is explicit. |
| `docker-compose.yml` database service and `database/*` mounts | Oracle XE container, persisted data, init script and mounted database scripts. [docker-compose.yml:3-17,75-76] | Oracle-specific setup/runtime. |
| `MANUAL_SETUP.md` database and backend configuration steps | Oracle SQL setup and Oracle connection variables. [MANUAL_SETUP.md:5-26] | Oracle-specific manual setup. |
| `frontend/Dockerfile` | Node 20 image, npm install, dev server on 3000. [frontend/Dockerfile:1-12] | Frontend runtime; Node/Vite based. |
| Compose `frontend` service and `frontend/src`, `frontend/public` mounts | Dev server, API target, source/public hot-reload mounts. [docker-compose.yml:55-67] | Frontend pieces reusable independently of the Oracle/Python backend, subject to API compatibility. |
| Manual frontend setup | `npm install`, `npm run dev`, browser at port 3000. [MANUAL_SETUP.md:35-38,55-64] | Frontend-specific manual workflow. |

## Observed startup order and unknowns

In the container backend entrypoint, `python scripts/seed_demo.py` executes before `python app.py`; `set -e` means a failing seed command exits before the app command. [backend/entrypoint.sh:1-8] Compose starts the backend after database health is reported, then frontend depends on backend. [docker-compose.yml:43-45,63-64] The manual guide describes Oracle as already running in the background and starts backend and frontend in separate terminals. [MANUAL_SETUP.md:42-68]

Not established by these inspected files: actual host port selected for `db`; whether the manual seed script succeeds or what it changes; readiness semantics of the backend dependency; frontend package/framework details beyond the Dockerfile command; application API routes and whether another backend is compatible; behavior of the Oracle init script; complete environment-variable precedence.
