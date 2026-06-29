import { useState, useEffect } from "react";

const EDGE_COLORS = {
  "Strong Lean": { bg: "#0f3d2a", border: "#22c55e", text: "#4ade80", badge: "#166534" },
  "Lean":        { bg: "#1a3a1a", border: "#86efac", text: "#86efac", badge: "#14532d" },
  "Slight Edge": { bg: "#1e2a1e", border: "#4ade80", text: "#6ee7b7", badge: "#14532d" },
  "Too Close":   { bg: "#1a1a2e", border: "#6366f1", text: "#a5b4fc", badge: "#3730a3" },
  "Pass":        { bg: "#1c1a1a", border: "#6b7280", text: "#9ca3af", badge: "#374151" },
};

function Spinner({ small }) {
  const size = small ? 20 : 36;
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", padding: small ? "8px" : "32px 0" }}>
      <div style={{ width:size, height:size, border:"3px solid #21262d", borderTop:"3px solid #388bfd", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// Route all external fetches through Claude's backend to bypass CORS
async function claudeSearch(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      system: "You are a baseball data assistant. Search the web to find accurate MLB data. Return ONLY a valid JSON object — no markdown, no backticks, no explanation. Use only ASCII characters in all string values. No apostrophes or special characters in names.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const cleaned = text.replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON returned: " + text.slice(0, 200));
  // Try parsing, then attempt repair if malformed
  try {
    return JSON.parse(match[0]);
  } catch(e) {
    // Truncate at last complete array element
    const raw = match[0];
    const lastClose = raw.lastIndexOf("}]");
    if (lastClose > 0) {
      try { return JSON.parse(raw.slice(0, lastClose + 2) + "}"); } catch(_) {}
    }
    // Strip trailing incomplete game object
    const truncated = raw.replace(/,\s*\{[^}]*$/, "") + "]}";
    try { return JSON.parse(truncated); } catch(_) {}
    throw new Error("Schedule parse failed — try refreshing.");
  }
}

async function claudeAnalyze(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: "You are an elite MLB F5 moneyline betting analyst. Return ONLY valid JSON, no markdown.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const match = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON from analysis");
  return JSON.parse(match[0]);
}

function getToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
}

