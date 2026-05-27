<div align="center">

# 🏠 Homestead AI

### Autonomous Multi-Agent Engineering Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-E8A0BF.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.5%2B-339933?logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-E8A0BF.svg)](CONTRIBUTING.md)
[![Stars](https://img.shields.io/github/stars/your-username/homestead-ai?style=social)](https://github.com/your-username/homestead-ai)

**Homestead AI** orchestrates a team of specialized AI agents to plan, build, test, and ship software — autonomously. Think of it as an AI-powered engineering team that writes code, runs tests, files bugs, writes docs, and deploys — all from a single goal.

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [Agents](#-agent-roster) · [API](#-api-reference) · [Contributing](#-contributing)

</div>

---

## ✨ Why Homestead AI?

Most AI coding tools are single-agent chat interfaces. Homestead AI is different:

| Feature | Single-Agent Tools | **Homestead AI** |
|---------|:------------------:|:----------------:|
| Multiple specialized agents | ❌ | ✅ 12 agents with distinct roles |
| Autonomous task orchestration | ❌ | ✅ DAG-based mission planning |
| Evidence-gated completion | ❌ | ✅ Code must run, tests must pass |
| Knowledge vault (Obsidian) | ❌ | ✅ Persistent memory across sessions |
| Multi-LLM provider support | Limited | ✅ OpenAI, Anthropic, Gemini, any OpenAI-compatible |
| Real-time Kanban board | ❌ | ✅ Watch agents work in real-time |
| Tool execution (shell, git, browser) | Limited | ✅ Full sandboxed execution |
| Atlassian integration | ❌ | ✅ Jira + Confluence sync |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js 22.5+** (required for `--experimental-sqlite`)
- At least one LLM API key (OpenAI, Anthropic, Gemini, or any OpenAI-compatible endpoint)

### Setup

```bash
# Clone the repo
git clone https://github.com/your-username/homestead-ai.git
cd homestead-ai

# Install dependencies
npm install

# Configure your LLM provider
cp apps/backend/.env.example apps/backend/.env
# Edit .env with your API keys (see Configuration section)

# Start the server
npm start

# Open in browser
# → http://localhost:8765
```

### Minimal `.env` (pick one provider)

```env
# OpenAI
OPENAI_API_KEY=sk-...

# OR Anthropic (Claude)
ANTHROPIC_API_KEY=sk-ant-...

# OR Google Gemini
GEMINI_KEY_1=AIza...

# OR any OpenAI-compatible endpoint (Azure, Ollama, vLLM, LiteLLM)
LLM_BASE_URL=https://your-endpoint.example.com
LLM_API_KEY=your-key-here
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Browser (React)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │Dashboard │ │Task Board│ │Agent Hub │ │Pipeline│ │
│  │          │ │ (Kanban) │ │  (Chat)  │ │ Engine │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘ │
└──────────────────────┬──────────────────────────────┘
                       │ REST + WebSocket
┌──────────────────────▼──────────────────────────────┐
│                Express Server (:8765)                │
│  ┌──────────────┐  ┌───────────────────────────┐    │
│  │  LLM Pool    │  │    Orchestrator            │    │
│  │  (multi-key  │  │  ┌─────────┐ ┌──────────┐ │    │
│  │   rotation)  │  │  │Director │ │Task      │ │    │
│  │              │  │  │Pipeline │ │Runner    │ │    │
│  └──────────────┘  │  └─────────┘ └──────────┘ │    │
│  ┌──────────────┐  │  ┌─────────┐ ┌──────────┐ │    │
│  │  Tool        │  │  │Workflow │ │Escalation│ │    │
│  │  Registry    │  │  │Engine   │ │Ladder    │ │    │
│  └──────────────┘  │  └─────────┘ └──────────┘ │    │
│  ┌──────────────┐  └───────────────────────────┘    │
│  │  Brain/Vault │  ┌───────────────────────────┐    │
│  │  (Obsidian   │  │    Services                │    │
│  │   markdown)  │  │  SLO · Incidents · Risk    │    │
│  │  + Vectors   │  │  Decisions · Safety        │    │
│  └──────────────┘  └───────────────────────────┘    │
│  ┌──────────────────────────────────────────────┐   │
│  │         SQLite + JSON Fallback               │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Key Subsystems

| Subsystem | Description |
|-----------|-------------|
| **LLM Pool** | Multi-key rotation across providers with purpose-based routing (plan, code, verify, classify) |
| **Orchestrator** | DAG-based mission planner — breaks goals into dependency-aware tasks |
| **Task Runner** | Executes queued tasks, assigns agents, enforces timeouts and retries |
| **Brain/Vault** | Obsidian-compatible markdown knowledge base with vector search |
| **Tool Registry** | Sandboxed execution: shell, Python, Git, browser (Playwright), filesystem |
| **Evidence Gate** | Agents must prove their work — no "it should work" without shell output |
| **Services** | SLO tracking, incident management, risk gates, decision ledger |

---

## 🤖 Agent Roster

Homestead AI ships with **12 specialized agents**, each with defined roles, tool access, and expertise:

| Agent | Role | Tier | Key Capabilities |
|-------|------|------|------------------|
| 🎼 **Director** | Chief Orchestrator | Strong | Breaks goals into tasks, manages dependencies |
| 🛠️ **Engineer** | Software Engineer | Strong | Writes, runs, and proves code |
| 📋 **Analyst** | Requirements Analyst | Standard | Translates goals into specs |
| 🏛️ **Architect** | System Architect | Strong | Designs interfaces, writes ADRs |
| 🔧 **QA Engineer** | Test Engineer | Standard | Runs tests, demands evidence |
| 🔎 **Debugger** | Bug Hunter | Strong | Reproduces bugs, finds root causes |
| 📚 **Technical Writer** | Documentation | Standard | Writes docs, syncs to Confluence |
| 🎨 **Designer** | UI/UX Engineer | Standard | Frontend components, styling |
| ⚙️ **DevOps** | Infrastructure | Standard | Docker, CI/CD, deployment |
| 🔐 **Security** | Security Auditor | Strong | Vulnerability scanning, chaos engineering |
| 🧠 **Data Engineer** | ML/Data | Standard | Data pipelines, model integration |
| 🖥️ **Visual QA** | Visual Testing | Strong | Browser automation, accessibility |

### Agent Tiers

- **Strong**: Uses the most capable model (e.g., Claude Opus, GPT-4) for complex reasoning
- **Standard**: Uses a faster model (e.g., Claude Sonnet, GPT-4o) for structured work

---

## 🎨 UI Design

The interface is inspired by the movie **Her** — warm, intimate, and focused:

- **Light mode**: Cream and blush tones (`#FFF5F0`, `#FFF0EA`)
- **Dark mode**: Deep warm grays with pink accents (`#1a1216`, `#140e12`)
- **Accent**: Soft coral-pink (`#E8A0BF`)
- **Typography**: Inter (UI), Fraunces (headings), JetBrains Mono (code)
- **Animations**: Soft liquid gradient background with organic motion

### Screens

| Screen | Purpose |
|--------|---------|
| **Dashboard** | Project overview, agent status, activity feed, LLM health |
| **Task Board** | Kanban with drag-drop, real-time agent progress |
| **Agent Hub** | Chat with individual agents, view tool calls |
| **Pipeline Engine** | DAG flow visualization, mission planning |
| **Workspace** | File tree, code viewer, terminal, debug panel |
| **Tool Registry** | Browse all available tools and MCP integrations |
| **Requirements** | Requirement tracking with coverage visualization |
| **Records** | Vault notes, run history, decision log |

---

## 🔧 Configuration

### LLM Provider Setup

Homestead AI supports **any OpenAI-compatible API**. Configure one or more providers in `.env`:

```env
# ── Direct Provider Keys ──
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_KEY_1=AIza...

# ── Custom OpenAI-Compatible Endpoint ──
LLM_BASE_URL=https://your-endpoint.example.com
LLM_API_KEY=your-key-here
LLM_MODEL_STRONG=your-strong-model
LLM_MODEL_FAST=your-fast-model

# ── LiteLLM Proxy (recommended for multi-provider) ──
LITELLM_URL=http://localhost:4000
LITELLM_KEY=sk-homestead-local
```

### Integrations

| Integration | Required | Setup |
|-------------|:--------:|-------|
| LLM Provider | ✅ | At least one API key in `.env` |
| Jira | Optional | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` |
| Confluence | Optional | `CONFLUENCE_BASE_URL`, `CONFLUENCE_TOKEN` |
| GitHub | Optional | `GITHUB_TOKEN` for webhooks |
| Slack | Optional | `SLACK_BOT_TOKEN` via MCP |
| PostgreSQL | Optional | `POSTGRES_URL` via MCP |

---

## 📡 API Reference

### Core Endpoints

<details>
<summary><strong>Health & State</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server status + LLM pool snapshot |
| `GET` | `/api/state` | Full frontend bootstrap data |
| `POST` | `/api/seed` | Load demo project data |

</details>

<details>
<summary><strong>Projects</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/projects` | Create new project from template |
| `PATCH` | `/api/projects/:id` | Update project metadata |
| `DELETE` | `/api/projects/:id` | Delete project (cascading) |
| `PATCH` | `/api/projects/:id/pause` | Pause/unpause project |

</details>

<details>
<summary><strong>Tasks (Kanban)</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tasks/:id` | Get task details |
| `POST` | `/api/tasks` | Create task |
| `PATCH` | `/api/tasks/:id` | Update task (status, assignment) |
| `POST` | `/api/tasks/:id/retry` | Retry failed task |
| `POST` | `/api/tasks/:id/cancel` | Cancel running task |
| `POST` | `/api/tasks/:id/audit` | Run LLM audit on completion |

</details>

<details>
<summary><strong>Agents & Chat</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List all agents |
| `POST` | `/api/agents` | Create custom agent |
| `GET` | `/api/agents/:id/messages` | Get chat history |
| `POST` | `/api/agents/:id/messages` | Send message to agent |

</details>

<details>
<summary><strong>Missions</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/projects/:id/missions` | Start a mission (multi-agent goal) |
| `GET` | `/api/projects/:id/missions` | List missions |
| `POST` | `/api/missions/:id/abort` | Abort a running mission |

</details>

<details>
<summary><strong>Vault & Knowledge</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/vault/files` | List vault files |
| `GET` | `/api/vault/note` | Read specific note |
| `GET` | `/api/vault/graph` | Build knowledge graph |
| `GET` | `/api/vault/records` | List vault records with metadata |

</details>

<details>
<summary><strong>SLO & Incidents</strong></summary>

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects/:id/slo` | SLO evaluation |
| `GET` | `/api/projects/:id/slo/burn-rate` | Error budget burn rate |
| `POST` | `/api/incidents` | Create incident |
| `POST` | `/api/incidents/:id/postmortem` | Generate postmortem |

</details>

### WebSocket

Connect to `/ws` for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:8765/ws');
ws.onmessage = (event) => {
  const delta = JSON.parse(event.data);
  // delta types: task_update, agent_message, mission_progress, etc.
};
```

---

## 📁 Project Structure

```
homestead-ai/
├── apps/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── server.js          # Express server (entry point)
│   │   │   ├── db.js              # Database adapter (SQLite/JSON)
│   │   │   ├── llm/               # LLM pool, embeddings, structured output
│   │   │   ├── orchestrator/      # Agents, task runner, pipelines, missions
│   │   │   ├── brain/             # Vault, vector search, memory tiers
│   │   │   ├── services/          # SLO, incidents, risk gates, decisions
│   │   │   ├── tools/             # Shell, git, browser, MCP, Atlassian
│   │   │   ├── skills/            # Playbook routing and versioning
│   │   │   └── seed/              # Demo data and templates
│   │   ├── .env.example           # Environment template
│   │   └── package.json
│   └── frontend/
│       ├── index.html             # Entry point (React UMD)
│       ├── h-core.jsx             # Theme system + utility components
│       ├── h-api.jsx              # REST/WebSocket API client
│       ├── h-app.jsx              # Main app shell + routing
│       ├── h-shell.jsx            # Sidebar + navigation
│       ├── h-dashboard.jsx        # Dashboard + stats
│       ├── h-tasks.jsx            # Kanban task board
│       ├── h-agent-hub.jsx        # Agent chat interface
│       ├── h-workspace.jsx        # IDE, terminal, pipelines
│       └── h-requirements.jsx     # Requirements tracking
├── misc/
│   └── experimental/              # Promising but unfinished features
├── docker-compose.yml             # LiteLLM proxy + server
├── LICENSE                        # MIT License
└── README.md                      # This file
```

---

## 🔬 Experimental Features

The `misc/experimental/` directory contains promising features that are not yet fully integrated:

| File | Description | Status |
|------|-------------|--------|
| `feature-pipeline.ts` | TypeScript version of the orchestration pipeline | Partial — needs migration from JS |
| `computer-use.js` | Anthropic computer-use tool (Docker-based) | Working — requires Docker setup |
| `browser_task.py` | Python browser automation script | Working — alternative to Playwright JS |
| `afeela-shm.js` | Demo seed data for automotive SHM project | Complete — example project template |

To use any experimental feature, copy it into the appropriate `src/` directory and update imports.

---

## 🧪 Development

```bash
# Development mode (auto-reload)
npm run dev

# Run smoke tests
node apps/backend/smoke-test.mjs

# Seed demo data
npm run seed

# Scan vault for indexing
npm run vault:scan
```

---

## 🛡️ Security

- **No hardcoded secrets** — all API keys via `.env` (never committed)
- **Webhook signature verification** — HMAC validation for Jira/GitHub webhooks
- **Tool sandboxing** — agents have scoped tool access (e.g., Analyst can't run shell)
- **Evidence gate** — agents can't mark tasks complete without proof
- **Secret scanning** — `git_scan_secrets` runs before every commit

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📜 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

### Third-Party Licenses

| Dependency | License | Usage |
|------------|---------|-------|
| [Express](https://expressjs.com/) | MIT | HTTP server |
| [LangChain](https://js.langchain.com/) | MIT | LLM integration framework |
| [React](https://react.dev/) | MIT | Frontend UI (UMD) |
| [Playwright](https://playwright.dev/) | Apache-2.0 | Browser automation |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | SQLite bindings |
| [Zod](https://zod.dev/) | MIT | Schema validation |
| [ws](https://github.com/websockets/ws) | MIT | WebSocket server |
| [dotenv](https://github.com/motdotla/dotenv) | BSD-2-Clause | Environment configuration |
| [Turndown](https://github.com/mixmark-io/turndown) | MIT | HTML to Markdown conversion |
| [tsx](https://github.com/privatenumber/tsx) | MIT | TypeScript execution |

All dependencies are MIT or Apache-2.0 compatible. No copyleft (GPL) dependencies.

---

## 🔑 Keywords

`ai-agents` `multi-agent` `autonomous-coding` `llm-orchestration` `task-automation` `software-engineering` `ai-engineering-team` `kanban` `knowledge-management` `obsidian-vault` `openai` `anthropic` `gemini` `langchain` `developer-tools` `devops-automation` `code-generation` `test-automation` `project-management` `real-time-collaboration`

---

<div align="center">

**Built with ❤️ for the future of autonomous software engineering**

*Star ⭐ this repo if you find it useful!*

</div>
