export const config = { runtime: "edge" };
const H = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"};

// ── football-data.org (free, designed for servers, no blocking) ──
async function fetchFixtures(dateStr, apiKey) {
  const matches = [];
  const competitions = [
    "CL","EL","EC","PL","PD","SA","BL1","FL1","DED","PPL",
    "BSA","MLS","CLI","WC"
  ];
  try {
    const results = await Promise.allSettled(
      competitions.map(async code => {
        const r = await fetch(
          `https://api.football-data.org/v4/competitions/${code}/matches?dateFrom=${dateStr}&dateTo=${dateStr}&status=SCHEDULED,TIMED,LIVE`,
          {
            headers:{
              "X-Auth-Token": apiKey,
              "Accept": "application/json",
            },
            signal: AbortSignal.timeout(6000),
          }
        );
        if(!r.ok) return [];
        const d = await r.json();
        return (d.matches||[]).map(m => ({
          home: m.homeTeam?.shortName||m.homeTeam?.name||"",
          away: m.awayTeam?.shortName||m.awayTeam?.name||"",
          league: d.competition?.name||code,
          time: m.utcDate
            ? new Date(m.utcDate).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT"
            : "TBD",
          source: "football-data.org",
        })).filter(m=>m.home&&m.away);
      })
    );
    return results.flatMap(r=>r.status==="fulfilled"?r.value:[]);
  } catch(e){ return []; }
}

const norm = s=>(s||"").toLowerCase().replace(/\bfc\b|\bsc\b|\bac\b|\bafc\b|\bcf\b|\bfk\b/g,"").replace(/[^a-z0-9]/g,"");

function isReal(tipMatch, fixtures) {
  const parts=(tipMatch||"").split(/\s+vs\s+/i);
  if(parts.length<2) return false;
  const [th,ta]=parts.map(s=>norm(s));
  if(th.length<3||ta.length<3) return false;
  return fixtures.some(f=>{
    const fh=norm(f.home),fa=norm(f.away);
    const hOk=fh.length>=3&&(fh.includes(th.slice(0,5))||th.includes(fh.slice(0,5)));
    const aOk=fa.length>=3&&(fa.includes(ta.slice(0,5))||ta.includes(fa.slice(0,5)));
    return hOk&&aOk;
  });
}

function buildPrompt(fixtures, date) {
  const list = fixtures.slice(0,25).map((f,i)=>`${i+1}. ${f.home} vs ${f.away} | ${f.league} | ${f.time}`).join("\n");
  return `Football betting analyst. Match date: ${date}.

VERIFIED REAL MATCHES FROM FOOTBALL-DATA.ORG — analyse ONLY these:
${list}

Per match analyse: last 5 results & goals, H2H history, home/away record, injuries, suspensions, tactical setup, match importance.

Pick 7-8 best tips from a VARIETY of leagues and markets:
Allowed: Over/Under 1.5/2.5/3.5/4.5 Goals, BTTS Yes/No, 1st Half Over 0.5/1.5, 2nd Half Over 0.5, Over/Under 8.5/9.5/10.5 Corners, Over/Under 3.5/4.5 Cards.
FORBIDDEN: match winner, double chance, correct score, goalscorer.

Return ONLY JSON array, nothing before [ or after ]:
[{"match":"Home vs Away","league":"League","time":"HH:MM GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":84,"reasoning":"Specific stats in 2-3 sentences.","key_stats":["Home 2.4g/game","BTTS 8/10 away","H2H avg 3.1 goals"],"risk":"LOW"}]`;
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
          {role:"system",content:"Football analyst. Respond ONLY with a JSON array. Start with [ end with ]. No markdown."},
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
    else{const obj=JSON.parse(text.trim());arr=Array.isArray(obj)?obj:Object.values(obj).find(Array.isArray)||[];}
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
  const claudeKey   = process.env.ANTHROPIC_API_KEY;
  const geminiKey   = process.env.GEMINI_API_KEY||"";
  const groqKey     = process.env.GROQ_API_KEY||"";
  const footballKey = process.env.FOOTBALL_API_KEY||"";

  if(!claudeKey) return new Response(JSON.stringify({error:"ANTHROPIC_API_KEY not set."}),{status:500,headers:H});
  if(!footballKey) return new Response(JSON.stringify({
    error:"FOOTBALL_API_KEY not set. Go to football-data.org, sign up free (2 min), get your key, add it to Vercel Environment Variables as FOOTBALL_API_KEY."
  }),{status:500,headers:H});

  let today=new Date().toISOString().split("T")[0];
  try{const b=await req.json();if(b.date)today=b.date;}catch(e){}

  try{
    const fixtures = await fetchFixtures(today, footballKey);

    if(fixtures.length===0) return new Response(JSON.stringify({
      tips:[],count:0,date:today,fixturesFound:0,
      message:`No matches found for ${today} in football-data.org. Leagues may be on break today.`,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"no-store"}});

    const prompt = buildPrompt(fixtures, today);
    const [cRaw,gRaw,qRaw] = await Promise.all([
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
      message:`Found ${fixtures.length} verified matches but tips failed validation. Try again.`,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"no-store"}});

    return new Response(JSON.stringify({
      tips,count:tips.length,date:today,fixturesFound:fixtures.length,activeAIs,generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"s-maxage=1800"}});

  }catch(err){
    return new Response(JSON.stringify({error:err.message||"Server error"}),{status:500,headers:H});
  }
}
