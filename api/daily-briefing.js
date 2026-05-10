const crypto = require("crypto");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "goaltrack-15e35";
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "(default)";
const CREATOR_EMAIL = process.env.CREATOR_EMAIL || "tae.suh123@gmail.com";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Goaltrack <onboarding@resend.dev>";
const FIRESTORE_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${encodeURIComponent(DATABASE_ID)}/documents`;
let tokenCache = { token: "", expires: 0 };

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function b64url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function serviceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim();
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(json);
  }
  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    };
  }
  throw new Error("Firebase service account is not configured.");
}

async function accessToken() {
  if (tokenCache.token && tokenCache.expires > Date.now() + 60000) return tokenCache.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  signer.end();
  const signature = signer.sign(sa.private_key, "base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${signature}`
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || data.error || "Could not authenticate with Firebase.");
  tokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function firestore(method, path, body) {
  const token = await accessToken();
  const resp = await fetch(`${FIRESTORE_ROOT}/${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error?.message || "Firestore request failed.");
  return data;
}

function fromValue(value) {
  if (!value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(fromValue);
  if ("mapValue" in value) return fromFields(value.mapValue.fields || {});
  return null;
}

function fromFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromValue(value)]));
}

function toValue(value) {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === "number") return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  if (value && typeof value === "object") return { mapValue: { fields: toFields(value) } };
  return { stringValue: String(value ?? "") };
}

function toFields(obj) {
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, toValue(value)]));
}

function dateParts(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { iso: `${map.year}-${map.month}-${map.day}`, label: `${map.weekday}, ${map.month}/${map.day}` };
}

function timeRange(event) {
  if (event.allDay) return "All day";
  if (event.time && event.end) return `${event.time}-${event.end}`;
  return event.time || "Time not set";
}

function activeGoalsForToday(events, goals) {
  const ids = new Set(events.flatMap(e => Array.isArray(e.gids) ? e.gids : [e.gid]).filter(Boolean).map(Number));
  return goals.filter(g => !g.done && ids.has(Number(g.id)));
}

function buildBriefing({ appState, settings, dateInfo }) {
  const name = appState.userProfile?.name || settings.email?.split("@")[0] || "there";
  const events = (appState.events || []).filter(e => e.date === dateInfo.iso).sort((a, b) => (a.time || "00:00").localeCompare(b.time || "00:00"));
  const goals = appState.goals || [];
  const connectedGoals = activeGoalsForToday(events, goals);
  const activeGoals = goals.filter(g => !g.done).slice(0, 5);
  const lines = [`Good morning, ${name}.`, "", `Today is ${dateInfo.label}.`, ""];

  if (settings.includeCalendar) {
    lines.push("Today you have:");
    if (events.length) events.forEach(e => lines.push(`- ${e.title}, ${timeRange(e)}`));
    else lines.push("- No calendar events logged in GoalTrack.");
    lines.push("");
  }

  if (settings.includeGoals) {
    lines.push("Goals connected to today:");
    if (connectedGoals.length) connectedGoals.forEach(g => lines.push(`- ${g.title}`));
    else if (activeGoals.length) activeGoals.slice(0, 3).forEach(g => lines.push(`- ${g.title}`));
    else lines.push("- No active goals yet.");
    lines.push("");
  }

  if (settings.includeMessageToSelf && settings.messageToSelf) {
    lines.push("Message to yourself:");
    lines.push(settings.messageToSelf);
    lines.push("");
  }

  lines.push("Have a steady day.");
  lines.push("GoalTrack");
  return lines.join("\n");
}

function htmlEmail(text) {
  return `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#1A1916;max-width:620px;margin:0 auto;padding:24px"><h1 style="font-size:24px;margin:0 0 18px">GoalTrack Daily Briefing</h1>${text.split("\n\n").map(p => `<p style="white-space:pre-line;margin:0 0 16px">${escapeHtml(p)}</p>`).join("")}</div>`;
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

async function sendEmail({ to, subject, text }) {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, subject, text, html: htmlEmail(text) })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.message || data.error || "Resend email failed.");
  return data;
}

