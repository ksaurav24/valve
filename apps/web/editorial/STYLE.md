# Engineering article checklist

Write for experienced JavaScript and backend developers in Saurav's voice:
conversational, technical, precise, and interested in tradeoffs. First-person
design reasoning must describe an actual choice, not an invented experience.

- Give each article one argument, a concrete failure or workload, and a distinct
  opening and ending. Use connected paragraphs and sentence-case headings.
- Use current Valve APIs and make imports, store ownership, scope identities,
  timing assumptions, and cleanup clear. Label illustrative numbers and timelines.
- Separate grant, callback start, HTTP arrival, and external completion. Atomic
  admission does not provide refunds or exactly-once external effects.
- State the atomicity domain: one configured Valve ID and, for Redis Cluster,
  one key slot. Independent chains and group children do not share one grant.
- Treat Bottleneck fairly. Its Redis operations are atomic; its independent
  chained admissions are not one multi-budget transaction. Explain where its
  scheduling features fit better.
- Keep local queues, global leases, scoped rate counters, and feedback domains
  distinct. Do not promise cross-worker fairness or cancellation of side effects.
- Distinguish GCRA pacing/burst, epoch-aligned fixed windows, and unsupported
  exact rolling windows. Do not describe illustrative quotas as provider policy.
- Cite relevant primary sources inline and add 2-5 useful further-reading links.
  Verify links and claims against the implementation. Do not copy source prose.
- Never invent measurements or personal experiments. Explain workload, build,
  resource controls, replication, and A/A uncertainty when discussing evidence.
- Use no em dash, emoji, keyword stuffing, sales language, canned intro/outro,
  or filler such as "delve", "leverage", "unlock", or "game-changer".
- Frontmatter needs title, description, quoted date, author, and explicit draft
  state. Publication date for this series is `2026-10-29` after review.
- Render examples as fenced code and compact timelines as Markdown tables/text.
  Link to current guides and relevant sibling articles without repeating sections.

Every article receives its own independent editorial and technical review.
Resolve factual blockers, major style findings, citation problems, and
cross-article contradictions before publication. Verify code, MDX rendering,
article routes, index, metadata, heading anchors, and sitemap in the final build.
