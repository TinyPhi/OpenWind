#!/usr/bin/env node
/**
 * CI code review script — calls Claude to review a PR diff against project
 * conventions and posts the result as a GitHub PR review comment.
 *
 * Usage:
 *   node claude-review.mjs --pr <number> --diff <path> --conventions <path>
 *
 * Required env:
 *   ANTHROPIC_API_KEY   — Anthropic API key
 *   GITHUB_TOKEN        — GitHub token with pull-requests: write
 *   GITHUB_REPOSITORY   — set automatically by GitHub Actions (owner/repo)
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    pr: { type: "string" },
    diff: { type: "string" },
    conventions: { type: "string" },
  },
});

if (!args.pr || !args.diff || !args.conventions) {
  console.error("Usage: claude-review.mjs --pr <n> --diff <path> --conventions <path>");
  process.exit(1);
}

const { ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set — skipping review.");
  process.exit(0);
}
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
  console.error("GITHUB_TOKEN or GITHUB_REPOSITORY is not set.");
  process.exit(1);
}

const diff = readFileSync(args.diff, "utf8");
const conventions = readFileSync(args.conventions, "utf8");

if (!diff.trim()) {
  console.log("Empty diff — nothing to review.");
  process.exit(0);
}

const MAX_DIFF_CHARS = 80_000;
const truncatedDiff =
  diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated — showing first 80k chars]"
    : diff;

const systemPrompt = `You are a senior engineer performing a code review on a pull request.
Your job is to check the diff against the project conventions below and flag any violations or concerns.

Focus on:
1. Convention violations (naming, file structure, forbidden patterns)
2. Security issues (missing validation, SQL injection, missing RLS, secrets in code)
3. TypeScript issues (use of \`any\`, missing return types, type assertions without comment)
4. Missing tests for changed behavior
5. Error handling problems

Be concise. Group findings by severity: 🔴 blocking, 🟡 warning, 🟢 suggestion.
If the diff looks clean, say so briefly. Do not repeat the diff back.

PROJECT CONVENTIONS:
${conventions}`;

const userPrompt = `Please review this pull request diff:\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;

console.log("Calling Claude API for review...");

const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "prompt-caching-2024-07-31",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPrompt }],
  }),
});

if (!anthropicResponse.ok) {
  const body = await anthropicResponse.text();
  console.error(`Anthropic API error ${anthropicResponse.status}: ${body}`);
  process.exit(1);
}

const { content } = await anthropicResponse.json();
const reviewBody = content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n");

console.log("Review generated. Posting to GitHub...");

const [owner, repo] = GITHUB_REPOSITORY.split("/");
const githubResponse = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/pulls/${args.pr}/reviews`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      body: `## Claude Code Review\n\n${reviewBody}`,
      event: "COMMENT",
    }),
  },
);

if (!githubResponse.ok) {
  const body = await githubResponse.text();
  console.error(`GitHub API error ${githubResponse.status}: ${body}`);
  process.exit(1);
}

console.log("Review posted successfully.");
