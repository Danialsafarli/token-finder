# Token Finder — project instructions

Token Finder discovers, analyses, ranks and monitors newly launched Solana
tokens. It is a **read-only analysis tool**: it reads public market and chain
data and produces rankings. It holds no keys, signs nothing, and trades nothing.

Architecture is documented in [ARCHITECTURE.md](ARCHITECTURE.md),
[PIPELINE.md](PIPELINE.md) and [SCORING.md](SCORING.md). Read those before
changing analysis behaviour.

---

## Solana work: use authoritative sources

The Solana ecosystem moves faster than any model's training cutoff. For
**non-trivial Solana-specific work** — account layouts, RPC semantics, SPL /
Token-2022 behaviour, transaction formats, program development — prefer live
official sources over recall.

### Tools available

**Solana Developer MCP** (`solana-mcp`, `https://mcp.solana.com/mcp`, no API key):

| Tool | Use for |
|---|---|
| `list_sections` | discovering which documentation sources are relevant — call this first |
| `get_documentation` | canonical full documentation for a source or section id |
| `Solana_Documentation_Search` | narrow semantic queries across the docs corpus |
| `Solana_Expert__Ask_For_Help` | specific how-to and debugging questions |
| `program_autofixer` | static security linting of Solana program Rust |

**Official Solana Development Skill** (`solana-dev`, Solana Foundation, MIT) —
current implementation practice: `@solana/kit`, Wallet Standard, RPC usage,
SPL / Token-2022, Anchor and Pinocchio, testing, security, version
compatibility.

The skill's content is not committed. Re-create it in a fresh clone with:

```bash
npx skills add solana-foundation/solana-dev-skill
```

`skills-lock.json` records the source and content hash and **is** committed.

### Source priority

1. **Tier 1** — Solana Developer MCP, the official Solana Development Skill,
   official Solana documentation.
2. **Tier 2** — official documentation for the specific framework or provider
   in use (DexScreener, Jupiter, RugCheck, Helius, Birdeye).
3. **Tier 3** — official Solana templates and program examples.
4. **Tier 4** — high-quality community references and prior work.

Community examples are never canonical when current official documentation
exists. State which tier an answer came from, and mark anything resting on
recall rather than a retrieved source as an assumption.

### Rules that constrain Solana work here

- **Do not migrate the stack because a newer one exists.** Token Finder has
  **zero runtime dependencies** — no `@solana/web3.js`, no `@solana/kit`, no
  Anchor. It reads the chain through Helius JSON-RPC over `fetch`. That is a
  deliberate architectural choice, not an oversight. The skill will recommend
  `@solana/kit` for new applications; that recommendation is correct in general
  and does **not** by itself justify changing this project.
- **Any dependency or migration is a separate architecture decision**, taken
  explicitly, with compatibility evaluated against Node 24 and the existing
  zero-dependency runtime shape. Never introduced as a side effect of another
  task.
- **If Solana program Rust is ever written here**, run `program_autofixer` per
  the official MCP workflow and re-check after each round of fixes until it
  reports nothing further. There is no on-chain program in this project today,
  and one must not be created merely to exercise that tool.

---

## Evidence discipline

This project already enforces a strict evidence model, and Solana work must
respect it. Full detail in [PIPELINE.md](PIPELINE.md); the short version:

- **UNKNOWN is never zero, and INVALID is never safe.** Missing evidence earns
  no points and reduces coverage.
- **Score, coverage and confidence are three separate numbers** and are never
  multiplied together.
- **Provider disagreement stays visible**, resolved conservatively for safety
  facts, with every claim retained.
- **Stale evidence cannot assert a current fact** — neither a veto nor a
  penalty.
- **Never fabricate** a value, a confidence, a probability or a target.
  `UNKNOWN`, `INSUFFICIENT_DATA` and `NOT_MEASURED` are correct answers.

## Boundaries

- **TypeSafe / Jev stays disabled** (`TYPESAFE_ENABLED=false`) and has zero
  effect on scoring, ranking or vetoes. It is advisory only.
- **No trading, no wallet integration, no key handling** without explicit
  approval. The roadmap reaches these; the code does not.
- **Technical Intelligence is planned, not implemented** — see
  [TECHNICAL_INTELLIGENCE.md](TECHNICAL_INTELLIGENCE.md).

## Verification

```bash
npm run typecheck    # tsc --noEmit
npm test             # node --test
npm run check        # both
```

Secrets come from the environment only, read solely by `src/config.ts`. Never
commit a real key; `.env.example` documents the variable names with empty
values.
