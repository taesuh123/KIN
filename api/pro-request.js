const crypto = require("crypto");

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "goaltrack-15e35";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Goaltrack <onboarding@resend.dev>";
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO || "no-reply@goaltrack.app";
const PRO_REQUEST_TO = process.env.PRO_REQUEST_TO || "infogoaltrack@gmail.com";
let certCache = { expires: 0, certs: null };

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function b64url(input) {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
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

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

async function sendEmail({ subject, text }) {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#1A1916;max-width:620px;margin:0 auto;padding:24px"><h1 style="font-size:24px;margin:0 0 18px">Goaltrack Pro Access Request</h1>${text.split("\n").map(line => `<p style="margin:0 0 10px">${escapeHtml(line)}</p>`).join("")}</div>`;
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: PRO_REQUEST_TO,
      reply_to: RESEND_REPLY_TO,
      subject,
      text,
      html
    })
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
    const usage = payload.usage || {};
    const profile = payload.profile || {};
    const email = user.email || "unknown email";
    const text = [
      "A Goaltrack user requested beta Pro access.",
      `User: ${email}`,
      `Firebase UID: ${user.user_id || user.sub || ""}`,
      `Current plan: ${usage.plan || "free"}`,
      `Free prompts used: ${usage.promptsUsed || 0}`,
      `Monthly spend: ${JSON.stringify(usage.monthlySpend || {})}`,
      `Profile name: ${profile.name || ""}`,
      `Requested at: ${new Date().toISOString()}`,
      "",
      "Manual next step: update this user's users/{uid}/appState/main agentUsage.plan to beta_pro or pro in Firestore."
    ].join("\n");
    const sent = await sendEmail({ subject: `Goaltrack Pro access request - ${email}`, text });
    return send(res, 200, { ok: true, id: sent.id || "" });
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || "Could not send Pro request." });
  }
};
