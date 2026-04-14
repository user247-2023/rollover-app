export const config = { runtime: "edge" };

export default async function handler(req) {
  const H = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"};
  if (req.method !== "POST") return new Response(JSON.stringify({error:"Method not allowed"}),{status:405,headers:H});

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || "";
  const groqKey   = process.env.GROQ_API_KEY   || "";
  if (!claudeKey) return new Response(JSON.stringify({error:"ANTHROPIC_API_KEY not set."}),{status:500,headers:H});

  let today = new Date().toISOString().split("T")[0];
  try { const b = await req.json(); if(b.date) today = b.date; } catch(e){}

  // ONE combined prompt: search + analyse + return JSON
  const prompt =
    "Today is " + today + ". Search the web for 'football fixtures " + today + "' and 'soccer matches today " + today + "'.\n\n"
  + "From the search results, pick the 6 best matches to analyse for betting.\n\n"
  + "For each match analyse: recent form, head-to-head goals, home/away record, injuries/suspensions.\n\n"
  + "Suggest ONE tip per match. Use ONLY these markets:\n"
  + "Over/Under 1.5 Goals, Over/Under 2.5 Goals, Over/Under 3.5 Goals, BTTS Yes, BTTS No, "
  + "First Half Over 0.5 Goals, First Half Over 1.5 Goals, Over/Under 8.5 Corners, "
  + "Over/Under 9.5 Corners, Over/Under 3.5 Cards, Over/Under 4.5 Cards.\n\n"
  + "NEVER suggest: match winner, double chance, correct score, goalscorer.\n\n"
  + "You MUST return ONLY a raw JSON array. Start your response with [ and end with ]. No other text:\n"
  + '[{"match":"Team A vs Team B","league":"League (Country)","time":"20:45 GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":82,"reasoning":"Both teams avg 2.4 goals/game. H2H last 5: avg 3.1 goals. No key injuries.","key_stats":["Home: 2.4 goals/game","Away: scored in 8/10 away","H2H avg 3.1 goals"],"risk":"LOW"}]';

  async function callClaude() {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":claudeKey,"anthropic-version":"2023-06-01","anthropic-beta":"web-search-2025-03-05"},
        body:JSON.stringify({
          model:"claude-haiku-4-5-20251001",
          max_tokens:2000,
          tools:[{type:"web_search_20250305",name:"web_search",max_uses:2}],
          messages:[{role:"user",content:prompt}],
        }),
      });
      const d = await r.json();
      return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    } catch(e){ return ""; }
  }

  async function callGemini() {
    if(!geminiKey) return "";
    try {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key="+geminiKey,
        {method:"POST",headers:{"Content-Type":"application/json"},
         body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:2000,temperature:0.2}})}
      );
      const d = await r.json();
      return d.candidates?.[0]?.content?.parts?.[0]?.text||"";
    } catch(e){ return ""; }
  }

  async function callGroq() {
    if(!groqKey) return "";
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions",{
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+groqKey},
        body:JSON.stringify({model:"llama-3.1-8b-instant",messages:[{role:"user",content:prompt}],max_tokens:2000,temperature:0.2}),
      });
      const d = await r.json();
      return d.choices?.[0]?.message?.content||"";
    } catch(e){ return ""; }
  }

  function parse(text, aiName) {
    if(!text||text.length<10) return [];
    // Try to find JSON array - greedy match
    const m = text.match(/\[[\s\S]*\]/);
    if(!m) return [];
    try {
      const arr = JSON.parse(m[0]);
      return arr
        .filter(t=>t&&t.match&&t.market&&t.pick)
        .map(t=>({
          ...t,
          id:Math.random().toString(36).substr(2,8),
          confidence:Math.min(Math.max(parseInt(t.confidence)||72,50),98),
          risk:t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
          ais:[aiName],votes:1,confs:[parseInt(t.confidence)||72],
          generatedAt:Date.now(),
        }));
    } catch(e){ return []; }
  }

  function merge(arrays) {
    const map = {};
    arrays.forEach((tips,idx)=>{
      const name=["Claude","Gemini","Groq"][idx];
      tips.forEach(t=>{
        const key=(t.match||"").toLowerCase().replace(/\s/g,"")
                 +"|"+(t.pick||"").toLowerCase().replace(/\s/g,"");
        if(!map[key]){ map[key]={...t,ais:[],votes:0,confs:[]}; }
        if(!map[key].ais.includes(name)) map[key].ais.push(name);
        map[key].votes++;
        map[key].confs.push(parseInt(t.confidence)||72);
        if((t.reasoning||"").length>(map[key].reasoning||"").length) map[key].reasoning=t.reasoning;
        if(t.key_stats) map[key].key_stats=[...new Set([...(map[key].key_stats||[]),...t.key_stats])].slice(0,5);
      });
    });
    return Object.values(map).map(t=>({
      ...t,
      confidence:Math.min(98,Math.round(t.confs.reduce((a,b)=>a+b,0)/t.confs.length+(t.votes===2?5:t.votes===3?10:0))),
      multiAI:t.votes>=2, confirmed:t.votes>=3, aiCount:t.votes,
    })).sort((a,b)=>b.confirmed-a.confirmed||b.multiAI-a.multiAI||b.confidence-a.confidence);
  }

  try {
    const [cRaw,gRaw,qRaw] = await Promise.all([callClaude(),callGemini(),callGroq()]);
    const tips = merge([parse(cRaw,"Claude"),parse(gRaw,"Gemini"),parse(qRaw,"Groq")]);

    const activeAIs=["Claude","Gemini","Groq"].filter((_,i)=>[parse(cRaw,"Claude"),parse(gRaw,"Gemini"),parse(qRaw,"Groq")][i].length>0);

    if(tips.length===0) return new Response(JSON.stringify({
      tips:[],count:0,date:today,
      message:"No tips generated for today "+today+". Matches may not have started yet — try again in a few hours.",
      generatedAt:Date.now()
    }),{status:200,headers:{...H,"Cache-Control":"no-store"}});

    return new Response(JSON.stringify({
      tips,count:tips.length,date:today,activeAIs,generatedAt:Date.now()
    }),{status:200,headers:{...H,"Cache-Control":"s-maxage=1800"}});

  } catch(err){
    return new Response(JSON.stringify({error:err.message||"Server error"}),{status:500,headers:H});
  }
}
