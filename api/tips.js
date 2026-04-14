export const config = { runtime: "edge" };

// ═══════════════════════════════════════════════════════════════
//  PROFESSIONAL MULTI-AI BETTING TIPS ENGINE
//  Markets: Goals, Corners, Cards, Halftime, Asian Lines, BTTS
//  Leagues:  EVERY league worldwide
//  Analysis: Form, H2H, Injuries, Suspensions, Tactics, Venue
// ═══════════════════════════════════════════════════════════════

const ALLOWED_MARKETS = `
GOALS MARKETS:
- Over/Under 1.5 Goals
- Over/Under 2.5 Goals
- Over/Under 3.5 Goals
- Over/Under 4.5 Goals
- BTTS (Both Teams to Score) Yes
- BTTS (Both Teams to Score) No
- First Half Over 0.5 Goals
- First Half Over 1.5 Goals
- Second Half Over 0.5 Goals
- Second Half Over 1.5 Goals
- Asian Total Goals Over/Under 2 Goals
- Asian Total Goals Over/Under 3 Goals

CORNERS MARKETS:
- Over/Under 8.5 Corners
- Over/Under 9.5 Corners
- Over/Under 10.5 Corners
- Over/Under 11.5 Corners
- First Half Over 4.5 Corners
- Asian Corners Over/Under

CARDS MARKETS:
- Over/Under 3.5 Cards
- Over/Under 4.5 Cards
- Over/Under 5.5 Cards

OTHER MARKETS:
- Clean Sheet Yes (Home)
- Clean Sheet Yes (Away)
- Both Halves Over 0.5 Goals
- Draw at Halftime
- Over/Under 0.5 Goals First Half
`;

const FORBIDDEN_MARKETS = `
STRICTLY FORBIDDEN (never suggest these):
- Match Result / 1X2 (Home Win, Draw, Away Win)
- Double Chance (1X, X2, 12)
- Draw No Bet
- Correct Score
- Anytime Goalscorer
- First Goalscorer
- Last Goalscorer
- Handicap (team-based win handicap)
`;

const TIP_SCHEMA = `[
  {
    "match": "Exact Team A vs Exact Team B",
    "league": "Full League Name + Country",
    "time": "HH:MM GMT",
    "market": "Exact Market Name",
    "pick": "Exact Pick e.g. Over 2.5 Goals",
    "odds_range": "e.g. 1.75-1.95",
    "confidence": 85,
    "reasoning": "3-4 sentences: specific stats, form, H2H, injuries, tactics.",
    "key_stats": [
      "Home team last 5: W-W-D-W-L, avg 2.3 goals/game",
      "Away team: 4 of last 5 away games had Over 2.5",
      "H2H last 6: 4 games had 3+ goals",
      "Key absence: Home CF suspended"
    ],
    "risk": "LOW"
  }
]`;

// ── Parse tips from any AI response ────────────────────────────
function parseTips(text, aiName) {
  if (!text) return [];
  const m = text.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0])
      .filter(t => t.match && t.market && t.pick)
      .map(t => ({
        ...t,
        confidence: Math.min(Math.max(parseInt(t.confidence)||70,50),98),
        risk: t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
        id: Math.random().toString(36).substr(2,8),
        aiSource: aiName,
        generatedAt: Date.now(),
      }));
  } catch(e) { return []; }
}

// ── Merge tips from multiple AIs ────────────────────────────────
function mergeTips(allArrays) {
  const map = {};
  allArrays.forEach((tips, idx) => {
    const name = ["Claude","Gemini","Groq"][idx];
    tips.forEach(t => {
      const key = (t.match||"").toLowerCase().replace(/\s/g,"")
                + "|" + (t.pick||"").toLowerCase().replace(/\s/g,"");
      if (!map[key]) map[key] = { ...t, ais:[], votes:0, confs:[] };
      map[key].ais.push(name);
      map[key].votes++;
      map[key].confs.push(t.confidence);
      // Merge key_stats from multiple AIs
      if (t.key_stats) {
        map[key].key_stats = [...new Set([...(map[key].key_stats||[]), ...t.key_stats])].slice(0,6);
      }
      // Use longest reasoning
      if ((t.reasoning||"").length > (map[key].reasoning||"").length) {
        map[key].reasoning = t.reasoning;
      }
    });
  });

  return Object.values(map)
    .map(t => ({
      ...t,
      confidence: Math.min(98, Math.round(
        t.confs.reduce((a,b)=>a+b,0)/t.confs.length
        + (t.votes===2?4:0) + (t.votes===3?8:0)
      )),
      multiAI:   t.votes >= 2,
      confirmed: t.votes >= 3,
      aiCount:   t.votes,
    }))
    .sort((a,b) => {
      if(b.confirmed!==a.confirmed) return b.confirmed-a.confirmed;
      if(b.multiAI!==a.multiAI)     return b.multiAI-a.multiAI;
      return b.confidence-a.confidence;
    });
}

