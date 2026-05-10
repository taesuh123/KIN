const crypto = require("crypto");

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "goaltrack-15e35";
const CREATOR_EMAILS = (process.env.CREATOR_EMAIL || "tae.suh123@gmail.com,taesuh123@gmail.com").split(",").map(email => email.trim()).filter(Boolean);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
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

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  const [name, domain] = value.split("@");
  return domain === "gmail.com" ? `${name.replace(/\./g, "")}@${domain}` : value;
}

function isCreator(email) {
  const signedIn = normalizeEmail(email);
  return CREATOR_EMAILS.some(allowed => normalizeEmail(allowed) === signedIn);
}

function textFromResponse(data) {
  if (data.output_text) return data.output_text.trim();
  return (data.output || []).flatMap(item => item.content || []).map(c => c.text || "").join("\n").trim();
}

function compactContext(context) {
  return {
    goals: (context.goals || []).slice(0, 12).map(g => ({ title: g.title, type: g.type, done: !!g.done })),
    recentEvents: (context.events || []).slice(-20).map(e => ({ title: e.title, date: e.date, category: e.cat, skills: e.skills || [] })),
    profile: context.profile || {},
    habitSummary: context.habitSummary || "",
    progressSummary: context.progressSummary || ""
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (!process.env.OPENAI_API_KEY) return send(res, 500, { error: "OPENAI_API_KEY is not configured." });
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifyFirebaseToken(token);
    if (!isCreator(user.email)) return send(res, 403, { error: "Only the creator can generate snapshot messages." });
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = String(payload.prompt || "").trim();
    if (!prompt) return send(res, 400, { error: "Prompt is required." });

    const input = [
      {
        role: "system",
        content: [{ type: "input_text", text: "You generate one optional personal message for a Goaltrack Daily Snapshot email. Stay strictly inside the user's requested message theme plus their Goaltrack context. Do not answer unrelated questions. Do not mention that you are an AI. If asked for a Bible verse, provide a short verse reference and brief motivational wording. Keep it under 55 words. Return only the final message text." }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify({ prompt, goaltrackContext: compactContext(payload.context || {}), notificationSettings: payload.settings || {} }) }]
      }
    ];

    const ai = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: OPENAI_MODEL, input })
    });
    const data = await ai.json();
    if (!ai.ok) return send(res, ai.status, { error: data.error?.message || "OpenAI request failed." });
    return send(res, 200, { message: textFromResponse(data).replace(/^["']|["']$/g, "") });
  } catch (err) {
    return send(res, 500, { error: err.message || "Snapshot message failed." });
  }
};
