# TenderPro — Setup Guide (Windows / macOS / Linux)

## The one thing you must do first: start MongoDB

The error `buffering timed out after 10000ms` means **MongoDB is not running**.
You need MongoDB running before `npm run seed` will work.

---

## Option A — Docker (Easiest — no installs needed)

```powershell
# Windows PowerShell or CMD
docker run -d -p 27017:27017 --name mongo  mongo:7.0
docker run -d -p 6379:6379   --name redis  redis:7.2-alpine
```

Then proceed to Step 2 below.

---

## Option B — Install MongoDB locally on Windows

1. Download **MongoDB Community Server** from:
   https://www.mongodb.com/try/download/community
   (Choose Windows, MSI package)

2. Run the installer — **check "Install MongoDB as a Service"**

3. Start it (in an **Administrator** PowerShell):
   ```powershell
   net start MongoDB
   ```

4. Verify it works:
   ```powershell
   mongosh --eval "db.adminCommand({ping:1})"
   # Should print: { ok: 1 }
   ```

5. Install Redis for Windows:
   Download from: https://github.com/microsoftarchive/redis/releases
   Run the .msi installer → it starts as a Windows service automatically.

---

## Option C — MongoDB Atlas (Free Cloud — no local install)

1. Sign up at https://cloud.mongodb.com (free M0 tier)
2. Create a cluster → Connect → Drivers → copy the connection string
3. In `backend/.env` set:
   ```
   MONGODB_URI=mongodb+srv://youruser:yourpass@cluster.mongodb.net/tenderpro
   ```
   (No local MongoDB needed — skip the `net start` step)

---

## Full Setup Steps

### Step 1 — Copy the environment file
```powershell
cd tenderpro\backend
copy .env.example .env
```
Open `backend\.env` in Notepad and fill in at minimum:
- `MONGODB_URI` (if using Atlas) — or leave as default for local
- `ANTHROPIC_API_KEY` — get from https://console.anthropic.com
- `OPENAI_API_KEY` — get from https://platform.openai.com
- `PINECONE_API_KEY` — get from https://pinecone.io (free tier)
- `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_WHATSAPP_NUMBER`
  → WhatsApp sandbox at https://console.twilio.com (free for testing)

> **Everything else is optional for the first run.**
> The agent works with just MongoDB + Anthropic + OpenAI.
> WhatsApp alerts require Twilio. Search discovery requires Tavily/Exa.

---

### Step 2 — Install dependencies
```powershell
# From the project root (tenderpro folder)
cd ..               # make sure you're in the tenderpro/ folder
npm install         # root devDeps
cd backend
npm install
cd ..\frontend
npm install
cd ..
```

### Step 3 — Install Playwright browsers (for agentic browsing)
```powershell
cd backend
npx playwright install chromium --with-deps
cd ..
```

### Step 4 — Seed the database
```powershell
# Make sure MongoDB is running first!
# From the project root:
node scripts/seed.js

# Or from backend folder:
cd backend
npm run seed
```

Expected output:
```
✅ Loaded env from: ...backend\.env
🔍 Pre-flight checks…
  ✅ MongoDB reachable
  ✅ Redis reachable
🌱 Connecting to MongoDB…
✅ Connected to MongoDB
🏢 Creating demo company…
...
🎉 Seed complete!
   Login: demo@tenderpro.ai / TenderPro2024!
```

### Step 5 — Start the app
```powershell
# Terminal 1 — backend
cd backend
node server.js

# Terminal 2 — frontend
cd frontend
npm start
```

Open http://localhost:3000 → login with `demo@tenderpro.ai` / `TenderPro2024!`

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `buffering timed out after 10000ms` | MongoDB not running | Run `net start MongoDB` or start Docker |
| `Cannot find module '../backend/models'` | Wrong working directory | Run from project root: `node scripts/seed.js` |
| `ECONNREFUSED 127.0.0.1:6379` | Redis not running | Redis warning is safe to ignore — seeding continues without it |
| `Invalid API key` | Missing `.env` values | Fill in `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in `backend\.env` |
| `Port 5000 already in use` | Another process on port 5000 | Change `PORT=5001` in `.env` |
| Frontend blank page | Backend not running | Start backend first, then frontend |

---

## Minimum required API keys to run

| Key | Get it from | Cost |
|---|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com | Pay-per-use |
| `OPENAI_API_KEY` | https://platform.openai.com | Pay-per-use |
| `PINECONE_API_KEY` | https://pinecone.io | Free tier (5GB) |

Everything else (Twilio, Tavily, Stripe, M-Pesa) is optional for initial testing.
