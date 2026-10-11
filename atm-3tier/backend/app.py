"""Delta Bank ATM - backend (tier 2): a Flask REST API on top of PostgreSQL."""
import logging
import os
import secrets
import time
from contextlib import contextmanager
from functools import wraps

import psycopg2
import psycopg2.extras
from flask import Flask, g, jsonify, request
from psycopg2.pool import ThreadedConnectionPool
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("atm")

app = Flask(__name__)

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "db"),
    "port": int(os.getenv("DB_PORT", "5432")),
    "dbname": os.getenv("DB_NAME", "atm"),
    "user": os.getenv("DB_USER", "atm_user"),
    "password": os.getenv("DB_PASSWORD", "atm_pass"),
}

SESSION_MINUTES = 5      # a session ends after this much inactivity
MAX_PIN_ATTEMPTS = 3     # the card is locked after this many wrong PINs
MAX_AMOUNT = 5000        # per transaction

# Fake demo cards, created on first start.
DEMO_ACCOUNTS = [
    ("1111222233334444", "1234", "Malak Afify", 5000),
    ("5555666677778888", "4321", "Demo User", 1200),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id              SERIAL PRIMARY KEY,
    card_number     VARCHAR(16) UNIQUE NOT NULL,
    pin_hash        TEXT NOT NULL,
    holder_name     TEXT NOT NULL,
    balance         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    failed_attempts INT NOT NULL DEFAULT 0,
    locked          BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS transactions (
    id            SERIAL PRIMARY KEY,
    account_id    INT NOT NULL REFERENCES accounts(id),
    kind          VARCHAR(10) NOT NULL,
    amount        NUMERIC(12,2) NOT NULL,
    balance_after NUMERIC(12,2) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    account_id INT NOT NULL REFERENCES accounts(id),
    expires_at TIMESTAMPTZ NOT NULL
);
"""

_pool = None


def get_pool():
    global _pool
    if _pool is None:
        _pool = ThreadedConnectionPool(1, 10, **DB_CONFIG)
    return _pool


@contextmanager
def db():
    """Yield a cursor; commit on success, roll back on error."""
    pool = get_pool()
    conn = pool.getconn()
    try:
        with conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                yield cur
    finally:
        pool.putconn(conn)


def init_db():
    for attempt in range(1, 31):
        try:
            with db() as cur:
                cur.execute("SELECT pg_advisory_xact_lock(7731)")  # safe with many replicas
                cur.execute(SCHEMA)
                for card, pin, name, balance in DEMO_ACCOUNTS:
                    cur.execute(
                        "INSERT INTO accounts (card_number, pin_hash, holder_name, balance) "
                        "VALUES (%s, %s, %s, %s) ON CONFLICT (card_number) DO NOTHING",
                        (card, generate_password_hash(pin), name, balance),
                    )
            log.info("Database ready")
            return
        except psycopg2.OperationalError as exc:
            log.warning("Database not ready (attempt %s/30): %s", attempt, exc)
            time.sleep(2)
    raise RuntimeError("Could not connect to the database")


def err(message, status):
    return jsonify(error=message), status


def auth(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        if not token:
            return err("Please insert your card and sign in.", 401)
        with db() as cur:
            cur.execute(
                "SELECT account_id FROM sessions WHERE token = %s AND expires_at > now()",
                (token,),
            )
            row = cur.fetchone()
            if not row:
                return err("Your session has ended. Please sign in again.", 401)
            cur.execute(
                "UPDATE sessions SET expires_at = now() + %s * interval '1 minute' WHERE token = %s",
                (SESSION_MINUTES, token),
            )
        g.account_id = row["account_id"]
        g.token = token
        return view(*args, **kwargs)

    return wrapper


@app.errorhandler(Exception)
def unexpected(exc):
    if isinstance(exc, HTTPException):
        return err(exc.description, exc.code)
    log.exception("Unhandled error")
    return err("The ATM is out of service. Please try again later.", 500)


@app.get("/api/health")
def health():
    with db() as cur:
        cur.execute("SELECT 1")
    return jsonify(status="ok")


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    card = str(data.get("card", "")).strip()
    pin = str(data.get("pin", "")).strip()
    if not (card.isdigit() and len(card) == 16 and pin.isdigit() and len(pin) == 4):
        return err("Enter a 16-digit card number and a 4-digit PIN.", 400)

    with db() as cur:
        cur.execute("SELECT * FROM accounts WHERE card_number = %s FOR UPDATE", (card,))
        acc = cur.fetchone()
        if not acc:
            return err("Card not recognised.", 404)
        if acc["locked"]:
            return err("This card is locked. Please contact your bank.", 403)

        if not check_password_hash(acc["pin_hash"], pin):
            attempts = acc["failed_attempts"] + 1
            locked = attempts >= MAX_PIN_ATTEMPTS
            cur.execute(
                "UPDATE accounts SET failed_attempts = %s, locked = %s WHERE id = %s",
                (attempts, locked, acc["id"]),
            )
            if locked:
                return err("Too many wrong PINs. This card is now locked.", 403)
            left = MAX_PIN_ATTEMPTS - attempts
            return err(f"Wrong PIN. {left} attempt{'s' if left != 1 else ''} left.", 401)

        cur.execute("UPDATE accounts SET failed_attempts = 0 WHERE id = %s", (acc["id"],))
        token = secrets.token_urlsafe(32)
        cur.execute(
            "INSERT INTO sessions (token, account_id, expires_at) "
            "VALUES (%s, %s, now() + %s * interval '1 minute')",
            (token, acc["id"], SESSION_MINUTES),
        )
    return jsonify(token=token, holder=acc["holder_name"])


@app.post("/api/logout")
@auth
def logout():
    with db() as cur:
        cur.execute("DELETE FROM sessions WHERE token = %s", (g.token,))
    return jsonify(status="signed out")


@app.get("/api/balance")
@auth
def balance():
    with db() as cur:
        cur.execute("SELECT balance FROM accounts WHERE id = %s", (g.account_id,))
        row = cur.fetchone()
    return jsonify(balance=float(row["balance"]))


def parse_amount():
    data = request.get_json(silent=True) or {}
    try:
        amount = int(data.get("amount"))
    except (TypeError, ValueError):
        return None, err("Enter a whole-number amount.", 400)
    if amount <= 0 or amount > MAX_AMOUNT:
        return None, err(f"The amount must be between 1 and {MAX_AMOUNT}.", 400)
    return amount, None


def move_money(kind, delta):
    with db() as cur:
        cur.execute("SELECT balance FROM accounts WHERE id = %s FOR UPDATE", (g.account_id,))
        current = cur.fetchone()["balance"]
        new_balance = current + delta
        if new_balance < 0:
            return err("Insufficient funds.", 400)
        cur.execute("UPDATE accounts SET balance = %s WHERE id = %s", (new_balance, g.account_id))
        cur.execute(
            "INSERT INTO transactions (account_id, kind, amount, balance_after) "
            "VALUES (%s, %s, %s, %s)",
            (g.account_id, kind, abs(delta), new_balance),
        )
    return jsonify(balance=float(new_balance))


@app.post("/api/deposit")
@auth
def deposit():
    amount, problem = parse_amount()
    if problem:
        return problem
    return move_money("deposit", amount)


@app.post("/api/withdraw")
@auth
def withdraw():
    amount, problem = parse_amount()
    if problem:
        return problem
    if amount % 10:
        return err("Withdrawals must be in multiples of 10.", 400)
    return move_money("withdraw", -amount)


@app.get("/api/transactions")
@auth
def transactions():
    with db() as cur:
        cur.execute(
            "SELECT kind, amount, balance_after, created_at FROM transactions "
            "WHERE account_id = %s ORDER BY id DESC LIMIT 10",
            (g.account_id,),
        )
        rows = cur.fetchall()
    return jsonify(
        transactions=[
            {
                "kind": r["kind"],
                "amount": float(r["amount"]),
                "balance_after": float(r["balance_after"]),
                "at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
    )


init_db()
