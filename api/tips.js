export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" }
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set in Vercel environment variables." }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const date = body.date || new Date().toISOString().split("T")[0];

    const prompt = `Today is ${date}. You are an elite football betting analyst.

Search the web for today's football matches across Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, Europa League and any other top leagues playing today.

For each match analyse current form, head-to-head goal records, average goals per game, and team news.

Return ONLY a JSON array of 6-8 betting tips focused EXCLUSIVELY on goals markets.

ALLOWED markets:
- Over/Under 1.5 Goals
- Over/Under 2.5 Goals
- Over/Under 3.5 Goals
- Both Teams to Score (BTTS Yes)
- Both Teams to Score (BTTS No)
- First Half Over/Under 0.5 Goals
- First Half Over/Under 1.5 Goals

FORBIDDEN: Match result wins, double chance, correct score, goalscorer markets.

Return ONLY this JSON format, nothing else:
[
  {
    "match": "Team A vs Team B",
    "league": "League Name",
    "time": "HH:MM GMT",
    "market": "Over/Under 2.5 Goals",
    "pick": "Over 2.5 Goals",
    "odds_range": "1.80-2.00",
    "confidence": 82,
    "reasoning": "Both teams average 2.8 goals per game this season. Last 5 H2H averaged 3.2 goals. Home side missing defensive midfielder.",
    "key_stats": ["Home team: 3.1 goals/game avg", "Away team scored in last 8 away games", "H2H last 5: 3-1, 2-2, 4-1, 1-1, 3-0"],
    "risk": "LOW"
  }
]`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: data?.error?.message || "Anthropic API error", code: response.status }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Extract all text blocks
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const rawText = textBlocks.map(b => b.text).join("\n");

    // Parse JSON array from response
    let tips = [];
    const match = rawText.match(/\[[\s\S]*\]/);
    if (match) {
      try { tips = JSON.parse(match[0]); } catch(e) {
        return new Response(
          JSON.stringify({ error: "Could not parse AI response as JSON.", raw: rawText.slice(0, 300) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    } else {
      return new Response(
        JSON.stringify({ error: "AI did not return a JSON array.", raw: rawText.slice(0, 300) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Clean tips
    tips = tips
      .filter(t => t.match && t.market && t.pick)
      .map(t => ({
        ...t,
        id: Math.random().toString(36).substr(2, 8),
        confidence: Math.min(Math.max(parseInt(t.confidence) || 70, 50), 98),
        risk: t.risk || (t.confidence >= 80 ? "LOW" : t.confidence >= 65 ? "MEDIUM" : "HIGH"),
        generatedAt: Date.now(),
      }));

    return new Response(
      JSON.stringify({ tips, count: tips.length, date, generatedAt: Date.now() }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "s-maxage=1800",
        },
      }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Unknown server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
