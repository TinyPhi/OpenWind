#!/usr/bin/env python3
# OpenBao startup loader for images without Node (Superset). Same contract as
# bao-env-loader.mjs (ADR-023 Decision 2):
#
#   python3 bao-env-loader.py <original command...>
#
# Logs in with AppRole, reads ONE KV v2 path, revokes its own token, checks the
# required keys, then execs the original command with those values added to its
# environment. Fails closed and never prints a value. See bao-env-loader.mjs
# for the settings; the only difference is that the CA file, when needed, comes
# from BAO_CACERT instead of NODE_EXTRA_CA_CERTS.
#
# Exit codes: 69 unreachable or sealed, 77 refused, 78 configuration or
# missing/conflicting key.
import ipaddress
import json
import os
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TAG = "[bao-env]"
REQUEST_TIMEOUT_S = 15
EXIT_UNREACHABLE = 69
EXIT_REFUSED = 77
EXIT_CONFIG = 78


def log(message):
    print(f"{TAG} {message}", file=sys.stderr, flush=True)


def number_setting(name, fallback):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    try:
        value = float(raw)
    except ValueError:
        return fallback
    return value if value >= 0 else fallback


FAIL_SLEEP_S = number_setting("BAO_FAIL_SLEEP_SECONDS", 30)
WAIT_S = number_setting("BAO_WAIT_SECONDS", 120)


def fail(code, message):
    log(f"FATAL: {message}")
    # Unreachable already waited; everything else pauses so a restart policy
    # can't hammer OpenBao with failed logins.
    if code != EXIT_UNREACHABLE and FAIL_SLEEP_S > 0:
        time.sleep(FAIL_SLEEP_S)
    sys.exit(code)


def need(name):
    value = os.environ.get(name, "")
    return value if value.strip() else None


def is_transient(status):
    return status == 429 or status >= 500


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: it would re-send the token (or the AppRole
    login) to a host the network check never saw. OpenBao doesn't redirect
    these calls, so a 3xx surfaces as an HTTPError and counts as a refusal."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def call(ctx, addr, method, path, body=None, token=None):
    headers = {"content-type": "application/json"}
    if token:
        headers["x-vault-token"] = token
    req = urllib.request.Request(
        f"{addr}/v1/{path}",
        method=method,
        headers=headers,
        data=json.dumps(body).encode() if body is not None else None,
    )
    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ctx), _NoRedirect()
    )
    try:
        with opener.open(req, timeout=REQUEST_TIMEOUT_S) as res:
            raw = res.read()
            try:
                return res.status, (json.loads(raw) if raw else {})
            except ValueError:
                # A malformed body is treated like an empty one, so the normal
                # exit codes and the fail-sleep apply instead of a traceback.
                return res.status, {}
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b"{}")
        except ValueError:
            return err.code, {}


def call_with_wait(ctx, addr, method, path, body, token, deadline):
    delay = 1.0
    while True:
        error = None
        try:
            status, payload = call(ctx, addr, method, path, body, token)
            if not is_transient(status):
                return status, payload
        except (urllib.error.URLError, OSError) as err:
            status, error = 0, err
        if time.monotonic() + delay > deadline:
            reason = f"unreachable ({type(error).__name__})" if status == 0 else f"HTTP {status}"
            fail(EXIT_UNREACHABLE, f"OpenBao {reason} at {addr}; gave up after {int(WAIT_S)}s")
        log(f"OpenBao not ready ({'unreachable' if status == 0 else f'HTTP {status}'}); retrying")
        time.sleep(delay)
        delay = min(delay * 2, 10.0)


