// Edge runtime — 30 second limit, supports streaming
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error:"Method not allowed" }), {
      status:405, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error:"ANTHROPIC_API_KEY not set in Vercel." }), {
      status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
    });
  }

  const today = new Date().toISOString().split("T")[0];
  const dayOfWeek = new Date().toLocaleDateString("en-US",{weekday:"long"});

  const prompt =
    "You are a football betting analyst. Today's date is " + dayOfWeek + " " + today + ".\n\n"
  + "STEP 1 — Search the web RIGHT NOW for: 'football matches today " + today + "'\n"
  + "Also search: 'UEFA Champions League fixtures " + today + "'\n"
  + "Also search: 'Premier League La Liga Serie A Bundesliga matches " + today + "'\n\n"
  + "STEP 2 — From your search results, list ONLY the actual matches scheduled for today " + today + ". "
  + "Do NOT use any matches from other dates. Do NOT invent matches.\n\n"
  + "STEP 3 — For each real match found, analyse goals potential using:\n"
  + "- Both teams average goals per game this season (search if needed)\n"
  + "- Head-to-head goal history\n"
  + "- Home/away scoring records\n"
  + "- Missing key players\n\n"
  + "STEP 4 — Return ONLY a JSON array of 6-8 tips using ONLY these markets:\n"
  + "Over/Under 1.5 Goals, Over/Under 2.5 Goals, Over/Under 3.5 Goals, "
  + "BTTS Yes, BTTS No, First Half Over 0.5 Goals, First Half Over 1.5 Goals.\n\n"
  + "FORBIDDEN markets: match winner, double chance, correct score, goalscorer, cards, corners.\n\n"
  + "Return ONLY this JSON, zero other text:\n"
  + '[{"match":"Real Team A vs Real Team B","league":"League","time":"20:45 GMT",'
  + '"market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.75-1.95",'
  + '"confidence":85,"reasoning":"Specific stat-based reason.","key_stats":["stat1","stat2","stat3"],'
  + '"risk":"LOW"}]';

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key": apiKey,
        "anthropic-version":"2023-06-01",
        "anthropic-beta":"web-search-2025-03-05",
      },
      body: JSON.stringify({
        model:"claude-sonnet-4-5",
        max_tokens:3000,
        tools:[{ type:"web_search_20250305", name:"web_search" }],
        messages:[{ role:"user", content:prompt }],
      }),
    });

    const aiData = await aiRes.json();

    if (!aiRes.ok) {
      return new Response(
        JSON.stringify({ error: aiData?.error?.message || "Anthropic API error: "+aiRes.status }),
        { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    // Get all text blocks (after web search tool use)
    const rawText = (aiData.content||[])
      .filter(b => b.type==="text")
      .map(b => b.text)
      .join("")
      .trim();

    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return new Response(
        JSON.stringify({ error:"AI returned no valid tips. Try again.", debug: rawText.slice(0,300) }),
        { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    let tips = [];
    try { tips = JSON.parse(jsonMatch[0]); }
    catch(e) {
      return new Response(
        JSON.stringify({ error:"Could not parse tips JSON. Try again." }),
        { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    tips = tips
      .filter(t => t.match && t.market && t.pick)
      .map(t => ({
        ...t,
        id: Math.random().toString(36).substr(2,8),
        confidence: Math.min(Math.max(parseInt(t.confidence)||70, 50), 98),
        risk: t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
        generatedAt: Date.now(),
      }));

    return new Response(
      JSON.stringify({ tips, count:tips.length, date:today, generatedAt:Date.now() }),
      { status:200, headers:{
        "Content-Type":"application/json",
        "Access-Control-Allow-Origin":"*",
        "Cache-Control":"s-maxage=1800",
      }}
    );

  } catch(err) {
    return new Response(
      JSON.stringify({ error: err.message || "Server error" }),
      { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
    );
  }
}
