/**
 * Builds the sandbox handover as a CSV the platform admin can download and share. Built in the
 * browser from the handover already on screen: no extra request, so the credentials are never
 * fetched or sent anywhere a second time.
 */

export interface HandoverCsvAccount {
  username: string;
  email: string;
  role: string;
  password: string;
}

const HEADER = ["Username", "Email", "Role", "Password"];

// A cell starting with one of these is run as a formula by Excel/Sheets (CSV injection).
const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

function csvCell(value: string): string {
  const safe = FORMULA_TRIGGERS.some((c) => value.startsWith(c))
    ? `'${value}`
    : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV with a UTF-8 BOM, so Excel opens it as UTF-8 on a double-click. */
export function buildHandoverCsv(accounts: HandoverCsvAccount[]): string {
  const rows = [
    HEADER,
    ...accounts.map((a) => [a.username, a.email, a.role, a.password]),
  ];
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/**
 * Formats the credentials as a tab-separated table with a header row, ready for the clipboard.
 * Pastes cleanly into spreadsheets (Excel, Google Sheets), Slack or a text document.
 */
export function formatHandoverClipboard(
  accounts: HandoverCsvAccount[],
): string {
  const rows = [
    HEADER,
    ...accounts.map((a) => [a.username, a.email, a.role, a.password]),
  ];
  return rows.map((r) => r.join("\t")).join("\n");
}

export function handoverCsvFileName(orgName: string): string {
  const slug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "sandbox"}-accounts.csv`;
}

export function downloadHandoverCsv(
  orgName: string,
  accounts: HandoverCsvAccount[],
): void {
  const blob = new Blob([buildHandoverCsv(accounts)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = handoverCsvFileName(orgName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
