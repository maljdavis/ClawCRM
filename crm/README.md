# ClawCRM — AI-Powered Service Business CRM

A white-label CRM platform for service businesses. Deploy once to Supabase + Netlify, onboard unlimited clients.

## Features

- **CRM + Jobs** — Contacts, leads, kanban job pipeline (Lead → Quoted → Booked → Paid)
- **Missed Call Text Back** — Auto-SMS when anyone calls and gets no answer (Twilio)
- **Voice AI Agent** — Claude-powered phone receptionist that answers calls, takes messages
- **Invoice Payments** — Generate invoices, send payment links via SMS, Stripe handles checkout
- **Multi-tenant** — One deployment, unlimited business clients (fully data-isolated)

---

## Deploy in 15 Minutes

### 1. Fork / clone this repo

```bash
git clone https://github.com/YOUR_USERNAME/clawcrm.git
cd clawcrm
```

> **To make this its own standalone GitHub repo:**
> 1. Create a new GitHub repo at github.com/new
> 2. Copy just the `crm/` folder and `supabase/` folder into it
> 3. Push: `git push origin main`

### 2. Create Supabase project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Open the SQL Editor → paste and run `supabase/schema.sql` (existing)
3. Then paste and run `supabase/crm-schema.sql` (CRM tables)
4. Copy your **Project URL** and **Anon Key** from Project Settings → API

### 3. Configure Supabase keys in the app

Edit two files — replace `YOUR_PROJECT` and `YOUR_ANON_KEY`:

- `crm/index.html` — lines 41–42
- `crm/js/crm-core.js` — lines 7–8

```js
const SUPABASE_URL  = 'https://abcdefgh.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

### 4. Deploy Edge Functions

Install Supabase CLI: `npm install -g supabase`

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF

# Set required secrets
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...

# Deploy all functions
supabase functions deploy twilio-voice-webhook
supabase functions deploy missed-call-handler
supabase functions deploy voice-ai-agent
supabase functions deploy stripe-create-invoice
supabase functions deploy stripe-webhook
```

### 5. Deploy frontend

**Option A — Netlify (recommended):**
1. Connect your GitHub repo to Netlify
2. Publish directory: `crm/`
3. Your CRM is live at `https://YOUR_SITE.netlify.app`

**Option B — GitHub Pages:**
```bash
# In repo settings → Pages → Source: Deploy from branch
# Branch: main, Folder: /crm
```

### 6. Create your first tenant + user

In Supabase SQL Editor:

```sql
-- Create a tenant (business client)
INSERT INTO crm_tenants (name, slug, phone)
VALUES ('Apex Plumbing', 'apex-plumbing', '+15551234567');

-- Get the tenant ID
SELECT id FROM crm_tenants WHERE slug = 'apex-plumbing';
```

In Supabase Auth → Users → Invite user (enter staff email).

Then in SQL Editor, link the user to the tenant:
```sql
INSERT INTO crm_users (id, tenant_id, role, full_name)
VALUES (
  'AUTH_USER_UUID_HERE',
  'TENANT_UUID_HERE',
  'admin',
  'John Smith'
);
```

### 7. Connect Twilio (per client)

1. Log in to the CRM → Settings
2. Enter Twilio Account SID, Auth Token, Phone Number → Save
3. Copy the two webhook URLs shown and paste into Twilio:
   - **Voice URL**: `https://YOUR_PROJECT.supabase.co/functions/v1/twilio-voice-webhook`
   - **Status Callback**: `https://YOUR_PROJECT.supabase.co/functions/v1/missed-call-handler`

### 8. Connect Stripe (per client)

1. In CRM Settings → Stripe section
2. Enter Publishable Key + Secret Key → Save
3. Copy the Stripe webhook URL → paste in [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks)
4. Add `STRIPE_WEBHOOK_SECRET` to Supabase Edge Function secrets

### 9. Enable AI voice agent

1. In CRM Settings → AI Voice Agent → toggle ON
2. Customize the system prompt for the business
3. Test by calling the Twilio number

---

## Adding a New Client

For each new service business client:

```sql
-- 1. Create tenant
INSERT INTO crm_tenants (name, slug, phone)
VALUES ('Pro Roofing Co', 'pro-roofing', '+15559876543');

-- 2. Create their staff accounts via Supabase Auth → Invite
-- 3. Link users to tenant in crm_users
-- 4. Client logs into Settings to configure their own Twilio + Stripe
```

Each client's data is **100% isolated** — Supabase RLS ensures no data crosses tenant boundaries.

---

## Architecture

```
Browser (crm/*.html)
    │
    ├── Supabase Auth (login)
    ├── Supabase Database (contacts, jobs, invoices, activities)
    └── Supabase Edge Functions
            ├── twilio-voice-webhook  ← Twilio calls this on inbound call
            │       └── Returns ConversationRelay TwiML
            ├── voice-ai-agent        ← WebSocket: Claude responds in real-time
            │       └── Streams tokens to Twilio TTS
            ├── missed-call-handler   ← Fires on no-answer → sends auto-SMS
            ├── stripe-create-invoice ← Creates Stripe invoice, returns payment URL
            └── stripe-webhook        ← Stripe calls on payment success
```

---

## Environment Secrets (Supabase Edge Functions)

| Secret | Where to get it |
|--------|----------------|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Webhooks → Signing Secret |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set by Supabase |

Twilio and Stripe credentials are stored **per-tenant** in the database (not as global secrets), so each client uses their own accounts.

---

## Tech Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3 (no build tools required)
- **Backend**: Supabase (PostgreSQL + Auth + Storage + Edge Functions / Deno)
- **AI**: Claude claude-sonnet-4-6 via Anthropic API
- **Phone/SMS**: Twilio Voice (ConversationRelay) + Twilio Messaging
- **Payments**: Stripe Invoicing + Stripe Webhooks
- **Hosting**: Netlify / GitHub Pages
