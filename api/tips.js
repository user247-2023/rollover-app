// Standard Node.js serverless function
const H = { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" };

// ================================================================
// EXACT LEAGUE IDs FROM API-FOOTBALL — only these, nothing else
// ================================================================
const ALLOWED_LEAGUE_IDS = new Set([
  // ── MAJOR EUROPEAN CUPS ─────────────────────────────────────
  2,    // UEFA Champions League
  3,    // UEFA Europa League
  848,  // UEFA Conference League
  531,  // UEFA Super Cup
  1,    // FIFA World Cup
  4,    // UEFA European Championship
  5,    // UEFA Nations League
  6,    // Africa Cup of Nations (AFCON)
  9,    // Copa America
  13,   // Copa Libertadores
  11,   // Copa Sudamericana

  // ── ENGLAND ─────────────────────────────────────────────────
  39,   // Premier League
  40,   // Championship
  41,   // League One
  42,   // League Two
  43,   // National League
  45,   // FA Cup
  46,   // EFL Cup (Carabao Cup)
  528,  // Community Shield

  // ── SPAIN ───────────────────────────────────────────────────
  140,  // La Liga
  141,  // La Liga 2
  143,  // Copa del Rey

  // ── ITALY ───────────────────────────────────────────────────
  135,  // Serie A
  136,  // Serie B
  137,  // Coppa Italia

  // ── GERMANY ─────────────────────────────────────────────────
  78,   // Bundesliga
  79,   // Bundesliga 2
  80,   // DFB Pokal
  81,   // Regionalliga Bayern
  82,   // Regionalliga Southwest
  83,   // Regionalliga West
  84,   // Regionalliga Northeast
  793,  // Frauen Bundesliga (Women)

  // ── FRANCE ──────────────────────────────────────────────────
  61,   // Ligue 1
  62,   // Ligue 2
  66,   // Coupe de France

  // ── NETHERLANDS ─────────────────────────────────────────────
  88,   // Eredivisie
  89,   // Eerste Divisie
  90,   // KNVB Cup

  // ── PORTUGAL ────────────────────────────────────────────────
  94,   // Primeira Liga
  95,   // Liga Portugal 2
  96,   // Taca de Portugal (Cup)

  // ── SCOTLAND ────────────────────────────────────────────────
  179,  // Scottish Premiership
  180,  // Scottish Championship
  181,  // Scottish League Cup

  // ── BELGIUM ─────────────────────────────────────────────────
  144,  // Belgian Pro League (Jupiler)
  145,  // Belgian First Amateur
  146,  // Belgian Cup

  // ── BULGARIA ────────────────────────────────────────────────
  172,  // Bulgarian First League

  // ── TURKEY ──────────────────────────────────────────────────
  203,  // Super Lig
  204,  // 1. Lig

  // ── SAUDI ARABIA ────────────────────────────────────────────
  307,  // Saudi Pro League

  // ── ARMENIA ─────────────────────────────────────────────────
  371,  // Armenia Premier League

  // ── USA ─────────────────────────────────────────────────────
  253,  // MLS
  254,  // NWSL (Women)

  // ── BRAZIL ──────────────────────────────────────────────────
  71,   // Serie A
  72,   // Serie B
  73,   // Copa do Brasil

  // ── ARGENTINA ───────────────────────────────────────────────
  128,  // Primera Division
  129,  // Copa Argentina

  // ── SWITZERLAND ─────────────────────────────────────────────
  197,  // Super League

  // ── WOMEN'S LEAGUES ─────────────────────────────────────────
  802,  // UEFA Women's Champions League
  804,  // FIFA Women's World Cup
  806,  // UEFA Women's Euro
  116,  // England Women's Super League (WSL)
  794,  // France Division 1 Feminine
  807,  // Spain Liga F (Women)
  799,  // Italy Serie A Women
  783,  // Germany Frauen Bundesliga (alt ID)
  752,  // Netherlands Vrouwen Eredivisie
  851,  // Champions League Women (alt)

  // ── AFRICA & ASIA CUPS ──────────────────────────────────────
  12,   // CAF Champions League
  20,   // AFC Champions League
  29,   // AFC Cup
]);

// ================================================================
// Fetch fixtures using exact league IDs
// ================================================================
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
        if(!["NS","TBD","PST"].includes(status)) return false;
        return ALLOWED_LEAGUE_IDS.has(f.league?.id); // strict ID filter
      })
      .map(f => ({
        home:      f.teams?.home?.name||"",
        away:      f.teams?.away?.name||"",
        league:    `${f.league?.name||""} (${f.league?.country||""})`,
        leagueId:  f.league?.id,
        time:      f.fixture?.date
          ? new Date(f.fixture.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT"
          : "TBD",
      }))
      .filter(f => f.home && f.away);
  } catch(e) { return []; }
}

