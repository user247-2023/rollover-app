export const config = { runtime: "edge" };
const H = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"};

// ═══════════════════════════════════════════════════════════════
//  FIXTURE SOURCE 1: football-data.org (top European leagues)
// ═══════════════════════════════════════════════════════════════
async function fromFootballData(dateStr, apiKey) {
  if(!apiKey) return [];
  const competitions = [
    "PL","ELC","EL1","EL2","PPL","PD","SA","BL1","FL1",
    "DED","CL","EL","EC","BSA","CLI","WC","MLS"
  ];
  const results = await Promise.allSettled(
    competitions.map(async code => {
      try {
        const r = await fetch(
          `https://api.football-data.org/v4/competitions/${code}/matches?dateFrom=${dateStr}&dateTo=${dateStr}`,
          { headers:{"X-Auth-Token":apiKey,"Accept":"application/json"}, signal:AbortSignal.timeout(5000) }
        );
        if(!r.ok) return [];
        const d = await r.json();
        return (d.matches||[]).map(m=>({
          home: m.homeTeam?.shortName||m.homeTeam?.name||"",
          away: m.awayTeam?.shortName||m.awayTeam?.name||"",
          league: d.competition?.name||code,
          time: m.utcDate ? new Date(m.utcDate).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT" : "TBD",
          source:"football-data.org",
        })).filter(m=>m.home&&m.away);
      } catch(e){return [];}
    })
  );
  return results.flatMap(r=>r.status==="fulfilled"?r.value:[]);
}

