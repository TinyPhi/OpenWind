# 2026-10-16 — OpenBao loaders and environment proxies

**Session type:** Review follow-up
**Branch:** `fix/PLAT-hardening-bao-loader-ignore-proxy`
**Source:** security review of #967 (info finding)

- **Done.** The Python loader (`bao-env-loader.py`) now builds its opener with an empty `ProxyHandler`, so
  `HTTPS_PROXY`, `https_proxy` and `ALL_PROXY` in the container environment no longer route the AppRole login or the
  token through a proxy. It connects straight to the address the `OPENBAO_NETWORK_CIDR` check validated, as the Node
  loader does by default. Both loaders' headers say so.
- **Verified.** A loader test sets all three variables to a dead address: the Python loader failed it before (exit
  69, trying the proxy) and passes after; the Node loader passes it before and after (Node's `fetch` ignores proxy
  variables by default). Loader suite 44/44.
- **Not changed (Node opt-in).** With `NODE_USE_ENV_PROXY=1` in the environment Node's runtime routes `fetch` through
  `HTTPS_PROXY`, and the loader cannot override that without replacing its HTTP client (`undici`'s dispatcher is not
  importable from a standalone script). I checked: both loaders fail my probe in that mode before the change. The
  opt-in is deliberate on the operator's side and the connection to OpenBao is still TLS-verified end to end through
  the proxy tunnel, so this is left documented in the loader header, not rewritten.
- **Decision recorded.** A deployment that relied on the Python loader reaching OpenBao through a proxy would now
  connect directly; the production setup puts the loader and OpenBao on one private network (ADR-023), which is what the
  CIDR check assumes.
