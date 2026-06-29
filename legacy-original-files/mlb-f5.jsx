import { useState, useEffect } from "react";

const TEAMS = [
  { abbr: "NYY", name: "New York Yankees", league: "AL" },
  { abbr: "BOS", name: "Boston Red Sox", league: "AL" },
  { abbr: "HOU", name: "Houston Astros", league: "AL" },
  { abbr: "LAD", name: "Los Angeles Dodgers", league: "NL" },
  { abbr: "ATL", name: "Atlanta Braves", league: "NL" },
  { abbr: "PHI", name: "Philadelphia Phillies", league: "NL" },
  { abbr: "MIL", name: "Milwaukee Brewers", league: "NL" },
  { abbr: "BAL", name: "Baltimore Orioles", league: "AL" },
  { abbr: "CLE", name: "Cleveland Guardians", league: "AL" },
  { abbr: "MIN", name: "Minnesota Twins", league: "AL" },
  { abbr: "SEA", name: "Seattle Mariners", league: "AL" },
  { abbr: "TBR", name: "Tampa Bay Rays", league: "AL" },
  { abbr: "TOR", name: "Toronto Blue Jays", league: "AL" },
  { abbr: "CHW", name: "Chicago White Sox", league: "AL" },
  { abbr: "KCR", name: "Kansas City Royals", league: "AL" },
  { abbr: "DET", name: "Detroit Tigers", league: "AL" },
  { abbr: "OAK", name: "Oakland Athletics", league: "AL" },
  { abbr: "LAA", name: "Los Angeles Angels", league: "AL" },
  { abbr: "TEX", name: "Texas Rangers", league: "AL" },
  { abbr: "NYM", name: "New York Mets", league: "NL" },
  { abbr: "CHC", name: "Chicago Cubs", league: "NL" },
  { abbr: "STL", name: "St. Louis Cardinals", league: "NL" },
  { abbr: "SFG", name: "San Francisco Giants", league: "NL" },
  { abbr: "SDP", name: "San Diego Padres", league: "NL" },
  { abbr: "COL", name: "Colorado Rockies", league: "NL" },
  { abbr: "ARI", name: "Arizona Diamondbacks", league: "NL" },
  { abbr: "CIN", name: "Cincinnati Reds", league: "NL" },
  { abbr: "PIT", name: "Pittsburgh Pirates", league: "NL" },
  { abbr: "MIA", name: "Miami Marlins", league: "NL" },
  { abbr: "WSN", name: "Washington Nationals", league: "NL" },
];

const PARKS = [
  "Coors Field (COL)", "Fenway Park (BOS)", "Great American Ball Park (CIN)",
  "Wrigley Field (CHC)", "Globe Life Field (TEX)", "Yankee Stadium (NYY)",
  "Dodger Stadium (LAD)", "Oracle Park (SFG)", "Truist Park (ATL)",
  "Citizens Bank Park (PHI)", "PNC Park (PIT)", "Petco Park (SDP)",
  "T-Mobile Park (SEA)", "Target Field (MIN)", "American Family Field (MIL)",
  "Busch Stadium (STL)", "loanDepot park (MIA)", "Nationals Park (WSN)",
  "Chase Field (ARI)", "Tropicana Field (TBR)", "Oakland Coliseum (OAK)",
  "Progressive Field (CLE)", "Camden Yards (BAL)", "Rogers Centre (TOR)",
  "Guaranteed Rate Field (CHW)", "Kauffman Stadium (KCR)", "Comerica Park (DET)",
  "Angel Stadium (LAA)", "Minute Maid Park (HOU)", "Citi Field (NYM)"
];

const WIND = ["None / Dome", "In 5 mph", "In 10 mph", "In 15+ mph", "Out 5 mph", "Out 10 mph", "Out 15+ mph", "Crosswind"];
const TEMPS = ["< 50°F", "50–65°F", "65–80°F", "80–90°F", "> 90°F"];

const emptyPitcher = { name: "", era: "", whip: "", k9: "", bb9: "", woba: "", ip_avg: "" };
const emptyLineup = { woba: "", slg: "", k_pct: "", runs_f5: "" };

