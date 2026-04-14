export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Vercel environment variables." });
  }

  try {
    const date = new Date().toISOString().split("T")[0];
    const dayOfWeek = new Date().toLocaleDateString("en-US", { weekday: "long" });

    const prompt = `You are an elite football betting analyst. Today is ${dayOfWeek}, ${date}.

Using your knowledge of current football statistics, team form, and goal-scoring patterns across major leagues, generate exactly 7 betting tips.

ONLY use these goal markets (NO wins, NO double chance):
- Over/Under 1.5 Goals
- Over/Under 2.5 Goals  
- Over/Under 3.5 Goals
- Both Teams to Score (BTTS Yes)
- Both Teams to Score (BTTS No)
- First Half Over 0.5 Goals
- First Half Over 1.5 Goals

Choose realistic matches from Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League or Europa League.

Return ONLY a JSON array, no other text:
[{"match":"Team A vs Team B","league":"League","time":"15:00 GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.70-1.90","confidence":84,"reasoning":"Both teams average over 2.5 goals per game. Last 5 meetings produced 3+ goals each.","key_stats":["Home team 2.8 goals/game","Away team scored in 9 of last 10","H2H avg 3.1 goals"],"risk":"LOW"}]`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: data?.error?.message || "Anthropic API error" });
    }

    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const rawText = textBlocks.map(b => b.text).join("").trim();
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      return res.status(500).json({ error: "AI did not return JSON. Try again." });
    }

    let tips = [];
    try { tips = JSON.parse(jsonMatch[0]); }
    catch(e) { return res.status(500).json({ error: "Failed to parse AI response. Try again." }); }

    tips = tips
      .filter(t => t.match && t.market && t.pick)
      .map(t => ({
        ...t,
        id: Math.random().toString(36).substr(2, 8),
        confidence: Math.min(Math.max(parseInt(t.confidence) || 70, 50), 98),
        risk: t.risk || (t.confidence >= 80 ? "LOW" : t.confidence >= 65 ? "MEDIUM" : "HIGH"),
        generatedAt: Date.now(),
      }));

    return res.status(200).json({ tips, count: tips.length, date, generatedAt: Date.now() });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Unexpected error" });
  }
}
