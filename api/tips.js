// ╔══════════════════════════════════════════════════════════════╗
// ║     ROLLOVER AI TIPS ENGINE — Vercel Serverless Function     ║
// ║     Uses Claude AI + Web Search to analyze matches           ║
// ║     Focuses ONLY on goals-based betting markets              ║
// ╚══════════════════════════════════════════════════════════════╝

const SYSTEM_PROMPT = `You are an elite football betting analyst specialising exclusively in GOALS-BASED markets.

Your job is to analyse today's football matches using current form, statistics, head-to-head records, team news, and tactical patterns — then recommend bets from the following markets ONLY:

ALLOWED MARKETS (goals-based only):
- Over/Under 1.5 Goals
- Over/Under 2.5 Goals  
- Over/Under 3.5 Goals
- Over/Under 4.5 Goals
- Both Teams to Score (BTTS - Yes)
- Both Teams to Score (BTTS - No)
- First Half Over/Under 0.5 Goals
- First Half Over/Under 1.5 Goals
- Asian Total Goals (Over/Under lines like 2, 2.5, 3)
- Total Match Goals - Exact Band (e.g. 1-2 goals, 3-4 goals)
- Either Team to Score in Both Halves
- Over 0.5 Goals in Each Half

STRICTLY FORBIDDEN MARKETS:
- Match result (1X2) — NO straight wins
- Double chance (1X, X2, 12)
- Draw no bet
- Correct score
- Handicap (team-based)
- Anytime scorer / goalscorer markets
- Cards / corners

For each recommendation output ONLY valid JSON — no markdown, no explanation outside JSON.

Output format (array of tip objects):
[
  {
    "match": "Team A vs Team B",
    "league": "League Name",
    "time": "HH:MM GMT",
    "market": "Market name exactly as above",
    "pick": "e.g. Over 2.5 Goals",
    "odds_range": "1.10-1.20" or "1.20-1.35" or "1.35-1.60" or "1.60+",
    "confidence": 85,
    "reasoning": "Concise 2-3 sentence analysis referencing specific stats/form",
    "key_stats": ["Stat 1", "Stat 2", "Stat 3"],
    "risk": "LOW" or "MEDIUM" or "HIGH"
  }
]

Provide 6-8 tips. Sort by confidence descending. Be specific and data-driven. Reference actual current form and statistics you find.`;

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key not configured" }), { status: 500 });
  }

  try {
    const body = await req.json();
    const { planOdds = [1.10, 1.20, 1.50], date = new Date().toISOString().split("T")[0] } = body;

    const userPrompt = `Today is ${date}. 

Search for today's major football matches across these leagues: Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, Europa League, MLS, and any other top leagues playing today.

For each match found, deeply analyse:
1. Both teams' last 5 match goal tallies (home and away separately)
2. Head-to-head goal averages from last 5 meetings
3. League position and recent form momentum
4. Any missing key attackers or defenders (affects goal likelihood)
5. Match context (must-win, dead rubber, cup vs league priority)
6. Average goals per game for both teams this season

The user's rollover plan uses odds around ${planOdds.join(", ")}. 
Prioritise finding tips in the odds range 1.10-1.60 for goals markets.

Search multiple sources: BBC Sport, ESPN FC, SofaScore, Flashscore, WhoScored, FBref, Understat — cross-reference statistics.

Return ONLY the JSON array of tips. No other text.`;

    // Call Claude with web search tool
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return new Response(JSON.stringify({ error: "AI error", detail: err }), { status: 500 });
    }

    const data = await response.json();

    // Extract text from response
    const textBlocks = data.content?.filter(b => b.type === "text") || [];
    const rawText = textBlocks.map(b => b.text).join("\n");

    // Parse JSON from response
    let tips = [];
    try {
      // Find JSON array in response
      const match = rawText.match(/\[[\s\S]*\]/);
      if (match) tips = JSON.parse(match[0]);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Parse error", raw: rawText.slice(0,500) }), { status: 500 });
    }

    // Validate and clean tips
    tips = tips
      .filter(t => t.match && t.market && t.pick && t.confidence)
      .map(t => ({
        ...t,
        confidence: Math.min(Math.max(parseInt(t.confidence)||70, 50), 98),
        risk: t.risk || (t.confidence >= 80 ? "LOW" : t.confidence >= 65 ? "MEDIUM" : "HIGH"),
        id: Math.random().toString(36).substr(2, 8),
        generatedAt: Date.now(),
      }));

    return new Response(
      JSON.stringify({ tips, count: tips.length, date, generatedAt: Date.now() }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "s-maxage=1800", // cache 30 mins
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
