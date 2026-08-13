---
name: source-driven-development
description: Grounds a framework-specific implementation decision in official versioned documentation instead of training-data patterns. Invoke when implementing a pattern for a dependency not used recently in this project (BullMQ, Drizzle, Hono, Zitadel, Novu), when correctness depends on the exact version in use, or when wiring up a Phase 3A-3C external service integration.
---

# Skill: source-driven-development

Ground every framework-specific decision in official versioned documentation.
Training data goes stale. APIs get deprecated. Best practices evolve.

---

## When to use

Invoke `/sourced` when:

- Implementing a pattern for a dependency you haven't used recently in this project
- The user requests a "correct" or "current" implementation
- Correctness depends on the specific version in use (BullMQ, Drizzle, Hono, Zitadel, Novu)
- You are about to wire up an external service integration (Phase 3A–3C especially)

Skip for pure logic, variable renaming, or when the user explicitly prioritises speed.

---

## Process

### 1. DETECT — read the dependency file

```bash
cat package.json | jq '.dependencies, .devDependencies'
```

Note the **exact version** of the package in question. A pattern that is correct for
BullMQ 4.x may be wrong for 5.x.

### 2. FETCH — retrieve official documentation

Sources in priority order:

1. Official docs site for that package + version (e.g. `docs.bullmq.io`, `orm.drizzle.team`)
2. Official changelog / migration guide for the version in use
3. Web standards bodies (MDN, web.dev) for platform APIs
4. Official GitHub repository README or `/docs` directory

**Not authoritative:** Stack Overflow, blog posts, AI-generated docs, training data.

Use WebFetch to retrieve the relevant page. If the page is versioned, find the version
matching the project's `package.json`.

### 3. IMPLEMENT — follow the documented pattern

Implement exactly what the current version's docs show.
If the docs show a different pattern than what is currently in the codebase, surface
the conflict — do not silently pick one.

### 4. CITE — reference the source

For every non-trivial framework-specific decision, include in your response:

- The URL of the documentation page consulted
- The relevant quote or code sample

---

## OpenWind packages to verify against official docs

| Package       | Docs                          |
| ------------- | ----------------------------- |
| `bullmq`      | https://docs.bullmq.io        |
| `drizzle-orm` | https://orm.drizzle.team/docs |
| `hono`        | https://hono.dev/docs         |
| `zod`         | https://zod.dev               |
| `@novu/node`  | https://docs.novu.co          |
| Zitadel       | https://zitadel.com/docs      |
| OpenBao       | https://openbao.org/docs      |

---

## Flag, don't guess

If you cannot find official documentation for a pattern:

> "I could not find official documentation for [X] in [package] [version].
> This is unverified. Proceed with review?"

Never deliver unverified framework-specific patterns with false confidence.
