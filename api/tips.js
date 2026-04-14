export const config = { maxDuration: 30 };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json" }
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured in Vercel." }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const date = body.date || new Date().toISOString().split("T")[0];
    const dayOfWeek = new Date(date).toLocaleDateString("en-US", { weekday: "long" });

    const prompt = `You are an elite football betting analyst. Today is ${dayOfWeek}, ${date}.

Based on your deep knowledge of current football statistics, team form, head-to-head records, playing styles, and tactical tendencies across all major leagues — generate 7 high-quality betting tips for matches likely playing today or this week.

Use your knowledge of:
- Each team's average goals per game this season
- Home vs away goal-scoring records
- Head-to-head historical goal averages
- Teams known for high/low scoring games
- Defensive vs attacking tactical setups
- Recent injuries to key attackers or defenders

ONLY suggest these goal markets:
- Over/Under 1.5 Goals
- Over/Under 2.5 Goals
- Over/Under 3.5 Goals
- Both Teams to Score (BTTS Yes)
- Both Teams to Score (BTTS No)
- First Half Over 0.5 Goals
- First Half Over 1.5 Goals

DO NOT suggest: match result wins, double chance, correct score, goalscorer, cards, corners.

Pick matches from: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, Europa League, MLS, or other top leagues.

Prioritise tips with odds roughly in the 1.60-2.20 range for goals markets.

Return ONLY a valid JSON array — no markdown, no explanation, no extra text. Just the array:

[
  {
    "match": "Exact Team A vs Exact Team B",
    "league": "League Name",
    "time": "estimated kickoff e.g. 15:00 GMT",
    "market": "Over/Under 2.5 Goals",
    "pick": "Over 2.5 Goals",
    "odds_range": "1.70-1.90",
    "confidence": 84,
    "reasoning": "Specific 2-3 sentence analysis with concrete stats and reasoning",
    "key_stats": [
      "Specific stat about home team goals",
      "Specific stat about away team goals",
      "H2H or tactical insight"
    ],
    "risk": "LOW"
  }
]

Risk levels: LOW = confidence 80+, MEDIUM = 65-79, HIGH = below 65.
Generate exactly 7 tips. Sort by confidence descending. Be specific with team names and stats.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: data?.error?.message || `Anthropic error ${response.status}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const rawText = textBlocks.map(b => b.text).join("\n").trim();

    // Extract JSON array
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return new Response(
        JSON.stringify({ error: "AI response did not contain JSON. Try again.", raw: rawText.slice(0, 200) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    let tips = [];
    try {
      tips = JSON.parse(jsonMatch[0]);
    } catch(e) {
      return new Response(
        JSON.stringify({ error: "Failed to parse AI JSON response. Try again." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

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
      JSON.stringify({ error: err.message || "Unexpected server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
