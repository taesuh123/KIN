const crypto = require("crypto");

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "goaltrack-15e35";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Goaltrack <onboarding@resend.dev>";
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO || "no-reply@goaltrack.app";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CREATOR_EMAILS = new Set(["tae.suh123@gmail.com", "taesuh123@gmail.com", "infogoaltrack@gmail.com"]);
let certCache = { expires: 0, certs: null };

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function b64url(input) {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  const [name, domain] = value.split("@");
  return domain === "gmail.com" ? `${name.replace(/\./g, "")}@${domain}` : value;
}

async function firebaseCerts() {
  if (certCache.certs && certCache.expires > Date.now()) return certCache.certs;
  const resp = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
  const certs = await resp.json();
  const maxAge = /max-age=(\d+)/.exec(resp.headers.get("cache-control") || "");
  certCache = { certs, expires: Date.now() + (maxAge ? Number(maxAge[1]) * 1000 : 300000) };
  return certs;
}

async function verifyFirebaseToken(token) {
  const [rawHead, rawPayload, signature] = String(token || "").split(".");
  if (!rawHead || !rawPayload || !signature) throw new Error("Missing auth token");
  const head = JSON.parse(b64url(rawHead).toString("utf8"));
  const payload = JSON.parse(b64url(rawPayload).toString("utf8"));
  const certs = await firebaseCerts();
  const cert = certs[head.kid];
  if (!cert) throw new Error("Unknown auth key");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(rawHead + "." + rawPayload);
  verifier.end();
  if (!verifier.verify(cert, b64url(signature))) throw new Error("Invalid auth signature");
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== FIREBASE_PROJECT_ID || payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}` || payload.exp < now) throw new Error("Invalid auth token");
  return payload;
}

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  const [name, domain] = value.split("@");
  return domain === "gmail.com" ? `${name.replace(/\./g, "")}@${domain}` : value;
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

function normalizedTitle(title) {
  return String(title || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function habitLines(appState, todaysEvents) {
  const counts = {};
  (appState.events || []).forEach(event => {
    const key = normalizedTitle(event.title);
    if (key) counts[key] = (counts[key] || 0) + 1;
  });
  const repeated = Object.entries(counts).filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]);
  const todayRepeated = todaysEvents.filter(event => counts[normalizedTitle(event.title)] > 1).map(event => event.title);
  const lines = [...new Set(todayRepeated)].slice(0, 3);
  if (lines.length) return lines.map(title => `- ${title}`);
  if (repeated.length) return repeated.slice(0, 3).map(([title, count]) => `- ${title.replace(/\b\w/g, c => c.toUpperCase())} (${count}x logged)`);
  return ["- No recurring habit pattern yet."];
}

function snapshotContext({ appState, dateInfo, events }) {
  return {
    date: dateInfo.iso,
    profile: appState.userProfile || {},
    todayEvents: events.slice(0, 12).map(e => ({ title: e.title, time: timeRange(e), category: e.category })),
    activeGoals: (appState.goals || []).filter(g => !g.done).slice(0, 12).map(g => ({ title: g.title, type: g.type || g.category, description: g.desc || g.description || "" })),
    habitSignals: habitLines(appState, events)
  };
}

async function resolvePersonalMessage(prompt, { appState, settings, dateInfo, events }) {
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt || !settings.messageOnlineEnabled) return cleanPrompt;
  if (!process.env.OPENAI_API_KEY) return cleanPrompt;
  const input = [
    {
      role: "system",
      content: [{
        type: "input_text",
        text: "You write the Personal message section for a Goaltrack Daily Snapshot email. Use the user's prompt and Goaltrack context only. Stay encouraging, practical, and appropriate for a daily briefing. If the prompt asks for a verse, quote or paraphrase a short relevant verse with a reference and one sentence of motivation. Keep the final message under 65 words. Return only the message text."
      }]
    },
    {
      role: "user",
      content: [{
        type: "input_text",
        text: JSON.stringify({ prompt: cleanPrompt, context: snapshotContext({ appState, dateInfo, events }) })
      }]
    }
  ];
  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: OPENAI_MODEL, input })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return cleanPrompt;
    const text = data.output_text || (data.output || []).flatMap(item => item.content || []).map(part => part.text || "").join("\n").trim();
    return text || cleanPrompt;
  } catch {
    return cleanPrompt;
  }
}

async function buildBriefing({ appState, settings, dateInfo }) {
  const name = appState.userProfile?.name || settings.email?.split("@")[0] || "there";
  const todaysEvents = (appState.events || []).filter(e => e.date === dateInfo.iso).sort((a, b) => (a.time || "00:00").localeCompare(b.time || "00:00"));
  const goals = appState.goals || [];
  const connectedGoals = activeGoalsForToday(todaysEvents, goals);
  const activeGoals = goals.filter(g => !g.done).slice(0, 3);
  const lines = [`Good morning, ${name}.`, "", `Today is ${dateInfo.label}.`, ""];

  if (settings.includeCalendar !== false) {
    lines.push("Today you have:");
    if (todaysEvents.length) todaysEvents.forEach(e => lines.push(`- ${e.title}, ${timeRange(e)}`));
    else lines.push("- No calendar events logged in Goaltrack for this specific day.");
    lines.push("");
    lines.push("Habits:");
    habitLines(appState, todaysEvents).forEach(line => lines.push(line));
    lines.push("");
  }

  if (settings.includeGoals !== false) {
    lines.push("Goals connected to today:");
    if (connectedGoals.length) connectedGoals.forEach(g => lines.push(`- ${g.title}`));
    else if (activeGoals.length) activeGoals.forEach(g => lines.push(`- ${g.title}`));
    else lines.push("- No active goals yet.");
    lines.push("");
  }

  if (settings.includeMessageToSelf && settings.messageToSelf) {
    const personalMessage = await resolvePersonalMessage(settings.messageToSelf, { appState, settings, dateInfo, events: todaysEvents });
    lines.push("Personal message:");
    lines.push(personalMessage);
    lines.push("");
  }

  lines.push("This was a test email from Goaltrack.");
  lines.push("");
  lines.push("This is an automated snapshot. Replies are not monitored.");
  return lines.join("\n");
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

function htmlEmail(text) {
  return `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#1A1916;max-width:620px;margin:0 auto;padding:24px"><h1 style="font-size:24px;margin:0 0 18px">Goaltrack Daily Snapshot Test</h1>${text.split("\n\n").map(p => `<p style="white-space:pre-line;margin:0 0 16px">${escapeHtml(p)}</p>`).join("")}</div>`;
}

async function sendEmail({ to, subject, text }) {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to, reply_to: RESEND_REPLY_TO, subject, text, html: htmlEmail(text) })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.message || data.error || "Resend email failed.");
  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifyFirebaseToken(token);
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const appState = payload.appState || {};
    const settings = { ...(payload.settings || {}) };
    if (!CREATOR_EMAILS.has(normalizeEmail(user.email))) settings.messageOnlineEnabled = false;
    const email = settings.email || user.email;
    const dateInfo = dateParts(settings.timezone || appState.userProfile?.timezone || "America/New_York");
    const text = await buildBriefing({ appState, settings, dateInfo });
    const sent = await sendEmail({ to: email, subject: `Goaltrack Daily Snapshot Test - ${dateInfo.iso}`, text });
    return send(res, 200, { ok: true, email, date: dateInfo.iso, id: sent.id || "" });
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || "Could not send test email." });
  }
};
