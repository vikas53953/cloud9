# Cloud9 standing pipeline

- **Conductor:** Sol/root owns the request, intent, architecture, decomposition,
  integration, and final handoff. Keep work in bounded slices and use the
  maximum safe parallelism; preserve unrelated or in-progress changes.
- **Execution and review:** Prefer Luna for implementation when available;
  Terra is an explicitly authorised fallback. Every implementation has a
  distinct reviewer lane (the author does not review or approve its own work).
  Reviewers verify the claim and may require another pass before integration.
- **Reference gate:** Before implementing product or visual behaviour, observe
  the real installed app and the named reference product/docs. Record what was
  actually observed; do not fill gaps with assumptions.
- **Stages:** `branch -> implementation -> review -> tests/build -> merge ->
  installer -> installed visual walk/screenshots`. Do not call a visual change
  done from source or green tests alone; identify the binary/install and retain
  the evidence.
- **Evidence and resources:** Keep automated, structural, browser, installed-
  app, and human evidence distinct. State unverified or externally gated work
  plainly. Avoid uncontrolled retries and quota burn; use narrow, bounded
  commands and inspect results before retrying.

Existing repository guidance in `PIPELINE.md`, `HANDOFF*.md`, and `TRACKER.md`
continues to provide task-specific detail; this file is the standing rule.
