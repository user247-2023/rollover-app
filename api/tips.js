export const config = { runtime: "edge" };
const H = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"};

// ── ESPN fixtures with exact date parameter ──────────────────────
async function fetchFixtures(today) {
  const espnDate = today.replace(/-/g,"");
  const leagues  = [
    "uefa.champions_league","uefa.europa","uefa.europa_conf",
    "eng.1","esp.1","ita.1","ger.1","fra.1","ned.1","por.1",
    "usa.1","eng.2","sco.1","tur.1","bra.1","arg.1","mex.1",
    "sau.1","egy.1","zaf.1","jpn.1","chn.1","kor.1",
  ];
  const results = await Promise.allSettled(
    leagues.map(async lg => {
      try {
        const r = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${espnDate}`,
          {signal:AbortSignal.timeout(5000)}
        );
        const d = await r.json();
        return (d.events||[]).map(e=>{
          const c    = e.competitions?.[0];
          const home = c?.competitors?.find(x=>x.homeAway==="home")?.team?.displayName||"";
          const away = c?.competitors?.find(x=>x.homeAway==="away")?.team?.displayName||"";
          const time = e.date ? new Date(e.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT" : "TBD";
          return home&&away ? {home,away,league:e.season?.slug||lg,time,matchStr:`${home} vs ${away}|${lg}|${time}`} : null;
        }).filter(Boolean);
      } catch(e){return [];}
    })
  );
  return results.flatMap(r=>r.status==="fulfilled"?r.value:[]);
}

// ── Normalise team name for fuzzy matching ───────────────────────
const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"").replace(/\b(fc|cf|sc|ac|as|ss|rc|rcd|rb|vfb|vfl|bsc|fk|sk|nk|hfc|afc|united|city|town|rovers|wanderers|athletic|atletico|real|borussia|hertha|bayer|sport|sporting|inter|internazionale)\b/g,"").replace(/\s+/g,"");

// ── Validate tip match against real fixture list ─────────────────
function isRealMatch(tipMatch, fixtures) {
  const [tipHome="", tipAway=""] = tipMatch.split(" vs ").map(s=>norm(s.trim()));
  if(!tipHome&&!tipAway) return false;
  return fixtures.some(f=>{
    const fHome=norm(f.home), fAway=norm(f.away);
    // Both teams must partially match
    const homeOk = fHome.includes(tipHome)||tipHome.includes(fHome)||tipHome.includes(fHome.slice(0,5))||fHome.includes(tipHome.slice(0,5));
    const awayOk = fAway.includes(tipAway)||tipAway.includes(fAway)||tipAway.includes(fAway.slice(0,5))||fAway.includes(tipAway.slice(0,5));
    return homeOk && awayOk;
  });
}

// ── Build analysis prompt ────────────────────────────────────────
function buildPrompt(fixtures, today) {
  const list = fixtures.map((f,i)=>`${i+1}. ${f.home} vs ${f.away} | ${f.league} | ${f.time}`).join("\n");
  return `You are a football betting analyst. Today is ${today}.

THESE ARE THE ONLY REAL MATCHES TODAY FROM ESPN. Analyse ONLY these matches. Do NOT add any other match:
${list}

For each match analyse: last 5 results, H2H goals, home/away record, injuries, tactical style.

Pick the 6 best tips. Markets allowed:
Over/Under 1.5, 2.5, 3.5, 4.5 Goals | BTTS Yes/No | 1st Half Over 0.5/1.5 Goals | 2nd Half Over 0.5 Goals | Over/Under 8.5/9.5/10.5 Corners | Over/Under 3.5/4.5 Cards

FORBIDDEN: match winner, double chance, correct score, goalscorer.

Return ONLY a raw JSON array. Start with [ end with ]. No other text:
[{"match":"EXACT team name from list vs EXACT team name from list","league":"league","time":"HH:MM GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":82,"reasoning":"2-3 sentence stat-based reason.","key_stats":["stat1","stat2","stat3"],"risk":"LOW"}]`;
}

// ── AI callers ───────────────────────────────────────────────────
async function callClaude(key,prompt){
  if(!key) return "";
  try{
    const r=await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:2000,messages:[{role:"user",content:prompt}]}),
    });
    const d=await r.json();
    return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
  }catch(e){return "";}
}

async function callGemini(key,prompt){
  if(!key) return "";
  try{
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {method:"POST",headers:{"Content-Type":"application/json"},
       body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:2000,temperature:0.1}})});
    const d=await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text||"";
  }catch(e){return "";}
}

async function callGroq(key,prompt){
  if(!key) return "";
  try{
    const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},
      body:JSON.stringify({
        model:"llama-3.3-70b-versatile",
        messages:[
          {role:"system",content:"You are a football analyst. Respond ONLY with a valid JSON array starting with [ and ending with ]. No other text."},
          {role:"user",content:prompt}
        ],
        max_tokens:2000,temperature:0.1,
      }),
    });
    const d=await r.json();
    return d.choices?.[0]?.message?.content||"";
  }catch(e){return "";}
}

// ── Parse + validate tips ────────────────────────────────────────
function parseTips(text, aiName, fixtures) {
  if(!text||text.length<5) return [];
  let arr=[];
  try{
    // Try direct parse first
    if(text.trim().startsWith("[")) arr=JSON.parse(text.trim());
    else{
      const m=text.match(/\[[\s\S]*\]/);
      if(m) arr=JSON.parse(m[0]);
    }
  }catch(e){return [];}

  return arr
    .filter(t=>t&&t.match&&t.pick)
    .filter(t=>isRealMatch(t.match, fixtures))   // ← ONLY real matches
    .map(t=>({
      ...t,
      id:Math.random().toString(36).substr(2,8),
      confidence:Math.min(Math.max(parseInt(t.confidence)||72,50),98),
      risk:t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
      ais:[aiName],votes:1,confs:[parseInt(t.confidence)||72],
      generatedAt:Date.now(),
    }));
}

// ── Merge tips from multiple AIs ─────────────────────────────────
function mergeTips(arrays){
  const map={};
  arrays.forEach((tips,idx)=>{
    const name=["Claude","Gemini","Groq"][idx];
    tips.forEach(t=>{
      const key=norm(t.match)+norm(t.pick);
      if(!map[key]) map[key]={...t,ais:[],votes:0,confs:[]};
      if(!map[key].ais.includes(name)) map[key].ais.push(name);
      map[key].votes++;
      map[key].confs.push(parseInt(t.confidence)||72);
      if((t.reasoning||"").length>(map[key].reasoning||"").length) map[key].reasoning=t.reasoning;
      if(t.key_stats) map[key].key_stats=[...new Set([...(map[key].key_stats||[]),...(t.key_stats||[])])].slice(0,5);
    });
  });
  return Object.values(map)
    .map(t=>({
      ...t,
      confidence:Math.min(98,Math.round(t.confs.reduce((a,b)=>a+b,0)/t.confs.length+(t.votes===2?5:t.votes>=3?10:0))),
      multiAI:t.votes>=2,confirmed:t.votes>=3,aiCount:t.votes,
    }))
    .sort((a,b)=>b.confirmed-a.confirmed||b.multiAI-a.multiAI||b.confidence-a.confidence);
}

// ── MAIN ─────────────────────────────────────────────────────────
export default async function handler(req){
  if(req.method!=="POST") return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers:H});

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY||"";
  const groqKey   = process.env.GROQ_API_KEY||"";
  if(!claudeKey) return new Response(JSON.stringify({error:"ANTHROPIC_API_KEY not set."}),{status:500,headers:H});

  let today=new Date().toISOString().split("T")[0];
  try{const b=await req.json();if(b.date)today=b.date;}catch(e){}

  try{
    // Step 1: Get real fixtures from ESPN with exact date
    const fixtures=await fetchFixtures(today);

    if(fixtures.length===0){
      return new Response(JSON.stringify({
        tips:[],count:0,date:today,
        message:`No fixtures found for ${today} in any major league. There may be no matches today — check back tomorrow.`,
        generatedAt:Date.now(),
      }),{status:200,headers:{...H,"Cache-Control":"no-store"}});
    }

    // Step 2: All 3 AIs analyse the SAME fixture list simultaneously
    const prompt=buildPrompt(fixtures,today);
    const [cRaw,gRaw,qRaw]=await Promise.all([
      callClaude(claudeKey,prompt),
      callGemini(geminiKey,prompt),
      callGroq(groqKey,prompt),
    ]);

    // Step 3: Parse + validate (reject any match not in ESPN fixture list)
    const claudeTips=parseTips(cRaw,"Claude",fixtures);
    const geminiTips=parseTips(gRaw,"Gemini",fixtures);
    const groqTips  =parseTips(qRaw,"Groq",  fixtures);
    const tips      =mergeTips([claudeTips,geminiTips,groqTips]);
    const activeAIs =[claudeTips.length?"Claude":null,geminiTips.length?"Gemini":null,groqTips.length?"Groq":null].filter(Boolean);

    if(tips.length===0){
      return new Response(JSON.stringify({
        tips:[],count:0,date:today,activeAIs,
        fixturesFound:fixtures.length,
        message:`Found ${fixtures.length} matches for ${today} but no valid tips passed validation. Try again.`,
        generatedAt:Date.now(),
      }),{status:200,headers:{...H,"Cache-Control":"no-store"}});
    }

    return new Response(JSON.stringify({
      tips,count:tips.length,date:today,activeAIs,
      fixturesFound:fixtures.length,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"s-maxage=1800"}});

  }catch(err){
    return new Response(JSON.stringify({error:err.message||"Server error"}),{status:500,headers:H});
  }
}