async function notificationDocs() {
  const data = await firestore("POST", ":runQuery", {
    structuredQuery: {
      from: [{ collectionId: "settings", allDescendants: true }],
      where: {
        fieldFilter: { field: { fieldPath: "dailyEmailEnabled" }, op: "EQUAL", value: { booleanValue: true } }
      }
    }
  }).catch(async () => {
    const creator = await findCreatorNotification();
    return creator ? [{ document: creator }] : [];
  });
  return data.map(row => row.document).filter(doc => doc?.name?.endsWith("/settings/notifications"));
}

async function findCreatorNotification() {
  if (!CREATOR_EMAIL) return null;
  const data = await firestore("POST", ":runQuery", {
    structuredQuery: {
      from: [{ collectionId: "settings", allDescendants: true }],
      where: {
        fieldFilter: { field: { fieldPath: "email" }, op: "EQUAL", value: { stringValue: CREATOR_EMAIL } }
      },
      limit: 1
    }
  });
  return data.find(row => row.document?.name?.endsWith("/settings/notifications"))?.document || null;
}

function uidFromSettingsPath(name) {
  const match = String(name || "").match(/\/users\/([^/]+)\/settings\/notifications$/);
  return match?.[1] || "";
}

async function getAppState(uid) {
  const doc = await firestore("GET", `users/${uid}/appState/main`);
  return fromFields(doc.fields || {});
}

async function getSentLog(uid, key) {
  try {
    await firestore("GET", `users/${uid}/sentLogs/${key}`);
    return true;
  } catch {
    return false;
  }
}

async function setSentLog(uid, key, data) {
  await firestore("PATCH", `users/${uid}/sentLogs/${key}`, { fields: toFields({ ...data, sentAt: new Date().toISOString() }) });
}

function authorize(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not configured.");
  const auth = req.headers.authorization || "";
  const querySecret = new URL(req.url, "http://localhost").searchParams.get("secret");
  if (auth === `Bearer ${secret}` || req.headers["x-cron-secret"] === secret || querySecret === secret) return;
  const vercelCron = req.headers["x-vercel-cron"] === "1";
  if (vercelCron && auth === `Bearer ${secret}`) return;
  throw new Error("Unauthorized.");
}

async function sendCreatorTest() {
  const dateInfo = dateParts("America/New_York");
  const text = [
    "Good morning, Tae.",
    "",
    `Today is ${dateInfo.label}.`,
    "",
    "This is a GoalTrack test email. Your daily briefing sender is connected to Resend.",
    "",
    "Once your notification settings are enabled, the cron job will pull your real calendar events, goals, and personal message from Firebase.",
    "",
    "GoalTrack"
  ].join("\n");
  return sendEmail({ to: CREATOR_EMAIL, subject: "GoalTrack test email", text });
}

async function runDailyBriefings() {
  const docs = await notificationDocs();
  const results = [];
  for (const doc of docs) {
    const uid = uidFromSettingsPath(doc.name);
    const settings = fromFields(doc.fields || {});
    if (!uid || !settings.dailyEmailEnabled || !settings.email) continue;
    const dateInfo = dateParts(settings.timezone || "America/New_York");
    const logKey = `daily-email-${dateInfo.iso}`;
    if (await getSentLog(uid, logKey)) {
      results.push({ uid, email: settings.email, skipped: "already-sent" });
      continue;
    }
    const appState = await getAppState(uid);
    const text = buildBriefing({ appState, settings, dateInfo });
    const email = await sendEmail({ to: settings.email, subject: `GoalTrack Daily Briefing - ${dateInfo.iso}`, text });
    await setSentLog(uid, logKey, { email: settings.email, resendId: email.id || "", date: dateInfo.iso });
    results.push({ uid, email: settings.email, sent: true, id: email.id || "" });
  }
  return results;
}

module.exports = async function handler(req, res) {
  try {
    authorize(req);
    const url = new URL(req.url, "http://localhost");
    if (url.searchParams.get("test") === "creator") {
      const email = await sendCreatorTest();
      return send(res, 200, { ok: true, test: true, email });
    }
    const results = await runDailyBriefings();
    return send(res, 200, { ok: true, count: results.length, results });
  } catch (err) {
    return send(res, err.message === "Unauthorized." ? 401 : 500, { ok: false, error: err.message || "Daily briefing failed." });
  }
};
