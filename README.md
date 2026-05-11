# Life Review OS

[English](README.md) | [中文](README.zh.md)

> A Claude Skill that automates **weekly planning / bi-weekly retros / quarterly direction checks**.
> Reads your Lark (Feishu) Weekly doc, compares plan vs. execution, generates next week's plan, and writes it back automatically.

![License](https://img.shields.io/badge/license-MIT-blue)
![Skill](https://img.shields.io/badge/claude-skill-orange)
![Lark](https://img.shields.io/badge/integration-feishu/lark-green)

---

## What is this?

Life Review OS is a Claude Skill built for people who **already do OKR + weekly planning in Lark (Feishu)**.

It solves a very specific pain: **you make plans, but rarely look back; execution drifts, and you don't feel it.**

Trigger the skill once a week (or every two weeks, or at quarter end) and it will:

1. Read your OKR definition and the last N weeks of execution table
2. Compare plan vs. actual — flag completed / missed / drifted items
3. Combine your verbal retro and how you felt this week
4. Generate next week's plan (with MITs) and write it back into the Lark table

Choice of analysis framework:
- `stephen-covey` — Q1/Q2/Q3/Q4 + P/PC balance + mission alignment
- `okr-pure` — pure KR completion rate + drift detection

---

## Quick start

### Prerequisites

- [Claude Code](https://claude.com/claude-code) CLI installed
- [lark-cli](https://github.com/larksuite/lark-openapi-cli) installed, with `lark-cli auth login` done
- A Lark Weekly doc (containing an OKR section + a per-week execution table)

### Install

```bash
# 1. Clone into your Claude skills directory
git clone https://github.com/alexli-77/life-review-os.git \
  ~/.claude/skills/weekly-review

# 2. Copy the config template and fill in your Lark tokens
cd ~/.claude/skills/weekly-review
cp config.example.yaml config.yaml
$EDITOR config.yaml
```

### Configure `config.yaml`

```yaml
user:
  name: Your Name
  symbol: 🐧                # emoji that identifies you in the Lark doc
  timezone: America/Toronto

framework: stephen-covey    # or okr-pure

documents:
  mission_statement: YOUR_MISSION_DOC_TOKEN
  five_year_plan: YOUR_FIVE_YEAR_PLAN_TOKEN
  weekly:
    - year: 2026
      token: YOUR_2026_WEEKLY_TOKEN
      table_block_id: YOUR_2026_TABLE_BLOCK_ID
    - year: 2025
      token: YOUR_2025_WEEKLY_TOKEN

modes:
  weekly:
    lookback_weeks: 2
    auto_write: true
  biweekly:
    lookback_weeks: 4
    auto_write: true
  quarterly:
    auto_write: false       # quarterly reports require manual confirmation before write-back
```

> The Lark doc token is in the URL: `https://xxx.feishu.cn/docx/[TOKEN]`
>
> The table `block_id` can be found via `lark-cli api GET /open-apis/docx/v1/documents/{token}/blocks`.

---

## Usage

Inside Claude Code:

```
/weekly-review              # weekly mode (default)
/weekly-review weekly       # same as above
/weekly-review biweekly     # bi-weekly retro + trend analysis
/weekly-review quarterly    # quarter-end deep retro + mission alignment
```

You can also trigger via natural language: "do my weekly review" / "run a bi-weekly retro".

### Standard flow after trigger

```
Step 1: Skill asks for your retro and how this week felt
Step 2: Reads the OKR section + last N weeks of execution table
Step 3: Comparative analysis (completed / missed / drifted)
Step 4: Generates next week's plan (MIT + 6-8 priority items)
Step 5: Outputs an analysis summary in the chat
Step 6: Auto-writes a new column to the Lark table (quarterly mode requires manual confirmation)
```

### Input example

```
retro: Finished the main project's day-to-day work; side project still stuck before the last step.
how I felt: A bit low mood, but workouts were on point. External pressure was high.
```

---

## Three modes compared

| | weekly | biweekly | quarterly |
|---|---|---|---|
| Frequency | every week | every two weeks | every quarter end |
| Read range | last 2 weeks | last 4 weeks | full quarter + mission statement + 5-year plan |
| Extra output | — | KR trend table + MIT completion rate | mission alignment + long-term stagnation + direction check |
| Auto write-back | ✅ | ✅ | ❌ (needs confirmation) |
| Duration | < 2 min | < 5 min | 15-30 min |

---

## File structure

```
life-review-os/
├── SKILL.md                # Claude skill entry point
├── config.example.yaml     # config template (copy to config.yaml)
├── engine/                 # general execution engine
│   ├── 01-read.md          # read Lark docs
│   ├── 02-analyze.md       # analysis logic
│   ├── 03-plan.md          # generate next week's plan
│   └── 04-write.md         # write back to Lark
├── frameworks/             # analysis frameworks (extensible)
│   ├── stephen-covey.md
│   └── okr-pure.md
└── modes/                  # rules for the three modes
    ├── weekly.md
    ├── biweekly.md
    └── quarterly.md
```

**Two-layer architecture:** `engine/`, `frameworks/`, `modes/` are general — shared by all users.
`config.yaml` is personal — `.gitignore`'d, never committed.
Migrating to a new user means changing only `config.yaml`.

---

## Extending

### Add a new analysis framework

Add a `.md` file under `frameworks/`, following the structure of existing files:
- Input: OKR + last N weeks of execution data
- Output: diagnostic summary

Then in `config.yaml`, set `framework` to the new file name (without `.md`).

### Replace the data source

The current implementation is bound to Lark. If you use Notion / Obsidian / Google Docs,
rewrite `engine/01-read.md` and `engine/04-write.md` — the other files don't need changes.

---

## Limitations

- ❌ No scheduled triggers — you run it manually (or wrap it yourself with `launchd` / cron)
- ❌ Write-back acts as your Lark user, not as an "organization"
- ⚠️ The Lark doc structure must match the expected layout: OKR section + per-week table

---

## Optional: Obsidian knowledge-base integration

The watch-list scan and OKR metadata persistence features rely on a local knowledge-base directory (any markdown notes folder works — Obsidian / Logseq / plain `.md` folders all supported).

If you don't have a suitable knowledge-base structure yet, use the companion template:

> **Leon-knowledgeBase-template**
> https://github.com/alexli-77/Leon-knowledgeBase-template
>
> Obsidian PARA structure + Claude Code `/record` skill, one-command deploy. Already includes the `99_Meta/watch-list.md` structure this skill expects.

Enable: set `vault.enabled` to `true` in `config.yaml` and point `vault.path` to your notes directory. On first run, the skill will ask whether to create `okr-metadata.yaml` (used for deadline / status structured fields).

Once vault is enabled, another optional feature unlocks: **Todos file**. Point `vault.todos` to `99_Meta/todos.md` (or wherever you prefer) to track small ad-hoc todos that exist outside your OKRs (things like "renew car insurance" or "buy new badminton shoes" — not worth a KR, but you don't want to forget). The skill only reads (never writes) this file during weekly review, surfaces overdue / urgent items as background, and folds up to 2 items into next week's "if there's bandwidth" block. Format reference: [`examples/todos.md.example`](examples/todos.md.example).

Don't want to use a knowledge base? Set `vault.enabled` to `false` — core OKR review still works exactly the same.

See [`references/metadata-conventions.md`](references/metadata-conventions.md) for details.

---

## Contributing

Bug fixes, doc improvements, new analysis frameworks — all welcome.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. It covers:
- Which PRs can go directly, which should start as an issue
- The full fork + branch + PR flow
- Commit message style and constraints on sensitive info

> This is a personal project. PR response time may be 1-2 weeks. If your change is time-sensitive, open an issue first.

---

## License

MIT — use, modify, distribute freely.
