import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import yaml from "js-yaml";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const obsDir = path.resolve(__dirname, "../../../docker/observability");

interface PrometheusRuleGroup {
  groups: {
    rules: {
      alert: string;
      labels?: {
        team?: string;
      };
    }[];
  }[];
}

interface AlertmanagerConfig {
  global?: {
    smtp_smarthost?: string;
  };
  receivers?: {
    name: string;
  }[];
}

interface GrafanaDatasources {
  datasources?: {
    name: string;
    url: string;
  }[];
}

interface GrafanaDashboards {
  providers?: {
    options: {
      path: string;
    };
  }[];
}

interface GrafanaDashboardJson {
  title: string;
  panels: {
    title: string;
  }[];
}

function isDockerAvailable(): boolean {
  try {
    const res = spawnSync("docker", ["info"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

describe("Observability Configuration Validation", () => {
  it("validates alert.rules.yml has correct syntax and rules", () => {
    const rulesPath = path.join(obsDir, "alert.rules.yml");
    expect(fs.existsSync(rulesPath)).toBe(true);

    const content = fs.readFileSync(rulesPath, "utf8");
    const parsed = yaml.load(content) as PrometheusRuleGroup;

    expect(parsed).toBeDefined();
    expect(parsed.groups).toBeInstanceOf(Array);
    expect(parsed.groups.length).toBeGreaterThan(0);

    const rules = parsed.groups![0]!.rules;
    const alerts = rules.map((r) => r.alert);

    // Finding 10: QueueDepth split into high/low throughput families
    expect(alerts).toContain("QueueDepthHighPlatform");
    expect(alerts).toContain("QueueDepthHighWorker");
    expect(alerts).toContain("HttpErrorRateHigh");
    expect(alerts).toContain("HttpLatencyHigh");

    // Finding 5: Ensure team label is set for routing
    for (const rule of rules) {
      expect(rule.labels?.team).toBe("platform");
    }
  });

  it("validates alert.rules.yml with promtool check rules if docker is available", () => {
    if (!isDockerAvailable()) {
      console.warn("Docker not available, skipping promtool validation");
      return;
    }
    const res = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${obsDir}:/obs`,
        "--entrypoint",
        "promtool",
        "prom/prometheus:v2.53.0",
        "check",
        "rules",
        "/obs/alert.rules.yml",
      ],
      { encoding: "utf8" },
    );
    if (res.status !== 0) {
      throw new Error(
        `promtool validation failed: ${res.stdout || res.stderr || ""}`,
      );
    }
    expect(res.stdout).toContain("SUCCESS");
  }, 60000);

  it("validates alertmanager.yml has correct syntax and mailhog config", () => {
    const amPath = path.join(obsDir, "alertmanager.yml");
    expect(fs.existsSync(amPath)).toBe(true);

    const content = fs.readFileSync(amPath, "utf8");
    const parsed = yaml.load(content) as AlertmanagerConfig;

    expect(parsed).toBeDefined();
    expect(parsed.global).toBeDefined();
    expect(parsed.global!.smtp_smarthost).toBe("ow-mailhog:1025");
    expect(parsed.receivers).toBeInstanceOf(Array);
    expect(parsed.receivers![0]!.name).toBe("mailhog");
  });

  it("validates alertmanager.yml with amtool check-config if docker is available", () => {
    if (!isDockerAvailable()) {
      console.warn("Docker not available, skipping amtool validation");
      return;
    }
    const res = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${obsDir}:/obs`,
        "--entrypoint",
        "amtool",
        "prom/alertmanager:v0.27.0",
        "check-config",
        "/obs/alertmanager.yml",
      ],
      { encoding: "utf8" },
    );
    if (res.status !== 0) {
      throw new Error(
        `amtool validation failed: ${res.stdout || res.stderr || ""}`,
      );
    }
    expect(res.stdout).toContain("SUCCESS");
  }, 60000);

  it("validates Grafana datasources provisioning file syntax", () => {
    const dsPath = path.join(
      obsDir,
      "grafana/provisioning/datasources/datasources.yaml",
    );
    expect(fs.existsSync(dsPath)).toBe(true);

    const content = fs.readFileSync(dsPath, "utf8");
    const parsed = yaml.load(content) as GrafanaDatasources;

    expect(parsed).toBeDefined();
    expect(parsed.datasources).toBeInstanceOf(Array);
    expect(parsed.datasources![0]!.name).toBe("Prometheus");
    expect(parsed.datasources![0]!.url).toBe("http://ow-prometheus:9090");
  });

  it("validates Grafana dashboards provisioning file syntax", () => {
    const dbProvPath = path.join(
      obsDir,
      "grafana/provisioning/dashboards/dashboards.yaml",
    );
    expect(fs.existsSync(dbProvPath)).toBe(true);

    const content = fs.readFileSync(dbProvPath, "utf8");
    const parsed = yaml.load(content) as GrafanaDashboards;

    expect(parsed).toBeDefined();
    expect(parsed.providers).toBeInstanceOf(Array);
    expect(parsed.providers![0]!.options.path).toBe("/etc/grafana/dashboards");
  });

  it("validates openwind-dashboard.json has correct syntax and expected panels", () => {
    const dbPath = path.join(
      obsDir,
      "grafana/dashboards/openwind-dashboard.json",
    );
    expect(fs.existsSync(dbPath)).toBe(true);

    const content = fs.readFileSync(dbPath, "utf8");
    const parsed = JSON.parse(content) as GrafanaDashboardJson;

    expect(parsed).toBeDefined();
    expect(parsed.title).toBe("OpenWind Platform");
    expect(parsed.panels).toBeInstanceOf(Array);
    expect(parsed.panels.length).toBeGreaterThanOrEqual(7);

    const panelTitles = parsed.panels.map((p) => p.title);
    expect(panelTitles).toContain("API Request Rate");
    expect(panelTitles).toContain("HTTP 5xx Error Rate (%)");
    expect(panelTitles).toContain("HTTP Latency (P95)");
    expect(panelTitles).toContain("BullMQ Queue Depths (Waiting Jobs)");
    expect(panelTitles).toContain("HTTP Latency (P99)");
    expect(panelTitles).toContain("Degraded Tenants by Reason");
    expect(panelTitles).toContain("Billing Rejections (422)");
  });
});
