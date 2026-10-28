# LoopBoard

The existing light-mode website with a Supabase pickup-request backend. The form saves a request before showing a reference. It does not confirm a collection slot or send SMS/email.

## Files

- `index.html`: website, calculator and existing illustrations/motion.
- `config.js`: two public Supabase connection values.
- `booking.js`: form validation, submission, loading/error states and safe retries.
- `supabase/migrations/202610280001_pickups.sql`: private table and transactional request function.
- `supabase/functions/create-pickup/`: public HTTP endpoint with validation and origin checks.
- `tests/backend.test.mjs`: dependency-free backend tests.
- `supabase/tests/pickups.sql`: database smoke tests for a development project.

## Supabase setup

### 1. Create a project

Create a new project at https://supabase.com/dashboard. Save its database password privately. Use a new project so the migration does not conflict with an existing `pickups` table or function.

In the project's Connect dialog / Settings > API Keys, copy the project URL and a **publishable** key (`sb_publishable_...`). Ensure the project also has a secret key named `default`. The backend reads the runtime-injected `SUPABASE_SECRET_KEYS.default`; you do not copy that secret into the website.

### 2. Apply the database migration

Open PowerShell in this folder. Node.js 22 or newer is recommended. The Supabase CLI can run through npx; no application dependencies need installing.

```powershell
cd 'C:\Users\Hp\Downloads\LoopBoard'
npx supabase@latest login
npx supabase@latest link --project-ref YOUR_PROJECT_REF
npx supabase@latest db push
```

Replace `YOUR_PROJECT_REF` with the project ID in Project Settings. Enter the database password if prompted. The included `supabase/config.toml` is already initialized; do not run `supabase init` over it.

`db push` applies the migration once and records it in migration history. Avoid also running the same migration manually in SQL Editor.

### 3. Allow your website's origin and deploy

For local testing:

```powershell
npx supabase@latest secrets set 'ALLOWED_ORIGINS=http://localhost:8000,http://127.0.0.1:8000'
npx supabase@latest functions deploy create-pickup --use-api
```

The deployment uses the API, so Docker is not required. `verify_jwt = false` in `supabase/config.toml` lets visitors submit without signing in. The handler still checks your public application key, allowed origin, field values and request limits. A public key identifies the application; it is not a user's identity.

For a hosted website, set its exact origin (scheme + domain, no path/trailing slash), for example:

```powershell
npx supabase@latest secrets set 'ALLOWED_ORIGINS=https://your-domain.example'
```

Use comma-separated origins if you serve both `www` and non-`www`. Do not use `*`. Remove localhost from production configuration. The allowlist stops other browser origins; it is not authentication for non-browser clients.

### 4. Connect the website

Edit `config.js`:

```javascript
window.LOOPBOARD = {
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  publishableKey: 'sb_publishable_YOUR_PUBLIC_KEY',
};
```

Only the project URL and publishable key belong here. Never paste a secret key, service-role key, database password or Supabase access token into frontend files or Git.

### 5. Run and test the website

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

Open http://localhost:8000 in your browser. Serve the folder over HTTP rather than double-clicking the HTML; `file://` has a null origin and the backend rejects it.

Submit one request with test contact details and a date from tomorrow onwards, using India time. Confirm all of these:

1. The form shows a saved reference, not a confirmed pickup slot.
2. Supabase > Table Editor > `pickups` contains exactly one new row with status `requested`.
3. A failed connection keeps the form details and offers a retry.
4. The same request retried with its original identifier returns the original reference.

The original HTML in Downloads also loads this folder's `config.js` and `booking.js`. Use this project folder's `index.html` as the version you deploy and maintain.

### 6. Manage requests

In Supabase Table Editor, open `pickups`, sort by `created_at`, and contact the customer yourself. Update `status` to `confirmed`, `collected` or `cancelled` as appropriate. Customer logins and a custom admin page are not required. Public and signed-in website visitors cannot read, insert, update or delete rows directly.

Limit Supabase dashboard access to the people handling requests. Keep exports private, and delete contact details when they are no longer needed. The SQL tests below must be run on a development project, not customer data.

### 7. Host the frontend

Publish only `index.html`, `config.js`, and `booking.js` using a static web host. Set `ALLOWED_ORIGINS` to that site's HTTPS origin. Re-test with a test request from the hosted page. Do not upload backend source, tests, `.env`, exports or backups into the public web root.

## Checks

```powershell
npm test
```

These tests use a fake database transport and do not send requests or personal data to Supabase. They cover validation, payload limits, origin/key checks, error handling and India dates. They do not substitute for a deployed end-to-end test.

`node tests/browser-check.mjs` checks the form in headless Chromium against the actual HTTP handler with a fake database transport. It covers failed saves, lost-response retries, loading, rate limits, focus, safe text rendering and four viewport sizes. It uses this machine's cached Chromium; on another machine set `CHROME_PATH` to an existing Chromium executable. It does not require live Supabase credentials.

After applying the migration in a **development project**, run `supabase/tests/pickups.sql` in its SQL Editor. It checks permissions, idempotency, and both rate limits, then rolls back the test rows. A successful run returns no assertion error.

## Limits and retries

- Maximum 3 saved requests per phone number per hour; 10 per IP hash per hour. These limits are enforced inside the database transaction, including simultaneous submissions.
- IPs are HMAC-hashed with the backend secret before storage. Raw addresses are not stored. The Supabase proxy supplies `X-Forwarded-For`; requests without it share a conservative `unknown` bucket.
- Retries with the same UUID and unchanged fields return the original reference. Edited fields get a new UUID. Reloading the page starts a new request, so retry from the existing form after an uncertain connection.
- Shared connections may hit the IP limit. These are basic abuse controls, not a CAPTCHA or protection against distributed bots.
- The handler does not log contact details or credentials, and its error responses omit database internals. There are no automatic confirmation calls, messages, emails or collection assignments.

## Git

This folder includes `.gitignore`; keys, local Supabase state, exports and backups stay out of commits. Commit the SQL migration with the backend and frontend change that needs it.

```powershell
git init -b main
git add .
git commit -m "Add LoopBoard pickup requests with Supabase"
```

Create an empty private GitHub repository, then use its actual URL:

```powershell
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

## Official references

- Supabase CLI and deployment: https://supabase.com/docs/guides/functions/quickstart
- Injected environment variables: https://supabase.com/docs/guides/functions/secrets
- API keys and server-only secrets: https://supabase.com/docs/guides/getting-started/api-keys
- Database migrations: https://supabase.com/docs/guides/deployment/database-migrations
