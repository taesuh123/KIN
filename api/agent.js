const crypto = require("crypto");

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "goaltrack-15e35";
let certCache = { expires: 0, certs: null };
const CREATOR_EMAILS = new Set(["tae.suh123@gmail.com", "taesuh123@gmail.com", "infogoaltrack@gmail.com"]);
const FRIENDS_FAMILY_EMAILS = new Set(["magstwoody@gmail.com", "chansuh@gmail.com"]);
const FRIENDS_FAMILY_MONTHLY_AGENT_LIMIT_USD = 0.20;
const BETA_MONTHLY_AGENT_LIMIT_USD = 0.10;
const MODEL_RATES_PER_MILLION = {
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 5.00, output: 15.00 }
};

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

function accountTierForUser(user, requestedTier) {
  const email = normalizeEmail(user.email);
  if (CREATOR_EMAILS.has(email)) return "creator";
  if (FRIENDS_FAMILY_EMAILS.has(email)) return "friends_family";
  const tier = String(requestedTier || "free").toLowerCase().replace(/[\s-]+/g, "_");
  return ["pro", "beta_pro", "beta"].includes(tier) ? tier : "free";
}

function monthlyCapForTier(tier) {
  if (tier === "friends_family") return FRIENDS_FAMILY_MONTHLY_AGENT_LIMIT_USD;
  if (tier === "beta" || tier === "beta_pro") return BETA_MONTHLY_AGENT_LIMIT_USD;
  return Infinity;
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

function normalizeForSafety(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[@]/g, "a")
    .replace(/[!|1]/g, "i")
    .replace(/[3]/g, "e")
    .replace(/[0]/g, "o")
    .replace(/[$5]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[8]/g, "b")
    .replace(/[9]/g, "g")
    .replace(/(.)\1{2,}/g, "$1$1");
}

function containsBannedLanguage(text) {
  const normalized = normalizeForSafety(text);
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  const tokens = normalized.match(/[a-z0-9]+/g) || [];
  const bannedTokens = new Set([
    "fuck", "fucking", "fucker", "fucked", "shit", "shitty", "bullshit", "bitch", "bitches", "bitching",
    "asshole", "dick", "dicks", "cock", "cocks", "pussy", "cunt", "bastard", "damn", "hell",
    "whore", "slut", "fag", "faggot", "retard", "retarded", "kike", "spic", "chink", "gook",
    "wetback", "beaner", "coon", "jigaboo", "porchmonkey", "raghead", "towelhead", "sandnigger"
  ]);
  if (tokens.some(t => bannedTokens.has(t))) return true;
  const compactPatterns = [
    /f+u+c+k+/, /f+c+k+/, /m+o+t+h+e+r+f+u+c+k+/, /s+h+i+t+/, /s+h+t+/, /b+i+t+c+h+/, /b+t+c+h+/,
    /a+s+s+h+o+l+e+/, /c+u+n+t+/, /c+n+t+/, /d+i+c+k+/, /p+u+s+s+y+/, /b+a+s+t+a+r+d+/,
    /f+a+g+g+o+t+/, /f+g+g+t+/, /r+e+t+a+r+d+/, /w+h+o+r+e+/, /s+l+u+t+/,
    /n+[i1]+[gq]+[gq]+[aeu3a@4]*r?/, /n+[i1]+[gq]+[aeu3a@4]+/, /n+[i1]+b+b+[aeu3a@4]+/,
    /k+i+k+e+/, /c+h+i+n+k+/, /w+e+t+b+a+c+k+/, /b+e+a+n+e+r+/, /t+o+w+e+l+h+e+a+d+/, /r+a+g+h+e+a+d+/
  ];
  return compactPatterns.some(re => re.test(compact));
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
    [["personal", "health", "doctor"], ["routine", "appointment", "wellness", "schedule", "habit"]],
    [["girlfriend", "boyfriend", "partner", "relationship", "wife", "husband", "family", "friend"], ["date", "dates", "quality", "time", "together", "places", "restaurant", "dinner", "activity", "activities", "weekend", "budget", "romantic"]]
  ];
  const base = [...set].join(" ");
  topicMap.forEach(([triggers, extras]) => {
    if (triggers.some(t => base.includes(t))) extras.forEach(e => set.add(e));
  });
  return set;
}