const EDGE_COLORS = {
  "Strong Lean": { bg: "#0f3d2a", border: "#22c55e", text: "#4ade80", label: "#bbf7d0" },
  "Lean": { bg: "#1a3a1a", border: "#86efac", text: "#86efac", label: "#dcfce7" },
  "Slight Edge": { bg: "#1e2a1e", border: "#4ade80", text: "#6ee7b7", label: "#d1fae5" },
  "Too Close": { bg: "#1a1a2e", border: "#6366f1", text: "#a5b4fc", label: "#e0e7ff" },
  "Pass": { bg: "#1c1a1a", border: "#6b7280", text: "#9ca3af", label: "#e5e7eb" },
};

export default function MLBF5Tool() {
  const [home, setHome] = useState("NYY");
  const [away, setAway] = useState("BOS");
  const [park, setPark] = useState("Yankee Stadium (NYY)");
  const [wind, setWind] = useState("None / Dome");
  const [temp, setTemp] = useState("65–80°F");
  const [homePitcher, setHomePitcher] = useState({ ...emptyPitcher });
  const [awayPitcher, setAwayPitcher] = useState({ ...emptyPitcher });
  const [homeLineup, setHomeLineup] = useState({ ...emptyLineup });
  const [awayLineup, setAwayLineup] = useState({ ...emptyLineup });
  const [f5Line, setF5Line] = useState({ homeML: "", awayML: "", total: "" });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("home");

  const updatePitcher = (side, field, val) => {
    if (side === "home") setHomePitcher(p => ({ ...p, [field]: val }));
    else setAwayPitcher(p => ({ ...p, [field]: val }));
  };

  const updateLineup = (side, field, val) => {
    if (side === "home") setHomeLineup(l => ({ ...l, [field]: val }));
    else setAwayLineup(l => ({ ...l, [field]: val }));
  };

  const buildPrompt = () => `
You are an elite MLB sports betting analyst specializing in First 5 Innings (F5) wagering. 
Analyze this matchup and provide a structured betting assessment.

**MATCHUP:** ${away} @ ${home}
**PARK:** ${park} | **WIND:** ${wind} | **TEMP:** ${temp}

**${away} SP (Away):** ${awayPitcher.name || "Unknown"}
ERA: ${awayPitcher.era || "N/A"} | WHIP: ${awayPitcher.whip || "N/A"} | K/9: ${awayPitcher.k9 || "N/A"} | BB/9: ${awayPitcher.bb9 || "N/A"} | wOBA against: ${awayPitcher.woba || "N/A"} | Avg IP: ${awayPitcher.ip_avg || "N/A"}

**${home} SP (Home):** ${homePitcher.name || "Unknown"}
ERA: ${homePitcher.era || "N/A"} | WHIP: ${homePitcher.whip || "N/A"} | K/9: ${homePitcher.k9 || "N/A"} | BB/9: ${homePitcher.bb9 || "N/A"} | wOBA against: ${homePitcher.woba || "N/A"} | Avg IP: ${homePitcher.ip_avg || "N/A"}

**${away} Lineup (Batting vs ${homePitcher.name || "Home SP"}):**
wOBA: ${awayLineup.woba || "N/A"} | SLG: ${awayLineup.slg || "N/A"} | K%: ${awayLineup.k_pct || "N/A"} | F5 Runs/G: ${awayLineup.runs_f5 || "N/A"}

**${home} Lineup (Batting vs ${awayPitcher.name || "Away SP"}):**
wOBA: ${homeLineup.woba || "N/A"} | SLG: ${homeLineup.slg || "N/A"} | K%: ${homeLineup.k_pct || "N/A"} | F5 Runs/G: ${homeLineup.runs_f5 || "N/A"}

**F5 LINES:** ${home} ML: ${f5Line.homeML || "N/A"} | ${away} ML: ${f5Line.awayML || "N/A"} | F5 Total: ${f5Line.total || "N/A"}

Respond ONLY with a valid JSON object (no markdown, no explanation) with this exact structure:
{
  "edge": "Strong Lean" | "Lean" | "Slight Edge" | "Too Close" | "Pass",
  "pick": "string — e.g. '${away} F5 ML -115' or 'Under 4.5 F5 -110' or 'No Bet'",
  "confidence": number between 1 and 10,
  "f5_run_projection": { "away": number, "home": number },
  "pitcher_edge": "away" | "home" | "even",
  "lineup_edge": "away" | "home" | "even",
  "park_factor": "hitter" | "pitcher" | "neutral",
  "weather_impact": "positive" | "negative" | "neutral",
  "key_factors": ["string", "string", "string"],
  "risk_flags": ["string"] or [],
  "summary": "2-3 sentence sharp betting take"
}
`.trim();

  const analyze = async () => {
    setLoading(true);
    setResult(null);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: buildPrompt() }],
        }),
      });
      const data = await response.json();
      const text = data.content?.map(b => b.text || "").join("") || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setResult(parsed);
    } catch (err) {
      setResult({ error: "Analysis failed. Check your inputs and try again." });
    }
    setLoading(false);
  };

  const StatInput = ({ label, value, onChange, placeholder }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 10, color: "#6b7280", letterSpacing: "0.08em", textTransform: "uppercase", fontFamily: "monospace" }}>{label}</label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || "—"}
        style={{
          background: "#0d1117", border: "1px solid #21262d", borderRadius: 6,
          color: "#e6edf3", padding: "7px 10px", fontSize: 13, fontFamily: "monospace",
          width: "100%", outline: "none", boxSizing: "border-box",
        }}
        onFocus={e => e.target.style.borderColor = "#388bfd"}
        onBlur={e => e.target.style.borderColor = "#21262d"}
      />
    </div>
  );

  const teamColor = (abbr) => {
    const colors = { NYY: "#003087", BOS: "#bd3039", HOU: "#002d62", LAD: "#005a9c", ATL: "#ce1141", PHI: "#e81828" };
    return colors[abbr] || "#4b5563";
  };

  const edgeStyle = result && !result.error ? (EDGE_COLORS[result.edge] || EDGE_COLORS["Pass"]) : null;

  return (
    <div style={{ minHeight: "100vh", background: "#010409", color: "#e6edf3", fontFamily: "'Inter', 'Segoe UI', sans-serif", padding: "0 0 60px" }}>
      {/* Header */}
      <div style={{ background: "linear-gradient(180deg, #0d1117 0%, #010409 100%)", borderBottom: "1px solid #21262d", padding: "28px 24px 20px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 11, letterSpacing: "0.2em", color: "#388bfd", textTransform: "uppercase", fontFamily: "monospace", fontWeight: 600 }}>MLB</span>
            <span style={{ color: "#30363d" }}>|</span>
            <span style={{ fontSize: 11, letterSpacing: "0.2em", color: "#6b7280", textTransform: "uppercase", fontFamily: "monospace" }}>First 5 Innings</span>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, letterSpacing: "-0.03em", color: "#e6edf3" }}>
            F5 <span style={{ color: "#388bfd" }}>Edge</span> Finder
          </h1>
          <p style={{ margin: "6px 0 0", color: "#6b7280", fontSize: 13 }}>
            Pitcher-weighted AI analysis for first-half wagering
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 24px 0" }}>

        {/* Matchup Row */}
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 10, padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "monospace", marginBottom: 12 }}>Matchup</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 12, alignItems: "center" }}>
            <div>
              <label style={{ fontSize: 10, color: "#6b7280", display: "block", marginBottom: 4, fontFamily: "monospace", textTransform: "uppercase" }}>Away Team</label>
              <select value={away} onChange={e => setAway(e.target.value)} style={{ width: "100%", background: "#161b22", border: "1px solid #21262d", color: "#e6edf3", padding: "9px 12px", borderRadius: 7, fontSize: 14, fontWeight: 600 }}>
                {TEAMS.map(t => <option key={t.abbr} value={t.abbr}>{t.abbr} – {t.name}</option>)}
              </select>
            </div>
            <div style={{ textAlign: "center", fontSize: 13, color: "#30363d", fontWeight: 700, paddingTop: 16 }}>@</div>
            <div>
              <label style={{ fontSize: 10, color: "#6b7280", display: "block", marginBottom: 4, fontFamily: "monospace", textTransform: "uppercase" }}>Home Team</label>
              <select value={home} onChange={e => setHome(e.target.value)} style={{ width: "100%", background: "#161b22", border: "1px solid #21262d", color: "#e6edf3", padding: "9px 12px", borderRadius: 7, fontSize: 14, fontWeight: 600 }}>
                {TEAMS.map(t => <option key={t.abbr} value={t.abbr}>{t.abbr} – {t.name}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 14 }}>
            <div>
              <label style={{ fontSize: 10, color: "#6b7280", display: "block", marginBottom: 4, fontFamily: "monospace", textTransform: "uppercase" }}>Park</label>
              <select value={park} onChange={e => setPark(e.target.value)} style={{ width: "100%", background: "#161b22", border: "1px solid #21262d", color: "#e6edf3", padding: "8px 10px", borderRadius: 7, fontSize: 12 }}>
                {PARKS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 10, color: "#6b7280", display: "block", marginBottom: 4, fontFamily: "monospace", textTransform: "uppercase" }}>Wind</label>
              <select value={wind} onChange={e => setWind(e.target.value)} style={{ width: "100%", background: "#161b22", border: "1px solid #21262d", color: "#e6edf3", padding: "8px 10px", borderRadius: 7, fontSize: 12 }}>
                {WIND.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 10, color: "#6b7280", display: "block", marginBottom: 4, fontFamily: "monospace", textTransform: "uppercase" }}>Temp</label>
              <select value={temp} onChange={e => setTemp(e.target.value)} style={{ width: "100%", background: "#161b22", border: "1px solid #21262d", color: "#e6edf3", padding: "8px 10px", borderRadius: 7, fontSize: 12 }}>
                {TEMPS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Pitcher & Lineup Tabs */}
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 10, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "1px solid #21262d" }}>
            {["home", "away"].map(side => (
              <button
                key={side}
                onClick={() => setActiveTab(side)}
                style={{
                  padding: "8px 18px", background: "none", border: "none", cursor: "pointer",
                  borderBottom: activeTab === side ? "2px solid #388bfd" : "2px solid transparent",
                  color: activeTab === side ? "#e6edf3" : "#6b7280",
                  fontSize: 13, fontWeight: 600, textTransform: "capitalize",
                  marginBottom: -1,
                }}
              >
                {side === "home" ? `🏠 ${home}` : `✈️ ${away}`}
              </button>
            ))}
          </div>

          {["home", "away"].map(side => {
            const pitcher = side === "home" ? homePitcher : awayPitcher;
            const lineup = side === "home" ? homeLineup : awayLineup;
            const team = side === "home" ? home : away;
            if (activeTab !== side) return null;
            return (
              <div key={side}>
                <div style={{ fontSize: 10, color: "#388bfd", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "monospace", marginBottom: 12 }}>Starting Pitcher</div>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr 1fr", gap: 10, marginBottom: 20 }}>
                  <StatInput label="Name" value={pitcher.name} onChange={v => updatePitcher(side, "name", v)} placeholder="Pitcher name" />
                  <StatInput label="ERA" value={pitcher.era} onChange={v => updatePitcher(side, "era", v)} placeholder="3.45" />
                  <StatInput label="WHIP" value={pitcher.whip} onChange={v => updatePitcher(side, "whip", v)} placeholder="1.12" />
                  <StatInput label="K/9" value={pitcher.k9} onChange={v => updatePitcher(side, "k9", v)} placeholder="9.2" />
                  <StatInput label="BB/9" value={pitcher.bb9} onChange={v => updatePitcher(side, "bb9", v)} placeholder="2.8" />
                  <StatInput label="wOBA vs" value={pitcher.woba} onChange={v => updatePitcher(side, "woba", v)} placeholder=".310" />
                  <StatInput label="Avg IP" value={pitcher.ip_avg} onChange={v => updatePitcher(side, "ip_avg", v)} placeholder="5.2" />
                </div>

                <div style={{ fontSize: 10, color: "#f59e0b", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "monospace", marginBottom: 12 }}>Lineup vs Opposing SP</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
                  <StatInput label="wOBA" value={lineup.woba} onChange={v => updateLineup(side, "woba", v)} placeholder=".320" />
                  <StatInput label="SLG" value={lineup.slg} onChange={v => updateLineup(side, "slg", v)} placeholder=".430" />
                  <StatInput label="K%" value={lineup.k_pct} onChange={v => updateLineup(side, "k_pct", v)} placeholder="22%" />
                  <StatInput label="F5 R/G" value={lineup.runs_f5} onChange={v => updateLineup(side, "runs_f5", v)} placeholder="2.3" />
                </div>
              </div>
            );
          })}
        </div>

        {/* F5 Lines */}
        <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 10, padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", fontFamily: "monospace", marginBottom: 12 }}>F5 Lines</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <StatInput label={`${home} F5 ML`} value={f5Line.homeML} onChange={v => setF5Line(l => ({ ...l, homeML: v }))} placeholder="-130" />
            <StatInput label={`${away} F5 ML`} value={f5Line.awayML} onChange={v => setF5Line(l => ({ ...l, awayML: v }))} placeholder="+110" />
            <StatInput label="F5 Total" value={f5Line.total} onChange={v => setF5Line(l => ({ ...l, total: v }))} placeholder="4.5" />
          </div>
        </div>

        {/* Analyze Button */}
        <button
          onClick={analyze}
          disabled={loading}
          style={{
            width: "100%", padding: "14px", background: loading ? "#1c2128" : "linear-gradient(135deg, #1f6feb 0%, #388bfd 100%)",
            border: "none", borderRadius: 9, color: "#fff", fontSize: 15, fontWeight: 700,
            cursor: loading ? "not-allowed" : "pointer", letterSpacing: "0.02em",
            transition: "all 0.2s", marginBottom: 24,
            boxShadow: loading ? "none" : "0 0 20px rgba(56,139,253,0.25)",
          }}
        >
          {loading ? "⚙️  Analyzing matchup..." : "⚡  Run F5 Analysis"}
        </button>

        {/* Result */}
        {result && !result.error && (
          <div style={{
            background: edgeStyle?.bg || "#0d1117",
            border: `1px solid ${edgeStyle?.border || "#21262d"}`,
            borderRadius: 12, padding: 24, marginBottom: 16,
          }}>
            {/* Pick Banner */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: edgeStyle?.label || "#9ca3af", textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "monospace", marginBottom: 6 }}>
                  {result.edge}
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: edgeStyle?.text || "#e6edf3", letterSpacing: "-0.02em" }}>
                  {result.pick}
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "monospace", textTransform: "uppercase", marginBottom: 4 }}>Confidence</div>
                <div style={{ fontSize: 36, fontWeight: 900, color: edgeStyle?.text || "#e6edf3", lineHeight: 1 }}>{result.confidence}</div>
                <div style={{ fontSize: 10, color: "#6b7280" }}>/10</div>
              </div>
            </div>

            {/* Run Projections */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
              {[away, home].map((team, i) => (
                <div key={team} style={{ background: "#010409", borderRadius: 8, padding: "12px 16px", border: "1px solid #21262d" }}>
                  <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "monospace", textTransform: "uppercase", marginBottom: 4 }}>{team} F5 Proj</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: "#e6edf3" }}>
                    {i === 0 ? result.f5_run_projection?.away : result.f5_run_projection?.home}
                    <span style={{ fontSize: 13, color: "#6b7280", fontWeight: 400, marginLeft: 4 }}>runs</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Edge Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 18 }}>
              {[
                { label: "Pitcher Edge", value: result.pitcher_edge },
                { label: "Lineup Edge", value: result.lineup_edge },
                { label: "Park", value: result.park_factor },
                { label: "Weather", value: result.weather_impact },
              ].map(({ label, value }) => (
                <div key={label} style={{ background: "#010409", borderRadius: 7, padding: "10px 12px", border: "1px solid #21262d", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#6b7280", fontFamily: "monospace", textTransform: "uppercase", marginBottom: 5 }}>{label}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#e6edf3", textTransform: "capitalize" }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Key Factors */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "monospace", textTransform: "uppercase", marginBottom: 8 }}>Key Factors</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {result.key_factors?.map((f, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ color: edgeStyle?.text || "#388bfd", fontSize: 11, marginTop: 2 }}>▸</span>
                    <span style={{ fontSize: 13, color: "#c9d1d9" }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Risk Flags */}
            {result.risk_flags?.length > 0 && (
              <div style={{ background: "#1a0a00", border: "1px solid #7c2d12", borderRadius: 7, padding: "10px 14px", marginBottom: 16 }}>
                <div style={{ fontSize: 10, color: "#f97316", fontFamily: "monospace", textTransform: "uppercase", marginBottom: 6 }}>⚠ Risk Flags</div>
                {result.risk_flags.map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#fed7aa", marginBottom: 2 }}>• {r}</div>
                ))}
              </div>
            )}

            {/* Summary */}
            <div style={{ borderTop: "1px solid #21262d", paddingTop: 14, fontSize: 13, color: "#8b949e", lineHeight: 1.6 }}>
              {result.summary}
            </div>
          </div>
        )}

        {result?.error && (
          <div style={{ background: "#1a0a0a", border: "1px solid #7c2d12", borderRadius: 10, padding: 16, color: "#f87171", fontSize: 13 }}>
            ⚠ {result.error}
          </div>
        )}
      </div>
    </div>
  );
}
