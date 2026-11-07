# TalentLoop — A Switch-Powered Multi-Agent Job Search Platform

Built for the **Flip the Switch Hackathon**.

**TalentLoop** is an AI-powered job search, application automation, startup founder intelligence, and Gmail outreach platform where candidates interact with a coordinated team of six specialized AI agents in **Slack**, powered by **Switch** as the core agent communication and room coordination infrastructure.

---

## 1. The Six-Agent Team (Registered in Switch Room `talentloop-job-search`)

| Agent ID | Name & Role | Switch Role | Responsibilities |
| :--- | :--- | :--- | :--- |
| **`milo`** | **Milo — Talent Manager** | `@talent-manager` | Primary user-facing coordinator in Slack. Handles Job Seeker vs. Hiring selection, candidate onboarding, resume parsing, natural-language workflow planning, task delegation over Switch, human approval gates, and consolidated reporting. |
| **`wally`** | **Wally — Wellfound Specialist** | `@wellfound-specialist` | Executes human-approved Wellfound application batches through the candidate's local browser companion (`Athaxv/crawlJob` `src/wellfound/` + `src/application-agent/` + `src/job-screening.ts`). Never marks an application `APPLIED` without verification. |
| **`inky`** | **Inky — Internshala Specialist** | `@internshala-specialist` | Executes human-approved Internshala internship and job batches through the local browser companion (`Athaxv/crawlJob` `src/internshala/`). Handles resume continuation and required field checks, verifying `IS.success`. |
| **`scout`** | **Scout — Opportunity Discovery** | `@opportunity-scout` | Searches real public job APIs (Remotive, Arbeitnow) and verified Wellfound/Internshala startup postings, normalizes records, removes duplicates, and ranks matches using candidate skills and `crawlJob`'s `screenJob()` rules. |
| **`clover`** | **Clover — Founder Intelligence** | `@founder-researcher` | Researches recently funded and actively hiring startups (YC directory, funding announcements, startup websites), identifies founders, verifies publicly listed business emails with source URLs and confidence scores, and refuses private/guessed emails. |
| **`pip`** | **Pip — Gmail Outreach** | `@outreach-specialist` | Connects to Gmail via OAuth2, drafts personalized cold emails grounded strictly in factual candidate experience and projects, creates Gmail drafts, requires explicit human approval in Slack before sending, records Gmail message IDs, and prevents duplicate outreach or sending to opted-out contacts. |

---

## 2. Architecture & Switch Integration

- **Real Switch Agent Protocol (`lib/switch/protocol-client.ts` & `lib/switch/coordinator.ts`)**:
  - Registers all 6 agents via `POST /agents` with `Authorization: Bearer <AGENT_REGISTRATION_TOKEN>`.
  - Configures addressing via `POST /agents/{agent_id}/ops/update_agent_detail` (`anyone` for `milo`, `owner_and_owner_agents` for specialists).
  - Creates the `talentloop-job-search` room (`create_room`), invites all 6 agents (`invite_agent_to_room`), defines and assumes room roles (`define_role`, `assume_role`), and attaches room protocol documents (`create_room_document`).
  - Opens persistent WebSocket connections (`GET /agents/{agent_id}/connection/ws`) for all 6 agents, reading `connection_state`, answering 2-second `ping` frames immediately with `{"type": "pong", "cursor": <seq>}`, and routing `message` domain events (`payload.addressed === true`).
  - Includes an embedded Switch Protocol Server (`lib/switch/local-switch-server.ts`) that automatically starts if an external Docker Switch Core server is not running at `SWITCH_SERVER_URL`, ensuring agents **always** communicate through Switch's HTTP + WebSocket protocol.
- **Official Switch Template & Slack Manifest**:
  - `switch/talentloop.template.yaml`: Switch Template Language v1 defining all 6 agents, room roles, room documents, and kickoff for `talentloop-job-search`.
  - `switch/slack-manifest.json`: Slack App Manifest with Socket Mode, slash commands, and `chat:write.customize` scopes.