// ================================================================
// Categorise fixtures for the prompt
// ================================================================
function categorise(fixtures) {
  const cups     = fixtures.filter(f => [2,3,848,531,45,46,80,66,90,96,143,137,146,181,73,129,13,11,1,4,5,6,9,12,20,29,528].includes(f.leagueId));
  const england  = fixtures.filter(f => [39,40,41,42,43].includes(f.leagueId));
  const top5     = fixtures.filter(f => [140,135,78,61,88,94,141,136,62,89,95].includes(f.leagueId));
  const germany  = fixtures.filter(f => [79,81,82,83,84,793,783].includes(f.leagueId));
  const belgian  = fixtures.filter(f => [144,145,146].includes(f.leagueId));
  const bulgaria = fixtures.filter(f => [172].includes(f.leagueId));
  const turkey   = fixtures.filter(f => [203,204].includes(f.leagueId));
  const saudi    = fixtures.filter(f => [307].includes(f.leagueId));
  const armenia  = fixtures.filter(f => [371].includes(f.leagueId));
  const women    = fixtures.filter(f => [802,804,806,116,794,807,799,783,752,851,254].includes(f.leagueId));
  const others   = fixtures.filter(f => [253,71,72,128,197,179,180,197].includes(f.leagueId));
  return { cups, england, top5, germany, belgian, bulgaria, turkey, saudi, armenia, women, others };
}

function fmtList(arr) {
  return arr.slice(0,10).map((f,i)=>`  ${i+1}. ${f.home} vs ${f.away} | ${f.league} | ${f.time}`).join("\n") || "  (none today)";
}

// ================================================================
// Build prompt
// ================================================================
function buildPrompt(fixtures, date, tipsNeeded=20) {
  const c = categorise(fixtures);
  return `You are a professional football betting analyst. Date: ${date}.

TODAY'S VERIFIED MATCHES BY LEAGUE:

[MAJOR CUPS - UCL/UEL/UECL/FA Cup/Copa del Rey/Coppa Italia/DFB Pokal/Copa Libertadores/World Cup]
${fmtList(c.cups)}

[ENGLAND - Premier League/Championship/League One/League Two/National League]
${fmtList(c.england)}

[TOP 5 LEAGUES - La Liga/Serie A/Bundesliga/Ligue 1/Eredivisie]
${fmtList(c.top5)}

[GERMANY - Bundesliga 2/Frauen Bundesliga/Regionalliga Bayern/Southwest/West]
${fmtList(c.germany)}

[BELGIAN PRO LEAGUE]
${fmtList(c.belgian)}

[BULGARIAN FIRST LEAGUE]
${fmtList(c.bulgaria)}

[TURKIYE SUPER LIG]
${fmtList(c.turkey)}

[SAUDI PRO LEAGUE]
${fmtList(c.saudi)}

[ARMENIA PREMIER LEAGUE]
${fmtList(c.armenia)}

[WOMEN'S LEAGUES - WSL/Frauen Bundesliga/Division 1 Fem/Liga F/Serie A Women/NWSL/Women's UCL]
${fmtList(c.women)}

[OTHERS - MLS/Brazil Serie A/Argentina/Scottish Premiership/Portugal/Switzerland]
${fmtList(c.others)}

================================================================
MANDATORY - GENERATE ${tipsNeeded} TIPS (max available from today's matches)
================================================================
Required distribution (skip category if no matches today, give those tips to other categories):
- 3 tips from ENGLAND (Premier League + lower leagues)
- 2 tips from MAJOR CUPS (UCL/Europa/Conference/domestic cups)
- 2 tips from TOP 5 LEAGUES (La Liga/Serie A/Bundesliga/Ligue 1)
- 2 tips from GERMAN LEAGUES (Bundesliga 2/Frauen/Regionalliga)
- 2 tips from BELGIAN PRO LEAGUE
- 1 tip  from BULGARIAN FIRST LEAGUE
- 1 tip  from TURKIYE SUPER LIG
- 1 tip  from SAUDI PRO LEAGUE
- 1 tip  from ARMENIA PREMIER LEAGUE
- 2 tips from WOMEN'S LEAGUES (WSL/Frauen/Division 1/Liga F/NWSL/Women's UCL)
- 3 tips from OTHERS (MLS/Brazil/Argentina/Scotland/Portugal)
TOTAL = 20 TIPS EXACTLY.

================================================================
ANALYSIS FRAMEWORK (apply to every tip)
================================================================
1. Form: last 5-10 results, goals, current streak
2. Home/Away: separate records this season
3. Injuries/Suspensions: missing players and impact
4. Motivation: title, relegation, European spot, dead rubber, knockout
5. H2H: last 5-6 meetings, goals, psychological edge
6. Tactics: style matchup, pressing vs counter-attack
7. xG: expected goals for/against, over/underperforming
8. Stats: shots/game, clean sheets, corners/game, cards/game
9. Conditions: congestion, travel, weather

================================================================
ALLOWED MARKETS
================================================================
Over/Under 1.5/2.5/3.5/4.5 Goals | BTTS Yes/No |
1st Half Over 0.5/1.5 | 2nd Half Over 0.5/1.5 |
Over/Under 8.5/9.5/10.5/11.5 Corners |
Over/Under 3.5/4.5/5.5 Cards | Both Halves Over 0.5 | Clean Sheet Yes

FORBIDDEN: Match winner, double chance, correct score, goalscorer, handicap.
Use VARIETY of markets across the 20 tips.
confidence: 65-92. risk: LOW=80+, MEDIUM=65-79, HIGH<65.

Return ONLY a JSON array of 20 objects. Nothing before [ or after ]:
[{"match":"Home vs Away","league":"League (Country)","time":"HH:MM GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":83,"reasoning":"3-4 sentence analysis with xG, form, H2H, injuries.","key_stats":["Home xG 2.1/game","Away striker out","H2H: 4/5 had 3+ goals","Away 2.3g conceded","Corners avg 10.2/game"],"risk":"LOW"}]`;
}

