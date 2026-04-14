export const config = { runtime: "edge" };

const H = { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" };

// ── Fetch today's fixtures from ESPN (free, no API key) ─────────
async function fetchFixtures(today) {
  // Format date as YYYYMMDD for ESPN API
  const espnDate = today.replace(/-/g, "");

  const leagues = [
    "uefa.champions_league","uefa.europa","uefa.europa_conf",
    "eng.1","esp.1","ita.1","ger.1","fra.1",
    "usa.1","ned.1","por.1","eng.2","sco.1",
    "mex.1","bra.1","arg.1","tur.1","rus.1",
    "jpn.1","chn.1","sau.1","egy.1","zaf.1",
  ];

  const results = await Promise.allSettled(
    leagues.map(async (lg) => {
      // Pass dates param — ESPN returns ONLY matches on that exact date
      const r = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${espnDate}`,
        { signal: AbortSignal.timeout(4000) }
      );
      const d = await r.json();
      return (d.events || []).map(e => {
        const c    = e.competitions?.[0];
        const home = c?.competitors?.find(x=>x.homeAway==="home")?.team?.displayName || "";
        const away = c?.competitors?.find(x=>x.homeAway==="away")?.team?.displayName || "";
        const time = e.date
          ? new Date(e.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT"
          : "TBD";
        const done = c?.status?.type?.completed;
        return home && away && !done
          ? `${home} vs ${away} | ${e.name?.split(" - ")?.[0] || lg} | ${time}`
          : null;
      }).filter(Boolean);
    })
  );

  const matches = results.flatMap(r => r.status==="fulfilled" ? r.value : []);
  return [...new Set(matches)]; // deduplicate
}

// ── Build analysis prompt ───────────────────────────────────────
function buildPrompt(matches, today) {
  const list = matches.length > 0
    ? matches.slice(0,20).map((m,i)=>`${i+1}. ${m}`).join("\n")
    : `Find football matches for ${today} from any league worldwide.`;

  return `You are a professional football betting analyst. Today: ${today}.

MATCHES TO ANALYSE:
${list}

For each match use your knowledge of: current form, H2H goals history, home/away records, injuries, suspensions, tactical style.

Pick the 6 best tips. Allowed markets ONLY:
Over/Under 1.5 Goals, Over/Under 2.5 Goals, Over/Under 3.5 Goals, BTTS Yes, BTTS No, First Half Over 0.5 Goals, First Half Over 1.5 Goals, Over/Under 8.5 Corners, Over/Under 9.5 Corners, Over/Under 3.5 Cards, Over/Under 4.5 Cards, Second Half Over 0.5 Goals.

FORBIDDEN: match winner, double chance, correct score, goalscorer, handicap.

Respond with ONLY a JSON array (no markdown, no text before or after the [):
[{"match":"Team A vs Team B","league":"League (Country)","time":"HH:MM GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":82,"reasoning":"Specific stats and reason in 2 sentences.","key_stats":["Home 2.4 g/game","Away 8/10 BTTS away","H2H avg 3.1 goals"],"risk":"LOW"}]`;
}

// ── Call Groq (free, fast, great at JSON) ──────────────────────
async function callGroq(key, prompt) {
  if (!key) return "";
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization":"Bearer "+key },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role:"system", content:"You are a football betting analyst. Always respond with ONLY a valid JSON array. No markdown. No explanation. Start with [ end with ]." },
        { role:"user", content:prompt }
      ],
      max_tokens: 2000,
      temperature: 0.2,
      response_format: { type:"json_object" },
    }),
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

// ── Call Gemini (free) ──────────────────────────────────────────
async function callGemini(key, prompt) {
  if (!key) return "";
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        contents:[{parts:[{text:prompt}]}],
        generationConfig:{ maxOutputTokens:2000, temperature:0.2 },
      }) }
  );
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ── Call Claude (no web search — just analysis) ─────────────────
async function callClaude(key, prompt) {
  if (!key) return "";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role:"user", content:prompt }],
    }),
  });
  const d = await r.json();
  return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
}

// ── Parse JSON from any AI response ────────────────────────────
function parse(text, name) {
  if (!text) return [];
  // Handle json_object wrapper from Groq
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) return tag(obj, name);
    // Groq sometimes returns {"tips":[...]} or {"data":[...]}
    const arr = obj.tips || obj.data || obj.matches || obj.predictions || Object.values(obj).find(Array.isArray);
    if (arr) return tag(arr, name);
  } catch(e) {}
  // Try to find raw array
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { return tag(JSON.parse(m[0]), name); } catch(e) { return []; }
}

function tag(arr, name) {
  return (arr||[]).filter(t=>t&&t.match&&t.pick).map(t=>({
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
  arrays.forEach((tips, idx) => {
    const name = ["Claude","Gemini","Groq"][idx];
    tips.forEach(t => {
      const key = (t.match||"").toLowerCase().replace(/\s/g,"")
                + (t.pick||"").toLowerCase().replace(/\s/g,"");
      if (!map[key]) map[key] = {...t, ais:[], votes:0, confs:[]};
      if (!map[key].ais.includes(name)) map[key].ais.push(name);
      map[key].votes++;
      map[key].confs.push(parseInt(t.confidence)||72);
      if ((t.reasoning||"").length>(map[key].reasoning||"").length) map[key].reasoning=t.reasoning;
      if (t.key_stats) map[key].key_stats=[...new Set([...(map[key].key_stats||[]),...(t.key_stats||[])])].slice(0,5);
    });
  });
  return Object.values(map).map(t=>({
    ...t,
    confidence: Math.min(98,Math.round(t.confs.reduce((a,b)=>a+b,0)/t.confs.length+(t.votes===2?5:t.votes>=3?10:0))),
    multiAI: t.votes>=2, confirmed: t.votes>=3, aiCount: t.votes,
  })).sort((a,b)=>b.confirmed-a.confirmed||b.multiAI-a.multiAI||b.confidence-a.confidence);
}

// ── MAIN ────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== "POST") return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers:H});

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || "";
  const groqKey   = process.env.GROQ_API_KEY   || "";
  if (!claudeKey) return new Response(JSON.stringify({error:"ANTHROPIC_API_KEY not set."}),{status:500,headers:H});

  let today = new Date().toISOString().split("T")[0];
  try { const b=await req.json(); if(b.date) today=b.date; } catch(e){}

  try {
    // Step 1: Get real fixtures from ESPN filtered by today's exact date
    const matches = await fetchFixtures(today);

    // Step 2: Build prompt with real fixtures
    const prompt = buildPrompt(matches, today);

    // Step 3: All 3 AIs analyse simultaneously
    const [cRaw, gRaw, qRaw] = await Promise.all([
      callClaude(claudeKey, prompt),
      callGemini(geminiKey, prompt),
      callGroq(groqKey, prompt),
    ]);

    const claudeTips = parse(cRaw, "Claude");
    const geminiTips = parse(gRaw, "Gemini");
    const groqTips   = parse(qRaw, "Groq");
    const tips       = merge([claudeTips, geminiTips, groqTips]);
    const activeAIs  = [claudeTips.length?"Claude":null, geminiTips.length?"Gemini":null, groqTips.length?"Groq":null].filter(Boolean);

    if (tips.length === 0) return new Response(JSON.stringify({
      tips:[], count:0, date:today, activeAIs,
      message: matches.length > 0
        ? `Found ${matches.length} matches but AIs returned no tips. Try again.`
        : "No live fixtures found. Major leagues may be on a break today.",
      generatedAt: Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"no-store"}});

    return new Response(JSON.stringify({
      tips, count:tips.length, date:today, activeAIs,
      fixturesFound: matches.length,
      generatedAt: Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"s-maxage=1800"}});

  } catch(err) {
    return new Response(JSON.stringify({error:err.message||"Server error"}),{status:500,headers:H});
  }
}
