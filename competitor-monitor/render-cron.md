# Render Cron Job Setup for Bimbly Intel Monitor

## Steps

1. Go to https://render.com and open your dashboard.
2. Click **New +** then select **Cron Job**.
3. Connect the GitHub repo: `samvaghefi/bookingagent`.
4. Set the following:

| Field | Value |
|---|---|
| Name | `bimbly-intel-monitor` |
| Build Command | `npm install` |
| Start Command | `node competitor-monitor/index.js` |
| Schedule | `0 11 * * *` |

> Schedule `0 11 * * *` = 7:00 AM Toronto time (UTC-4 in summer, UTC-5 in winter).
> Adjust to `0 12 * * *` in winter (EST, UTC-5) if you want a strict 7 AM ET run year-round.
> Recommended: set to `0 12 * * *` for winter and accept ~8 AM in summer, or use a fixed UTC time.

5. Under **Environment Variables**, add the following (copy values from your main bookingagent service):

| Key | Source |
|---|---|
| `SUPABASE_URL` | Copy from main service |
| `SUPABASE_SERVICE_ROLE_KEY` | From Supabase Dashboard > Settings > API > service_role key |
| `SENDGRID_API_KEY` | Copy from main service |
| `ANTHROPIC_API_KEY` | Copy from main service |

6. Click **Create Cron Job**.

## First Run

On first run the script stores baseline snapshots and sends one baseline email to vaghefi@gmail.com with subject:
`Bimbly Intel -- Baseline Report -- [DATE]`

Subsequent daily runs only send an email when changes are detected.

## Supabase Setup (one-time, before first run)

Run the SQL in `competitor-monitor/supabase-migration.sql` in your Supabase SQL editor:
1. Open https://supabase.com and go to your project.
2. Click **SQL Editor** in the left sidebar.
3. Paste the contents of `competitor-monitor/supabase-migration.sql` and click **Run**.
