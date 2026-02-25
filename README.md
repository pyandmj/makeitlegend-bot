# 🐾 Make It Legend — Discord Command Center

> The AI-powered operations hub for Make It Legend — an AI pet portrait business.
> One human founder, managed entirely through Discord.

**Stack:** TypeScript · discord.js v14 · Express · SQLite (better-sqlite3) · node-cron

---

## Deploy to Railway (5 minutes)

### Step 1 — Create the GitHub repo

Go to [github.com/new](https://github.com/new) and create a **public** repository:
- **Name:** `makeitlegend-bot`
- **Owner:** `pyandmj`
- Leave everything else default → click **Create repository**

### Step 2 — Push the code

Open a terminal in the unzipped project folder and run:

```bash
cd makeitlegend-bot
git init
git branch -M main
git add .
git commit -m "Initial commit - Make It Legend Discord Bot"
git remote add origin https://github.com/pyandmj/makeitlegend-bot.git
git push -u origin main
```

### Step 3 — Deploy on Railway

1. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo**
2. Select `pyandmj/makeitlegend-bot`
3. Railway auto-detects `railway.json` — click **Deploy**
4. Go to the **Variables** tab and add all environment variables (table below)
5. Railway will rebuild and deploy with your vars — done

### Step 4 — Set Environment Variables in Railway

| Variable | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | Your Discord bot token (from Discord Developer Portal → Bot → Token) |
| `DISCORD_CLIENT_ID` | `1476085430876373023` |
| `DISCORD_GUILD_ID` | `1476091316080349224` |
| `FOUNDER_USER_ID` | Your Discord user ID (right-click your name → Copy User ID) |
| `MANUS_API_KEY` | Your Manus API key (from open.manus.im) |
| `WEBHOOK_PORT` | `3000` |
| `NODE_ENV` | `production` |
| `TIMEZONE` | `America/New_York` |
| `BRIEFING_CRON` | `0 8 * * *` |
| `LOG_LEVEL` | `info` |
| `STRIPE_WEBHOOK_SECRET` | From Stripe Dashboard → Webhooks (add when ready) |
| `MANUS_WEBHOOK_SECRET` | Any random secret string you choose |
| `WEBSITE_WEBHOOK_SECRET` | Any random secret string you choose |

### Step 5 — Get Your Webhook URL

After deploy, Railway gives you a public URL like:
```
https://makeitlegend-bot-production.up.railway.app
```

Configure these in each external service:
- **Stripe:** `https://your-url.railway.app/webhooks/stripe`
- **Manus:** `https://your-url.railway.app/webhooks/manus`
- **Website:** `https://your-url.railway.app/webhooks/website`

---

## Alternative: Railway CLI Deploy

```bash
cd makeitlegend-bot
railway login
railway init
railway vars set DISCORD_BOT_TOKEN=your_token
railway vars set DISCORD_CLIENT_ID=1476085430876373023
railway vars set DISCORD_GUILD_ID=1476091316080349224
railway vars set MANUS_API_KEY=your_manus_key
railway vars set WEBHOOK_PORT=3000
railway vars set NODE_ENV=production
railway vars set TIMEZONE=America/New_York
railway vars set BRIEFING_CRON="0 8 * * *"
railway vars set LOG_LEVEL=info
railway up
```

---

## Run Locally

```bash
npm install
cp .env.example .env
# Edit .env with your values
npm run build
npm start
```

---

## Discord Server Structure

The bot auto-creates this channel structure when it first joins a server:

```
📋 EXECUTIVE
├── #ceo-briefing       — Daily summary, posted every morning at 8 AM ET
├── #approvals          — Agent requests requiring human decision
└── #announcements      — Company-wide updates

🚨 ALERTS
├── #alerts-critical    — System failures, urgent issues
└── #alerts-warning     — Non-critical issues needing attention

🔧 ENGINEERING
├── #eng-general
├── #eng-deployments
└── #eng-bugs

🎨 CREATIVE
├── #creative-general
├── #creative-portraits — Portrait generation logs and results
└── #creative-content

📈 MARKETING
├── #mkt-general
├── #mkt-campaigns
└── #mkt-analytics

🛒 OPERATIONS
├── #ops-orders         — New orders, payments, Stripe events
├── #ops-support
└── #ops-quality

📊 ANALYTICS
├── #analytics-dashboard
├── #analytics-credits  — Credit usage, efficiency reports, waste alerts
├── #analytics-anomalies
└── #analytics-self-healing
```

---

## Slash Commands

| Command | Description |
|---|---|
| `/briefing` | Trigger the daily CEO briefing on demand |
| `/status` | System health overview for all departments |
| `/task [dept] [description]` | Create a task — dispatches to Manus API |
| `/approve [id]` | Approve a pending request by ID |
| `/deny [id] [reason]` | Deny a pending request with a reason |
| `/pause [department]` | Pause all agent activity in a department |
| `/resume [department]` | Resume a paused department |
| `/report [department]` | Get the latest report from a department |
| `/credits daily` | Today's credit usage breakdown |
| `/credits weekly` | This week's efficiency report |
| `/credits agent [name]` | Specific agent's usage history |

---

## Webhook Endpoints

### Stripe Events
```
POST /webhooks/stripe
```
Handles: `payment_intent.succeeded`, `checkout.session.completed`, `charge.refunded`, `payment_intent.payment_failed`, `charge.dispute.created`

Routes to: `#ops-orders`, `#ops-support`, `#alerts-warning`

### Manus API Events
```
POST /webhooks/manus
x-webhook-secret: <your_manus_webhook_secret>
```
```json
{
  "event": "task.completed",
  "taskId": "task_abc123",
  "department": "creative",
  "status": "completed",
  "result": "Portrait generated successfully"
}
```

### Website Events
```
POST /webhooks/website
x-webhook-secret: <your_website_webhook_secret>
```

| Event | Routes to |
|---|---|
| `portrait.generation.started` | `#creative-portraits` |
| `portrait.generation.completed` | `#creative-portraits` |
| `portrait.generation.failed` | `#creative-portraits` + `#alerts-warning` |
| `user.signup` | `#ops-orders` |
| `order.created` | `#ops-orders` |
| `error.*` | `#eng-bugs` + `#alerts-warning` |

### Generic Alert
```
POST /api/alert
Content-Type: application/json

{
  "severity": "warning",
  "title": "Something needs attention",
  "description": "Details here",
  "department": "engineering"
}
```

### Approval Request
```
POST /api/approval
Content-Type: application/json

{
  "title": "Deploy to production?",
  "description": "Agent wants to deploy v2.1",
  "department": "engineering",
  "requestedBy": "deploy-agent",
  "callbackUrl": "https://your-service.com/callback"
}
```

### Credit Summary
```
GET /api/credits/summary
```

---

## Approval System

When an agent posts an approval request, the bot:
1. Posts to `#approvals` with a rich embed showing what the agent wants and why
2. Adds ✅ and ❌ reaction buttons
3. Watches for the founder's reaction
4. Routes the decision back (calls `callbackUrl` if provided)

---

## Credit & Efficiency Monitoring

Every Manus API call is tracked in SQLite with waste detection rules:

| Rule | Trigger | Action |
|---|---|---|
| **Retry Abuse** | Same operation retried >2 times | Flag + alert to `#analytics-credits` |
| **Credit Overrun** | Task uses >3x estimated credits | Flag for review |
| **Spend Spike** | Department daily spend >150% of 7-day avg | Warning alert |
| **Hard Error Retry** | Agent retries after a permanent error | Critical alert, blocked immediately |

**Fail-Fast:** The Manus client checks error history before every call. If the same operation previously hit a hard error (403, 401, permission denied, etc.), the call is blocked before it's made — saving credits and preventing waste loops.

---

## Project Structure

```
makeitlegend-bot/
├── src/
│   ├── commands/           # Slash commands (approve, briefing, credits, deny,
│   │                       #   pause, report, resume, status, task)
│   ├── config/             # Config and channel definitions
│   ├── events/             # Discord event handlers
│   ├── services/           # Core services
│   │   ├── approval-service.ts
│   │   ├── briefing-scheduler.ts
│   │   ├── channel-router.ts
│   │   ├── credit-database.ts   # SQLite credit tracking
│   │   ├── credit-reporter.ts   # Daily/weekly reports
│   │   ├── manus-client.ts      # Manus API + fail-fast enforcement
│   │   ├── server-setup.ts      # Auto-creates channels/roles
│   │   ├── service-registry.ts
│   │   └── waste-detector.ts    # Waste detection rules
│   ├── types/              # TypeScript types
│   ├── utils/              # Logger, embeds, store
│   ├── webhooks/           # Express webhook server
│   ├── deploy-commands.ts
│   └── index.ts            # Main entry point
├── .env.example
├── .gitignore
├── Dockerfile
├── Procfile
├── package.json
├── railway.json            # Railway deployment config
├── railway.toml
├── render.yaml             # Render.com deployment config
└── tsconfig.json
```

---

## How to Get Your Discord Guild ID

1. Open Discord → **User Settings** → **Advanced** → enable **Developer Mode**
2. Right-click your server name in the left sidebar
3. Click **Copy Server ID** — that's your `DISCORD_GUILD_ID`

The Make It Legend HQ server ID is already set: `1476091316080349224`

---

## License

Private — Make It Legend © 2026
