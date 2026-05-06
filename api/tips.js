// tips.js v4.0 - Calls Railway backend first, falls back to direct AI if needed

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).json({ ok: true });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  var RAILWAY = process.env.RAILWAY_API_URL || "";
  var CK = process.env.ANTHROPIC_API_KEY || "";
  var GK = process.env.GEMINI_API_KEY    || "";
  var QK = process.env.GROQ_API_KEY      || "";
  var FK = process.env.API_FOOTBALL_KEY  || "";

  var today = new Date().toISOString().split("T")[0];
  try { var b = await req.json(); if (b && b.date) today = b.date; } catch(e) {}

  // ── ROUTE 1: Call Railway backend (full ML pipeline) ──────────
  if (RAILWAY) {
    try {
      var r = await fetch(RAILWAY + "/api/tips", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": process.env.INTERNAL_API_KEY || "",
        },
        body: JSON.stringify({ date: today }),
      });
      var data = await r.json();
      return res.status(200).json(data);
    } catch(err) {
      console.log("Railway failed, falling back to direct mode:", err.message);
      // Fall through to direct mode below
    }
  }

  // ── ROUTE 2: Direct AI calls (fallback if Railway not set) ────
  if (!CK) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set." });
  if (!FK) return res.status(500).json({ error: "API_FOOTBALL_KEY not set." });

  var OK = new Set([
    2,3,848,531,1,4,5,6,9,13,11,
    39,40,41,42,43,45,46,528,
    140,141,143,135,136,137,
    78,79,80,81,82,83,84,793,
    61,62,66,88,89,90,94,95,96,
    179,180,181,144,145,146,172,
    203,204,307,371,253,254,
    71,72,73,128,129,197,
    802,804,806,116,794,807,799,783,752,851,
    12,20,29
  ]);

  try {
    // Fetch fixtures
    var fr = await fetch(
      "https://v3.football.api-sports.io/fixtures?date=" + today,
      { headers: { "x-apisports-key": FK } }
    );
    var fd = await fr.json();
    var fx = (fd.response || [])
      .filter(function(f) {
        return ["NS","TBD","PST","1H","2H","HT"].indexOf(f.fixture && f.fixture.status && f.fixture.status.short) >= 0
               && OK.has(f.league && f.league.id);
      })
      .map(function(f) {
        return {
          h: (f.teams && f.teams.home && f.teams.home.name) || "",
          a: (f.teams && f.teams.away && f.teams.away.name) || "",
          lg: ((f.league && f.league.name) || "") + " (" + ((f.league && f.league.country) || "") + ")",
          t: (f.fixture && f.fixture.date)
             ? new Date(f.fixture.date).toLocaleTimeString("en-GB", {hour:"2-digit",minute:"2-digit",timeZone:"UTC"}) + " GMT"
             : "TBD",
        };
      })
      .filter(function(f) { return f.h && f.a; });

    if (!fx.length) return res.status(200).json({
      tips: [], count: 0, date: today, fixturesFound: 0,
      message: "No matches in your leagues for " + today + ".",
      generatedAt: Date.now(),
    });

    // Build prompt
    var list = fx.slice(0,30).map(function(f,i) {
      return (i+1) + ". " + f.h + " vs " + f.a + " | " + f.lg + " | " + f.t;
    }).join("\n");

    var p = "Professional football value betting analyst. Date: " + today + ".\n\n"
      + "REAL MATCHES TODAY:\n" + list + "\n\n"
      + "Analyse using: form, H2H, injuries, motivation, xG, tactics, home/away stats, corners/cards averages.\n"
      + "Markets allowed: Over/Under 1.5/2.5/3.5/4.5 Goals | BTTS Yes/No | 1st/2nd Half Over 0.5/1.5 | Corners 8.5-11.5 | Cards 3.5-5.5 | Clean Sheet\n"
      + "FORBIDDEN: match winner, double chance, correct score, goalscorer.\n"
      + "Generate 20 tips. Variety of markets AND leagues.\n"
      + "Return ONLY JSON array. Start [ end ]. No markdown.\n"
      + '[{"match":"Team A vs Team B","league":"League (Country)","time":"HH:MM GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":84,"reasoning":"3-4 sentence stats-based reason.","key_stats":["s1","s2","s3","s4"],"risk":"LOW"}]';

    // Call all 3 AIs in parallel
    var results = await Promise.all([callClaude(CK,p), callGemini(GK,p), callGroq(QK,p)]);

    var cE = extract(results[0], "Claude");
    var gE = extract(results[1], "Gemini");
    var qE = extract(results[2], "Groq");
    var tips = merge([cE.tips, gE.tips, qE.tips]);
    var activeAIs = [];
    if (cE.tips.length) activeAIs.push("Claude");
    if (gE.tips.length) activeAIs.push("Gemini");
    if (qE.tips.length) activeAIs.push("Groq");

    if (!tips.length) return res.status(200).json({
      tips: [], count: 0, date: today, fixturesFound: fx.length, activeAIs: activeAIs,
      message: "AI debug: " + [cE.dbg, gE.dbg, qE.dbg].join(" | "),
      generatedAt: Date.now(),
    });

    return res.status(200).json({
      tips: tips, count: tips.length, date: today,
      fixturesFound: fx.length, activeAIs: activeAIs,
      generatedAt: Date.now(),
    });

  } catch(err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
}

// ── AI callers ────────────────────────────────────────────────────
function callClaude(key, p) {
  if (!key) return Promise.resolve("");
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01" },
    body: JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:4000, messages:[{role:"user",content:p}] }),
  }).then(function(r) { return r.json(); })
    .then(function(d) {
      return (d.content||[]).filter(function(b){return b.type==="text";}).map(function(b){return b.text;}).join("").trim();
    }).catch(function(e) { return "ERR:"+e.message; });
}

