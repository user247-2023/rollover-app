// Standard Node.js serverless function — no edge runtime
const H = { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" };

// ── API-Football (works, covers 1000+ leagues) ──────────────────
async function fetchFixtures(dateStr, apiKey) {
  if(!apiKey) return [];
  try {
    const r = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${dateStr}`,
      { headers:{ "x-apisports-key":apiKey, "Accept":"application/json" } }
    );
    if(!r.ok) return [];
    const d = await r.json();
    return (d.response||[])
      .filter(f => {
        const status = f.fixture?.status?.short;
        return ["NS","TBD","PST"].includes(status); // not started only
      })
      .map(f => ({
        home:   f.teams?.home?.name||"",
        away:   f.teams?.away?.name||"",
        league: `${f.league?.name||""} (${f.league?.country||""})`,
        time:   f.fixture?.date
          ? new Date(f.fixture.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT"
          : "TBD",
      }))
      .filter(f => f.home && f.away);
  } catch(e) { return []; }
}

// ── Normalise team name ─────────────────────────────────────────
const norm = s => (s||"").toLowerCase()
  .replace(/\bfc\b|\bsc\b|\bac\b|\bafc\b|\bcf\b|\bfk\b|\bsk\b|\bif\b|\bbk\b/g,"")
  .replace(/[^a-z0-9]/g,"");

// ── Validate tip is a real fixture ──────────────────────────────
function isReal(tipMatch, fixtures) {
  const parts = (tipMatch||"").split(/\s+vs\s+/i);
  if(parts.length < 2) return false;
  const [th,ta] = parts.map(s => norm(s));
  if(th.length < 3 || ta.length < 3) return false;
  return fixtures.some(f => {
    const fh=norm(f.home), fa=norm(f.away);
    const hOk = fh.length>=3 && (fh.includes(th.slice(0,5)) || th.includes(fh.slice(0,5)));
    const aOk = fa.length>=3 && (fa.includes(ta.slice(0,5)) || ta.includes(fa.slice(0,5)));
    return hOk && aOk;
  });
}

// ── Build analysis prompt ───────────────────────────────────────
function buildPrompt(fixtures, date) {
  const list = fixtures.slice(0,25).map((f,i) =>
    `${i+1}. ${f.home} vs ${f.away} | ${f.league} | ${f.time}`
  ).join("\n");

  return `Professional football betting analyst. Date: ${date}.

REAL MATCHES FROM API-FOOTBALL — analyse ONLY these:
${list}

For each tip analyse ALL of:
1. Current form last 5-10 matches (results, goals, streak)
2. Home vs away record separately this season
3. Key injuries and suspensions (missing strikers, defenders)
4. Motivation: title race, relegation, European spot, dead rubber, cup knockout
5. Head-to-head last 5-6 meetings (results and goals)
6. Tactical matchup (pressing, counter-attack, possession styles)
7. Expected Goals xG for and against this season
8. Stats: shots/game, clean sheets, corners/game, cards/game
9. Schedule congestion, travel fatigue, weather if relevant

Markets allowed:
Over/Under 1.5/2.5/3.5/4.5 Goals | BTTS Yes/No | 1st Half Over 0.5/1.5 Goals |
2nd Half Over 0.5/1.5 Goals | Over/Under 8.5/9.5/10.5/11.5 Corners |
Over/Under 3.5/4.5/5.5 Cards | Both Halves Over 0.5 Goals | Clean Sheet Yes

FORBIDDEN: Match winner, double chance, correct score, goalscorer, handicap.

Pick 7-8 tips across DIFFERENT leagues and DIFFERENT markets (not just Over 2.5).
Include lower leagues — Championship, Belgian, Saudi, Turkish, German etc.
reasoning: 3-4 sentences with specific stats.
key_stats: 4-5 items including xG, form, H2H, injuries.
confidence: 65-92 only. risk: LOW=80+, MEDIUM=65-79, HIGH<65.

Return ONLY JSON array, nothing before [ or after ]:
[{"match":"Home vs Away","league":"League (Country)","time":"HH:MM GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":84,"reasoning":"Home avg 2.6g/game (xG 2.1). Away striker suspended. H2H 4/5 had 3+ goals. Both teams press high.","key_stats":["Home xG 2.1/game","Away top scorer out","H2H: 4/5 had 3+ goals","Away 2.3g conceded away","Both teams top-6 attack"],"risk":"LOW"}]`;
}

// ── AI callers ──────────────────────────────────────────────────
async function callClaude(key, p) {
  if(!key) return "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:2500, messages:[{role:"user",content:p}] }),
    });
    const d = await r.json();
    return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
  } catch(e) { return ""; }
}

async function callGemini(key, p) {
  if(!key) return "";
  try {
    // Use gemini-2.0-flash (current working model)
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      { method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ contents:[{parts:[{text:p}]}], generationConfig:{maxOutputTokens:2500,temperature:0.1} }) }
    );
    const d = await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch(e) { return ""; }
}

async function callGroq(key, p) {
  if(!key) return "";
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},
      body:JSON.stringify({
        model:"llama-3.3-70b-versatile",
        messages:[
          {role:"system",content:"Football analyst. Respond ONLY with a JSON array starting [ ending ]. No markdown."},
          {role:"user",content:p}
        ],
        max_tokens:2500, temperature:0.1,
      }),
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content || "";
  } catch(e) { return ""; }
}

// ── Parse + validate ────────────────────────────────────────────
function parse(text, name, fixtures) {
  if(!text) return [];
  let arr = [];
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if(m) arr = JSON.parse(m[0]);
    else { const o=JSON.parse(text.trim()); arr=Array.isArray(o)?o:Object.values(o).find(Array.isArray)||[]; }
  } catch(e) { return []; }
  return arr
    .filter(t => t && t.match && t.pick && isReal(t.match, fixtures))
    .map(t => ({
      ...t,
      id: Math.random().toString(36).substr(2,8),
      confidence: Math.min(Math.max(parseInt(t.confidence)||72,50),98),
      risk: t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
      ais:[name], votes:1, confs:[parseInt(t.confidence)||72],
      generatedAt: Date.now(),
    }));
}

// ── Merge tips from multiple AIs ────────────────────────────────
function merge(arrays) {
  const map = {};
  arrays.forEach((tips,i) => {
    const name = ["Claude","Gemini","Groq"][i];
    tips.forEach(t => {
      const k = norm(t.match)+norm(t.pick);
      if(!map[k]) map[k] = {...t,ais:[],votes:0,confs:[]};
      if(!map[k].ais.includes(name)) map[k].ais.push(name);
      map[k].votes++; map[k].confs.push(parseInt(t.confidence)||72);
      if((t.reasoning||"").length>(map[k].reasoning||"").length) map[k].reasoning=t.reasoning;
      if(t.key_stats) map[k].key_stats=[...new Set([...(map[k].key_stats||[]),...(t.key_stats||[])])].slice(0,5);
    });
  });
  return Object.values(map)
    .map(t => ({...t,
      confidence: Math.min(98,Math.round(t.confs.reduce((a,b)=>a+b,0)/t.confs.length+(t.votes===2?5:t.votes>=3?10:0))),
      multiAI:t.votes>=2, confirmed:t.votes>=3, aiCount:t.votes,
    }))
    .sort((a,b)=>b.confirmed-a.confirmed||b.multiAI-a.multiAI||b.confidence-a.confidence);
}

// ── MAIN HANDLER ────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Content-Type","application/json");

  if(req.method==="OPTIONS") return res.status(200).json({ok:true});
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY   || "";
  const groqKey   = process.env.GROQ_API_KEY     || "";
  const afKey     = process.env.API_FOOTBALL_KEY || "";

  if(!claudeKey) return res.status(500).json({error:"ANTHROPIC_API_KEY not set in Vercel."});
  if(!afKey)     return res.status(500).json({error:"API_FOOTBALL_KEY not set. Sign up free at dashboard.api-football.com and add key to Vercel."});

  let today = new Date().toISOString().split("T")[0];
  try { const b=await req.json(); if(b?.date) today=b.date; } catch(e) {}

  try {
    // Step 1: Get real fixtures from API-Football
    const fixtures = await fetchFixtures(today, afKey);

    if(fixtures.length===0) return res.status(200).json({
      tips:[], count:0, date:today, fixturesFound:0,
      message:`No scheduled matches found for ${today}. Try again later or check tomorrow.`,
      generatedAt:Date.now(),
    });

    // Step 2: All 3 AIs analyse in parallel
    const prompt = buildPrompt(fixtures, today);
    const [cRaw,gRaw,qRaw] = await Promise.all([
      callClaude(claudeKey, prompt),
      callGemini(geminiKey, prompt),
      callGroq(groqKey,   prompt),
    ]);

    // Step 3: Parse, validate, merge
    const cT = parse(cRaw,"Claude",fixtures);
    const gT = parse(gRaw,"Gemini",fixtures);
    const qT = parse(qRaw,"Groq",  fixtures);
    const tips = merge([cT,gT,qT]);
    const activeAIs = [cT.length?"Claude":null,gT.length?"Gemini":null,qT.length?"Groq":null].filter(Boolean);

    if(tips.length===0) return res.status(200).json({
      tips:[], count:0, date:today, fixturesFound:fixtures.length, activeAIs,
      message:`Found ${fixtures.length} matches but tips failed validation. Try again.`,
      generatedAt:Date.now(),
    });

    return res.status(200).json({
      tips, count:tips.length, date:today,
      fixturesFound:fixtures.length, activeAIs,
      generatedAt:Date.now(),
    });

  } catch(err) {
    return res.status(500).json({error:err.message||"Server error"});
  }
}
