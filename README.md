# ScanForge

ScanForge provides automated website testing, quality analysis, browser/API automation, reports, evidence, and workspace quality management. It is built on the original TestTrace foundation.

## Local setup

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor, then apply [`supabase/migrations/20261118_run_login_configs.sql`](supabase/migrations/20261118_run_login_configs.sql). Existing deployments need only the migration for per-run login configuration.
2. Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and a random `CRON_SECRET`.
3. In Supabase Authentication settings, allow the local callback `http://localhost:3000/auth/callback` and enable email/password sign-in.
4. Install and start the app:

   ```powershell
   npm.cmd ci
   npm.cmd run dev
   ```

5. Open `http://localhost:3000`, create an account, and confirm its email if Supabase email confirmation is enabled. New accounts receive a private workspace with a starter cycle and example records.

## What works in the app

- Email/password sign-up, confirmation callback, sign-in, sign-out, and project-scoped access roles.
- Create, edit, filter, assign, execute, and remove test cases. Test steps and expected results are stored with each case. Evidence accepts PNG, JPG, WebP, PDF, and text files up to 4 MB.
- Create release cycles and choose their test cases; move tasks through To do, In progress, and Done; manage requirements-to-test-case links; track defects; and review audit history.
- Record manual test results. Each execution is stored as a run and updates the case status.
- Export the test suite to CSV/Excel and create a PDF quality report.
- Queue Playwright, Selenium, and Newman suites for GitHub Actions. Results and failure screenshots are stored with the run and are visible to project members.
- Enable a daily run for the active cycle. On Vercel Hobby it is scheduled once daily, near 02:15 UTC, subject to Vercel's schedule timing window.

## Connect the automation runner

The web app and API deploy to Vercel. The isolated browser/API worker runs as a GitHub Actions workflow so browser processes do not run inside a short-lived Vercel request.

1. Push this repository, including `.github/workflows/automation.yml`, to GitHub. The workflow must be present on the selected default/dispatch branch.
2. Create a GitHub fine-grained token with Actions read/write access for this repository.
3. Add these **GitHub Actions repository secrets**:
   - `SUPABASE_URL`: your Supabase project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: the Supabase service-role key. Keep it secret; never put it in browser code.
   - `E2E_EMAIL` and `E2E_PASSWORD`: an account in the ScanForge workspace, for the supplied sign-in examples.
   - `RUN_CONFIG_ENCRYPTION_KEY`: the same randomly generated base64 32-byte key configured in Vercel. Generate once with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and keep it secret.
4. Set these **Vercel environment variables** from `.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `RUN_CONFIG_ENCRYPTION_KEY`.
   - `GITHUB_AUTOMATION_OWNER`, `GITHUB_AUTOMATION_REPOSITORY`, `GITHUB_AUTOMATION_TOKEN`, `GITHUB_AUTOMATION_BRANCH`, `GITHUB_AUTOMATION_WORKFLOW`.
5. In ScanForge **Settings**, set the public HTTPS URL of the application or test target. Add an automated test case with a supported step list, or a Newman collection committed within this repository.

The sample Newman case checks `/api/health`. The Playwright and Selenium sign-in examples use the `E2E_EMAIL` and `E2E_PASSWORD` GitHub secrets. CI results are written directly to Supabase by the worker; service-role credentials are never sent to the browser.

## Deploy to Vercel

Import the repository in Vercel, set the environment variables above, and deploy the Next.js app. Apply the SQL schema before the first sign-up. The Vercel Hobby cron schedule runs once per day; on-demand automation uses the GitHub Actions allowance. Supabase Free can pause inactive projects, so a paused database must be resumed before the application can load shared records.

## Automation step format

### Local custom Test Cycles

Start with `npm run dev`. Create a test case with **Automation type: Playwright** and this JSON in **Test steps**:

```json
[{"action":"check","value":"page_title"}]
```

Supported check values are `page_response`, `page_title`, `h1_heading`, `image_alt`, and `mobile_viewport`. A case may contain multiple check objects; all must pass. `h1_heading` requires exactly one H1 element with nonempty text. `image_alt` requires nonempty alt text, except decorative images explicitly marked with both `alt=""` and `role="presentation"` or `role="none"`. `mobile_viewport` requires `width=device-width`.

Create a new cycle, explicitly select its cases, enter a public HTTP/HTTPS URL on **Test cycles**, and click **Run Cycle**. Results appear on the cycle card. Manual cases, empty definitions and unsupported actions appear as **Not Automated** (stored as `skipped`). A run passes only when every assigned case actually passes. Shared case statuses and the workspace scanner URL are never changed. No demo records are created automatically.

The authenticated `/api/cycles/run` endpoint works on Vercel and dispatches the existing GitHub Actions workflow with run and project identifiers. Browser execution remains in GitHub Actions. The cycle runner validates and pins public DNS addresses for browser requests, including redirects and subresources, and blocks local/private/reserved addresses, service workers and WebSockets. Enter login values in the collapsed **Login Test Configuration** section for each execution. The API stores only an AES-256-GCM encrypted payload in the service-role-only `run_login_configs` table. It expires after 30 minutes, is bound to its run and project, and the runner deletes it after execution. The daily Vercel cron removes expired payloads if a workflow never starts. Existing GitHub Actions `E2E_` secrets remain a fallback for runs queued before this feature.

Playwright/Selenium test cases store a JSON array in the `steps` field. Supported actions are `goto`, `fill`, `click`, `select`, `check`, `uncheck`, `expect_text`, `expect_url`, `expect_visible`, and `wait`. Each action uses `selector` and/or `value` as appropriate. Values may reference configured GitHub secrets using `{{env:E2E_NAME}}` syntax. Newman cases store a repository-relative `automation_file` path to a Postman collection JSON file.