- **Local Browser Execution Companion (`lib/companion/service.ts` & `scripts/companion-runner.ts`)**:
  - Pairs with the user's machine using SHA-256 hashed device tokens (`tl_dev_...`).
  - Syncs the candidate's verified database profile directly to `.crawljob/profile.json` (`CRAWLJOB_PROFILE_PATH`) using the exact `jobPreferences` schema from `https://github.com/Athaxv/crawlJob`.
  - Supports `pause`, `resume`, and `cancel` controls without ever exposing browser cookies or session files to Slack.

---

## 3. Quick Start & Setup

### Prerequisites
- **Node.js** ≥ 22.5 (tested on Node v24.22.1 with native `node:sqlite`)
- **Bun** ≥ 1.0 (for `crawlJob` local Playwright execution)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Key environment variables in `.env`:
- `TALENTLOOP_DB_PATH`: Path to the persistent SQLite database (default: `./.talentloop/talentloop.sqlite`).
- `SWITCH_SERVER_URL`: URL of your Switch Core server (or `http://127.0.0.1:8400` for the built-in Switch Protocol Server).
- `AGENT_REGISTRATION_TOKEN`: Switch bootstrap/registration key for `POST /agents`.
- `SWITCH_ROOM_NAME`: Default `talentloop-job-search`.
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`: Optional live Slack credentials (from `switch/slack-manifest.json`).
- `CRAWLJOB_REPO_PATH`: Local path to `Athaxv/crawlJob` (default: `D:\Learning\LLD\smallJobs\crawlJob`).
- `CRAWLJOB_PROFILE_PATH`: Path to sync `.crawljob/profile.json`.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GMAIL_ACCESS_TOKEN`: Optional live Gmail OAuth2 credentials for `@pip`.

---

## 4. Running the Reproducible 14-Step End-to-End Demo

Run the complete 14-step workflow from the terminal with a single command:

```bash
npm run demo
```

This executes all 14 steps over Switch WebSockets and SQLite:
1. User joins Slack (`#talentloop-job-search`).
2. **Milo** welcomes the user and asks Job Seeker vs. Hiring.
3. User selects **Job Seeker** (`1`).
4. User uploads their resume and sets preferences; Milo parses facts into SQLite and syncs `.crawljob/profile.json`.
5. User asks Milo to find relevant internships/jobs and research startup founders.
6. **Scout** discovers real opportunities, removes duplicates, and screens them with `crawlJob` filters.
7. **Milo** creates human approval gates for **Wally** (Wellfound) and **Inky** (Internshala).
8. User approves the application batches (`approve <approvalId>`).
9. **Local Companion Service** executes the Wellfound and Internshala automation adapters.
10. **Wally** and **Inky** verify submissions and report outcomes back to **Milo** over Switch.
11. **Clover** researches funded startups and verifies public professional founder emails with source citations.
12. **Pip** drafts personalized cold emails in Gmail and creates a human approval gate.
13. User approves email sending; **Pip** sends via Gmail and records Gmail Message IDs.
14. **Milo** generates the consolidated progress report calculated 100% from persisted database records.

---

## 5. Running the Web Dashboard & Interactive Slack Console

Start the Next.js development server:

```bash
npm run dev
```

Open **`http://localhost:3000`** to access:
- All **8 Dashboard Pages**:
  1. `Overview`
  2. `Discover Jobs`
  3. `My Applications`
  4. `Startup & Founder Research`
  5. `Email Outreach`
  6. `My Profile` (with live `.crawljob/profile.json` sync preview)
  7. `Agent Team (Switch)` (showing all 6 agents, Switch connection IDs, sequence cursors, and live Switch room log)
  8. `Settings & Companion` (with Local Companion registration and Pause/Resume controls)
- **Interactive `#talentloop-job-search` Slack Console** on the right panel to chat with `@milo`, upload resumes, approve/reject actions, or trigger the 14-step demo live.

---

## 6. Running the Test Suite

Run all phase verification tests (`Phase 1` through `Phase 8`):

```bash
npm run test:all
```

Or run individual phase tests:
```bash
npx tsx scripts/test-phase1.ts
npx tsx scripts/test-phase2.ts
npx tsx scripts/test-phase3.ts
npx tsx scripts/test-phase4.ts
npx tsx scripts/test-phase5-6.ts
npx tsx scripts/demo-e2e.ts
```
