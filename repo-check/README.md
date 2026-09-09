# Maruti — Inspection Report Builder

A self-contained fire/life-safety inspection CRM: log in, create a ticket for a
customer's site, pick a report type (Fire Alarm, plus configurable types like
Extinguisher, Pump, Sprinkler, etc.), fill it in, and export a branded PDF.
Includes a full Customers CRM (Billing Location → Service Location → Ticket →
Reports), a global Tickets list, and a Scheduler calendar — all backed by
Supabase (Postgres + Storage).

## Login

The app is gated behind a login screen. A master admin account is auto-seeded
the first time anyone logs in (see `MASTER_EMAIL` / `MASTER_PASSWORD` near the
top of `api/data.js` — it only re-seeds while the `Users` table is still
empty):

- Email: `support@maruti@zentrades.pro`
- Password: `Admin@123`

The master admin can create additional users (admin or regular) from the
**Admin** button in the top bar, which also lists every existing user's
password. Passwords are currently stored in **plain text** in the `Users`
table (by request, so an admin can read/manage them directly in the table or
the Admin panel) — anyone with database access, or an admin login to the app,
can see every password. Tighten this later (hash them) if that stops being an
acceptable tradeoff.

## Project structure

```
index.html   The entire app — single-file HTML/CSS/JS, no build step.
api/data.js  Vercel serverless function. The only thing that talks to
             Supabase — holds the service-role key server-side and proxies
             list/get/search/create/update/delete/login/logout/uploadAttachment
             calls to it, so the browser never sees Supabase credentials.
```

## Backend: Supabase

Data lives in Postgres tables that mirror the app's original Sheets:
`BillingLocations`, `ServiceLocations`, `Notes`, `Attachments`, `JobTickets`,
`ReportTypes`, `Reports`, `Users`, `Sessions`. Every table has Row Level
Security **enabled with no policies** — the anon/publishable key can't read or
write anything. The only way in is `api/data.js`, using the service-role key,
which bypasses RLS. That's intentional: it keeps the same shape as the old
setup (browser → same-origin proxy → the actual backend), just with Supabase
instead of Google Sheets + Apps Script.

Two bits of backend logic live in the database itself rather than the
function:
- **Ticket numbers** come from a Postgres sequence exposed as the
  `next_ticket_no()` RPC (`TCK-1001`, `TCK-1002`, …).
- **Attachments** upload to the public `attachments` Storage bucket instead of
  Google Drive; `Attachments.fileUrl` stores the resulting public URL.

### Setting it up (for a fresh Supabase project)

If you're pointing this at a brand new Supabase project instead of the one
already wired up, run once via the SQL editor:

```sql
-- tables: BillingLocations, ServiceLocations, Notes, Attachments, JobTickets,
-- ReportTypes, Reports, Users, Sessions — id uuid primary key default
-- gen_random_uuid(), createdAt timestamptz default now() (Reports uses
-- savedAt instead, no default), foreign keys following the hierarchy
-- BillingLocations -> ServiceLocations -> {Notes, Attachments, JobTickets},
-- JobTickets -> Reports, Users -> Sessions. Enable RLS on every table, add no
-- policies (service-role key is meant to be the only writer).

create sequence if not exists ticket_no_seq start with 1001;
create or replace function public.next_ticket_no()
returns text language sql as $$
  select 'TCK-' || nextval('ticket_no_seq')::text;
$$;

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;
```

### Environment variables (Vercel project settings)

- `SUPABASE_URL` — Project Settings → API → Project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → the **service_role**
  secret key. Not the anon/publishable key — that one is deliberately locked
  out by RLS. Never expose this key to the browser.

## Deploying (Vercel)

1. Push this repo to Vercel (import the GitHub repo directly, or `vercel` CLI
   from the repo root). No build command needed — it's static + one API
   route.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the project's
   environment variables (see above).
3. Deploy. Visit the Vercel URL and log in with the master admin above.

## Notes

- Everything runs client-side except the small server hop in `api/data.js`
  (proxying to Supabase with the service-role key) — there's no other
  backend.
- The Fire Alarm Inspection report type is built into the app directly (its
  own dedicated calculation engine) and isn't editable through the Report
  Types configurator. Other report types (Extinguisher, Pump, Sprinkler,
  Kitchen Hood, Emergency Lighting, Backflow, Dampers, Standpipe, Clean
  Agent) are configured there — fields and repeatable tables, no code needed
  per type.
- **Tickets** are the unit of work — created either from the **Tickets** tab
  (a flat list across every customer) or the **Scheduler** tab (click a day
  on the month calendar; chips are color-coded by status). Both open into the
  same ticket detail view used by Customers → Service Location → Job
  Tickets, where **+ Attach report** lets you fill and PDF-export any number
  of report types (Fire Alarm included) against that one ticket. Each ticket
  gets a human-friendly, auto-incrementing Ticket No (e.g. `TCK-1001`).
- Sessions last 12 hours; a session token is required for every backend call,
  so an expired session or an unreachable database surfaces as a clean
  "please log in again" rather than silent failures.
