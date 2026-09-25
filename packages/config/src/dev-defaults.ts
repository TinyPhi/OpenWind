/**
 * Reporting (3G) development-only secret defaults.
 *
 * These exist so `git clone && docker compose up` gives a working stack, and
 * every one of them is rejected in production by a refine in env.ts. They are
 * named constants rather than inline literals for one reason: the guard and the
 * default must never drift apart. An inline default that someone later edits
 * without editing the guard would silently become a usable production secret
 * again, which is exactly the failure the guard exists to prevent.
 *
 * Kept out of env.ts and out of the package's public exports. The values still
 * ship with the config module, necessarily: they are the defaults, and the
 * production guard compares against them. What they are not is part of the
 * package API; only env.ts and its tests import this file.
 */
export const DEV_SUPERSET_SECRET_KEY = "superset_dev_secret_key_change_in_prod";
export const DEV_SUPERSET_GUEST_TOKEN_SECRET = "superset_guest_dev_secret_key";
export const DEV_SUPERSET_SERVICE_ACCOUNT_PASSWORD =
  "service_account_dev_password";
export const DEV_SUPERSET_ADMIN_PASSWORD = "admin_dev_password";

/** The four together, for the guard tests to iterate over. */
export const DEV_SUPERSET_DEFAULTS = {
  SUPERSET_SECRET_KEY: DEV_SUPERSET_SECRET_KEY,
  SUPERSET_GUEST_TOKEN_SECRET: DEV_SUPERSET_GUEST_TOKEN_SECRET,
  SUPERSET_SERVICE_ACCOUNT_PASSWORD: DEV_SUPERSET_SERVICE_ACCOUNT_PASSWORD,
  SUPERSET_ADMIN_PASSWORD: DEV_SUPERSET_ADMIN_PASSWORD,
} as const;
