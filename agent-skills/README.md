# littledata specialist agent skills

Our own (not ClawHub) lean role skills for the specialized-agent pipeline. Each is a
standard OpenClaw `SKILL.md`. Deploy by placing under the OpenClaw skills root
(e.g. `~/.openclaw/skills/`, discovered up to 6 levels deep) or `openclaw skills install <dir>`.

| Skill | Role | Codes? |
|---|---|---|
| apex | Engineering lead — plan + review | no (coordinates) |
| helm | Product — feature idea → brief | no |
| lumen | Product analytics — metrics/tracking spec | delegates |
| spine | Backend | via `cli_codex` |
| prism | Frontend | via `cli_codex` |
| flux | Data pipelines | via `cli_codex` |
| forge | Infrastructure | via `cli_codex` |
| warden | Security review (PR diff) | no (read-only) |
| proof | QA / verification | delegates test code |

Coding specialists never edit files directly — they delegate to `codex exec` via the
`cli_codex` tool (codex's own sandbox), which is how "codex runs inside OpenClaw" while
staying clear of OpenClaw's exec-approval gate. Review/product roles are read-only.