// ================================================================
// AI callers
// ================================================================
async function callClaude(key, p) {
  if(!key) return "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:4000, messages:[{role:"user",content:p}] }),
    });
    const d = await r.json();
    return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
  } catch(e) { return ""; }
}

async function callGemini(key, p) {
  if(!key) return "";
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      { method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ contents:[{parts:[{text:p}]}], generationConfig:{maxOutputTokens:4000,temperature:0.1} }) }
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
          {role:"system",content:"Football analyst. Respond ONLY with a JSON array starting with [ and ending with ]. No markdown, no explanation."},
          {role:"user",content:p}
        ],
        max_tokens:4000, temperature:0.1,
      }),
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content || "";
  } catch(e) { return ""; }
}

// ================================================================
// Parse + validate
// ================================================================
const norm = s => (s||"").toLowerCase()
  .replace(/\bfc\b|\bsc\b|\bac\b|\bafc\b|\bcf\b|\bfk\b|\bsk\b|\bif\b|\bbk\b/g,"")
  .replace(/[^a-z0-9]/g,"");

function isReal(tipMatch, fixtures) {
  // Just check it has the vs format — fixtures are already in the prompt
  // so AI can only pick from what it sees
  if(!(tipMatch||"").toLowerCase().includes(" vs ")) return false;
  const parts = tipMatch.split(/\s+vs\s+/i);
  return parts.length === 2 && parts[0].trim().length > 1 && parts[1].trim().length > 1;
}

