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
    "Search the web for EXACTLY this query: 'football fixtures " + today + " site:bbc.co.uk OR site:skysports.com OR site:espn.com OR site:uefa.com'\n\n"
  + "Then search: 'UEFA Champions League " + today + " fixtures'\n"
  + "Then search: 'UEFA Europa League " + today + " fixtures'\n"
  + "Then search: 'Premier League fixtures " + today + "'\n\n"
  + "CRITICAL RULES:\n"
  + "1. ONLY include matches you found in search results with a real source. If you are not 100% certain a match is today " + today + ", DO NOT include it.\n"
  + "2. DO NOT use any match from your training data. ONLY use what you find in web search results right now.\n"
  + "3. If you cannot find any verified matches for today, return an empty array [].\n"
  + "4. Every match must have the correct kickoff time from the search results.\n\n"
  + "ALLOWED BETTING MARKETS (goals only):\n"
  + "Over 1.5 Goals, Over 2.5 Goals, Over 3.5 Goals, Under 1.5 Goals, Under 2.5 Goals, BTTS Yes, BTTS No, First Half Over 0.5, First Half Over 1.5\n\n"
  + "FORBIDDEN: Any match result bet, double chance, correct score, goalscorer, cards, corners.\n\n"
  + "For each real verified match, give a goals market tip with analysis based on current season stats you find via search.\n\n"
  + "Return ONLY a JSON array. No text outside it. Empty array if no matches found:\n"
  + '[{"match":"Team A vs Team B","league":"Competition Name","time":"20:45 GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.80-2.00","confidence":83,"reasoning":"Two sentences of specific stat-based reasoning from search results.","key_stats":["Home avg 2.4 goals/game","Away scored in last 7 away","H2H: 4 of last 5 had 3+ goals"],"risk":"LOW"}]';

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
        max_tokens:4000,
        tools:[{
          type:"web_search_20250305",
          name:"web_search",
          max_uses: 6,
        }],
        messages:[{ role:"user", content:prompt }],
      }),
    });

    const aiData = await aiRes.json();

    if (!aiRes.ok) {
      return new Response(
        JSON.stringify({ error: aiData?.error?.message || "Anthropic error "+aiRes.status }),
        { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    const rawText = (aiData.content||[])
      .filter(b => b.type==="text")
      .map(b => b.text)
      .join("")
      .trim();

    // Handle empty array (no matches today)
    if (rawText.trim() === "[]" || rawText.trim() === "") {
      return new Response(
        JSON.stringify({
          tips: [], count:0, date:today,
          message: "No verified matches found for today "+today+". Check back on a matchday.",
          generatedAt: Date.now()
        }),
        { status:200, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return new Response(
        JSON.stringify({ error:"AI returned no JSON. Try again.", raw:rawText.slice(0,200) }),
        { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

    let tips = [];
    try { tips = JSON.parse(jsonMatch[0]); }
    catch(e) {
      return new Response(
        JSON.stringify({ error:"JSON parse failed. Try again." }),
        { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
      );
    }

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
      { status:200, headers:{
        "Content-Type":"application/json",
        "Access-Control-Allow-Origin":"*",
        "Cache-Control":"s-maxage=1800",
      }}
    );

  } catch(err) {
    return new Response(
      JSON.stringify({ error: err.message||"Server error" }),
      { status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"} }
    );
  }
}
