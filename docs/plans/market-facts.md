# Market facts — checked 2026-07-30

Live sources only. Numbers below are quoted from the pages named, not remembered.

## (a) Slack Pro and Business+ — annual per-user prices

### USD (official Slack pricing page)

Source: [https://slack.com/pricing](https://slack.com/pricing) — fetched 2026-07-30.

Exact quotes from that page:

- Pro, annual: **"$7.25 USD per user / month, when paying annually"**
- Pro, monthly (for comparison): **"$8.75 … per user / month, when paying monthly"**
- Business+, annual: **"$15 USD per user / month, when paying annually"**
- Business+, monthly (for comparison): **"$18 … USD"** with the same "per user / month, when paying monthly" wording on the plan card

### INR

Source checked: [https://slack.com/intl/en-in/pricing](https://slack.com/intl/en-in/pricing) — fetched 2026-07-30.

Exact quotes from the India-localised Slack pricing page (still denominated in US dollars, not rupees):

- Pro, annual: **"$US7.25 per user/month, when paying annually"**
- Business+, annual: **"$US15 per user/month, when paying annually"**

**Finding:** Slack does **not** publish an official INR list price on its India pricing page as of 2026-07-30. Both the global and India pages quote USD. Any rupee figure in an internal comparison would be a currency conversion, not a Slack list price — do not present a converted number as Slack's INR price.

Salesforce India's Slack pricing page (`salesforce.com/in/slack/pricing/`) also surfaces the same **USD** annual figures ($7.25 / $15) in third-party summaries; the live fetch of that page timed out in this session, so it is not quoted here as primary evidence.

## (b) Buzz (Block Inc.) — what the public README promises today

**Real repository:** [https://github.com/block/buzz](https://github.com/block/buzz)  
GitHub description: **"A hive mind communication platform"**  
Fetched README: `https://raw.githubusercontent.com/block/buzz/main/README.md` on 2026-07-30.

Exact quotes from that README today:

- Tagline: **"A workspace where humans and agents build together, on a relay you own."**
- Caption under the hero screenshot: **"People and agents building together in the same room."**
- Opening definition: **"Buzz is a self-hostable workspace where humans and AI agents share the same rooms."**
- Protocol claim: **"It's a Nostr relay: every message, reaction, workflow step, review approval, and git event is a signed event in one log. Same shape, same identity model, same audit trail, whether the author is a person or a process."**
- Agent affordances: **"The difference is what agents can actually *do* once they're inside: open repos, send patches, review code, run workflows, edit canvases, orchestrate other agents, drop into voice huddles, create channels, and pull in whoever needs to see it. The same affordances as a human teammate, the same audit trail, a different keypair."**
- Licence link in the README header: **Apache 2.0**

Also listed under "Stuff you do in Buzz" (paraphrase avoided — see the README for the full bullet list): ask the project a question with receipts; let an agent triage a bug with its own keys/memberships/audit trail; turn a feature branch into a room; search conversation/patch/workflow/approval in one place; let an agent run the workspace (channels, canvases, workflows, huddles), not just talk in it.
