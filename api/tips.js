export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") return res.status(405).json({ error:"Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error:"ANTHROPIC_API_KEY not set in Vercel." });

  try {
    const today     = new Date().toISOString().split("T")[0];
    const dayOfWeek = new Date().toLocaleDateString("en-US", { weekday:"long" });

    // ── STEP 1: Fetch today's real fixtures from TheSportsDB ─────
    let todayMatches = [];
    try {
      const fRes = await fetch(
        "https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=" + today + "&s=Soccer",
        { signal: AbortSignal.timeout(5000) }
      );
      const fData = await fRes.json();
      const TOP = ["Champions","Europa","Premier","La Liga","Serie A","Bundesliga",
                   "Ligue 1","MLS","Saudi","Eredivisie","Liga Portugal","Championship"];
      todayMatches = (fData?.events || [])
        .filter(e => TOP.some(t => (e.strLeague||"").includes(t)))
        .slice(0, 14)
        .map(e => (e.strHomeTeam + " vs " + e.strAwayTeam + " | " + e.strLeague + " | " + (e.strTime||"TBD").substring(0,5) + " GMT"));
    } catch(e) { console.log("Fixtures fetch failed:", e.message); }

    // ── STEP 2: Build prompt ──────────────────────────────────────
    const fixtureSection = todayMatches.length > 0
      ? "TODAY'S REAL FIXTURES (" + today + ") — ONLY analyse these matches:\n" + todayMatches.map((m,i) => (i+1)+". "+m).join("\n")
      : "No live fixture data available. Use your knowledge of matches typically scheduled on " + dayOfWeek + " " + today + " in major European/world competitions.";

    const prompt = "You are an elite football betting analyst. Today is " + dayOfWeek + " " + today + ".\n\n"
      + fixtureSection + "\n\n"
      + "Analyse the matches above using your knowledge of:\n"
      + "- Both teams goals per game average this season\n"
      + "- Home/away scoring records\n"
      + "- Head-to-head historical goal averages\n"
      + "- Key missing players (attackers/defenders)\n"
      + "- Playing style and tactical setup\n\n"
      + "Generate 6-8 tips from ONLY these markets:\n"
      + "- Over/Under 1.5 Goals\n"
      + "- Over/Under 2.5 Goals\n"
      + "- Over/Under 3.5 Goals\n"
      + "- Both Teams to Score (BTTS Yes)\n"
      + "- Both Teams to Score (BTTS No)\n"
      + "- First Half Over 0.5 Goals\n"
      + "- First Half Over 1.5 Goals\n\n"
      + "FORBIDDEN: Match result, double chance, correct score, goalscorer, cards, corners.\n\n"
      + "Return ONLY a valid JSON array, zero other text:\n"
      + '[{"match":"Team A vs Team B","league":"League","time":"20:00 GMT","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.75-1.95","confidence":85,"reasoning":"Both teams average 2.8 goals per game. H2H last 5 produced 3+ goals each time.","key_stats":["Home 2.9 g/game","Away scored in 9/10 away","H2H avg 3.2 goals"],"risk":"LOW"}]';

    // ── STEP 3: Call Claude ───────────────────────────────────────
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2500,
        messages: [{ role:"user", content:prompt }],
      }),
      signal: AbortSignal.timeout(25000),
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) return res.status(500).json({ error: aiData?.error?.message || "Anthropic error" });

    const rawText = (aiData.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(500).json({ error:"AI did not return tips. Try again." });

    let tips = [];
    try { tips = JSON.parse(jsonMatch[0]); }
    catch(e) { return res.status(500).json({ error:"Could not parse AI response. Try again." }); }

    tips = tips
      .filter(t => t.match && t.market && t.pick)
      .map(t => ({
        ...t,
        id: Math.random().toString(36).substr(2,8),
        confidence: Math.min(Math.max(parseInt(t.confidence)||70, 50), 98),
        risk: t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
        generatedAt: Date.now(),
        isLiveFixture: todayMatches.some(f => f.toLowerCase().includes((t.match||"").split(" vs ")[0].toLowerCase())),
      }));

    return res.status(200).json({
      tips, count:tips.length, date:today,
      fixturesFound: todayMatches.length,
      generatedAt: Date.now(),
    });

  } catch(err) {
    return res.status(500).json({ error: err.message||"Server error" });
  }
}
