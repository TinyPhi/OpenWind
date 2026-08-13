---
name: interview-me
description: Extracts what the user actually wants before any plan, spec, or code is written. Invoke when a request is missing who the user is, why now, what success looks like, or what's out of scope, or when starting Phase 3 planning before a spec or primer exists.
---

# Skill: interview-me

Extract what the user actually wants before any plan, spec, or code is written.
The cheapest moment to find a requirements gap is before anything exists.

---

## When to use

Invoke `/interview` when:

- The request is missing: who the user is, why now, what success looks like, or what's out of scope
- The ask uses conventional language that may mask the real need ("make it faster",
  "add notifications", "improve the workflow")
- Starting Phase 3 planning — before writing the phase-3-primer or any spec
- Explicitly invoked: "interview me", "stress-test my thinking", "help me figure out what I want"

---

## Process

### 1. Hypothesize first

Before asking anything, state your best read of the request and a confidence number:

> "My read: you want X so that Y. Confidence: 60%. Let me check a few things."

This anchors the conversation and gives the user something to correct.

### 2. Ask one question at a time

Each question includes your guess at the answer:

> "Who is the primary user of this feature? My guess: the tenant admin, not the end customer."

Never ask more than one question per turn. Batching feels like a form, not a conversation.

### 3. Watch for "want vs. should want"

Listen for signals the user is answering what they think they _should_ want:

- Buzzwords without substance ("enterprise-grade", "AI-powered")
- Deferring to convention ("everyone does it this way")
- Vague affirmations when pushed on specifics

When you hear these, probe with: "What specifically breaks if we skip that?"

### 4. Restate intent

Once you reach ~95% confidence, restate the intent in the user's own language:

```
Outcome: [what will be true when done]
User: [who specifically benefits]
Why now: [what changed that makes this urgent]
Success: [how we'll know it worked — specific and measurable]
Constraints: [what we cannot do]
Out of scope: [what we are explicitly not doing]
```

The "Out of scope" line is the most important — it prevents silent misalignment.

### 5. Require explicit confirmation

"Yes, that's exactly it" counts.
"Whatever you think is best" does not count.
"Sounds good" does not count.
Silence does not count.

Keep asking until you get an unambiguous yes.

---

## Stop condition

Stop interviewing when you can predict the user's reaction to the next three questions
you would ask. That means you have enough.

---

## Output

If the user confirms, save to `docs/intent/[topic].md` and use it as the input
to `/spec` — replacing the vague original request.
