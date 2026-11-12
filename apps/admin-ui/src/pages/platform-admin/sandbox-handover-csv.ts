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
const LINK_HEADER = "Login link";

// The sandbox's login link (R13) rides along as one more column, so the sheet stays a plain table.
function withLink(
  row: string[],
  loginLink: string | null | undefined,
): string[] {
  return loginLink ? [...row, loginLink] : row;
}

function header(loginLink: string | null | undefined): string[] {
  return loginLink ? [...HEADER, LINK_HEADER] : HEADER;
}

// A cell starting with one of these is run as a formula by Excel/Sheets (CSV injection).
const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

function csvCell(value: string): string {
  const safe = FORMULA_TRIGGERS.some((c) => value.startsWith(c))
    ? `'${value}`
    : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RFC 4180 CSV with a UTF-8 BOM, so Excel opens it as UTF-8 on a double-click. */
export function buildHandoverCsv(
  accounts: HandoverCsvAccount[],
  loginLink?: string | null,
): string {
  const rows = [
    header(loginLink),
    ...accounts.map((a) =>
      withLink([a.username, a.email, a.role, a.password], loginLink),
    ),
  ];
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/**
 * Formats the credentials as a tab-separated table with a header row, ready for the clipboard.
 * Pastes cleanly into spreadsheets (Excel, Google Sheets), Slack or a text document.
 *
 * Values are raw on purpose, unlike `csvCell`: this text exists to be pasted as real credentials,
 * and prefixing a value that starts with a formula trigger would change the password. The server
 * generates every value (usernames and emails are slugs, passwords start "Ow-"), so none starts
 * with a trigger or contains a tab or newline. If that ever changes, escape here and say so on
 * the handover screen instead.
 */
export function formatHandoverClipboard(
  accounts: HandoverCsvAccount[],
  loginLink?: string | null,
): string {
  const rows = [
    header(loginLink),
    ...accounts.map((a) =>
      withLink([a.username, a.email, a.role, a.password], loginLink),
    ),
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
  loginLink?: string | null,
): void {
  const blob = new Blob([buildHandoverCsv(accounts, loginLink)], {
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