// ═══════════════════════════════════════════════════════════════
//  FIXTURE SOURCE 2: API-Football (1000+ leagues worldwide)
//  Sign up FREE at: dashboard.api-football.com
//  Free tier: 100 requests/day — covers EVERY league
// ═══════════════════════════════════════════════════════════════
async function fromAPIFootball(dateStr, apiKey) {
  if(!apiKey) return [];
  try {
    const r = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${dateStr}`,
      {
        headers:{
          "x-apisports-key": apiKey,
          "Accept":"application/json",
        },
        signal:AbortSignal.timeout(8000),
      }
    );
    if(!r.ok) return [];
    const d = await r.json();
    return (d.response||[]).map(f=>({
      home: f.teams?.home?.name||"",
      away: f.teams?.away?.name||"",
      league: `${f.league?.name||""} (${f.league?.country||""})`,
      time: f.fixture?.date
        ? new Date(f.fixture.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT"
        : "TBD",
      leagueId: f.league?.id,
      country: f.league?.country||"",
      source:"API-Football",
    })).filter(m=>m.home&&m.away);
  } catch(e){return [];}
}

// ═══════════════════════════════════════════════════════════════
//  Merge + deduplicate all fixture sources
// ═══════════════════════════════════════════════════════════════
const norm = s=>(s||"").toLowerCase()
  .replace(/\bfc\b|\bsc\b|\bac\b|\bafc\b|\bcf\b|\bfk\b|\bsk\b|\bif\b|\bbk\b/g,"")
  .replace(/[^a-z0-9]/g,"");

async function fetchAllFixtures(dateStr, fdKey, afKey) {
  const [fd, af] = await Promise.all([
    fromFootballData(dateStr, fdKey),
    fromAPIFootball(dateStr, afKey),
  ]);
  const all = [...fd, ...af];
  const seen = new Set();
  return all.filter(f=>{
    const k=norm(f.home)+norm(f.away);
    if(seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ═══════════════════════════════════════════════════════════════
//  Community tips from expert sites
// ═══════════════════════════════════════════════════════════════
async function fetchCommunityTips(claudeKey, fixtures, date) {
  if(!claudeKey||fixtures.length===0) return "";
  const sample = fixtures.slice(0,8).map(f=>`${f.home} vs ${f.away}`).join(", ");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{
        "Content-Type":"application/json","x-api-key":claudeKey,
        "anthropic-version":"2023-06-01","anthropic-beta":"web-search-2025-03-05",
      },
      body:JSON.stringify({
        model:"claude-haiku-4-5-20251001",max_tokens:1000,
        tools:[{type:"web_search_20250305",name:"web_search",max_uses:2}],
        messages:[{role:"user",content:
          `Search for football betting tips for ${date} from expert sites.\n`
          +`Search: "OLBG football tips ${date}" and "eagle predict ${date} football predictions"\n`
          +`Focus on these matches if found: ${sample}\n`
          +`Summarise briefly: which markets experts are backing and why. Bullet points only.`
        }],
      }),
    });
    const d = await r.json();
    return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
  } catch(e){return "";}
}

// ═══════════════════════════════════════════════════════════════
//  Validate AI tip is a real fixture
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
//  Analysis prompt with all professional factors
// ═══════════════════════════════════════════════════════════════
function buildPrompt(fixtures, date, communityTips="") {
  const list = fixtures.slice(0,30).map((f,i)=>`${i+1}. ${f.home} vs ${f.away} | ${f.league} | ${f.time}`).join("\n");
  const communitySection = communityTips
    ? `\n═══ EXPERT COMMUNITY TIPS (OLBG, Eagle Predict, Free Super Tips) ═══\n${communityTips}\nCross-reference these signals with your own analysis.\n`
    : "";
  return `Professional football betting analyst. Match date: ${date}.

VERIFIED REAL MATCHES FROM FOOTBALL-DATA.ORG + API-FOOTBALL (1000+ leagues):
${list}
${communitySection}
═══ MANDATORY ANALYSIS — check ALL for every tip ═══
1. FORM: Last 5-10 results, goals scored/conceded, streak & morale
2. HOME/AWAY: Separate home vs away record and goals this season
3. INJURIES/SUSPENSIONS: Missing strikers, defenders, playmakers + impact
4. MOTIVATION: Title, relegation, European spot, dead rubber, knockout cup
5. HEAD-TO-HEAD: Last 5-6 meetings — results, goals, psychological edge
6. TACTICS: Playing styles, how each team exploits opponent weaknesses
7. xG: Expected goals for/against, over/underperforming xG
8. STATS: Shots/game, possession, clean sheets, corners/cards per game
9. COACHING: Manager's flexibility, rotation, pressure response
10. CONDITIONS: Weather, pitch, travel fatigue, fixture congestion

═══ ALLOWED MARKETS ═══
Over/Under 1.5/2.5/3.5/4.5 Goals | BTTS Yes/No | 1st Half Over 0.5/1.5 |
2nd Half Over 0.5/1.5 | Over/Under 8.5/9.5/10.5/11.5 Corners |
Over/Under 3.5/4.5/5.5 Cards | Both Halves Over 0.5 Goals | Clean Sheet Yes

FORBIDDEN: Match winner, double chance, correct score, goalscorer, handicap.

Pick 8-10 tips from DIFFERENT leagues and DIFFERENT market types.
Include leagues like Championship, Belgian Pro League, Saudi, Turkish, German lower divisions — not just Champions League.
reasoning: 3-4 sentences with specific stats from factors above.
key_stats: 4-5 items — xG, form, H2H, injuries, community signals.
confidence: 65-92 range only. risk: LOW=80+, MEDIUM=65-79, HIGH<65.

Return ONLY a JSON array. Nothing before [ or after ]:
[{"match":"Home vs Away","league":"League (Country)","time":"HH:MM GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":84,"reasoning":"Home avg 2.6g/game at home (xG 2.1). Away striker suspended. H2H 4/5 had 3+ goals. OLBG: 71% backing Over 2.5.","key_stats":["Home xG 2.1/game","Away top scorer out","H2H: 4/5 had 3+ goals","Away: 2.3g conceded away","OLBG: 71% back Over 2.5"],"risk":"LOW"}]`;
}

// ═══════════════════════════════════════════════════════════════
//  AI callers
// ═══════════════════════════════════════════════════════════════
async function callClaude(key,p){
  if(!key) return "";
  try{
    const r=await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:2500,messages:[{role:"user",content:p}]}),
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
       body:JSON.stringify({contents:[{parts:[{text:p}]}],generationConfig:{maxOutputTokens:2500,temperature:0.1}})});
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
          {role:"system",content:"Football analyst. Respond ONLY with a JSON array starting with [ and ending with ]. No markdown, no other text."},
          {role:"user",content:p}
        ],
        max_tokens:2500,temperature:0.1,
      }),
    });
    const d=await r.json();
    return d.choices?.[0]?.message?.content||"";
  }catch(e){return "";}
}

// ═══════════════════════════════════════════════════════════════
//  Parse + validate
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ═══════════════════════════════════════════════════════════════
export default async function handler(req){
  if(req.method!=="POST") return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers:H});

  const claudeKey  = process.env.ANTHROPIC_API_KEY;
  const geminiKey  = process.env.GEMINI_API_KEY   ||"";
  const groqKey    = process.env.GROQ_API_KEY      ||"";
  const fdKey      = process.env.FOOTBALL_API_KEY  ||"";
  const afKey      = process.env.API_FOOTBALL_KEY  ||"";

  if(!claudeKey) return new Response(JSON.stringify({error:"ANTHROPIC_API_KEY not set."}),{status:500,headers:H});
  if(!fdKey&&!afKey) return new Response(JSON.stringify({
    error:"No fixture API key set. Add FOOTBALL_API_KEY (football-data.org) and/or API_FOOTBALL_KEY (api-football.com) to Vercel environment variables."
  }),{status:500,headers:H});

  let today=new Date().toISOString().split("T")[0];
  try{const b=await req.json();if(b.date)today=b.date;}catch(e){}

  try{
    // Step 1: Get real fixtures from both sources
    const fixtures=await fetchAllFixtures(today,fdKey,afKey);

    if(fixtures.length===0) return new Response(JSON.stringify({
      tips:[],count:0,date:today,fixturesFound:0,
      message:`No matches found for ${today}. Leagues may be on break — try again tomorrow.`,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"no-store"}});

    // Step 2: Get community tips from expert sites
    const communityTips=await fetchCommunityTips(claudeKey,fixtures,today);

    // Step 3: All 3 AIs analyse simultaneously
    const prompt=buildPrompt(fixtures,today,communityTips);
    const [cRaw,gRaw,qRaw]=await Promise.all([
      callClaude(claudeKey,prompt),
      callGemini(geminiKey,prompt),
      callGroq(groqKey,prompt),
    ]);

    // Step 4: Parse, validate, merge
    const cT=parse(cRaw,"Claude",fixtures);
    const gT=parse(gRaw,"Gemini",fixtures);
    const qT=parse(qRaw,"Groq",  fixtures);
    const tips=merge([cT,gT,qT]);
    const activeAIs=[cT.length?"Claude":null,gT.length?"Gemini":null,qT.length?"Groq":null].filter(Boolean);
    const sources=[...new Set(fixtures.map(f=>f.source))];

    if(tips.length===0) return new Response(JSON.stringify({
      tips:[],count:0,date:today,fixturesFound:fixtures.length,activeAIs,sources,
      message:`Found ${fixtures.length} matches but tips failed validation. Try again.`,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"no-store"}});

    return new Response(JSON.stringify({
      tips,count:tips.length,date:today,
      fixturesFound:fixtures.length,sources,activeAIs,
      generatedAt:Date.now(),
    }),{status:200,headers:{...H,"Cache-Control":"s-maxage=1800"}});

  }catch(err){
    return new Response(JSON.stringify({error:err.message||"Server error"}),{status:500,headers:H});
  }
}
