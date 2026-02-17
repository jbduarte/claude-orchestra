# Claude Orchestra — Brainstorm

**Date**: 2026-02-17
**Status**: Approved

## What We're Building

A terminal dashboard (TUI) that monitors all active Claude Code sessions, teams, and tasks from a single view. It reads the existing JSON files that Claude Code writes to `~/.claude/` and renders a unified dashboard with real-time updates and macOS notifications.

**Target user**: Claude Code power users who run multiple sessions in parallel across projects.

## Why This Approach

- Claude Code already writes rich, structured data to `~/.claude/` (tasks, teams, inboxes, stats, session history)
- No need to modify Claude Code itself — purely read-only monitoring
- File watching is simple and reliable
- Node.js + Ink gives React-like TUI components that are fast to build and iterate on

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope (MVP) | Monitor only | Start simple. Launching sessions can be added later. |
| Tech stack | Node.js + Ink | React-like TUI, fast iteration, rich ecosystem |
| Data source | `~/.claude/` JSON files | Already exists, well-structured, no integration needed |
| Detection method | File watching only | Simpler than process detection, sufficient for MVP |
| Primary view | Session overview | See all sessions, their tasks, progress, activity |
| Notifications | macOS native (osascript) | Free, no dependencies, works in background |

## Core Features (MVP)

### 1. Session Overview Panel
- List all active teams from `~/.claude/teams/*/config.json`
- Show team members, their roles, model, and status (active/idle)
- Show recent project sessions from `~/.claude/projects/*/` JSONL timestamps

### 2. Task Progress Panel
- Read `~/.claude/tasks/*/` JSON files
- Show task lists with status (pending/in_progress/completed)
- Progress bars per team (completed/total)
- Show blockers and dependencies

### 3. Message & Review Queue
- Read `~/.claude/teams/*/inboxes/*.json`
- Show unread messages across all agents
- Highlight idle notifications and task assignments
- Flag items needing human input (plan approvals, permission prompts)

### 4. Stats Panel
- Read `~/.claude/stats-cache.json`
- Show daily activity (messages, sessions, tool calls)
- Token usage by model
- Session history timeline

### 5. Notifications
- macOS notifications via `osascript` when:
  - A task completes
  - An agent goes idle (may need input)
  - A new unread message arrives
  - An error is detected in session output

## Data Sources (from ~/.claude/)

| Source | Path | What it provides |
|--------|------|-----------------|
| Teams | `teams/*/config.json` | Team members, roles, models, status |
| Inboxes | `teams/*/inboxes/*.json` | Agent messages, idle notifications |
| Tasks | `tasks/*/` | Task lists, progress, blockers |
| Stats | `stats-cache.json` | Daily activity, token usage |
| History | `history.jsonl` | Session timeline, query history |
| Projects | `projects/*/` | Session files by project |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Ink TUI App                      │
│  ┌────────────┐ ┌──────────┐ ┌────────────────┐ │
│  │  Sessions   │ │ Tasks    │ │ Messages/Queue │ │
│  │  Panel      │ │ Panel    │ │ Panel          │ │
│  └────────────┘ └──────────┘ └────────────────┘ │
│  ┌──────────────────────────────────────────────┐│
│  │              Stats Bar                        ││
│  └──────────────────────────────────────────────┘│
└──────────────────┬──────────────────────────────┘
                   │
         ┌─────────┴─────────┐
         │   State Manager    │
         │  (poll + aggregate)│
         └─────────┬─────────┘
                   │
    ┌──────────────┼──────────────┐
    │              │              │
┌───┴───┐   ┌─────┴────┐  ┌─────┴─────┐
│ File   │   │ Notifier │  │ Parser    │
│ Watcher│   │ (osascript│  │ (JSON)   │
└───┴───┘   └──────────┘  └───────────┘
    │
~/.claude/ (read-only)
```

## Future Extensions (Post-MVP)

- Launch new Claude Code sessions from dashboard
- Kill/restart sessions
- Send messages to agents from dashboard
- Cross-machine sync (if Claude data is in Dropbox/cloud)
- Web UI alternative
- Cost estimation based on token usage

## Open Questions

- How frequently should we poll? (1s? 2s? fswatch events?)
- Should we support keyboard navigation between panels?
- Should we persist dashboard state (e.g., which notifications were dismissed)?