// ── Step 1: Get fixtures worldwide via Claude web search ────────
async function getFixtures(key, today) {
  const searches = [
    "football fixtures today " + today + " worldwide all leagues",
    "UEFA Champions League Europa League Conference League matches " + today,
    "African football matches today " + today + " AFCON CAF Champions League",
  ];
  const prompt =
    "Do these searches one by one:\n"
    + searches.map((s,i)=>(i+1)+". Search: \""+s+"\"").join("\n")
    + "\n\nFrom ALL search results, list every football match you find for today " + today + "."
    + " Include ALL leagues worldwide: European top leagues, lower divisions, African leagues, Asian leagues, South American, MLS, everything."
    + " Format each match as:\nTeam A vs Team B | League Name (Country) | HH:MM GMT"
    + "\nOnly include matches confirmed for today " + today + ". No other text.";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-api-key":key,
      "anthropic-version":"2023-06-01",
      "anthropic-beta":"web-search-2025-03-05",
    },
    body: JSON.stringify({
      model:"claude-haiku-4-5-20251001",
      max_tokens:1500,
      tools:[{ type:"web_search_20250305", name:"web_search", max_uses:3 }],
      messages:[{ role:"user", content:prompt }],
    }),
  });
  const d = await res.json();
  return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
}

// ── Step 2: Deep analysis prompt ────────────────────────────────
function buildPrompt(fixtures, today) {
  return "You are a professional football betting analyst with access to all statistics.\n"
  + "Today is " + today + ".\n\n"
  + "TODAY'S CONFIRMED MATCHES WORLDWIDE:\n" + fixtures + "\n\n"
  + "ANALYSIS REQUIREMENTS — for each tip you must research and mention:\n"
  + "1. Last 5 match results and goals for BOTH teams\n"
  + "2. Head-to-head last 5-6 meetings (goals, results)\n"
  + "3. Home/away specific records this season\n"
  + "4. Known injuries, suspensions, or missing key players\n"
  + "5. Tactical style (high press, defensive, counter-attack)\n"
  + "6. Match importance (cup final, relegation, title race, dead rubber)\n"
  + "7. Average corners/cards per game if suggesting those markets\n\n"
  + "ALLOWED MARKETS:\n" + ALLOWED_MARKETS + "\n\n"
  + FORBIDDEN_MARKETS + "\n\n"
  + "Generate 8-10 tips from matches in the list above. Cover a variety of markets (not just Over 2.5 Goals).\n"
  + "Include matches from DIFFERENT leagues — not just Champions League.\n"
  + "Sort by confidence descending. Risk: LOW=80+, MEDIUM=65-79, HIGH<65.\n\n"
  + "Return ONLY a valid JSON array:\n" + TIP_SCHEMA;
}

// ── Claude analysis ─────────────────────────────────────────────
async function askClaude(key, prompt) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01" },
      body: JSON.stringify({
        model:"claude-haiku-4-5-20251001", max_tokens:2000,
        messages:[{ role:"user", content:prompt }],
      }),
    });
    const d = await r.json();
    return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
  } catch(e) { return ""; }
}

// ── Gemini analysis (FREE) ──────────────────────────────────────
async function askGemini(key, prompt) {
  if (!key) return "";
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key="+key,
      { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{maxOutputTokens:2000,temperature:0.2} }) }
    );
    const d = await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text||"";
  } catch(e) { return ""; }
}

// ── Groq analysis (FREE) ────────────────────────────────────────
async function askGroq(key, prompt) {
  if (!key) return "";
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{ "Content-Type":"application/json","Authorization":"Bearer "+key },
      body: JSON.stringify({
        model:"llama-3.1-8b-instant",
        messages:[{ role:"user", content:prompt }],
        max_tokens:2000, temperature:0.2,
      }),
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content||"";
  } catch(e) { return ""; }
}

// ── MAIN HANDLER ────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== "POST") return new Response(JSON.stringify({error:"Method not allowed"}),
    {status:405,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY  || "";
  const groqKey   = process.env.GROQ_API_KEY    || "";

  if (!claudeKey) return new Response(JSON.stringify({error:"ANTHROPIC_API_KEY not set."}),
    {status:500,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});

  let today;
  try { const b = await req.json(); today = b.date||new Date().toISOString().split("T")[0]; }
  catch(e) { today = new Date().toISOString().split("T")[0]; }

  try {
    // Step 1: Get real worldwide fixtures
    const fixtures = await getFixtures(claudeKey, today);

    if (!fixtures || fixtures.trim().length < 15) {
      return new Response(JSON.stringify({
        tips:[], count:0, date:today,
        message:"No matches found for today "+today+". Try again shortly.",
        generatedAt:Date.now()
      }), {status:200,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    // Step 2: All 3 AIs analyse in parallel
    const prompt = buildPrompt(fixtures, today);
    const [cRaw, gRaw, qRaw] = await Promise.all([
      askClaude(claudeKey, prompt),
      askGemini(geminiKey, prompt),
      askGroq(groqKey, prompt),
    ]);

    const claudeTips = parseTips(cRaw, "Claude");
    const geminiTips = parseTips(gRaw, "Gemini");
    const groqTips   = parseTips(qRaw, "Groq");

    const activeAIs = [
      claudeTips.length>0?"Claude":null,
      geminiTips.length>0?"Gemini":null,
      groqTips.length>0?"Groq":null,
    ].filter(Boolean);

    const tips = mergeTips([claudeTips, geminiTips, groqTips]);

    if (tips.length === 0) return new Response(JSON.stringify({
      tips:[], count:0, date:today,
      message:"No valid tips generated. Try again.",
      generatedAt:Date.now()
    }), {status:200,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});

    return new Response(JSON.stringify({
      tips, count:tips.length, date:today,
      activeAIs, generatedAt:Date.now(),
      fixtureSource: fixtures.split("\n").slice(0,8).join(" | "),
    }), {status:200,headers:{
      "Content-Type":"application/json",
      "Access-Control-Allow-Origin":"*",
      "Cache-Control":"s-maxage=1800",
    }});

  } catch(err) {
    return new Response(JSON.stringify({error:err.message||"Server error"}),
      {status:500,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
  }
}
