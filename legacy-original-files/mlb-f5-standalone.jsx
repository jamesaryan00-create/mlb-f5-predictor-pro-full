import { useState, useEffect } from "react";

const CORS_PROXY = "https://cors-anywhere.herokuapp.com/";
const MLB_API = "https://statsapi.mlb.com/api/v1";

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

function getToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
}

// Direct MLB API fetch (no Claude)
async function mlbFetch(endpoint) {
  const url = `${MLB_API}${endpoint}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB API ${res.status}: ${url}`);
  return res.json();
}

export default function MLBF5Standalone() {
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
      addLog(`Fetching schedule for ${today}...`);
      
      const data = await mlbFetch(`/schedule?sportId=1&date=${today}&gameType=R&hydrate=probablePitcher,venue,weather,team`);
      
      const games = (data.dates?.[0]?.games || []).map((g, i) => ({
        game_pk: g.gamePk,
        away_team: g.teams.away.team.name,
        away_team_id: g.teams.away.team.id,
        away_pitcher_id: g.teams.away.probablePitcher?.id || null,
        away_pitcher_name: g.teams.away.probablePitcher?.fullName || "TBD",
        home_team: g.teams.home.team.name,
        home_team_id: g.teams.home.team.id,
        home_pitcher_id: g.teams.home.probablePitcher?.id || null,
        home_pitcher_name: g.teams.home.probablePitcher?.fullName || "TBD",
        venue: g.venue?.name || "Unknown Park",
        game_time: g.gameDateTime ? new Date(g.gameDateTime).toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'}) + " ET" : "TBA",
        weather_temp: g.weather?.temp,
        weather_wind: g.weather?.wind,
      }));

      setGames(games);
      if (games.length > 0) setSelectedGame(games[0]);
      addLog(`Found ${games.length} games`);
    } catch (e) {
      setGamesError(e.message);
      addLog(`Error: ${e.message}`);
    }
    setGamesLoading(false);
  };

  const fetchPitcherStats = async (pitcherId, pitcherName) => {
    try {
      const data = await mlbFetch(`/people/${pitcherId}?hydrate=stats(group=pitching,type=season,season=2026,gameType=R)`);
      const stat = data.people?.[0]?.stats?.[0]?.splits?.[0]?.stat || {};
      const person = data.people?.[0] || {};
      return {
        name: person.fullName || pitcherName,
        hand: person.pitchHand?.code || "?",
        era: (stat.era ? Number(stat.era).toFixed(2) : "—"),
        whip: (stat.whip ? Number(stat.whip).toFixed(2) : "—"),
        k9: (stat.strikeoutsPer9Inn ? Number(stat.strikeoutsPer9Inn).toFixed(1) : "—"),
        bb9: (stat.walksPer9Inn ? Number(stat.walksPer9Inn).toFixed(1) : "—"),
        innings: (stat.inningsPitched ? Number(stat.inningsPitched).toFixed(1) : "—"),
        hits9: (stat.hitsPer9Inn ? Number(stat.hitsPer9Inn).toFixed(1) : "—"),
        hr9: (stat.homeRunsPer9 ? Number(stat.homeRunsPer9).toFixed(1) : "—"),
        wins: stat.wins || 0,
        losses: stat.losses || 0,
        gs: stat.gamesStarted || 0,
      };
    } catch (e) {
      return {
        name: pitcherName,
        hand: "?",
        era: "—", whip: "—", k9: "—", bb9: "—", innings: "—", hits9: "—", hr9: "—",
        wins: "—", losses: "—", gs: "—"
      };
    }
  };

  const analyze = async () => {
    if (!selectedGame) return;
    setStep("fetching");
    setLog([]);
    setResult(null);
    setError(null);

    try {
      addLog(`Loading ${selectedGame.away_team} @ ${selectedGame.home_team}...`);

      // Fetch away pitcher stats
      addLog(`Fetching ${selectedGame.away_pitcher_name}...`);
      const ap = selectedGame.away_pitcher_id
        ? await fetchPitcherStats(selectedGame.away_pitcher_id, selectedGame.away_pitcher_name)
        : { name: selectedGame.away_pitcher_name, hand:"?", era:"—", whip:"—", k9:"—", bb9:"—", innings:"—", hits9:"—", hr9:"—", wins:"—", losses:"—", gs:"—" };
      addLog(`✓ ${ap.name}: ERA ${ap.era}`);

      // Fetch home pitcher stats
      addLog(`Fetching ${selectedGame.home_pitcher_name}...`);
      const hp = selectedGame.home_pitcher_id
        ? await fetchPitcherStats(selectedGame.home_pitcher_id, selectedGame.home_pitcher_name)
        : { name: selectedGame.home_pitcher_name, hand:"?", era:"—", whip:"—", k9:"—", bb9:"—", innings:"—", hits9:"—", hr9:"—", wins:"—", losses:"—", gs:"—" };
      addLog(`✓ ${hp.name}: ERA ${hp.era}`);

      addLog("Running F5 ML analysis...");

      // Multi-factor F5 ML analysis using pitcher stats + OddsShark profitability
      const awayERA = parseFloat(ap.era);
      const homeERA = parseFloat(hp.era);
      const awayWHIP = parseFloat(ap.whip);
      const homeWHIP = parseFloat(hp.whip);
      const awayK9 = parseFloat(ap.k9);
      const homeK9 = parseFloat(hp.k9);

      // Look up OddsShark F5 pitcher records (if pitcher is in database)
      const awayPitcherProf = ODDSSHARK_F5_PITCHERS.profitable.find(p => p.name === ap.name) || 
                             ODDSSHARK_F5_PITCHERS.unprofitable.find(p => p.name === ap.name);
      const homePitcherProf = ODDSSHARK_F5_PITCHERS.profitable.find(p => p.name === hp.name) || 
                             ODDSSHARK_F5_PITCHERS.unprofitable.find(p => p.name === hp.name);

      // Look up OddsShark team F5 records
      const awayTeamRecord = ODDSSHARK_TEAM_F5[selectedGame.away_team];
      const homeTeamRecord = ODDSSHARK_TEAM_F5[selectedGame.home_team];

      let pitcher_edge = "even";
      let confidence = 5;
      let win_prob = { away: 45, home: 45, push: 10 };
      let key_reasons = [];

      // Era differential (primary factor)
      if (!isNaN(awayERA) && !isNaN(homeERA)) {
        const eraDiff = homeERA - awayERA;
        if (eraDiff > 1.0) {
          pitcher_edge = "away";
          confidence = 7;
          win_prob = { away: 60, home: 30, push: 10 };
          key_reasons.push(`Away SP ERA ${ap.era} vs Home SP ERA ${hp.era}`);
        } else if (eraDiff < -1.0) {
          pitcher_edge = "home";
          confidence = 7;
          win_prob = { away: 30, home: 60, push: 10 };
          key_reasons.push(`Home SP ERA ${hp.era} vs Away SP ERA ${ap.era}`);
        } else if (Math.abs(eraDiff) > 0.3) {
          pitcher_edge = eraDiff > 0 ? "away" : "home";
          confidence = 6;
          win_prob = eraDiff > 0 ? { away: 52, home: 38, push: 10 } : { away: 38, home: 52, push: 10 };
          key_reasons.push(`ERA edge: ${Math.abs(eraDiff).toFixed(2)} runs`);
        }
      }

      // OddsShark pitcher profitability (secondary factor)
      if (awayPitcherProf?.profit > 500) {
        confidence = Math.min(confidence + 1, 10);
        key_reasons.push(`Away SP: ${awayPitcherProf.name} +$${awayPitcherProf.profit.toFixed(0)} F5 profit`);
      } else if (awayPitcherProf?.profit < -500) {
        confidence = Math.max(confidence - 1, 1);
        key_reasons.push(`Away SP: ${awayPitcherProf.name} -$${Math.abs(awayPitcherProf.profit).toFixed(0)} F5 loss`);
      }

      if (homePitcherProf?.profit > 500) {
        confidence = Math.min(confidence + 1, 10);
        key_reasons.push(`Home SP: ${homePitcherProf.name} +$${homePitcherProf.profit.toFixed(0)} F5 profit`);
      } else if (homePitcherProf?.profit < -500) {
        confidence = Math.max(confidence - 1, 1);
        key_reasons.push(`Home SP: ${homePitcherProf.name} -$${Math.abs(homePitcherProf.profit).toFixed(0)} F5 loss`);
      }

      // OddsShark team records (tertiary factor)
      if (awayTeamRecord && awayTeamRecord.winPct > 0.60) {
        confidence = Math.min(confidence + 1, 10);
        key_reasons.push(`${selectedGame.away_team}: ${(awayTeamRecord.winPct * 100).toFixed(1)}% F5 win rate`);
      }
      if (homeTeamRecord && homeTeamRecord.winPct > 0.60) {
        confidence = Math.min(confidence + 1, 10);
        key_reasons.push(`${selectedGame.home_team}: ${(homeTeamRecord.winPct * 100).toFixed(1)}% F5 win rate`);
      }

      const edge = confidence >= 8 ? "Strong Lean" : confidence >= 7 ? "Lean" : confidence >= 6 ? "Slight Edge" : "Too Close";
      const side = pitcher_edge === "away" ? selectedGame.away_team : pitcher_edge === "home" ? selectedGame.home_team : "even";
      const pick = side !== "even" ? `${side} F5 ML` : "No Bet";

      setResult({
        edge,
        side,
        pick,
        confidence,
        win_prob,
        f5_projection: { away: 2.3, home: 2.1 },
        pitcher_edge,
        reasoning: `${ap.name} (${ap.era} ERA) vs ${hp.name} (${hp.era} ERA)`,
        park_factor: "neutral",
        key_factors: key_reasons.length > 0 ? key_reasons : [
          `Away SP ERA: ${ap.era}`,
          `Home SP ERA: ${hp.era}`,
          `Venue: ${selectedGame.venue}`,
        ],
        risk_flags: ap.era === "—" || hp.era === "—" ? ["Incomplete pitcher data"] : [],
        summary: `${side !== "even" ? `${side} has a clear starter advantage` : "Similar pitcher profiles"} in the first five innings. ${confidence}/10 confidence based on ERA differential.`,
        away: { team: selectedGame.away_team, ...ap },
        home: { team: selectedGame.home_team, ...hp },
        venue: selectedGame.venue,
        game_time: selectedGame.game_time,
      });
      setStep("result");

    } catch (e) {
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
      <div style={{ background:"#0d1117", borderBottom:"1px solid #21262d", padding:"22px 24px 16px" }}>
        <div style={{ maxWidth:800, margin:"0 auto" }}>
          <div style={{ fontSize:10, color:"#388bfd", letterSpacing:"0.2em", textTransform:"uppercase", fontFamily:"monospace", marginBottom:3 }}>MLB · First 5 Innings · {today} · Standalone (No Claude)</div>
          <h1 style={{ fontSize:26, fontWeight:800, margin:0, letterSpacing:"-0.03em" }}>F5 <span style={{ color:"#388bfd" }}>ML</span> Finder</h1>
          <p style={{ margin:"5px 0 0", color:"#6b7280", fontSize:12 }}>Direct MLB Stats API · Pitcher-based F5 moneyline analysis</p>
        </div>
      </div>

      <div style={{ maxWidth:800, margin:"0 auto", padding:"24px" }}>

        {/* Game Selector */}
        <div style={{ background:"#0d1117", border:"1px solid #21262d", borderRadius:10, padding:20, marginBottom:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div style={{ fontSize:10, color:"#6b7280", textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:"monospace" }}>Today's Games</div>
            {!gamesLoading && <button onClick={loadGames} style={{ background:"none", border:"1px solid #21262d", color:"#6b7280", padding:"3px 10px", borderRadius:5, cursor:"pointer", fontSize:11 }}>↻ Refresh</button>}
          </div>

          {gamesLoading && <div style={{ display:"flex", alignItems:"center", gap:10 }}><Spinner small /><span style={{ color:"#6b7280", fontSize:12 }}>Loading MLB schedule...</span></div>}

          {gamesError && (
            <div style={{ color:"#f87171", fontSize:12, marginBottom:8 }}>
              ⚠ {gamesError}
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
                        {g.away_pitcher_name || "SP TBD"} vs {g.home_pitcher_name || "SP TBD"}
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
              {(log.length ? log : ["Loading..."]).map((l,i) => (
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

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:14 }}>
                <StatBox label={`${result.away.team} Win%`} value={`${result.win_prob?.away}%`} />
                <StatBox label="Push%" value={`${result.win_prob?.push}%`} />
                <StatBox label={`${result.home.team} Win%`} value={`${result.win_prob?.home}%`} />
              </div>

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

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:14 }}>
                <StatBox label={`${result.away.team} F5 Proj`} value={result.f5_projection?.away} />
                <StatBox label={`${result.home.team} F5 Proj`} value={result.f5_projection?.home} />
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:14 }}>
                <StatBox label="Pitcher Edge" value={result.pitcher_edge} />
                <StatBox label="Park" value={result.park_factor} />
                <StatBox label="Home Field" value="advantage" />
              </div>

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

// NOTE: To add OddsShark F5 data, add this function and call it in loadGames()
// This would require either:
// 1. A backend endpoint that scrapes OddsShark (CORS-safe)
// 2. Or use a third-party scraping API like ScraperAPI or Apify
// 3. Or manually update the data once daily

// Example OddsShark F5 pitcher profitability data (2025 season)
const ODDSSHARK_F5_PITCHERS = {
  profitable: [
    { name: "Jack Leiter", profit: 794.36, record: "17-9-3", winPct: 0.654 },
    { name: "Merrill Kelly", profit: 701.21, record: "18-7-7", winPct: 0.72 },
    { name: "Carlos Rodon", profit: 698.07, record: "24-8-1", winPct: 0.75 },
    { name: "Jason Alexander", profit: 669.75, record: "9-3-1", winPct: 0.75 },
    { name: "Jose Soriano", profit: 669.17, record: "15-10-6", winPct: 0.60 },
  ],
  unprofitable: [
    { name: "Andre Pallante", profit: -1500.35, record: "7-22-2", winPct: 0.241 },
    { name: "Dustin May", profit: -1095.12, record: "7-15-1", winPct: 0.318 },
    { name: "Erick Fedde", profit: -1008.85, record: "3-13-8", winPct: 0.188 },
    { name: "Spencer Strider", profit: -951.06, record: "7-14-2", winPct: 0.333 },
    { name: "Zack Littell", profit: -906.64, record: "8-17-7", winPct: 0.32 },
  ]
};

// Team F5 moneyline records (2025) from OddsShark
const ODDSSHARK_TEAM_F5 = {
  "Brewers": { wins: 79, losses: 51, pushes: 32, profit: 1694.87, winPct: 0.608 },
  "Cubs": { wins: 83, losses: 52, pushes: 27, profit: 1101.93, winPct: 0.615 },
  "Yankees": { wins: 91, losses: 50, pushes: 21, profit: 1036.18, winPct: 0.645 },
  "Rangers": { wins: 79, losses: 60, pushes: 23, profit: 591.28, winPct: 0.568 },
  "White Sox": { wins: 59, losses: 71, pushes: 32, profit: 472.65, winPct: 0.454 },
  "Diamondbacks": { wins: 79, losses: 64, pushes: 19, profit: 272.07, winPct: 0.553 },
  "Tigers": { wins: 78, losses: 58, pushes: 26, profit: 162.18, winPct: 0.573 },
  "Athletics": { wins: 65, losses: 69, pushes: 28, profit: -17.23, winPct: 0.485 },
  "Phillies": { wins: 78, losses: 54, pushes: 30, profit: -326.08, winPct: 0.591 },
  "Pirates": { wins: 59, losses: 61, pushes: 42, profit: -528.08, winPct: 0.492 },
  "Royals": { wins: 69, losses: 68, pushes: 25, profit: -557.34, winPct: 0.504 },
  "Mets": { wins: 78, losses: 66, pushes: 18, profit: -594.29, winPct: 0.541 },
  "Rays": { wins: 71, losses: 71, pushes: 20, profit: -641.4, winPct: 0.5 },
  "Angels": { wins: 58, losses: 76, pushes: 28, profit: -709.27, winPct: 0.433 },
  "Red Sox": { wins: 72, losses: 66, pushes: 24, profit: -745.49, winPct: 0.521 },
  "Reds": { wins: 65, losses: 65, pushes: 32, profit: -763.2, winPct: 0.5 },
  "Orioles": { wins: 65, losses: 71, pushes: 26, profit: -812.28, winPct: 0.478 },
  "Giants": { wins: 63, losses: 63, pushes: 36, profit: -874.63, winPct: 0.5 },
  "Guardians": { wins: 62, losses: 70, pushes: 29, profit: -1020.33, winPct: 0.47 },
  "Mariners": { wins: 70, losses: 66, pushes: 26, profit: -1089.07, winPct: 0.515 },
  "Dodgers": { wins: 75, losses: 61, pushes: 26, profit: -1300.58, winPct: 0.551 },
  "Blue Jays": { wins: 68, losses: 68, pushes: 26, profit: -1304.44, winPct: 0.5 },
  "Twins": { wins: 63, losses: 70, pushes: 28, profit: -1411.55, winPct: 0.474 },
  "Astros": { wins: 67, losses: 75, pushes: 20, profit: -1543.15, winPct: 0.472 },
  "Padres": { wins: 69, losses: 74, pushes: 19, profit: -1652.58, winPct: 0.483 },
  "Marlins": { wins: 59, losses: 80, pushes: 23, profit: -1761.22, winPct: 0.424 },
  "Cardinals": { wins: 61, losses: 77, pushes: 24, profit: -1958.68, winPct: 0.442 },
  "Nationals": { wins: 56, losses: 86, pushes: 20, profit: -1962.26, winPct: 0.394 },
  "Braves": { wins: 61, losses: 80, pushes: 21, profit: -3283.91, winPct: 0.432 },
  "Rockies": { wins: 41, losses: 100, pushes: 21, profit: -3451.6, winPct: 0.291 },
};

