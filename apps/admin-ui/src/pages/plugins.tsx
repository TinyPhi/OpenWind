import React, { useState } from "react";
import { useList } from "@refinedev/core";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Button,
  TOKENS,
} from "@platform/ui";
import { useTranslation } from "react-i18next";
import { fetchWithAuth, API_URL } from "../lib/api.js";

/**
 * Plugin health dashboard (3B Phase 3, R11) — reuses the generic Table
 * primitive rather than a bespoke per-plugin view, same "one generic
 * component serves every module" precedent 2C already established for
 * modules/entities. Backed by GET /plugins (apps/api's listPluginsForTenant).
 */
export interface PluginListEntry {
  slug: string;
  name: string;
  version: string;
  category: string;
  installed: boolean;
  status: "installing" | "active" | "error" | "disabled" | null;
  errorCount: number;
}

const STATUS_LABEL: Record<string, string> = {
  installing: "Installing…",
  active: "Active",
  error: "Error",
  disabled: "Disabled",
};

export function Plugins(): React.ReactElement {
  const { t } = useTranslation();
  const {
    result: data,
    query: { isLoading, refetch },
  } = useList<PluginListEntry>({
    resource: "plugins",
  });
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const plugins = data.data;

  async function handleUninstall(slug: string): Promise<void> {
    setBusySlug(slug);
    setErrorMessage(null);
    try {
      await fetchWithAuth(`${API_URL}/plugins/${slug}/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await refetch();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : t("plugins.failedToUninstall"),
      );
    } finally {
      setBusySlug(null);
    }
  }

  if (isLoading) {
    return <div style={{ padding: 24 }}>{t("plugins.loading")}</div>;
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>{t("plugins.title")}</h1>
      {errorMessage && <p style={{ color: TOKENS.danger }}>⚠ {errorMessage}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("plugins.name")}</TableHead>
            <TableHead>{t("plugins.version")}</TableHead>
            <TableHead>{t("plugins.category")}</TableHead>
            <TableHead>{t("plugins.statusHeader")}</TableHead>
            <TableHead>{t("plugins.errors")}</TableHead>
            <TableHead>{t("plugins.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plugins.map((plugin) => (
            <TableRow key={plugin.slug}>
              <TableCell>{plugin.name}</TableCell>
              <TableCell>{plugin.version}</TableCell>
              <TableCell>{plugin.category}</TableCell>
              <TableCell>
                {plugin.installed
                  ? (STATUS_LABEL[plugin.status ?? ""] ?? plugin.status)
                  : t("plugins.notInstalled")}
              </TableCell>
              <TableCell>
                {plugin.errorCount > 0 ? (
                  <span style={{ color: TOKENS.danger }}>
                    {plugin.errorCount}
                  </span>
                ) : (
                  0
                )}
              </TableCell>
              <TableCell>
                {plugin.installed && plugin.status !== "disabled" ? (
                  <Button
                    variant="secondary"
                    disabled={busySlug === plugin.slug}
                    onClick={() => void handleUninstall(plugin.slug)}
                  >
                    {busySlug === plugin.slug
                      ? t("plugins.uninstalling")
                      : t("plugins.uninstall")}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