function callGemini(key, p) {
  if (!key) return Promise.resolve("");
  return fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key="+key, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ contents:[{parts:[{text:p}]}], generationConfig:{maxOutputTokens:4000,temperature:0.1} }),
  }).then(function(r) { return r.json(); })
    .then(function(d) {
      return (d.candidates&&d.candidates[0]&&d.candidates[0].content&&d.candidates[0].content.parts&&d.candidates[0].content.parts[0]&&d.candidates[0].content.parts[0].text)||"";
    }).catch(function(e) { return "ERR:"+e.message; });
}

function callGroq(key, p) {
  if (!key) return Promise.resolve("");
  return fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json","Authorization":"Bearer "+key },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {role:"system",content:"Football analyst. Return ONLY JSON array starting [ ending ]. No markdown."},
        {role:"user",content:p}
      ],
      max_tokens: 4000, temperature: 0.1,
    }),
  }).then(function(r) { return r.json(); })
    .then(function(d) {
      return (d.choices&&d.choices[0]&&d.choices[0].message&&d.choices[0].message.content)||"";
    }).catch(function(e) { return "ERR:"+e.message; });
}

// ── Bulletproof parser ────────────────────────────────────────────
function extract(raw, name) {
  if (!raw || raw.length < 10 || raw.indexOf("ERR:") === 0)
    return { tips:[], dbg: name+": "+(raw||"empty").substring(0,80) };

  var text = raw.replace(/```json/gi,"").replace(/```/g,"").trim();
  var arr = [];

  try { if(text.charAt(0)==="[") arr=JSON.parse(text); } catch(e){}
  if(!arr.length) { try { var m=text.match(/\[[\s\S]*\]/); if(m) arr=JSON.parse(m[0]); } catch(e){} }
  if(!arr.length) {
    var objs=text.match(/\{[^{}]{20,}\}/g);
    if(objs){ arr=[]; for(var i=0;i<objs.length;i++){try{arr.push(JSON.parse(objs[i]));}catch(e){}} }
  }
  if(!arr.length) {
    try {
      var fixed=text.replace(/,\s*\]/g,"]").replace(/,\s*\}/g,"}");
      var m2=fixed.match(/\[[\s\S]*\]/); if(m2) arr=JSON.parse(m2[0]);
    } catch(e){}
  }
  if(!arr.length) return { tips:[], dbg: name+": no JSON ("+text.substring(0,80)+")" };

  var tips=[];
  for(var j=0;j<arr.length;j++){
    var t=arr[j]; if(!t||typeof t!=="object") continue;
    var match=t.match||t.teams||t.fixture||t.game||"";
    var pick=t.pick||t.bet||t.selection||t.tip||"";
    if(match.length<4||pick.length<3) continue;
    tips.push({
      match:match, league:t.league||t.competition||"Unknown",
      time:t.time||t.kickoff||"TBD", market:t.market||t.type||"",
      pick:pick, odds_range:t.odds_range||t.odds||"",
      confidence:Math.min(Math.max(parseInt(t.confidence)||72,50),98),
      reasoning:t.reasoning||t.analysis||t.reason||"",
      key_stats:t.key_stats||t.stats||[],
      risk:t.risk||(parseInt(t.confidence)>=80?"LOW":parseInt(t.confidence)>=65?"MEDIUM":"HIGH"),
      id:Math.random().toString(36).substr(2,8),
      ais:[name],votes:1,confs:[parseInt(t.confidence)||72],
      generatedAt:Date.now(),
    });
  }
  return { tips:tips, dbg: name+": "+tips.length+" tips" };
}

// ── Merge tips from multiple AIs ──────────────────────────────────
function merge(arrays) {
  var norm=function(s){return(s||"").toLowerCase().replace(/[^a-z0-9]/g,"");};
  var map={};
  for(var i=0;i<arrays.length;i++){
    var name=["Claude","Gemini","Groq"][i];
    var tips=arrays[i];
    for(var j=0;j<tips.length;j++){
      var t=tips[j];
      var k=norm(t.match).substring(0,20)+norm(t.pick).substring(0,15);
      if(!map[k]){map[k]=JSON.parse(JSON.stringify(t));map[k].ais=[];map[k].votes=0;map[k].confs=[];}
      if(map[k].ais.indexOf(name)<0) map[k].ais.push(name);
      map[k].votes++;
      map[k].confs.push(t.confidence);
      if((t.reasoning||"").length>(map[k].reasoning||"").length) map[k].reasoning=t.reasoning;
      if(t.key_stats&&t.key_stats.length>(map[k].key_stats||[]).length) map[k].key_stats=t.key_stats;
    }
  }
  var result=[];
  var keys=Object.keys(map);
  for(var x=0;x<keys.length;x++){
    var item=map[keys[x]];
    var avg=0;
    for(var c=0;c<item.confs.length;c++) avg+=item.confs[c];
    avg=avg/item.confs.length;
    var boost=item.votes===2?5:item.votes>=3?10:0;
    item.confidence=Math.min(98,Math.round(avg+boost));
    item.multiAI=item.votes>=2;
    item.confirmed=item.votes>=3;
    item.aiCount=item.votes;
    result.push(item);
  }
  result.sort(function(a,b){
    if(b.confirmed!==a.confirmed)return(b.confirmed?1:0)-(a.confirmed?1:0);
    if(b.multiAI!==a.multiAI)return(b.multiAI?1:0)-(a.multiAI?1:0);
    return b.confidence-a.confidence;
  });
  return result;
}
