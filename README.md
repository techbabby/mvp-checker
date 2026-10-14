# MVP Checker — Standalone Deploy (Netlify)

No Claude account needed for visitors. No Tally, no Zapier. Scoring runs
through your own Anthropic API key, and every submission writes straight
into your Google Sheet — both handled privately by one serverless function.

## What's in this folder

- `index.html` — the whole app (5 questions now: problem, user, solution,
  email, features — report unlocks immediately, no gate)
- `netlify/functions/score.js` — scores the idea with Claude AND appends
  the submission to your Google Sheet, in one call
- `netlify.toml` — tells Netlify where the function lives
- `package.json` — lists the `googleapis` library the function needs;
  Netlify installs it automatically during deploy

## Environment variables you need to set in Netlify

Site configuration → Environment variables → Add a variable, for each of:

| Key | Where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | the `client_email` field in your service account JSON |
| `GOOGLE_PRIVATE_KEY` | the `private_key` field in that same JSON — paste it exactly as-is, including the `\n` characters and the BEGIN/END lines |
| `GOOGLE_SHEET_ID` | the long ID in your sheet's URL: `docs.google.com/spreadsheets/d/THIS_PART/edit` |

Important: your Google Sheet must be **shared with the service account's
email** (the `client_email` value) as an Editor, or the write will fail
silently (scoring still works, but nothing lands in the sheet).

## Deploy steps

1. **Push this folder to a GitHub repo**
   Drag-and-drop deploy does NOT support serverless functions — you need
   a Git-connected deploy. Create a new repo on GitHub and upload this
   folder's contents (GitHub's web UI lets you drag files in directly).

2. **Connect the repo to Netlify**
   app.netlify.com → "Add new site" → "Import an existing project" →
   GitHub → select your repo → "Deploy site."

3. **Add the four environment variables above**, then go to "Deploys" →
   "Trigger deploy" → "Deploy site" to pick them up.

4. **Test it** — open your new `.netlify.app` URL in an incognito window.
   Run the full flow: answer all 5 questions, confirm a real report comes
   back, then check your Google Sheet for the new row.

5. **Connect your domain** — Site configuration → Domain management →
   Add a domain → `useforma.design`, then follow Netlify's DNS
   instructions at your domain registrar.

## Costs to expect

- Netlify: free tier comfortably covers this
- Anthropic API: roughly $0.006–$0.01 per report generated (see note
  below), scales with usage
- Google Sheets API: free, well within the free quota for this volume
- Domain: separate, via wherever you registered useforma.design

## If something breaks

- **"The check hit an error"** on the loading screen → check Netlify's
  "Functions" tab → `score` → logs for the exact message. Usually a
  missing or mistyped environment variable.
- **Report works but nothing appears in the Sheet** → almost always means
  the Sheet isn't shared with the service account's email, or
  `GOOGLE_SHEET_ID` is wrong. Check the function logs — the error is
  logged there even though it doesn't block the user's report.
- **"Server is missing ANTHROPIC_API_KEY"** → the env var isn't set, or
  you haven't redeployed since adding it.
