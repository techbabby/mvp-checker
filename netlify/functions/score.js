// netlify/functions/score.js
//
// Runs on Netlify's servers, never in the visitor's browser.
// Two things happen here:
//   1. The idea gets scored by Claude (using ANTHROPIC_API_KEY)
//   2. The submission gets appended as a new row in your Google Sheet
//      (using the service account credentials below)
//
// None of these secrets are ever sent to, or visible from, the browser.
// All of them live only as environment variables, set in Netlify's
// dashboard under Site configuration -> Environment variables.
//
// Required environment variables:
//   ANTHROPIC_API_KEY            - from console.anthropic.com
//   GOOGLE_SERVICE_ACCOUNT_EMAIL - the "client_email" from your service account JSON
//   GOOGLE_PRIVATE_KEY           - the "private_key" from that same JSON (keep the \n's as-is)
//   GOOGLE_SHEET_ID              - the long ID in your sheet's URL, between /d/ and /edit

const { google } = require('googleapis');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server is missing ANTHROPIC_API_KEY.' }) };
  }

  let idea;
  try {
    idea = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { problem, user, solution, email, features } = idea;
  if (!problem || !user || !solution || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: problem, user, solution, email' }) };
  }

  const prompt = `You are the scoring engine behind MVP Checker, a tool built by the product studio Forma. Your job is to evaluate an early-stage product idea against a strict build-readiness rubric and tell the founder the truth — not generic startup encouragement.

Be direct and specific. If the idea is vague, say so and explain what's missing. Do not inflate scores to be nice. Ground every note in what the founder actually wrote, not assumptions.

FOUNDER'S IDEA:
Problem: ${problem}
Target user: ${user}
Proposed solution: ${solution}
Planned features: ${features || '(not provided)'}

Score the idea 0-10 on each of these five criteria:
1. Problem Clarity — is the pain point specific and evidenced, or vague and assumed?
2. User Specificity — is the target user narrowly named, or "everyone"?
3. Differentiation — is it clear why this, why now, why this founder?
4. Feasibility — can a real MVP of this be built in weeks, not years, with the current scope?
5. Riskiest Assumption — does the idea reveal awareness of what could kill it, and is the MVP shaped to test that?

Also review the planned features list (if provided) and split it into features to KEEP for a true MVP (only what's needed to test the core hypothesis) and features to CUT for v1 (nice-to-haves, scope creep, premature polish). If no features were listed, infer a minimal reasonable feature set from the solution description and populate both lists from that.

Identify 2-4 concrete red flags — specific risks or gaps in THIS idea, not generic startup advice.

Respond with ONLY valid JSON, no markdown fences, matching exactly this shape:
{
  "overall_score": <integer 0-100>,
  "verdict": "<one of: Ready to build | Needs sharpening | Not yet — rework the core idea>",
  "criteria": [
    {"name": "Problem Clarity", "score": <0-10>, "note": "<one specific sentence>"},
    {"name": "User Specificity", "score": <0-10>, "note": "<one specific sentence>"},
    {"name": "Differentiation", "score": <0-10>, "note": "<one specific sentence>"},
    {"name": "Feasibility", "score": <0-10>, "note": "<one specific sentence>"},
    {"name": "Riskiest Assumption", "score": <0-10>, "note": "<one specific sentence>"}
  ],
  "red_flags": ["<specific flag>", "..."],
  "keep_features": ["<feature>", "..."],
  "cut_features": ["<feature>", "..."],
  "riskiest_assumption_to_test": "<one sentence naming the single most important thing to validate first>",
  "summary": "<2-3 sentence direct summary of where this idea stands>"
}`;

  let report;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: `Anthropic API error: ${response.status} ${errText}` }) };
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'No text returned from model' }) };
    }

    report = extractJson(textBlock.text);
    if (!report) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Model did not return valid JSON', raw: textBlock.text.slice(0, 800) }) };
    }
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message || 'Unknown server error during scoring' }) };
  }

  // --- Write the submission to Google Sheets ---
  // Runs after scoring succeeds. If this fails, we still return the report
  // to the user (a sheet hiccup shouldn't break their experience) but log
  // the problem for your own debugging in the function's logs.
  try {
    await appendToSheet({ user, solution, features, email, problem });
  } catch (e) {
    console.error('Google Sheets write failed:', e.message);
  }

  return { statusCode: 200, headers, body: JSON.stringify(report) };
};

function extractJson(text) {
  // Try the whole trimmed string first.
  const attempts = [text.trim()];

  // Strip markdown code fences if present (```json ... ``` or ``` ... ```).
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());

  // Fall back to the substring between the first "{" and the last "}" —
  // catches cases where the model adds a sentence before or after the JSON.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    attempts.push(text.slice(first, last + 1).trim());
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // try the next candidate
    }
  }
  return null;
}

async function appendToSheet({ user, solution, features, email, problem }) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const saKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!sheetId || !saEmail || !saKey) {
    throw new Error('Missing GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY env vars');
  }

  // Netlify stores env vars as plain strings; the literal "\n" in the key
  // needs converting back into real newlines for the JWT signer to work.
  const privateKey = saKey.replace(/\\n/g, '\n');

  const auth = new google.auth.JWT(saEmail, null, privateKey, ['https://www.googleapis.com/auth/spreadsheets']);
  const sheets = google.sheets({ version: 'v4', auth });

  // Column order matches the existing sheet: Business Name | Target user | Solution | Planned features | Email
  // "Business Name" isn't collected in this version of the app, so it's left blank.
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Sheet1!A:E',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['', user, solution, features || '', email]]
    }
  });
}
