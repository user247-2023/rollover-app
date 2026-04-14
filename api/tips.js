export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error:"Method not allowed" }), {
      status:405, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error:"ANTHROPIC_API_KEY not set." }), {
      status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}
    });
  }

  const today = new Date().toISOString().split("T")[0];

  const prompt =
    "Search: 'football matches " + today + "'\n"
  + "Search: 'Champions League Europa League fixtures " + today + "'\n\n"
  + "List ONLY matches confirmed for today " + today + " from search results. No guessing.\n\n"
  + "For each real match, give ONE goals-only tip:\n"
  + "Markets allowed: Over/Under 1.5, 2.5, 3.5 Goals | BTTS Yes/No | 1st Half Over 0.5 or 1.5\n"
  + "Forbidden: match winner, double chance, correct score, goalscorer.\n\n"
  + "Return ONLY JSON array, no other text:\n"
  + '[{"match":"A vs B","league":"League","time":"20:45 GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":82,"reasoning":"Stats reason.","key_stats":["stat1","stat2","stat3"],"risk":"LOW"}]';

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
        model:"claude-haiku-4-5-20251001",
        max_tokens:1500,
        tools:[{ type:"web_search_20250305", name:"web_search", max_uses:3 }],
        messages:[{ role:"user", content:prompt }],
      }),
    });

    const aiData = await aiRes.json();

    if (!aiRes.ok) {
      return new Response(
        JSON.stringify({ error: aiData?.error?.message || "API error "+aiRes.status }),
        { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    const rawText = (aiData.content||[])
      .filter(b => b.type==="text")
      .map(b => b.text)
      .join("").trim();

    if (!rawText || rawText === "[]") {
      return new Response(
        JSON.stringify({ tips:[], count:0, date:today, message:"No matches found for today. Try again later.", generatedAt:Date.now() }),
        { status:200, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return new Response(
        JSON.stringify({ error:"No JSON returned. Try again." }),
        { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    let tips = [];
    try { tips = JSON.parse(jsonMatch[0]); }
    catch(e) { return new Response(JSON.stringify({ error:"Parse failed. Try again." }), { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }); }

    tips = tips
      .filter(t => t.match && t.market && t.pick)
      .map(t => ({
        ...t,
        id: Math.random().toString(36).substr(2,8),
        confidence: Math.min(Math.max(parseInt(t.confidence)||70,50),98),
        risk: t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
        generatedAt: Date.now(),
      }));

    return new Response(
      JSON.stringify({ tips, count:tips.length, date:today, generatedAt:Date.now() }),
      { status:200, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Cache-Control":"s-maxage=1800"} }
    );

  } catch(err) {
    return new Response(
      JSON.stringify({ error: err.message||"Server error" }),
      { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
    );
  }
}
