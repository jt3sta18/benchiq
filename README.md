# BenchIQ web

Front end for BenchIQ, backed by the lab Google Sheet through Apps Script.

## How it fits together

    browser  ->  /api/data    ->  Apps Script  ->  Google Sheet
             ->  /api/update  ->  Apps Script  ->  Google Sheet + BenchIQ_Log

The browser never talks to Google directly. The Apps Script URL and the shared
token live in Vercel environment variables, so they stay out of the page source.
This also sidesteps CORS entirely, since the page only calls its own origin.

## Setup

1. Push this folder to a GitHub repo.
2. In Vercel: Add New -> Project -> import the repo. No build settings needed.
   `vercel.json` raises the API function timeout to 30s — the default ~10s
   is not always enough for a cold Apps Script round-trip, which surfaces as
   an intermittent 504 on /api/data.
3. Settings -> Environment Variables, add both (all environments):

       SHEET_ENDPOINT   the /exec URL
       SHEET_TOKEN      the token from setupToken

4. Deploy, then check:

       https://<your-app>.vercel.app/api/data?action=version
       https://<your-app>.vercel.app/api/data

## Endpoints

`GET /api/data` — the full payload:

    {
      "ok": true,
      "version": "1790191976247",
      "inventory": { "columns": [...], "rows": [[...], ...] },
      "orders":    { "columns": [...], "rows": [[...], ...] },
      "counts":    { "inventory": 516, "orders": 91 }
    }

Cached at the edge for 30s. `?action=version` returns only the stamp and is
never cached — poll that, and refetch the full payload when the stamp changes.

`POST /api/update`:

    { "id": "INV-0042",
      "fields": { "Status": "Depleted", "Qty": 0 },
      "who": "cami@ucf.edu" }

Writable fields: Status, Qty, Notes, Hazard, CAS, Location. Anything else is
dropped. Every accepted change lands in the BenchIQ_Log tab with old and new
values, who made it, and when.

## Changing the Apps Script later

Deploy -> Manage deployments -> edit -> Version: New version. Creating a *new*
deployment mints a different /exec URL and breaks SHEET_ENDPOINT.

## Note on access

The Apps Script deployment is "Execute as me / Anyone with the link", so the
token is what protects it. Before this points at real lab data rather than a
copy, put a login in front of the app and re-mint the token.
