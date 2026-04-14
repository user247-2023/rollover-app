export const config = { runtime: "edge" };

// ═══════════════════════════════════════════════════════════════
//  MULTI-AI FOOTBALL TIPS ENGINE
//  Step 1: Claude Haiku  → fetches today's real fixtures via web
//  Step 2: Gemini Flash  → analyses fixtures for goals tips
//  Step 3: Groq / Llama  → analyses same fixtures for goals tips
//  Step 4: Merge results → tips agreed by 2+ AIs get CONFIRMED badge
// ═══════════════════════════════════════════════════════════════

const GOALS_MARKETS = "Over/Under 1.5 Goals, Over/Under 2.5 Goals, Over/Under 3.5 Goals, BTTS Yes, BTTS No, First Half Over 0.5 Goals, First Half Over 1.5 Goals";
const FORBIDDEN     = "match winner, double chance, correct score, goalscorer, cards, corners";
const TIP_SCHEMA    = '[{"match":"A vs B","league":"League","time":"20:45 GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":82,"reasoning":"Reason.","key_stats":["s1","s2","s3"],"risk":"LOW"}]';

function buildAnalysisPrompt(matchList, today) {
  return "You are a football betting analyst. Today is " + today + ".\n\n"
    + "Analyse ONLY these real matches playing today:\n" + matchList + "\n\n"
    + "Give goals-only tips. Allowed markets: " + GOALS_MARKETS + "\n"
    + "Forbidden: " + FORBIDDEN + "\n"
    + "Use statistics: avg goals/game, H2H history, home/away records, missing players.\n"
    + "Return ONLY a JSON array, zero other text:\n" + TIP_SCHEMA;
}

function parseTips(text) {
  if (!text) return [];
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0])
      .filter(t => t.match && t.market && t.pick)
      .map(t => ({
        ...t,
        confidence: Math.min(Math.max(parseInt(t.confidence)||70,50),98),
        risk: t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
        id: Math.random().toString(36).substr(2,8),
        generatedAt: Date.now(),
      }));
  } catch(e) { return []; }
}

// ── Get today's fixtures via Claude web search ──────────────────
async function getFixtures(apiKey, today) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-api-key":apiKey,
      "anthropic-version":"2023-06-01",
      "anthropic-beta":"web-search-2025-03-05",
    },
    body: JSON.stringify({
      model:"claude-haiku-4-5-20251001",
      max_tokens:800,
      tools:[{ type:"web_search_20250305", name:"web_search", max_uses:2 }],
      messages:[{
        role:"user",
        content:"Search for 'football fixtures " + today + " Champions League Europa League Premier League La Liga Serie A Bundesliga'. List ONLY confirmed matches for today " + today + " as: 'Team A vs Team B | League | HH:MM GMT'. One per line. No other text."
      }],
    }),
  });
  const d = await res.json();
  return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
}

// ── Claude Haiku analysis ───────────────────────────────────────
async function askClaude(apiKey, prompt) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key":apiKey,
        "anthropic-version":"2023-06-01",
      },
      body: JSON.stringify({
        model:"claude-haiku-4-5-20251001",
        max_tokens:1200,
        messages:[{ role:"user", content:prompt }],
      }),
    });
    const d = await res.json();
    return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  } catch(e) { return ""; }
}

// ── Gemini Flash analysis (FREE) ────────────────────────────────
async function askGemini(geminiKey, prompt) {
  if (!geminiKey) return "";
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + geminiKey,
      {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          contents:[{ parts:[{ text: prompt }] }],
          generationConfig:{ maxOutputTokens:1200, temperature:0.3 },
        }),
      }
    );
    const d = await res.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch(e) { return ""; }
}

// ── Groq / Llama analysis (FREE) ────────────────────────────────
async function askGroq(groqKey, prompt) {
  if (!groqKey) return "";
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":"Bearer " + groqKey,
      },
      body: JSON.stringify({
        model:"llama-3.1-8b-instant",
        messages:[{ role:"user", content:prompt }],
        max_tokens:1200,
        temperature:0.3,
      }),
    });
    const d = await res.json();
    return d.choices?.[0]?.message?.content || "";
  } catch(e) { return ""; }
}

