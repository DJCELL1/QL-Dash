"""Sign-in for the dashboard.

Anyone can read; changing anything needs an account. Deliberately small: a
handful of people on one factory's floor, no password resets, no roles. The
pieces that matter are that passwords are never stored in the clear and that a
session can't be forged without the server's secret.
"""
import base64
import hashlib
import hmac
import secrets
import time

# Cost of hashing a password. High enough that a stolen database is expensive to
# attack, low enough that signing in is instant.
PBKDF2_ROUNDS = 200_000
SESSION_DAYS = 30
COOKIE_NAME = "prodash_session"


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    """Return (salt, hash), both base64, for storing against a user."""
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return base64.b64encode(salt).decode(), base64.b64encode(digest).decode()


def verify_password(password: str, salt_b64: str, hash_b64: str) -> bool:
    try:
        salt = base64.b64decode(salt_b64)
    except Exception:  # noqa: BLE001 — a malformed row shouldn't 500 the login
        return False
    _, candidate = hash_password(password, salt)
    # constant time: a timing difference here leaks how much of the hash matched
    return hmac.compare_digest(candidate, hash_b64)


def _sign(secret: str, payload: str) -> str:
    mac = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def issue_session(secret: str, username: str) -> str:
    """A signed token the browser holds as a cookie.

    Stateless — the signature is what makes it trustworthy, so there's no
    session table to keep in step. Rotating the secret signs everyone out.
    """
    expires = int(time.time()) + SESSION_DAYS * 86400
    payload = f"{username}|{expires}"
    return f"{payload}|{_sign(secret, payload)}"


def read_session(secret: str, token: str | None) -> str | None:
    """The username a token vouches for, or None if it's missing, tampered with
    or expired."""
    if not token:
        return None
    parts = token.rsplit("|", 1)
    if len(parts) != 2:
        return None
    payload, signature = parts
    if not hmac.compare_digest(_sign(secret, payload), signature):
        return None
    try:
        username, expires = payload.rsplit("|", 1)
        if int(expires) < time.time():
            return None
    except ValueError:
        return None
    return username


def new_secret() -> str:
    return secrets.token_urlsafe(48)


LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}


def is_https(request) -> bool:
    """Whether the browser reached us over HTTPS.

    Railway terminates TLS at its edge and forwards plain HTTP, so the request's
    own scheme says http there — the forwarded header is what tells the truth.

    Local development is the exception: a dev proxy can announce https while the
    browser is really on http://localhost, and a Secure cookie sent over plain
    HTTP is dropped without a word, which looks exactly like a broken login.
    Nothing reachable from another machine is served on localhost, so treating
    it as insecure costs nothing.
    """
    host = (request.headers.get("host") or "").split(":")[0].strip().lower()
    if host in LOCAL_HOSTS:
        return False
    forwarded = request.headers.get("x-forwarded-proto", "")
    if forwarded:
        return forwarded.split(",")[0].strip().lower() == "https"
    return request.url.scheme == "https"


def cookie_kwargs(request) -> dict:
    """Cookie settings.

    SameSite=Lax is what stops another site posting changes using the browser's
    cookie — the API takes JSON on POST, so without it a hostile page could act
    as whoever is signed in.

    Secure follows the actual connection rather than a setting: marking the
    cookie Secure over plain HTTP means the browser silently drops it and the
    login appears to do nothing.
    """
    return {
        "httponly": True,
        "samesite": "lax",
        "secure": is_https(request),
        "max_age": SESSION_DAYS * 86400,
        "path": "/",
    }
