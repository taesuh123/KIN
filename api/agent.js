const crypto = require("crypto");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "goaltrack-15e35";
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

function words(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [];
}

function deriveTopicWords(context) {
  const corpus = [
    ...(context.goals || []).flatMap(g => [g.title, g.desc, g.type]),
    ...(context.events || []).slice(-40).flatMap(e => [e.title, e.notes, e.cat, ...(e.skills || [])]),
    ...(context.goalTypes || []).map(t => t.label),
    context.habitSummary,
    context.progressSummary
  ].join(" ");
  const set = new Set(words(corpus).filter(w => !["the", "and", "for", "with", "from", "this", "that", "goal", "goals", "event", "events"].includes(w)));
  const topicMap = [
    [["gym", "workout", "fitness", "bench", "strength", "weight", "run"], ["protein", "nutrition", "recovery", "sleep", "cardio", "lifting", "exercise", "habit", "consistency", "muscle"]],
    [["school", "academic", "class", "exam", "paper", "study"], ["study", "homework", "deadline", "rubric", "essay", "research", "exam", "grade", "course"]],
    [["finance", "budget", "money", "accounting"], ["excel", "budget", "saving", "spending", "debt", "financial", "forecast", "analysis"]],
    [["career", "professional", "internship", "resume"], ["resume", "interview", "linkedin", "networking", "job", "internship", "career"]],
    [["personal", "health", "doctor"], ["routine", "appointment", "wellness", "schedule", "habit"]]
  ];
  const base = [...set].join(" ");
  topicMap.forEach(([triggers, extras]) => {
    if (triggers.some(t => base.includes(t))) extras.forEach(e => set.add(e));
  });
  return set;
}

function scopeQuestion(question, context) {
  const qWords = words(question).filter(w => !["what", "should", "could", "would", "about", "help", "give", "make", "tell", "please"].includes(w));
  const topics = deriveTopicWords(context);
  const hits = qWords.filter(w => topics.has(w));
  const hasGoals = (context.goals || []).some(g => !g.done);
  const generalCoaching = /\b(next|plan|improve|progress|habit|routine|schedule|consistent|consistency|advice|feedback|goal|goals)\b/i.test(question);
  const practicalPlanning = /\b(grocery|groceries|shopping|meal|protein|budget|study|workout|fitness|schedule|calendar|list)\b/i.test(question);
  const offTopic = /\b(dog|cat|movie|celebrity|weather|politics|vacation|game)\b/i.test(question);
  const allowed = hits.length > 0 || ((hasGoals || practicalPlanning) && (generalCoaching || practicalPlanning) && !offTopic);
  const relatedGoals = (context.goals || []).filter(g => {
    const text = words(`${g.title} ${g.desc} ${g.type}`).join(" ");
    return hits.some(h => text.includes(h)) || (allowed && generalCoaching);
  }).slice(0, 4);
  return { allowed, hits, relatedGoals };
}

function compactContext(context) {
  return {
    goals: (context.goals || []).slice(0, 30),
    goalTypes: context.goalTypes || [],
    recentEvents: (context.events || []).slice(-50),
    profile: context.profile || {},
    habitSummary: context.habitSummary || "",
    progressSummary: context.progressSummary || "",
    memory: context.memory || {}
  };
}

function textFromResponse(data) {
  if (data.output_text) return data.output_text;
  return (data.output || []).flatMap(item => item.content || []).map(c => c.text || "").join("\n").trim();
}

function citationsFromResponse(data) {
  const citations = [];
  (data.output || []).forEach(item => (item.content || []).forEach(c => (c.annotations || []).forEach(a => {
    const url = a.url || a.url_citation?.url;
    const title = a.title || a.url_citation?.title || url;
    if (url && !citations.some(x => x.url === url)) citations.push({ title, url });
  })));
  return citations.slice(0, 5);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (!process.env.OPENAI_API_KEY) return send(res, 500, { error: "OpenAI API key is not configured yet." });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifyFirebaseToken(token);
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { question, context = {}, history = [] } = payload;
    if (!question || !String(question).trim()) return send(res, 400, { error: "Question is required." });

    const scoped = scopeQuestion(question, context);
    if (!scoped.allowed) {
      return send(res, 200, {
        blocked: true,
        text: "I can only help with questions tied to your GoalTrack goals, calendar, habits, progress, skills, or practical planning. What goal or plan would you like to connect this question to?"
      });
    }

    const safeContext = compactContext(context);
    const related = scoped.relatedGoals.map(g => g.title).join(", ") || "the user's GoalTrack data";
    const input = [
      {
        role: "system",
        content: [{ type: "input_text", text: `You are GoalTrack's personal agent. Only answer inside the user's GoalTrack context. Use the provided goals, calendar events, habits, progress, and memory. If the answer needs current or factual support, use web search and cite sources. Be practical, specific, and concise. Always end with one thoughtful follow-up question that either deepens the user's original request or asks what else they need help with. Default model is ${OPENAI_MODEL}.` }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify({
          userId: user.user_id,
          question,
          relatedGoalFocus: related,
          goaltrackContext: safeContext,
          recentChat: history.slice(-8)
        }) }]
      }
    ];

    const body = {
      model: OPENAI_MODEL,
      input
    };
    if (process.env.OPENAI_ENABLE_WEB_SEARCH !== "false") body.tools = [{ type: "web_search" }];

    const ai = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await ai.json();
    if (!ai.ok) return send(res, ai.status, { error: data.error?.message || "OpenAI request failed." });

    return send(res, 200, {
      text: textFromResponse(data),
      citations: citationsFromResponse(data),
      model: OPENAI_MODEL,
      relatedGoalIds: scoped.relatedGoals.map(g => g.id),
      memoryPatch: {
        lastRelatedGoals: scoped.relatedGoals.map(g => g.title),
        lastQuestionAt: new Date().toISOString()
      }
    });
  } catch (err) {
    return send(res, 401, { error: err.message || "Agent request failed." });
  }
};
