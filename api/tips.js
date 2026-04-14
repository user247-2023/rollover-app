export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") return res.status(405).json({ error:"Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error:"ANTHROPIC_API_KEY not configured." });

  try {
    const today = new Date().toISOString().split("T")[0]; // 2026-04-14
    const dayOfWeek = new Date().toLocaleDateString("en-US",{weekday:"long"});

    // ── STEP 1: Fetch TODAY's real fixtures from ESPN (free, no key) ──
    const ESPN_LEAGUES = [
      { id:"uefa.champions_league", name:"UEFA Champions League" },
      { id:"uefa.europa",           name:"UEFA Europa League" },
      { id:"uefa.europa_conf",      name:"UEFA Conference League" },
      { id:"eng.1",                 name:"Premier League" },
      { id:"esp.1",                 name:"La Liga" },
      { id:"ita.1",                 name:"Serie A" },
      { id:"ger.1",                 name:"Bundesliga" },
      { id:"fra.1",                 name:"Ligue 1" },
      { id:"usa.1",                 name:"MLS" },
      { id:"por.1",                 name:"Primeira Liga" },
      { id:"ned.1",                 name:"Eredivisie" },
      { id:"eng.2",                 name:"Championship" },
    ];

    // Fetch all leagues in parallel
    const fetchLeague = async (league) => {
      try {
        const r = await fetch(
          "https://site.api.espn.com/apis/site/v2/sports/soccer/" + league.id + "/scoreboard",
          { signal: AbortSignal.timeout(5000) }
        );
        const d = await r.json();
        return (d.events || []).map(e => {
          const comp = e.competitions?.[0];
          const home = comp?.competitors?.find(c => c.homeAway==="home")?.team?.displayName || "";
          const away = comp?.competitors?.find(c => c.homeAway==="away")?.team?.displayName || "";
          const time = e.date ? new Date(e.date).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" GMT" : "TBD";
          const status = comp?.status?.type?.name || "";
          return home && away ? { match: home+" vs "+away, league: league.name, time, status } : null;
        }).filter(Boolean);
      } catch(e) { return []; }
    };

    const results = await Promise.all(ESPN_LEAGUES.map(fetchLeague));
    const allMatches = results.flat();

    // Only keep scheduled/upcoming (not finished)
    const fixtures = allMatches
      .filter(m => !m.status.includes("Final") && !m.status.includes("Full"))
      .slice(0, 16);

    if (fixtures.length === 0) {
      return res.status(200).json({
        tips: [],
        count: 0,
        date: today,
        fixturesFound: 0,
        message: "No major football matches found today. Try again tomorrow or on a matchday.",
        generatedAt: Date.now(),
      });
    }

    // ── STEP 2: Build prompt with ONLY today's real matches ──────────
    const matchList = fixtures.map((m,i) =>
      (i+1)+". "+m.match+" | "+m.league+" | "+m.time
    ).join("\n");

    const prompt =
      "You are an elite football betting analyst. Today is "+dayOfWeek+" "+today+".\n\n"
    + "THESE ARE THE ONLY REAL MATCHES PLAYING TODAY. Analyse ONLY these — do not add any other matches:\n\n"
    + matchList + "\n\n"
    + "For each match use your statistical knowledge of:\n"
    + "- Both teams average goals per game this season\n"
    + "- Home vs away scoring records\n"
    + "- Head-to-head historical goal averages from last 5 meetings\n"
    + "- Any known absences of key strikers or defenders\n"
    + "- Whether the match is high-stakes (knockout, title race, relegation)\n\n"
    + "Pick the 6 BEST matches for goals tips. Use ONLY these markets:\n"
    + "- Over/Under 1.5 Goals\n"
    + "- Over/Under 2.5 Goals\n"
    + "- Over/Under 3.5 Goals\n"
    + "- Both Teams to Score (BTTS Yes)\n"
    + "- Both Teams to Score (BTTS No)\n"
    + "- First Half Over 0.5 Goals\n"
    + "- First Half Over 1.5 Goals\n\n"
    + "NEVER suggest: match winner, double chance, correct score, goalscorer, cards or corners.\n\n"
    + "Return ONLY a valid JSON array. Zero other text outside the array:\n"
    + '[{"match":"Exact Team A vs Exact Team B","league":"League Name","time":"KO time","market":"Over/Under 2.5 Goals","pick":"Over 2.5 Goals","odds_range":"1.75-1.95","confidence":85,"reasoning":"Specific 2-3 sentence analysis referencing real stats and form.","key_stats":["Home team 2.9 goals/game avg","Away team scored in 9 of last 10 away","H2H last 5 avg 3.1 goals"],"risk":"LOW"}]';

    // ── STEP 3: Claude analysis ───────────────────────────────────────
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key":apiKey,
        "anthropic-version":"2023-06-01",
      },
      body: JSON.stringify({
        model:"claude-sonnet-4-5",
        max_tokens:2500,
        messages:[{ role:"user", content:prompt }],
      }),
      signal: AbortSignal.timeout(25000),
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) return res.status(500).json({ error: aiData?.error?.message||"Anthropic error" });

    const rawText = (aiData.content||[])
      .filter(b=>b.type==="text").map(b=>b.text).join("").trim();

    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(500).json({ error:"AI returned no tips. Try again." });

    let tips = [];
    try { tips = JSON.parse(jsonMatch[0]); }
    catch(e) { return res.status(500).json({ error:"Failed to parse AI tips. Try again." }); }

    // Validate tips only include today's real matches
    const validMatches = fixtures.map(f => f.match.toLowerCase());
    tips = tips
      .filter(t => {
        if (!t.match||!t.market||!t.pick) return false;
        // Check it's one of today's actual matches
        const tipMatch = t.match.toLowerCase();
        return validMatches.some(vm => {
          const [h,a] = vm.split(" vs ");
          return tipMatch.includes(h.split(" ")[0]) || tipMatch.includes(a.split(" ")[0]);
        });
      })
      .map(t => ({
        ...t,
        id: Math.random().toString(36).substr(2,8),
        confidence: Math.min(Math.max(parseInt(t.confidence)||70,50),98),
        risk: t.risk||(t.confidence>=80?"LOW":t.confidence>=65?"MEDIUM":"HIGH"),
        generatedAt: Date.now(),
      }));

    return res.status(200).json({
      tips, count:tips.length, date:today,
      fixturesFound:fixtures.length,
      generatedAt:Date.now(),
    });

  } catch(err) {
    return res.status(500).json({ error:err.message||"Server error" });
  }
}