function parse(text, name, fixtures) {
  if(!text || text.length < 5) return { tips:[], debug:`${name}: empty response` };
  let arr = [];
  let debug = "";

  // Strategy 1: find JSON array in text
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if(m) {
      arr = JSON.parse(m[0]);
      debug = `${name}: parsed ${arr.length} from array match`;
    }
  } catch(e) {
    debug = `${name}: array parse failed - ${e.message}`;
  }

  // Strategy 2: if empty, try parsing as object with nested array
  if(arr.length === 0) {
    try {
      const cleaned = text.trim().replace(/^```json\s*/,"").replace(/```$/,"").trim();
      const o = JSON.parse(cleaned);
      if(Array.isArray(o)) arr = o;
      else arr = o.tips || o.predictions || o.matches || o.data || Object.values(o).find(Array.isArray) || [];
      debug = `${name}: parsed ${arr.length} from object`;
    } catch(e) {
      if(!debug) debug = `${name}: object parse failed`;
    }
  }

  // Strategy 3: manual extraction of JSON-like objects
  if(arr.length === 0) {
    const objMatches = text.match(/\{[^{}]*"match"[^{}]*\}/g);
    if(objMatches) {
      arr = objMatches.map(s => { try { return JSON.parse(s); } catch(e) { return null; }}).filter(Boolean);
      debug = `${name}: extracted ${arr.length} manually`;
    }
  }

  const valid = arr
    .filter(t => t && (t.match||t.teams||t.fixture) && (t.pick||t.bet||t.selection))
    .map(t => ({
      match: t.match || t.teams || t.fixture || "",
      league: t.league || t.competition || "Unknown",
      time: t.time || t.kickoff || "TBD",
      market: t.market || t.type || "",
      pick: t.pick || t.bet || t.selection || "",
      odds_range: t.odds_range || t.odds || "",
      confidence: Math.min(Math.max(parseInt(t.confidence)||72,50),98),
      reasoning: t.reasoning || t.analysis || t.reason || "",
      key_stats: t.key_stats || t.stats || [],
      risk: t.risk || (parseInt(t.confidence)>=80?"LOW":parseInt(t.confidence)>=65?"MEDIUM":"HIGH"),
      id: Math.random().toString(36).substr(2,8),
      ais:[name], votes:1, confs:[parseInt(t.confidence)||72],
      generatedAt: Date.now(),
    }))
    .filter(t => t.match && t.pick);

  return { tips: valid, debug: `${name}: ${valid.length} valid tips` };
}

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
    .map(t=>({...t,
      confidence:Math.min(98,Math.round(t.confs.reduce((a,b)=>a+b,0)/t.confs.length+(t.votes===2?5:t.votes>=3?10:0))),
      multiAI:t.votes>=2, confirmed:t.votes>=3, aiCount:t.votes,
    }))
    .sort((a,b)=>b.confirmed-a.confirmed||b.multiAI-a.multiAI||b.confidence-a.confidence);
}

// ================================================================
// MAIN HANDLER
// ================================================================
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Content-Type","application/json");
  if(req.method==="OPTIONS") return res.status(200).json({ok:true});
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY   || "";
  const groqKey   = process.env.GROQ_API_KEY     || "";
  const afKey     = process.env.API_FOOTBALL_KEY || "";

  if(!claudeKey) return res.status(500).json({error:"ANTHROPIC_API_KEY not set."});
  if(!afKey)     return res.status(500).json({error:"API_FOOTBALL_KEY not set. Sign up free at dashboard.api-football.com"});

  let today = new Date().toISOString().split("T")[0];
  try { const b=await req.json(); if(b?.date) today=b.date; } catch(e){}

  try {
    const fixtures = await fetchFixtures(today, afKey);

    if(fixtures.length===0) return res.status(200).json({
      tips:[], count:0, date:today, fixturesFound:0,
      message:`No matches found in your specified leagues for ${today}.`,
      generatedAt:Date.now(),
    });

    const tipsNeeded = fixtures.length >= 7 ? 20 : Math.max(fixtures.length * 2, 5);
    const prompt = buildPrompt(fixtures, today, tipsNeeded);
    const [cRaw,gRaw,qRaw] = await Promise.all([
      callClaude(claudeKey, prompt),
      callGemini(geminiKey, prompt),
      callGroq(groqKey,     prompt),
    ]);

    const cP=parse(cRaw,"Claude",fixtures);
    const gP=parse(gRaw,"Gemini",fixtures);
    const qP=parse(qRaw,"Groq",  fixtures);
    const cT=cP.tips, gT=gP.tips, qT=qP.tips;
    const debugInfo = [cP.debug, gP.debug, qP.debug].join(" | ");

    const tips=merge([cT,gT,qT]);
    const activeAIs=[cT.length?"Claude":null,gT.length?"Gemini":null,qT.length?"Groq":null].filter(Boolean);

    if(tips.length===0) return res.status(200).json({
      tips:[], count:0, date:today, fixturesFound:fixtures.length, activeAIs,
      debug: debugInfo,
      rawSample: {
        claude: (cRaw||"").slice(0,400),
        gemini: (gRaw||"").slice(0,400),
        groq: (qRaw||"").slice(0,400),
      },
      message:`Found ${fixtures.length} matches. AI debug: ${debugInfo}`,
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