export default function MLBF5Live() {
  const [games, setGames] = useState([]);
  const [gamesLoading, setGamesLoading] = useState(true);
  const [gamesError, setGamesError] = useState(null);
  const [selectedGame, setSelectedGame] = useState(null);
  const [step, setStep] = useState("select");
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const addLog = (msg) => setLog(prev => [...prev, msg]);

  // Load today's games on mount
  useEffect(() => {
    loadGames();
  }, []);

  const loadGames = async () => {
    setGamesLoading(true);
    setGamesError(null);
    try {
      const today = getToday();
      const data = await claudeSearch(
        `Search the web for today's MLB starting pitchers and schedule for ${today}. Use sources like the FanGraphs probables grid, MLB.com probable pitchers, or Rotowire daily lineups.

For EVERY MLB game scheduled today (${today}), give me the matchup, both probable starting pitchers, the ballpark, and start time.

Return ONLY this JSON (no apostrophes in names, escape nothing, include every game found):
{"date":"${today}","games":[{"away_team":"Red Sox","away_pitcher_name":"Pitcher Name","home_team":"Yankees","home_pitcher_name":"Pitcher Name","venue":"Yankee Stadium","game_time":"7:05 PM ET"}]}`
      );
      setGames(data.games || []);
      if (data.games?.length > 0) setSelectedGame(data.games[0]);
    } catch (e) {
      setGamesError(e.message);
    }
    setGamesLoading(false);
  };

  const analyze = async () => {
    if (!selectedGame) return;
    setStep("fetching");
    setLog([]);
    setResult(null);
    setError(null);

    try {
      const today = getToday();

      // Fetch away pitcher stats
      let ap = { name: selectedGame.away_pitcher_name || "TBD", hand:"?", era:"\u2014", whip:"\u2014", k9:"\u2014", bb9:"\u2014", innings:"\u2014", hits9:"\u2014", hr9:"\u2014", wins:"\u2014", losses:"\u2014", gs:"\u2014" };
      if (selectedGame.away_pitcher_name) {
        addLog(`Fetching 2026 stats for ${selectedGame.away_pitcher_name}...`);
        try {
          const s = await claudeSearch(
            `Search the web (FanGraphs, Baseball Reference, or ESPN) for the 2026 MLB season pitching stats of ${selectedGame.away_pitcher_name}, who pitches for the ${selectedGame.away_team}.

Return ONLY this JSON with his current 2026 season stats:
{"name":"${selectedGame.away_pitcher_name}","hand":"R","era":"3.45","whip":"1.15","k9":"9.0","bb9":"2.8","innings":"75.0","hits9":"7.5","hr9":"1.0","wins":5,"losses":3,"gs":12}`
          );
          ap = { ...ap, ...s };
          addLog(`\u2713 ${ap.name}: ERA ${ap.era} | WHIP ${ap.whip} | K/9 ${ap.k9}`);
        } catch(e) { addLog(`\u26a0 Could not fetch away SP stats: ${e.message}`); }
      } else {
        addLog(`\u26a0 Away SP not yet posted for ${selectedGame.away_team}`);
      }

      // Fetch home pitcher stats
      let hp = { name: selectedGame.home_pitcher_name || "TBD", hand:"?", era:"\u2014", whip:"\u2014", k9:"\u2014", bb9:"\u2014", innings:"\u2014", hits9:"\u2014", hr9:"\u2014", wins:"\u2014", losses:"\u2014", gs:"\u2014" };
      if (selectedGame.home_pitcher_name) {
        addLog(`Fetching 2026 stats for ${selectedGame.home_pitcher_name}...`);
        try {
          const s = await claudeSearch(
            `Search the web (FanGraphs, Baseball Reference, or ESPN) for the 2026 MLB season pitching stats of ${selectedGame.home_pitcher_name}, who pitches for the ${selectedGame.home_team}.

Return ONLY this JSON with his current 2026 season stats:
{"name":"${selectedGame.home_pitcher_name}","hand":"R","era":"3.45","whip":"1.15","k9":"9.0","bb9":"2.8","innings":"75.0","hits9":"7.5","hr9":"1.0","wins":5,"losses":3,"gs":12}`
          );
          hp = { ...hp, ...s };
          addLog(`\u2713 ${hp.name}: ERA ${hp.era} | WHIP ${hp.whip} | K/9 ${hp.k9}`);
        } catch(e) { addLog(`\u26a0 Could not fetch home SP stats: ${e.message}`); }
      } else {
        addLog(`\u26a0 Home SP not yet posted for ${selectedGame.home_team}`);
      }

      addLog("Running F5 ML analysis...");

      const analysis = await claudeAnalyze(`You are an elite MLB F5 moneyline betting analyst. Determine which team is more likely to be WINNING after 5 innings.

MATCHUP: ${selectedGame.away_team} (away) @ ${selectedGame.home_team} (home)
VENUE: ${selectedGame.venue}
GAME TIME: ${selectedGame.game_time}

AWAY SP — ${ap.name} (${ap.hand}HP): ERA ${ap.era} | WHIP ${ap.whip} | K/9 ${ap.k9} | BB/9 ${ap.bb9} | IP ${ap.innings} | H/9 ${ap.hits9} | HR/9 ${ap.hr9} | Record ${ap.wins}-${ap.losses} in ${ap.gs} GS

HOME SP — ${hp.name} (${hp.hand}HP): ERA ${hp.era} | WHIP ${hp.whip} | K/9 ${hp.k9} | BB/9 ${hp.bb9} | IP ${hp.innings} | H/9 ${hp.hits9} | HR/9 ${hp.hr9} | Record ${hp.wins}-${hp.losses} in ${hp.gs} GS

Key F5 ML factors: pitcher dominance (ERA, WHIP, K rate), home field, park factor, handedness matchups. Remember F5 ML pushes on a tie — factor in push probability.

Return ONLY valid JSON:
{
  "edge": "Strong Lean"|"Lean"|"Slight Edge"|"Too Close"|"Pass",
  "side": "away"|"home"|"no bet",
  "pick": "${selectedGame.away_team} F5 ML" or "${selectedGame.home_team} F5 ML" or "No Bet",
  "win_prob": { "away": number, "home": number, "push": number },
  "confidence": 1-10,
  "f5_projection": { "away": X.X, "home": X.X },
  "pitcher_edge": "away"|"home"|"even",
  "reasoning": "one sentence on which pitcher has the edge and why",
  "park_factor": "hitter"|"pitcher"|"neutral",
  "key_factors": ["...", "...", "..."],
  "risk_flags": [],
  "summary": "2-3 sentence sharp F5 ML take"
}`);

      setResult({ ...analysis, away: { team: selectedGame.away_team, ...ap }, home: { team: selectedGame.home_team, ...hp }, venue: selectedGame.venue, game_time: selectedGame.game_time });
      setStep("result");
    } catch(e) {
      setError(e.message);
      setStep("error");
    }
  };

  const reset = () => { setStep("select"); setResult(null); setLog([]); setError(null); };
  const ec = result ? (EDGE_COLORS[result.edge] || EDGE_COLORS["Pass"]) : null;

  const StatBox = ({ label, value }) => (
    <div style={{ background:"#010409", border:"1px solid #21262d", borderRadius:7, padding:"8px 10px", textAlign:"center" }}>
      <div style={{ fontSize:9, color:"#6b7280", fontFamily:"monospace", textTransform:"uppercase", marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:13, fontWeight:700, color:"#c9d1d9" }}>{value ?? "—"}</div>
    </div>
  );

  const today = getToday();

  return (
    <div style={{ minHeight:"100vh", background:"#010409", color:"#e6edf3", fontFamily:"'Inter','Segoe UI',sans-serif" }}>
      {/* Header */}
      <div style={{ background:"#0d1117", borderBottom:"1px solid #21262d", padding:"22px 24px 16px" }}>
        <div style={{ maxWidth:800, margin:"0 auto" }}>
          <div style={{ fontSize:10, color:"#388bfd", letterSpacing:"0.2em", textTransform:"uppercase", fontFamily:"monospace", marginBottom:3 }}>MLB · First 5 Innings · {today}</div>
          <h1 style={{ fontSize:26, fontWeight:800, margin:0, letterSpacing:"-0.03em" }}>F5 <span style={{ color:"#388bfd" }}>ML</span> Edge Finder</h1>
          <p style={{ margin:"5px 0 0", color:"#6b7280", fontSize:12 }}>Live 2026 pitcher stats · F5 moneyline analysis only</p>
        </div>
      </div>

      <div style={{ maxWidth:800, margin:"0 auto", padding:"24px" }}>

        {/* Game Selector */}
        <div style={{ background:"#0d1117", border:"1px solid #21262d", borderRadius:10, padding:20, marginBottom:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div style={{ fontSize:10, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:"monospace" }}>Today's Games</div>
            {!gamesLoading && <button onClick={loadGames} style={{ background:"none", border:"1px solid #21262d", color:"#6b7280", padding:"3px 10px", borderRadius:5, cursor:"pointer", fontSize:11 }}>↻ Refresh</button>}
          </div>

          {gamesLoading && <div style={{ display:"flex", alignItems:"center", gap:10 }}><Spinner small /><span style={{ color:"#6b7280", fontSize:12 }}>Loading today's schedule...</span></div>}

          {gamesError && (
            <div style={{ color:"#f87171", fontSize:12, marginBottom:8 }}>
              ⚠ Could not load schedule: {gamesError}
              <button onClick={loadGames} style={{ marginLeft:10, background:"none", border:"1px solid #7c2d12", color:"#f87171", padding:"2px 8px", borderRadius:4, cursor:"pointer", fontSize:11 }}>Retry</button>
            </div>
          )}

          {!gamesLoading && games.length === 0 && !gamesError && (
            <div style={{ color:"#6b7280", fontSize:13 }}>No games found for {today}.</div>
          )}

          {!gamesLoading && games.length > 0 && (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {games.map((g, i) => {
                const isSelected = selectedGame?.game_pk === g.game_pk;
                return (
                  <button key={i} onClick={() => setSelectedGame(g)} disabled={step==="fetching"}
                    style={{
                      display:"flex", justifyContent:"space-between", alignItems:"center",
                      background: isSelected ? "#161b22" : "#010409",
                      border: isSelected ? "1px solid #388bfd" : "1px solid #21262d",
                      borderRadius:8, padding:"12px 16px", cursor:"pointer", textAlign:"left",
                      transition:"all 0.15s"
                    }}>
                    <div>
                      <div style={{ fontSize:14, fontWeight:700, color:"#e6edf3" }}>{g.away_team} <span style={{ color:"#4b5563", fontWeight:400 }}>@</span> {g.home_team}</div>
                      <div style={{ fontSize:11, color:"#6b7280", marginTop:3 }}>
                        {g.away_pitcher_name || "SP TBD"} vs {g.home_pitcher_name || "SP TBD"} · {g.venue}
                      </div>
                    </div>
                    <div style={{ fontSize:12, color: isSelected ? "#388bfd" : "#6b7280", fontFamily:"monospace", whiteSpace:"nowrap", marginLeft:12 }}>{g.game_time}</div>
                  </button>
                );
              })}
            </div>
          )}

          {selectedGame && step !== "fetching" && (
            <button onClick={analyze} style={{ width:"100%", marginTop:16, padding:"13px", background:"linear-gradient(135deg,#1f6feb,#388bfd)", border:"none", borderRadius:8, color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", boxShadow:"0 0 20px rgba(56,139,253,0.2)" }}>
              ⚡ Analyze {selectedGame.away_team} @ {selectedGame.home_team} F5 ML
            </button>
          )}
        </div>

        {/* Fetching */}
        {step === "fetching" && (
          <div style={{ background:"#0d1117", border:"1px solid #21262d", borderRadius:10, padding:24 }}>
            <Spinner />
            <div style={{ fontFamily:"monospace", fontSize:12, display:"flex", flexDirection:"column", gap:5, maxWidth:440, margin:"0 auto" }}>
              {(log.length ? log : ["Connecting..."]).map((l,i) => (
                <div key={i} style={{ display:"flex", gap:8 }}>
                  <span style={{ color:"#388bfd" }}>›</span>
                  <span style={{ color: i===log.length-1 ? "#c9d1d9" : "#4b5563" }}>{l}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {step === "error" && (
          <div style={{ background:"#1a0a0a", border:"1px solid #7c2d12", borderRadius:10, padding:16, marginBottom:16 }}>
            <div style={{ color:"#f87171", fontSize:13, whiteSpace:"pre-wrap" }}>⚠ {error}</div>
            <button onClick={reset} style={{ marginTop:10, background:"none", border:"1px solid #7c2d12", color:"#f87171", padding:"5px 12px", borderRadius:6, cursor:"pointer", fontSize:12 }}>← Back</button>
          </div>
        )}

        {/* Result */}
        {step === "result" && result && ec && (
          <>
            <div style={{ background:ec.bg, border:`1px solid ${ec.border}`, borderRadius:12, padding:24, marginBottom:14 }}>

              {/* Pick header */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:12, marginBottom:20 }}>
                <div>
                  <span style={{ fontSize:10, background:ec.badge, color:ec.text, padding:"3px 10px", borderRadius:20, fontFamily:"monospace", textTransform:"uppercase", letterSpacing:"0.1em" }}>{result.edge}</span>
                  <div style={{ fontSize:26, fontWeight:800, color:ec.text, marginTop:10, letterSpacing:"-0.02em" }}>{result.pick}</div>
                  <div style={{ fontSize:12, color:"#6b7280", marginTop:3 }}>{result.venue} · {result.game_time}</div>
                  {result.reasoning && <div style={{ fontSize:12, color:"#8b949e", marginTop:6, fontStyle:"italic" }}>{result.reasoning}</div>}
                </div>
                <div style={{ textAlign:"center", background:"#010409", borderRadius:10, padding:"12px 20px", border:"1px solid #21262d" }}>
                  <div style={{ fontSize:9, color:"#6b7280", fontFamily:"monospace", textTransform:"uppercase" }}>Confidence</div>
                  <div style={{ fontSize:38, fontWeight:900, color:ec.text, lineHeight:1.1 }}>{result.confidence}</div>
                  <div style={{ fontSize:10, color:"#6b7280" }}>/10</div>
                </div>
              </div>

              {/* Win probabilities */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:14 }}>
                <StatBox label={`${result.away.team} Win%`} value={result.win_prob?.away != null ? `${result.win_prob.away}%` : "—"} />
                <StatBox label="Push%" value={result.win_prob?.push != null ? `${result.win_prob.push}%` : "—"} />
                <StatBox label={`${result.home.team} Win%`} value={result.win_prob?.home != null ? `${result.win_prob.home}%` : "—"} />
              </div>

              {/* Pitcher cards */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:14 }}>
                {[result.away, result.home].map((p,i) => (
                  <div key={i} style={{ background:"#010409", border:"1px solid #21262d", borderRadius:9, padding:"14px 16px" }}>
                    <div style={{ fontSize:10, color:"#6b7280", fontFamily:"monospace", textTransform:"uppercase", marginBottom:4 }}>{i===0?"✈ Away SP":"🏠 Home SP"}</div>
                    <div style={{ fontSize:15, fontWeight:800, color:"#e6edf3", marginBottom:2 }}>{p.name}</div>
                    <div style={{ fontSize:11, color:"#6b7280", marginBottom:10 }}>{p.team} · {p.hand}HP · {p.wins}-{p.losses} ({p.gs} GS)</div>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:6 }}>
                      {[["ERA",p.era],["WHIP",p.whip],["K/9",p.k9],["BB/9",p.bb9],["IP",p.innings],["H/9",p.hits9]].map(([k,v])=>(
                        <div key={k}><div style={{ fontSize:9, color:"#6b7280", fontFamily:"monospace" }}>{k}</div><div style={{ fontSize:14, fontWeight:700, color:"#c9d1d9" }}>{v}</div></div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* F5 projections */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14 }}>
                <StatBox label={`${result.away.team} F5 Proj`} value={result.f5_projection?.away} />
                <StatBox label={`${result.home.team} F5 Proj`} value={result.f5_projection?.home} />
              </div>

              {/* Context */}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:14 }}>
                <StatBox label="Pitcher Edge" value={result.pitcher_edge} />
                <StatBox label="Park" value={result.park_factor} />
                <StatBox label="Home Field" value="advantage" />
              </div>

              {/* Key factors */}
              <div style={{ marginBottom: result.risk_flags?.length ? 14 : 0 }}>
                <div style={{ fontSize:10, color:"#6b7280", fontFamily:"monospace", textTransform:"uppercase", marginBottom:8 }}>Key Factors</div>
                {result.key_factors?.map((f,i) => (
                  <div key={i} style={{ display:"flex", gap:10, marginBottom:6 }}>
                    <span style={{ color:ec.text, fontSize:11 }}>▸</span>
                    <span style={{ fontSize:13, color:"#c9d1d9" }}>{f}</span>
                  </div>
                ))}
              </div>

              {result.risk_flags?.length > 0 && (
                <div style={{ background:"#1a0a00", border:"1px solid #7c2d12", borderRadius:7, padding:"10px 14px", marginTop:14 }}>
                  <div style={{ fontSize:10, color:"#f97316", fontFamily:"monospace", marginBottom:6 }}>⚠ RISK FLAGS</div>
                  {result.risk_flags.map((r,i) => <div key={i} style={{ fontSize:12, color:"#fed7aa", marginBottom:2 }}>• {r}</div>)}
                </div>
              )}

              <div style={{ borderTop:"1px solid #21262d", paddingTop:14, marginTop:14, fontSize:13, color:"#8b949e", lineHeight:1.65 }}>{result.summary}</div>
            </div>

            <button onClick={reset} style={{ width:"100%", padding:"12px", background:"#161b22", border:"1px solid #21262d", borderRadius:8, color:"#8b949e", fontSize:13, cursor:"pointer" }}>
              ← Analyze Another Game
            </button>
          </>
        )}
      </div>
    </div>
  );
}
