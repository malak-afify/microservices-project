# Delta Bank ATM: 3-Tier Application

A cash machine you can use in the browser. The frontend looks and works like a real ATM (side keys, keypad, card slot, cash tray), and it is built as a classic **3-tier application** where every tier runs in its own container.

```
Browser  -->  Tier 1: Nginx (static ATM UI + reverse proxy)
                  |  /api/*
                  v
              Tier 2: Flask API (Gunicorn)
                  |
                  v
              Tier 3: PostgreSQL
```

| Tier | Tech | What it does |
|------|------|--------------|
| Presentation | HTML, CSS, JavaScript, Nginx | ATM interface, forwards `/api/*` to the backend |
| Application | Python, Flask, Gunicorn | PIN check, sessions, balance, deposits, withdrawals |
| Data | PostgreSQL 16 | Accounts, transactions, sessions |

## Run it

```bash
docker compose up --build
```

Open <http://localhost:8080>.

Demo cards (fake, created on first start):

| Card number | PIN | Holder |
|-------------|-----|--------|
| 1111 2222 3333 4444 | 1234 | Malak Afify |
| 5555 6666 7777 8888 | 4321 | Demo User |

You can use the on-screen keypad or your keyboard (digits, Enter, Backspace, Esc).

## Features

- Card number and PIN sign-in (PINs are stored hashed)
- Card locks after 3 wrong PINs
- Check balance, withdraw (multiples of 10), deposit, mini statement
- Sessions expire after 5 minutes of inactivity; the screen signs out after 60 seconds idle
- Withdrawals use row locks (`SELECT ... FOR UPDATE`) so the balance can never go negative, even with simultaneous requests

## API

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/api/login` | `{card, pin}` | returns a session token |
| POST | `/api/logout` | | needs `Authorization: Bearer <token>` |
| GET | `/api/balance` | | auth |
| POST | `/api/deposit` | `{amount}` | auth |
| POST | `/api/withdraw` | `{amount}` | auth |
| GET | `/api/transactions` | | last 10, auth |
| GET | `/api/health` | | for health checks and probes |

## Project structure

```
atm-3tier/
  docker-compose.yml
  frontend/   index.html, style.css, app.js, nginx.conf, Dockerfile
  backend/    app.py, requirements.txt, Dockerfile
```

## Notes

- Database credentials in `docker-compose.yml` are for local development only. Use secrets (for example Kubernetes Secrets or AWS Secrets Manager) when deploying.
- The backend creates its tables and demo accounts automatically on start-up, and waits for PostgreSQL to be ready.
