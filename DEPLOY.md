# Deployment Guide — Vercel (Frontend) + Railway (Backend)

This app is split into two independently deployed services:

| Service | Host | Purpose |
|---|---|---|
| **Frontend** (React SPA) | Vercel | UI served from CDN |
| **Backend** (Express API) | Railway | API, IMAP/SMTP, file DB |

---

## 1. Push to GitHub

Make sure your code is in a GitHub repository. Railway and Vercel both deploy directly from Git.

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/decile-outreach.git
git push -u origin main
```

> **Note**: `.data/` and `.env` are gitignored — they will never be committed. ✅

---

## 2. Deploy the Backend to Railway

### A. Create a new Railway project
1. Go to [railway.app](https://railway.app) → **New Project**
2. Select **Deploy from GitHub repo** → choose your repository
3. Railway auto-detects Node.js via `railway.toml` and starts building

### B. Configure environment variables in Railway
In Railway → your service → **Variables**, add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | Your Railway public URL (set after first deploy, e.g. `https://decile-outreach-production.up.railway.app`) |
| `MAIL_CREDENTIALS_KEY` | A 64-character hex string (run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `GROQ_API_KEY` | Your Groq API key (optional, for AI features) |
| `GEMINI_API_KEY` | Your Gemini API key (optional, fallback AI) |
| `CORS_ORIGIN` | Your Vercel URL — set this **after** step 3 (e.g. `https://decile-outreach.vercel.app`) |

### C. Add a persistent volume (important!)
The app stores data in `.data/`. Without a persistent volume, data resets on every redeploy.

1. Railway → your service → **Volumes** → **Add Volume**
2. Mount path: `/app/.data`
3. Click **Add**

### D. Get your Railway URL
After deploy completes: Railway → your service → **Settings** → copy the **Public URL**.
You'll need this for the next step.

---

## 3. Deploy the Frontend to Vercel

### A. Create a new Vercel project
1. Go to [vercel.com](https://vercel.com) → **New Project**
2. Import your GitHub repository
3. Framework preset: **Vite** (auto-detected)
4. Build command: `npm run build`
5. Output directory: `dist`

### B. Configure environment variables in Vercel
In Vercel → your project → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `VITE_API_URL` | Your Railway backend URL (e.g. `https://decile-outreach-production.up.railway.app`) |

### C. Deploy
Click **Deploy**. Vercel will build and deploy. Your frontend URL will be something like `https://decile-outreach.vercel.app`.

---

## 4. Connect the Two Services

After both are deployed:

1. **In Railway**: Set `CORS_ORIGIN` = your Vercel URL (e.g. `https://decile-outreach.vercel.app`)
2. **In Railway**: Redeploy (or it will auto-redeploy on the next push)

---

## 5. Verify the Deployment

1. Open your Vercel URL — you should see the login page
2. Set up your workspace password on first visit
3. Connect an email account under **Settings → Email Accounts**
4. Test by creating a campaign and sending a test email

---

## Cookie / Auth Note

Since the frontend and backend are on different domains, authentication uses **Bearer tokens** (stored in `localStorage`) in addition to cookies. This is already implemented — the `api.ts` client sends the `Authorization: Bearer <token>` header automatically.

---

## Local Development

No changes needed locally. Run as before:

```bash
npm run dev
```

The app runs as a monolith locally (Express serves both API and the Vite dev server).

---

## Generating a MAIL_CREDENTIALS_KEY

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the output and paste it as the `MAIL_CREDENTIALS_KEY` value in Railway.
