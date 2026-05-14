# TenderPro AI Agent

Autonomous global tender procurement SaaS — powered by Claude, GPT-4o Vision, and NVIDIA NIM fallback.

---

## What It Does

The agent browses government portals, NGOs, UN agencies, and private procurement sites worldwide — every 6 hours, for free, using its verified portal registry. It scores every tender against your company profile, calculates win probability, and delivers alerts directly to your WhatsApp.

---

## Quick Start (Local)

### Prerequisites
- Node.js 20+
- MongoDB (local or Atlas)
- Redis (local or cloud)

### 1. Clone and configure
```bash
git clone https://github.com/yourname/tenderpro-ai-agent.git
cd tenderpro-ai-agent/tenderpro
cp backend/.env.example backend/.env
# Open backend/.env and fill in your API keys
```

### 2. Install dependencies
```bash
# From the tenderpro/ folder
cd backend && npm install
cd ../frontend && npm install
```

### 3. Install Playwright browsers
```bash
cd backend
npx playwright install chromium --with-deps
```

### 4. Seed the database
```bash
cd backend
npm run seed
```

### 5. Start
```bash
# Terminal 1 — backend
cd backend && node server.js

# Terminal 2 — frontend
cd frontend && npm start
```

Open http://localhost:3000
Login: `demo@tenderpro.ai` / `TenderPro2024!`

---

## Deploy on Render (Recommended)

Render gives you a free PostgreSQL and Redis. The steps below use their free tier for Redis and a paid ($7/month) web service for the backend.

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourname/tenderpro.git
git push -u origin main
```

### Step 2 — Create a Redis instance on Render
1. Go to https://dashboard.render.com
2. Click **New** → **Redis**
3. Name: `tenderpro-redis`
4. Plan: **Free**
5. Click **Create Redis**
6. Copy the **Internal Redis URL** — you will use it as `REDIS_URL`

### Step 3 — Create a MongoDB Atlas cluster (free)
1. Go to https://cloud.mongodb.com
2. Create a free M0 cluster
3. Database Access → Add user with password
4. Network Access → Allow from anywhere (`0.0.0.0/0`)
5. Connect → Drivers → copy connection string
6. Replace `<password>` in the string with your password
7. Add `/tenderpro` before `?` — this is your `MONGODB_URI`

### Step 4 — Deploy the Backend on Render
1. Go to https://dashboard.render.com
2. Click **New** → **Web Service**
3. Connect your GitHub repo
4. Configure:
   - **Name:** `tenderpro-backend`
   - **Root Directory:** `tenderpro/backend`
   - **Runtime:** Node
   - **Build Command:** `npm install && npx playwright install chromium --with-deps`
   - **Start Command:** `node server.js`
   - **Plan:** Starter ($7/month) — free tier sleeps after 15 min inactivity
5. Click **Add Environment Variables** and paste ALL variables from `backend/.env.example`
   - Set `MONGODB_URI` to your Atlas connection string
   - Set `REDIS_URL` to the Render Redis internal URL
   - Set `FRONTEND_URL` to your frontend URL (fill in after deploying frontend)
   - Set `NODE_ENV=production`
6. Click **Create Web Service**
7. Wait for the build (3–5 minutes)
8. Copy the service URL: `https://tenderpro-backend.onrender.com`

### Step 5 — Deploy the Frontend on Render
1. Click **New** → **Static Site**
2. Connect the same GitHub repo
3. Configure:
   - **Name:** `tenderpro-frontend`
   - **Root Directory:** `tenderpro/frontend`
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** `build`
4. Add environment variable:
   - `REACT_APP_API_URL` = `https://tenderpro-backend.onrender.com`
5. Click **Create Static Site**
6. Copy the URL: `https://tenderpro-frontend.onrender.com`

### Step 6 — Update Backend with Frontend URL
1. Go to your backend service on Render
2. Environment → Edit `FRONTEND_URL` → set to `https://tenderpro-frontend.onrender.com`
3. Click **Save Changes** (backend redeploys automatically)

### Step 7 — Seed the production database
After backend deploys, open the Render **Shell** tab and run:
```bash
node ../scripts/seed.js
```

### Step 8 — Configure Twilio Webhook
1. Go to https://console.twilio.com
2. WhatsApp Sandbox → Sandbox Settings
3. Set **When a message comes in** to:
   `https://tenderpro-backend.onrender.com/api/whatsapp/webhook`
4. Save

### Step 9 — Access Admin Dashboard
The admin panel is at a secret URL only you know.

Set in your `.env`:
```
ADMIN_PATH_SECRET=your_secret_here
ADMIN_SECRET_KEY=your_admin_key_here
ADMIN_IPS=your.ip.address
```

Access from your machine only:
```
https://tenderpro-backend.onrender.com/api/__your_secret_here/stats
```

With header: `X-Admin-Key: your_admin_key_here`
And JWT: `Authorization: Bearer <superadmin_token>`