function scopeQuestion(question, context) {
  const rawQuestion = String(question || "");
  const qWords = words(rawQuestion).filter(w => !["what", "should", "could", "would", "about", "help", "give", "make", "tell", "please", "need"].includes(w));
  const topics = deriveTopicWords(context);
  const hits = qWords.filter(w => topics.has(w));
  const goalCorpus = (context.goals || []).map(g => `${g.title || ""} ${g.desc || ""} ${g.type || ""}`).join(" ");
  const hasGoals = (context.goals || []).some(g => !g.done);
  const generalCoaching = /\b(next|plan|improve|progress|habit|routine|schedule|consistent|consistency|advice|feedback|goal|goals)\b/i.test(question);
  const practicalPlanning = /\b(grocery|groceries|shopping|meal|protein|budget|under|total|cheap|affordable|study|workout|fitness|schedule|calendar|list|place|places|restaurant|restaurants|cafe|cafes|date|dates|activity|activities|itinerary|where|visit|go)\b/i.test(question);
  const hasRelationshipGoal = /\b(girlfriend|gf|boyfriend|bf|partner|relationship|wife|husband|spouse|date|dates|family|friend|friends|quality time|spend time|together)\b/i.test(goalCorpus);
  const relationshipPlanning = hasRelationshipGoal && /\b(girlfriend|gf|boyfriend|bf|partner|relationship|date|dates|romantic|place|places|restaurant|restaurants|dinner|cafe|cafes|activity|activities|where|visit|go|together)\b/i.test(question);
  const locationBudgetPlanning = practicalPlanning && /\b(under|budget|total|\$|cheap|affordable|near|in|around)\b/i.test(question);
  const hardOffTopic = /\b(dog|cat|celebrity|politics|video game|gaming)\b/i.test(question) && !hits.length && !relationshipPlanning;
  const allowed = hits.length > 0 || ((hasGoals || practicalPlanning) && (generalCoaching || practicalPlanning || relationshipPlanning || locationBudgetPlanning) && !hardOffTopic);
  const relatedGoals = (context.goals || []).filter(g => {
    const text = words(`${g.title} ${g.desc} ${g.type}`).join(" ");
    const isRelationshipGoal = /\b(girlfriend|boyfriend|partner|relationship|wife|husband|spouse|family|friend|quality|time|together)\b/i.test(`${g.title} ${g.desc}`);
    return hits.some(h => text.includes(h)) || (relationshipPlanning && isRelationshipGoal) || (allowed && generalCoaching);
  }).slice(0, 4);
  const intent = relationshipPlanning ? "relationship_planning" : practicalPlanning ? "practical_planning" : generalCoaching ? "goal_coaching" : "goal_related";
  return { allowed, hits, relatedGoals, intent };
}

function compactContext(context) {
  const sortedEvents = [...(context.events || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  return {
    goals: (context.goals || []).slice(0, 60),
    goalTypes: context.goalTypes || [],
    events: sortedEvents.slice(-200),
    eventCount: (context.events || []).length,
    profile: context.profile || {},
    notificationSettings: context.notificationSettings || {},
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

function estimateCost(data) {
  const usage = data.usage || {};
  const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  const rates = MODEL_RATES_PER_MILLION[OPENAI_MODEL] || MODEL_RATES_PER_MILLION["gpt-4o-mini"];
  return Number((((inputTokens / 1000000) * rates.input) + ((outputTokens / 1000000) * rates.output)).toFixed(6));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (!process.env.OPENAI_API_KEY) return send(res, 500, { error: "OpenAI API key is not configured yet." });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const user = await verifyFirebaseToken(token);
    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { question, context = {}, history = [], accountTier, monthlySpend = 0 } = payload;
    if (!question || !String(question).trim()) return send(res, 400, { error: "Question is required." });
    if (containsBannedLanguage(question)) {
      return send(res, 200, {
        blocked: true,
        text: "I can help with your goals, planning, habits, and progress, but I cannot process profanity, slurs, or abusive language. Please rephrase your question respectfully."
      });
    }
    const tier = accountTierForUser(user, accountTier);
    const cap = monthlyCapForTier(tier);
    if (Number(monthlySpend) >= cap) {
      const msg = tier === "friends_family"
        ? "Friends & Family monthly AI usage is up for this month."
        : "Your Beta Pro account usage is up for this month. Reach out to the Goaltrack sales team after beta if you want increased usage.";
      return send(res, 429, { error: msg, tier });
    }

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
        content: [{ type: "input_text", text: `You are GoalTrack's personal agent. Your value is personalization: before answering, infer what is unique about this user from their full GoalTrack picture: all provided calendar events, goal types, individual goals, goal completion status, linked sessions, notes, skills practiced, habits, progress summaries, profile preferences, memory, notification settings, and recent chat. Use those signals to tailor the answer so it would not be identical for another user. Only answer inside the user's GoalTrack context, but interpret context like a thoughtful human: personal goals can include relationships, family, health, errands, school, work, finances, and practical life planning. If a user asks for places, restaurants, date ideas, local activities, groceries, schedules, or budgets and that supports one of their goals, answer directly instead of asking them to reconnect it. If the answer needs current, local, price, hours, or factual support, use web search and cite sources. For local recommendations, honor the location, budget, constraints, and relationship to the goal; give concrete options, estimated cost, why each fits, and clickable citations. Do not use profanity, slurs, harassment, racist language, or abusive language, even if the user asks for it or tries alternate spellings. If the user uses that language, ask them to rephrase respectfully. Be practical, specific, and concise. Always end with one thoughtful follow-up question that either deepens the user's original request or asks what else they need help with. Default model is ${OPENAI_MODEL}.` }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify({
          userId: user.user_id,
          question,
          relatedGoalFocus: related,
          interpretedIntent: scoped.intent,
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
      usage: data.usage || {},
      estimatedCostUsd: estimateCost(data),
      tier,
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