def check_server_address(addr, cidr):
    host = urllib.parse.urlsplit(addr).hostname or ""
    try:
        network = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        fail(EXIT_CONFIG, f"OPENBAO_NETWORK_CIDR {cidr} is not a valid CIDR")
    try:
        infos = socket.getaddrinfo(host, None, socket.AF_INET)
    except OSError as err:
        fail(EXIT_CONFIG, f"cannot resolve {host} ({type(err).__name__})")
    addresses = {info[4][0] for info in infos}
    outside = [a for a in addresses if ipaddress.ip_address(a) not in network]
    if not addresses or outside:
        fail(
            EXIT_CONFIG,
            f"{host} does not resolve inside OPENBAO_NETWORK_CIDR {cidr}; refusing to send "
            "credentials (is this container on the OpenBao network?)",
        )


def main():
    addr = (need("OPENBAO_ADDR") or "").rstrip("/")
    role_id = need("OPENBAO_ROLE_ID")
    secret_id = need("OPENBAO_SECRET_ID")
    kv_path = need("BAO_KV_PATH")
    cidr = need("OPENBAO_NETWORK_CIDR")
    required = [k.strip() for k in os.environ.get("BAO_REQUIRED_KEYS", "").split(",") if k.strip()]
    argv = sys.argv[1:]

    for name, value in (
        ("OPENBAO_ADDR", addr),
        ("OPENBAO_ROLE_ID", role_id),
        ("OPENBAO_SECRET_ID", secret_id),
        ("BAO_KV_PATH", kv_path),
    ):
        if not value:
            fail(EXIT_CONFIG, f"{name} is not set")
    if not argv:
        fail(EXIT_CONFIG, "no command to run")
    if not addr.startswith("https://"):
        fail(EXIT_CONFIG, "OPENBAO_ADDR must use https://")
    if cidr:
        check_server_address(addr, cidr)

    ctx = ssl.create_default_context(cafile=os.environ.get("BAO_CACERT") or None)
    deadline = time.monotonic() + WAIT_S

    status, login = call_with_wait(
        ctx, addr, "POST", "auth/approle/login",
        {"role_id": role_id, "secret_id": secret_id}, None, deadline,
    )
    token = (login.get("auth") or {}).get("client_token")
    if status != 200 or not token:
        fail(EXIT_REFUSED, f"AppRole login refused (HTTP {status})")

    try:
        status, kv = call_with_wait(
            ctx, addr, "GET", f"secret/data/{kv_path}", None, token, deadline
        )
    finally:
        # The token was only needed for this one read. Revoked even when the
        # read fails (fail() exits through here), so restarts don't pile up live
        # tokens; a failed revoke is ignored.
        try:
            call(ctx, addr, "POST", "auth/token/revoke-self", {}, token)
        except (urllib.error.URLError, OSError):
            pass

    data = (kv.get("data") or {}).get("data")
    if status != 200 or not isinstance(data, dict):
        fail(EXIT_REFUSED, f"cannot read secret/{kv_path} (HTTP {status})")

    missing = [k for k in required if data.get(k) in (None, "")]
    if missing:
        fail(EXIT_CONFIG, f"required keys missing in secret/{kv_path}: {', '.join(missing)}")

    conflicts = sorted(k for k in data if os.environ.get(k, "").strip())
    if conflicts:
        fail(
            EXIT_CONFIG,
            f"keys set both by compose and in secret/{kv_path}: {', '.join(conflicts)} "
            "(remove them from compose; OpenBao is the source)",
        )

    env = dict(os.environ)
    for key, value in data.items():
        env[key] = value if isinstance(value, str) else json.dumps(value)
    keep_login = os.environ.get("BAO_KEEP_LOGIN") == "1"
    if not keep_login:
        env.pop("OPENBAO_ROLE_ID", None)
        env.pop("OPENBAO_SECRET_ID", None)
    log(
        f"applied {len(data)} keys from secret/{kv_path}"
        f"{'; login passed on' if keep_login else ''} (values never logged)"
    )
    try:
        if os.name == "nt":
            # exec doesn't replace the process on Windows; used only by local tests.
            sys.exit(subprocess.call(argv, env=env))
        os.execvpe(argv[0], argv, env)
    except OSError as err:
        fail(EXIT_CONFIG, f"cannot start {argv[0]} ({type(err).__name__})")


if __name__ == "__main__":
    main()