// ── Merge tips from multiple AIs ────────────────────────────────
function mergeTips(allTipArrays) {
  const merged = {};

  allTipArrays.forEach((tips, aiIndex) => {
    const aiName = ["Claude","Gemini","Groq"][aiIndex];
    tips.forEach(tip => {
      // Normalise match name for comparison
      const key = tip.match.toLowerCase().replace(/\s/g,"") + "|" + tip.pick.toLowerCase().replace(/\s/g,"");
      if (!merged[key]) {
        merged[key] = { ...tip, ais:[], votes:0, confidences:[] };
      }
      merged[key].ais.push(aiName);
      merged[key].votes += 1;
      merged[key].confidences.push(tip.confidence);
    });
  });

  return Object.values(merged)
    .map(t => ({
      ...t,
      // Average confidence across AIs, boosted if multi-AI confirmed
      confidence: Math.min(98, Math.round(
        t.confidences.reduce((a,b)=>a+b,0) / t.confidences.length
        + (t.votes >= 2 ? 5 : 0)   // +5 if 2 AIs agree
        + (t.votes >= 3 ? 5 : 0)   // +5 more if all 3 agree
      )),
      multiAI: t.votes >= 2,
      confirmed: t.votes >= 3,
      aiCount: t.votes,
    }))
    .sort((a,b) => {
      // Sort: confirmed first, then multiAI, then by confidence
      if(b.confirmed !== a.confirmed) return b.confirmed - a.confirmed;
      if(b.multiAI   !== a.multiAI)   return b.multiAI   - a.multiAI;
      return b.confidence - a.confidence;
    });
}

// ── MAIN HANDLER ────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error:"Method not allowed" }),
      { status:405, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} });
  }

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY  || "";
  const groqKey   = process.env.GROQ_API_KEY    || "";

  if (!claudeKey) {
    return new Response(JSON.stringify({ error:"ANTHROPIC_API_KEY not set in Vercel." }),
      { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} });
  }

  const today = new Date().toISOString().split("T")[0];

  try {
    // Step 1: Get today's real fixtures
    const fixtureText = await getFixtures(claudeKey, today);

    if (!fixtureText || fixtureText.trim().length < 10) {
      return new Response(
        JSON.stringify({ tips:[], count:0, date:today, message:"No matches found for today "+today+".", generatedAt:Date.now() }),
        { status:200, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    // Step 2: All 3 AIs analyse the same fixtures simultaneously
    const analysisPrompt = buildAnalysisPrompt(fixtureText, today);

    const [claudeRaw, geminiRaw, groqRaw] = await Promise.all([
      askClaude(claudeKey, analysisPrompt),
      askGemini(geminiKey, analysisPrompt),
      askGroq(groqKey, analysisPrompt),
    ]);

    // Step 3: Parse each AI's tips
    const claudeTips = parseTips(claudeRaw);
    const geminiTips = parseTips(geminiRaw);
    const groqTips   = parseTips(groqRaw);

    const activeAIs = [
      claudeTips.length > 0 ? "Claude" : null,
      geminiTips.length > 0 ? "Gemini" : null,
      groqTips.length   > 0 ? "Groq"   : null,
    ].filter(Boolean);

    // Step 4: Merge and rank
    const tips = mergeTips([claudeTips, geminiTips, groqTips]);

    if (tips.length === 0) {
      return new Response(
        JSON.stringify({ tips:[], count:0, date:today, message:"AIs found no valid goals tips for today. Try again.", generatedAt:Date.now() }),
        { status:200, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    return new Response(
      JSON.stringify({
        tips, count:tips.length, date:today,
        activeAIs, fixtureSource:fixtureText.split("\n").slice(0,5).join(" | "),
        generatedAt:Date.now(),
      }),
      { status:200, headers:{
        "Content-Type":"application/json",
        "Access-Control-Allow-Origin":"*",
        "Cache-Control":"s-maxage=1800",
      }}
    );

  } catch(err) {
    return new Response(
      JSON.stringify({ error:err.message||"Server error" }),
      { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
    );
  }
}
