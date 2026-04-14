export const config = { runtime: "edge" };
const H = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"};

// ── ESPN: fetch without date param, filter after ─────────────────
async function fetchFixtures(today) {
  const leagues = [
    "uefa.champions_league","uefa.europa","uefa.europa_conf",
    "eng.1","esp.1","ita.1","ger.1","fra.1","ned.1","por.1",
    "usa.1","eng.2","sco.1","tur.1","bra.1","arg.1","mex.1",
    "sau.1","egy.1","zaf.1","jpn.1","chn.1","kor.1",
  ];
  const results = await Promise.allSettled(
    leagues.map(async lg => {
      try {
        const r = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard`,
          {signal:AbortSignal.timeout(5000)}
        );
        const d = await r.json();
        return (d.events||[]).flatMap(e=>{
          // Only keep events on today's UTC date
          const eDate = (e.date||"").substring(0,10);
          if(eDate !== today) return [];
          const c    = e.competitions?.[0];
          const home = c?.competitors?.find(x=>x.homeAway==="home")?.team?.displayName||"";
          const away = c?.competitors?.find(x=>x.homeAway==="away")?.team?.displayName||"";
          const time = e.date
            ? new Date(e.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT"
            : "TBD";
          if(!home||!away) return [];
          return [{home, away, league:e.name||lg, time}];
        });
      } catch(e){ return []; }
    })
  );
  // Deduplicate by home+away
  const seen = new Set();
  return results
    .flatMap(r => r.status==="fulfilled" ? r.value : [])
    .filter(f => {
      const k = f.home+f.away;
      if(seen.has(k)) return false;
      seen.add(k); return true;
    });
}

// ── Team name normaliser ─────────────────────────────────────────
const norm = s => (s||"").toLowerCase()
  .replace(/\bfc\b|\bsc\b|\bac\b|\bas\b|\brc\b|\brb\b|\bafc\b|\bcf\b/g,"")
  .replace(/[^a-z0-9]/g,"");

// ── Validate AI tip against ESPN fixture list ────────────────────
function isReal(tipMatch, fixtures) {
  const parts = (tipMatch||"").split(/\s+vs\s+/i);
  if(parts.length < 2) return false;
  const [th, ta] = parts.map(s=>norm(s));
  return fixtures.some(f => {
    const fh=norm(f.home), fa=norm(f.away);
    const hOk = th.length>=4&&(fh.includes(th.slice(0,5))||th.includes(fh.slice(0,5)));
    const aOk = ta.length>=4&&(fa.includes(ta.slice(0,5))||ta.includes(fa.slice(0,5)));
    return hOk && aOk;
  });
}

// ── Analysis prompt ──────────────────────────────────────────────
function buildPrompt(fixtures, today) {
  const list = fixtures
    .map((f,i)=>`${i+1}. ${f.home} vs ${f.away} | ${f.league} | ${f.time}`)
    .join("\n");
  return `Football betting analyst. Today: ${today}.

REAL MATCHES FROM ESPN FOR TODAY — analyse ONLY these:
${list}

Per match check: last 5 results, H2H goals, home/away scoring, injuries, style.
Pick best 6 tips. Markets allowed: Over/Under 1.5/2.5/3.5/4.5 Goals, BTTS Yes/No, 1st Half Over 0.5/1.5, 2nd Half Over 0.5, Over/Under 8.5/9.5/10.5 Corners, Over/Under 3.5/4.5 Cards.
FORBIDDEN: match winner, double chance, correct score, goalscorer.

Respond with ONLY a JSON array. Nothing before [ or after ]:
[{"match":"${fixtures[0]?.home||"Team A"} vs ${fixtures[0]?.away||"Team B"}","league":"${fixtures[0]?.league||"League"}","time":"${fixtures[0]?.time||"TBD"}","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":83,"reasoning":"Stats here.","key_stats":["stat1","stat2","stat3"],"risk":"LOW"}]`;
}

// ── AI callers ───────────────────────────────────────────────────
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
        messages:[{role:"system",content:"Respond ONLY with a valid JSON array. Start with [ end with ]. No other text."},{role:"user",content:p}],
        max_tokens:2000,temperature:0.1,
      }),
    });
    const d=await r.json();
    return d.choices?.[0]?.message?.content||"";
  }catch(e){return "";}
}

// ── Parse ────────────────────────────────────────────────────────
function parse(text,name,fixtures){
  if(!text) return [];
  let arr=[];
  try{
    const m=text.match(/\[[\s\S]*\]/);
    if(m) arr=JSON.parse(m[0]);
    else if(text.trim().startsWith("{")) {
      const obj=JSON.parse(text);
      arr=obj.tips||obj.data||Object.values(obj).find(Array.isArray)||[];
    }
  }catch(e){return [];}
  return arr
    .filter(t=>t&&t.match&&t.pick&&isReal(t.match,fixtures))
    .map(t=>({
      ...t,
      id:Math.random().toString(36).substr(2,8),
      confidence:Math.min(Math.max(parseInt(t.confidence)||72,50),98),
      risk:t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
      ais:[name],votes:1,confs:[parseInt(t.confidence)||72],
      generatedAt:Date.now(),
    }));
}

// ── Merge ────────────────────────────────────────────────────────
function merge(arrays){
  const map={};
  arrays.forEach((tips,i)=>{
    const name=["Claude","Gemini","Groq"][i];
    tips.forEach(t=>{
      const k=norm(t.match)+norm(t.pick);
      if(!map[k]) map[k]={...t,ais:[],votes:0,confs:[]};
      if(!map[k].ais.includes(name)) map[k].ais.push(name);
      map[k].votes++; map[k].confs.push(parseInt(t.confidence)||72);
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

// ── MAIN ─────────────────────────────────────────────────────────
export default async function handler(req){
  if(req.method!=="POST") return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers:H});
  const claudeKey=process.env.ANTHROPIC_API_KEY;
  const geminiKey=process.env.GEMINI_API_KEY||"";
  const groqKey  =process.env.GROQ_API_KEY||"";
  if(!claudeKey) return new Response(JSON.stringify({error:"ANTHROPIC_API_KEY not set."}),{status:500,headers:H});

  let today=new Date().toISOString().split("T")[0];
  try{const b=await req.json();if(b.date)today=b.date;}catch(e){}

  try{
    const fixtures=await fetchFixtures(today);

    if(fixtures.length===0){
      return new Response(JSON.stringify({
        tips:[],count:0,date:today,fixturesFound:0,
        message:`ESPN found no matches for ${today}. Major leagues may be on break — try again tomorrow.`,
        generatedAt:Date.now(),
      }),{status:200,headers:{...H,"Cache-Control":"no-store"}});
    }

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

    if(tips.length===0) return new Response(JSON.stringify({
      tips:[],count:0,date:today,fixturesFound:fixtures.length,activeAIs,
      message:`ESPN confirmed ${fixtures.length} matches for ${today} but AIs couldn't generate valid tips. Try again.`,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"no-store"}});

    return new Response(JSON.stringify({
      tips,count:tips.length,date:today,fixturesFound:fixtures.length,activeAIs,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"s-maxage=1800"}});

  }catch(err){
    return new Response(JSON.stringify({error:err.message||"Server error"}),{status:500,headers:H});
  }
}
