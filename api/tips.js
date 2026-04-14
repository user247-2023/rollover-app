export const config = { runtime: "edge" };
const H = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"};

// ── SOURCE 1: FotMob (covers ALL leagues worldwide) ──────────────
async function fromFotmob(dateStr) {
  // FotMob uses YYYYMMDD format
  const d = dateStr.replace(/-/g,"");
  try {
    const r = await fetch(`https://www.fotmob.com/api/matches?date=${d}`, {
      headers:{
        "User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        "Accept":"application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    const fixtures = [];
    for(const league of (data.leagues||[])) {
      const lName = league.name||league.ccode||"Unknown";
      for(const match of (league.matches||[])) {
        const home = match.home?.name||match.home?.longName||"";
        const away = match.away?.name||match.away?.longName||"";
        if(!home||!away) continue;
        // Only upcoming/scheduled matches
        const status = match.status?.utcTime||match.status?.started;
        const time = match.status?.utcTime
          ? new Date(match.status.utcTime).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT"
          : "TBD";
        fixtures.push({home, away, league:lName, time, source:"FotMob"});
      }
    }
    return fixtures;
  } catch(e) { return []; }
}

// ── SOURCE 2: SofaScore (covers ALL leagues worldwide) ───────────
async function fromSofascore(dateStr) {
  try {
    const r = await fetch(
      `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${dateStr}`,
      {
        headers:{
          "User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
          "Accept":"application/json",
          "Referer":"https://www.sofascore.com/",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    const data = await r.json();
    return (data.events||[]).map(e=>{
      const home = e.homeTeam?.name||"";
      const away = e.awayTeam?.name||"";
      if(!home||!away) return null;
      const time = e.startTimestamp
        ? new Date(e.startTimestamp*1000).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT"
        : "TBD";
      const league = e.tournament?.name||e.tournament?.category?.name||"Unknown";
      return {home, away, league, time, source:"SofaScore"};
    }).filter(Boolean);
  } catch(e) { return []; }
}

// ── SOURCE 3: ESPN fallback ──────────────────────────────────────
async function fromESPN(dateStr) {
  const leagues = ["uefa.champions_league","uefa.europa","uefa.europa_conf","eng.1","esp.1","ita.1","ger.1","fra.1","ned.1","por.1","usa.1","tur.1","bra.1","arg.1"];
  const results = await Promise.allSettled(leagues.map(async lg=>{
    try{
      const r=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard`,{signal:AbortSignal.timeout(4000)});
      const d=await r.json();
      return (d.events||[]).flatMap(e=>{
        if((e.date||"").substring(0,10)!==dateStr) return [];
        const c=e.competitions?.[0];
        const home=c?.competitors?.find(x=>x.homeAway==="home")?.team?.displayName||"";
        const away=c?.competitors?.find(x=>x.homeAway==="away")?.team?.displayName||"";
        const time=e.date?new Date(e.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT":"TBD";
        return home&&away?[{home,away,league:e.name||lg,time,source:"ESPN"}]:[];
      });
    }catch(e){return [];}
  }));
  return results.flatMap(r=>r.status==="fulfilled"?r.value:[]);
}

// ── Merge all sources + deduplicate ─────────────────────────────
const norm = s=>(s||"").toLowerCase().replace(/\bfc\b|\bsc\b|\bac\b|\bafc\b|\bcf\b|\bfk\b|\bsk\b/g,"").replace(/[^a-z0-9]/g,"");

async function fetchAllFixtures(dateStr) {
  // Fetch from all 3 sources simultaneously
  const [fotmob, sofascore, espn] = await Promise.all([
    fromFotmob(dateStr),
    fromSofascore(dateStr),
    fromESPN(dateStr),
  ]);

  // Combine and deduplicate by team names
  const all = [...fotmob, ...sofascore, ...espn];
  const seen = new Set();
  return all.filter(f=>{
    const k = norm(f.home)+norm(f.away);
    if(seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ── Validate AI tip is a real fixture ────────────────────────────
function isReal(tipMatch, fixtures) {
  const parts=(tipMatch||"").split(/\s+vs\s+/i);
  if(parts.length<2) return false;
  const [th,ta]=parts.map(s=>norm(s));
  if(th.length<3||ta.length<3) return false;
  return fixtures.some(f=>{
    const fh=norm(f.home),fa=norm(f.away);
    const hOk=fh.length>=3&&(fh.includes(th.slice(0,6))||th.includes(fh.slice(0,6)));
    const aOk=fa.length>=3&&(fa.includes(ta.slice(0,6))||ta.includes(fa.slice(0,6)));
    return hOk&&aOk;
  });
}

function buildPrompt(fixtures, date) {
  // Pick top 20 matches for the prompt
  const list = fixtures.slice(0,20).map((f,i)=>
    `${i+1}. ${f.home} vs ${f.away} | ${f.league} | ${f.time}`
  ).join("\n");

  return `Football betting analyst. Match date: ${date}.

REAL MATCHES FROM FOTMOB + SOFASCORE + ESPN — analyse ONLY these:
${list}

Analyse per match: last 5 results & goals, H2H goal history, home/away record, injuries/suspensions, tactical style, match context (cup, must-win, etc).

Generate 7-8 tips. Allowed markets ONLY:
Over/Under 1.5 Goals, Over/Under 2.5 Goals, Over/Under 3.5 Goals, Over/Under 4.5 Goals,
BTTS Yes, BTTS No, First Half Over 0.5 Goals, First Half Over 1.5 Goals, Second Half Over 0.5 Goals,
Over/Under 8.5 Corners, Over/Under 9.5 Corners, Over/Under 10.5 Corners,
Over/Under 3.5 Cards, Over/Under 4.5 Cards.

FORBIDDEN: match winner, double chance, correct score, goalscorer, handicap.
Cover a variety of leagues and markets — not just goals.

Return ONLY a JSON array starting with [ and ending with ]. No other text:
[{"match":"Home Team vs Away Team","league":"League Name","time":"HH:MM GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":83,"reasoning":"Specific stats. Last 5 H2H avg X goals.","key_stats":["Home 2.4g/game","Away BTTS 8/10 away","H2H avg 3.1 goals"],"risk":"LOW"}]`;
}

async function callClaude(key,p){
  if(!key) return "";
  try{
    const r=await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:2000,messages:[{role:"user",content:p}]}),
    });
    const d=await r.json();
    return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
  }catch(e){return "";}
}

async function callGemini(key,p){
  if(!key) return "";
  try{
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {method:"POST",headers:{"Content-Type":"application/json"},
       body:JSON.stringify({contents:[{parts:[{text:p}]}],generationConfig:{maxOutputTokens:2000,temperature:0.1}})});
    const d=await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text||"";
  }catch(e){return "";}
}

async function callGroq(key,p){
  if(!key) return "";
  try{
    const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},
      body:JSON.stringify({
        model:"llama-3.3-70b-versatile",
        messages:[
          {role:"system",content:"You are a football analyst. Respond ONLY with a valid JSON array. Start response with [ and end with ]. No markdown."},
          {role:"user",content:p}
        ],
        max_tokens:2000,temperature:0.1,
      }),
    });
    const d=await r.json();
    return d.choices?.[0]?.message?.content||"";
  }catch(e){return "";}
}

function parse(text,name,fixtures){
  if(!text) return [];
  let arr=[];
  try{
    const m=text.match(/\[[\s\S]*\]/);
    if(m) arr=JSON.parse(m[0]);
    else{ const obj=JSON.parse(text.trim()); arr=Array.isArray(obj)?obj:Object.values(obj).find(Array.isArray)||[]; }
  }catch(e){return [];}
  return arr
    .filter(t=>t&&t.match&&t.pick&&isReal(t.match,fixtures))
    .map(t=>({
      ...t,
      id:Math.random().toString(36).substr(2,8),
      confidence:Math.min(Math.max(parseInt(t.confidence)||72,50),98),
      risk:t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
      ais:[name],votes:1,confs:[parseInt(t.confidence)||72],generatedAt:Date.now(),
    }));
}

function merge(arrays){
  const map={};
  arrays.forEach((tips,i)=>{
    const name=["Claude","Gemini","Groq"][i];
    tips.forEach(t=>{
      const k=norm(t.match)+norm(t.pick);
      if(!map[k]) map[k]={...t,ais:[],votes:0,confs:[]};
      if(!map[k].ais.includes(name)) map[k].ais.push(name);
      map[k].votes++;map[k].confs.push(parseInt(t.confidence)||72);
      if((t.reasoning||"").length>(map[k].reasoning||"").length) map[k].reasoning=t.reasoning;
      if(t.key_stats) map[k].key_stats=[...new Set([...(map[k].key_stats||[]),...(t.key_stats||[])])].slice(0,5);
    });
  });
  return Object.values(map)
    .map(t=>({...t,
      confidence:Math.min(98,Math.round(t.confs.reduce((a,b)=>a+b,0)/t.confs.length+(t.votes===2?5:t.votes>=3?10:0))),
      multiAI:t.votes>=2,confirmed:t.votes>=3,aiCount:t.votes,
    }))
    .sort((a,b)=>b.confirmed-a.confirmed||b.multiAI-a.multiAI||b.confidence-a.confidence);
}

export default async function handler(req){
  if(req.method!=="POST") return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers:H});
  const claudeKey=process.env.ANTHROPIC_API_KEY;
  const geminiKey=process.env.GEMINI_API_KEY||"";
  const groqKey  =process.env.GROQ_API_KEY||"";
  if(!claudeKey) return new Response(JSON.stringify({error:"ANTHROPIC_API_KEY not set."}),{status:500,headers:H});

  let today=new Date().toISOString().split("T")[0];
  try{const b=await req.json();if(b.date)today=b.date;}catch(e){}

  try{
    const fixtures=await fetchAllFixtures(today);

    if(fixtures.length===0) return new Response(JSON.stringify({
      tips:[],count:0,date:today,fixturesFound:0,
      message:`No matches found on FotMob, SofaScore or ESPN for ${today}. Genuinely no major fixtures today.`,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"no-store"}});

    const prompt=buildPrompt(fixtures,today);
    const [cRaw,gRaw,qRaw]=await Promise.all([
      callClaude(claudeKey,prompt),
      callGemini(geminiKey,prompt),
      callGroq(groqKey,prompt),
    ]);

    const cT=parse(cRaw,"Claude",fixtures);
    const gT=parse(gRaw,"Gemini",fixtures);
    const qT=parse(qRaw,"Groq",  fixtures);
    const tips=merge([cT,gT,qT]);
    const activeAIs=[cT.length?"Claude":null,gT.length?"Gemini":null,qT.length?"Groq":null].filter(Boolean);
    const sources=[...new Set(fixtures.map(f=>f.source))];

    if(tips.length===0) return new Response(JSON.stringify({
      tips:[],count:0,date:today,fixturesFound:fixtures.length,activeAIs,sources,
      message:`Found ${fixtures.length} real matches but tips failed validation. Try again.`,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"no-store"}});

    return new Response(JSON.stringify({
      tips,count:tips.length,date:today,
      fixturesFound:fixtures.length,
      sources,activeAIs,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"s-maxage=1800"}});

  }catch(err){
    return new Response(JSON.stringify({error:err.message||"Server error"}),{status:500,headers:H});
  }
}
