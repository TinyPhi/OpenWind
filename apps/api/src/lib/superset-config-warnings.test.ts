import { describe, it, expect, vi, beforeEach } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@platform/logger", () => ({ logger: { warn } }));

import { logSupersetConfigWarnings } from "./superset-config-warnings.js";

describe("logSupersetConfigWarnings", () => {
  beforeEach(() => warn.mockClear());

  it("logs nothing for a clean config", () => {
    logSupersetConfigWarnings({
      SUPERSET_DEPLOYMENT: "off",
      SUPERSET_OAUTH_CLIENT_ID: undefined,
      SUPERSET_ERASURE_ENABLED: undefined,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once about the deprecated SUPERSET_ERASURE_ENABLED", () => {
    logSupersetConfigWarnings({
      SUPERSET_DEPLOYMENT: "on",
      SUPERSET_OAUTH_CLIENT_ID: undefined,
      SUPERSET_ERASURE_ENABLED: "true",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {},
      expect.stringContaining("SUPERSET_ERASURE_ENABLED is deprecated"),
    );
  });

  it("warns about an OAuth client id while the deployment is off", () => {
    logSupersetConfigWarnings({
      SUPERSET_DEPLOYMENT: "off",
      SUPERSET_OAUTH_CLIENT_ID: "client-1",
      SUPERSET_ERASURE_ENABLED: undefined,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {},
      expect.stringContaining("SUPERSET_DEPLOYMENT is off"),
    );
  });
});
