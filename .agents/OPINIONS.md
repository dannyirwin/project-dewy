# OPINIONS.md

Compact map of Danny's durable beliefs about engineering, tools, and how to work.
Optimized for agents and future-you: concise, stable, easy to scan.

**Default stance:** strong opinions, loosely held.
Revisit when evidence, context, or experience changes.

## What belongs here

- Durable principles, taste, tradeoffs, and recurring judgments.
- Predictions and critiques only when they are stable enough to matter.

## What does not belong here

- Jokes, hot takes, one-off reactions, or context-specific comments.
- Implementation recipes, commands, API walkthroughs, or debugging steps.
- Quotes or steelmanning of someone else's view unless Danny clearly adopts it.

Technical details are evidence for an opinion, not content to copy.

---

## Software engineering

### Quality beats short-term development cost

Danny does not optimize primarily for how fast something is to build today.
He prefers quality, simplicity, robustness, scalability, and long-term
maintainability.
Evidence: `AGENTS.md`

### Reproduce bugs the way users hit them

Danny starts bug fixes by reproducing the problem in an end-to-end path that
matches real user interaction.
He wants the root cause fixed, not a patch that only works in isolation.
Evidence: `AGENTS.md`

### Fix what you touch, and what you notice

Danny holds a high bar for UI polish, lint, test failures, and flaky tests.
If something is clearly wrong while he is working nearby, he fixes it rather
than leaving it for later.
Evidence: `AGENTS.md`

### Tests encode intent

Danny treats tests as the durable statement of what should happen.
They give humans and agents a feedback loop when requirements are clear enough to
write down.

---

## Developer tools and workflow

### Reproducible personal infrastructure

Danny keeps machine setup in version-controlled dotfiles with symlinks, not
manual memory.
Local-only secrets and machine-specific paths stay out of the repo.
Evidence: `install.sh`, `README.md`, `~/.zshrc.local` pattern

### Good defaults, sensible overrides

Danny likes opinionated defaults that are centrally tuned, with escape hatches
for advanced use.
Examples: Tokyo Night across terminal tools, `fd` for fzf when available, XDG
base dirs.
Evidence: `wezterm/`, `tmux/`, `zsh/`, `nvim/`

### Clear tool boundaries over forced unification

Danny prefers each tool to do its job well rather than forcing everything
through one layer.
WezTerm for terminal UI, tmux for sessions, Neovim for editing, Starship for
prompt.

---

## AI agents

### Humans stay accountable

Danny treats AI as a tool, not a teammate or co-author.
Humans choose goals, approve outputs, and own consequences.
Agents should not auto-add themselves as commit co-authors.
Evidence: `AGENTS.md`

### Agents should verify, not just assert

Danny prefers agents that gather evidence with search, tests, and tools over
unsupported reasoning.
Wrong answers and rework cost more than slower, tool-heavy runs.

### Markdown for long-form agent context

Danny puts one full sentence per line in long Markdown files agents will read or
edit.
Evidence: `AGENTS.md`

---

## Product and building

<!-- Add stable beliefs here as they form. -->

---

## Career and learning

<!-- Add stable beliefs here as they form. -->
