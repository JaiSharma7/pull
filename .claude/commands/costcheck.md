---
description: Audit the codebase for read-path model calls and report generation spend.
---

Cost law (`CLAUDE.md` §2): **no LLM in the read path, ever.**

1. Search the read path — `supabase/migrations/*rpc*`, `packages/ranking`, and every
   `apps/web` data hook — for anything that reaches a model provider. Ranking, search,
   the Delta and the interleave planner must be SQL and vector maths only.
2. Any provider call outside `supabase/functions/worker` is a finding. Report it with
   `file:line` and explain what it would cost per impression at scale.
3. Summarise `cost_ledger`: total spend, spend per published summary, and the most
   expensive step. Flag any summary whose generation cost is a visible outlier — a
   canonical summary should amortise toward a fraction of a cent per reader.