---

## Minimum Required API Keys

| Key | Where | Cost |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com | Pay-per-use |
| `OPENAI_API_KEY` | platform.openai.com | Pay-per-use |
| `NVIDIA_API_KEY` | build.nvidia.com | **FREE** (1000 credits/month) |
| `PINECONE_API_KEY` | pinecone.io | **FREE** (5GB) |
| `MONGODB_URI` | cloud.mongodb.com | **FREE** (M0 cluster) |
| `REDIS_URL` | Render Redis | **FREE** |

Everything else (Twilio, Stripe, M-Pesa) is optional for initial testing.

---

## AI Fallback Chain

```
Request comes in
     │
     ▼
Anthropic Claude (primary — fastest, best quality)
     │ fails / 429 / timeout
     ▼
OpenAI GPT-4o (secondary)
     │ fails / 429 / timeout
     ▼
NVIDIA NIM FREE (meta/llama-3.1-405b) ← never pays, always available
     │ fails
     ▼
Graceful degradation — returns structured empty response
User sees "Processing…" not a crash
```

---

## SaaS Plans

| Plan | Price | Daily Searches | Monthly Alerts | AI Drafts |
|---|---|---|---|---|
| Trial | Free (3 days) | 3 | 10 | ✗ |
| Starter | $9.99/mo | 10 | 20 | ✗ |
| Professional | $49.99/mo | 50 | 100 | ✓ |
| Enterprise | $199.99/mo | Unlimited | Unlimited | ✓ |

Payment: **M-Pesa STK Push** (Kenya) + **Stripe** (international cards)

---

## Admin Dashboard Security

The admin panel has 3 independent security layers:

1. **Secret URL** — `/api/__<ADMIN_PATH_SECRET>/` — not guessable, not indexed
2. **X-Admin-Key header** — a second secret your browser sends with every request
3. **IP whitelist** — only requests from your specific IP address are allowed
4. **Superadmin role** — JWT must belong to a user with `role: superadmin`

Any request that fails any layer receives a `404 Not Found` — the existence of the admin panel is never revealed to attackers.

---

## Data Isolation

Every database query is automatically scoped to `req.companyId` via the `companyFilter()` middleware helper. A user can never access another company's:
- Tender matches
- Proposals
- Company profile
- Payment history
- Search history

This is enforced at the middleware level — it cannot be bypassed via API parameters.

---

## Credit Budget (Stay Free)

| Phase | Frequency | Search Credits |
|---|---|---|
| Scouting via verified portals | Every 6 hours | **$0** — direct URL access |
| Weekly discovery (find new portals) | Sunday 02:00 | ~50 Tavily credits |
| On-demand SEARCH command | User-triggered | ~5 credits |

After the first week, the verified portal registry is populated and most scouting rounds cost nothing.

---

## Project Structure

```
tenderpro/
├── agent/
│   ├── core/
│   │   ├── agentLoop.js        Main agentic loop
│   │   ├── llmClient.js        Resilient client (Anthropic→OpenAI→NVIDIA)
│   │   ├── schemas.js          Zod validation for all LLM outputs
│   │   └── winProbability.js   Win-probability engine
│   ├── perception/             GPT-4o vision page understanding
│   ├── planning/               Claude CoT goal decomposition
│   ├── action/                 Playwright semantic browser
│   ├── extraction/             Zero-shot + shadow-mode extraction
│   ├── discovery/              Tavily/Exa + verified portal registry
│   ├── memory/                 4-tier memory system
│   ├── rag/                    Pinecone knowledge base
│   └── orchestrator.js         Cron scheduler
│
├── backend/
│   ├── api/
│   │   ├── routes.js           All user-facing API routes
│   │   └── adminRoutes.js      Secret admin API
│   ├── middleware/
│   │   ├── auth.js             JWT, trial, quota, admin guards
│   │   └── rateLimiter.js      Per-user rate limiting
│   ├── models/index.js         Mongoose schemas
│   ├── services/               Payments, email, queues
│   ├── whatsapp/               Twilio handler + conversation engine
│   └── server.js               Entry point
│
├── frontend/
│   └── src/App.js              Full React SaaS UI
│
├── scripts/seed.js             Database seeder
├── infrastructure/             Dockerfiles + Nginx
├── docker-compose.yml
└── README.md
```

---

## Common Issues

| Error | Fix |
|---|---|
| `buffering timed out` | MongoDB not running. Start it or use Atlas. |
| `No models registered` | Run `cd backend && npm install` first |
| `NVIDIA_API_KEY not set` | Add to `.env` — get free key at build.nvidia.com |
| `401 on every request` | JWT_SECRET mismatch between .env and deployed env |
| `WhatsApp OTP not received` | Verify Twilio number format includes country code |
| `Admin returns 404` | Check X-Admin-Key header and your IP is in ADMIN_IPS |

