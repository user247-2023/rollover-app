import { useState, useEffect } from "react";

/* ═══════════════════════════════════════════════════════════
   MATCH PREDICTIONS — talks to the Dixon-Coles model on Railway.
   Pick a competition, pick two teams, read the match, check odds.
═══════════════════════════════════════════════════════════ */
const API = "https://web-production-6371a.up.railway.app";

const mono = "'DM Mono',monospace";
const orb  = "'Orbitron',monospace";
const C = { cyan:"#00E5FF", green:"#69FF47", red:"#FF1744", yellow:"#FFD600", mute:"#ffffff44" };

const short = (n)=> n ? n.replace(/\s+FC$/,"").replace(/\s+(AFC|CF)$/,"") : n;
const pc  = (x)=> Math.round(x*100)+"%";
const pc1 = (x)=> (x*100).toFixed(1)+"%";

const st = {
  wrap:{padding:"16px 16px 40px", position:"relative", zIndex:1},
  title:{fontFamily:orb, fontWeight:900, fontSize:18, color:C.cyan, letterSpacing:2, marginTop:10},
  sub:{fontFamily:mono, fontSize:9, color:C.mute, letterSpacing:2, marginBottom:18},
  label:{fontFamily:mono, fontSize:8, color:C.mute, letterSpacing:2, marginBottom:6, display:"block"},
  card:{background:"#ffffff05", border:"1px solid #ffffff12", borderRadius:14, padding:16, marginBottom:14},
  select:{width:"100%", background:"#0a1119", border:"1px solid #ffffff1f", borderRadius:10,
    padding:"12px", color:"#fff", fontFamily:mono, fontSize:13, WebkitAppearance:"none", appearance:"none"},
  input:{width:"100%", background:"#ffffff05", border:"1px solid #ffffff15", borderRadius:10,
    padding:"11px", color:"#fff", fontFamily:mono, fontSize:13},
  btn:{width:"100%", padding:"14px", borderRadius:10, border:"none", cursor:"pointer",
    fontFamily:orb, fontWeight:700, fontSize:13, letterSpacing:1,
    background:"linear-gradient(135deg,#00E5FF,#00B8D4)", color:"#001318", marginTop:14},
  seg:{display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
    fontFamily:orb, fontWeight:700, fontSize:13, minWidth:0, transition:"flex-grow .5s ease"},
  tile:{background:"#ffffff05", border:"1px solid #ffffff10", borderRadius:11, padding:"11px 8px", textAlign:"center"},
  tk:{fontFamily:mono, fontSize:7.5, color:C.mute, letterSpacing:1, marginBottom:5},
  tv:{fontFamily:orb, fontWeight:700, fontSize:16, color:"#fff"},
  notice:{fontFamily:mono, fontSize:11, lineHeight:1.6, padding:12, borderRadius:10,
    border:"1px solid #FF174433", background:"#FF174410", color:"#FF6D7A"},
  badge:(col)=>({fontFamily:orb, fontWeight:700, fontSize:8, letterSpacing:1, padding:"3px 8px",
    borderRadius:99, color:col, border:`1px solid ${col}55`, background:`${col}14`}),
};

export default function PredictScreen({ onBack }){
  const [leagues, setLeagues] = useState([]);
  const [league, setLeague]   = useState(39);
  const [teams, setTeams]     = useState([]);
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [home, setHome] = useState("");
  const [away, setAway] = useState("");

  const [pred, setPred] = useState(null);
  const [pLoading, setPLoading] = useState(false);
  const [pErr, setPErr] = useState("");

  const [odds, setOdds] = useState({h:"",d:"",a:"",ov:"",un:"",by:"",bn:""});
  const [bankroll, setBankroll] = useState("");
  const [val, setVal] = useState(null);
  const [vLoading, setVLoading] = useState(false);
  const [vErr, setVErr] = useState("");
  const [showAll, setShowAll] = useState(false);

  // load competitions once
  useEffect(()=>{
    fetch(`${API}/api/goals/leagues`)
      .then(r=>r.json())
      .then(d=> setLeagues(d.leagues||[]))
      .catch(()=>{});
  },[]);

  // load teams whenever the competition changes
  useEffect(()=>{
    let live = true;
    setTeamsLoading(true); setTeams([]); setPred(null); setVal(null); setPErr("");
    fetch(`${API}/api/goals/ratings?league=${league}`)
      .then(r=>r.json())
      .then(d=>{
        if(!live) return;
        const ts = (d.ratings||[]).map(t=>t.team).sort((a,b)=>short(a).localeCompare(short(b)));
        setTeams(ts); setHome(ts[0]||""); setAway(ts[1]||"");
      })
      .catch(()=>{ if(live) setTeams([]); })
      .finally(()=>{ if(live) setTeamsLoading(false); });
    return ()=>{ live=false; };
  },[league]);

  const isIntl = league === 1;

  async function readMatch(){
    if(!home || !away || home===away){ setPErr("Pick two different teams."); return; }
    setPLoading(true); setPErr(""); setPred(null); setVal(null);
    try{
      const r = await fetch(`${API}/api/goals/predict?league=${league}&home_team=${encodeURIComponent(home)}&away_team=${encodeURIComponent(away)}`);
      if(!r.ok){ const j = await r.json().catch(()=>({})); throw new Error(j.detail || "Could not read this match."); }
      setPred(await r.json());
    }catch(e){ setPErr(e.message); }
    finally{ setPLoading(false); }
  }

  async function checkValue(){
    const num = (v)=>{ const x = parseFloat(v); return isFinite(x) && x>1 ? x : null; };
    const o = {};
    if(num(odds.h)&&num(odds.d)&&num(odds.a)) o["1x2"]=[num(odds.h),num(odds.d),num(odds.a)];
    if(num(odds.ov)&&num(odds.un))            o["ou_2_5"]=[num(odds.ov),num(odds.un)];
    if(num(odds.by)&&num(odds.bn))            o["btts"]=[num(odds.by),num(odds.bn)];
    if(Object.keys(o).length===0){ setVErr("Add at least one full market — both sides (e.g. Over and Under)."); setVal(null); return; }
    setVLoading(true); setVErr(""); setVal(null); setShowAll(false);
    const body = { home_team:home, away_team:away, league, odds_by_market:o };
    const bk = parseFloat(bankroll);
    if(isFinite(bk) && bk>0) body.bankroll = bk;
    try{
      const r = await fetch(`${API}/api/goals/value`, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body),
      });
      if(!r.ok){ const j = await r.json().catch(()=>({})); throw new Error(j.detail || "Could not check value."); }
      setVal(await r.json());
    }catch(e){ setVErr(e.message); }
    finally{ setVLoading(false); }
  }

  const setOdd = (k,v)=> setOdds(o=>({...o,[k]:v}));

  return (
    <div style={st.wrap}>
      <button onClick={onBack} style={{background:"none",border:"none",color:"#00E5FF88",
        fontFamily:mono, fontSize:11, cursor:"pointer", padding:"4px 0", letterSpacing:2}}>← BACK</button>

      <div style={st.title}>MATCH PREDICTIONS</div>
      <div style={st.sub}>MODEL-DRIVEN ANALYSIS · 18 COMPETITIONS</div>

      {/* PICK */}
      <div style={st.card}>
        <label style={st.label}>COMPETITION</label>
        <select style={st.select} value={league} onChange={e=>setLeague(Number(e.target.value))}>
          {leagues.length===0 && <option>Loading…</option>}
          {leagues.map(l=> <option key={l.league_id} value={l.league_id}>{l.name}</option>)}
        </select>

        <div style={{marginTop:14, display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>
          <div>
            <label style={st.label}>HOME</label>
            <select style={st.select} value={home} onChange={e=>setHome(e.target.value)} disabled={teamsLoading}>
              {teams.map(t=> <option key={t} value={t}>{short(t)}</option>)}
            </select>
          </div>
          <div>
            <label style={st.label}>AWAY</label>
            <select style={st.select} value={away} onChange={e=>setAway(e.target.value)} disabled={teamsLoading}>
              {teams.map(t=> <option key={t} value={t}>{short(t)}</option>)}
            </select>
          </div>
        </div>

        {teamsLoading && (
          <div style={{fontFamily:mono, fontSize:10, color:C.cyan, marginTop:10, letterSpacing:1}}>
            Loading teams{isIntl ? " — national teams take a few seconds the first time…" : "…"}
          </div>
        )}

        <button style={{...st.btn, opacity:(pLoading||teamsLoading)?0.6:1}}
          onClick={readMatch} disabled={pLoading||teamsLoading}>
          {pLoading ? "READING…" : "READ THE MATCH"}
        </button>
      </div>

      {pErr && <div style={st.notice}>{pErr}</div>}

      {/* RESULT */}
      {pred && (() => {
        const h=pred["1x2"].home, d=pred["1x2"].draw, a=pred["1x2"].away;
        const eg=pred.expected_goals, ou=pred.over_under, btts=pred.btts;
        const sc=pred.correct_score||[];
        return (
          <div style={{animation:"fadeUp .4s ease"}}>
            <div style={st.card}>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", flexWrap:"wrap"}}>
                <div style={{fontFamily:orb, fontWeight:700, fontSize:15, color:"#fff"}}>
                  {short(home)} <span style={{color:C.mute}}>v</span> {short(away)}
                </div>
                <div style={{fontFamily:mono, fontSize:11, color:C.mute}}>
                  xG {eg.home.toFixed(2)} – {eg.away.toFixed(2)}
                </div>
              </div>

              <div style={{display:"flex", height:44, borderRadius:10, overflow:"hidden",
                border:"1px solid #ffffff12", marginTop:14}}>
                <div style={{...st.seg, flexGrow:h||0.001, background:C.green, color:"#062b00"}}>{pc(h)}<span style={{fontSize:8,fontWeight:500}}>HOME</span></div>
                <div style={{...st.seg, flexGrow:d||0.001, background:"#2b3547", color:"#fff"}}>{pc(d)}<span style={{fontSize:8,fontWeight:500,opacity:.7}}>DRAW</span></div>
                <div style={{...st.seg, flexGrow:a||0.001, background:C.red, color:"#2b0008"}}>{pc(a)}<span style={{fontSize:8,fontWeight:500}}>AWAY</span></div>
              </div>

              <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginTop:14}}>
                <div style={st.tile}><div style={st.tk}>OVER 2.5</div><div style={st.tv}>{pc(ou["2.5"].over)}</div></div>
                <div style={st.tile}><div style={st.tk}>BTTS</div><div style={st.tv}>{pc(btts.yes)}</div></div>
                <div style={st.tile}><div style={st.tk}>OVER 1.5</div><div style={st.tv}>{pc(ou["1.5"].over)}</div></div>
              </div>

              <div style={{fontFamily:mono, fontSize:8, color:C.mute, letterSpacing:2, margin:"16px 0 8px"}}>LIKELY SCORES</div>
              <div style={{display:"flex", gap:7, flexWrap:"wrap"}}>
                {sc.map((s,i)=>(
                  <div key={i} style={{flex:1, minWidth:60, textAlign:"center", padding:"8px 4px", borderRadius:10,
                    border:`1px solid ${i===0?C.cyan:"#ffffff10"}`, background:i===0?"#00E5FF12":"#ffffff05"}}>
                    <div style={{fontFamily:mono, fontSize:15, color:"#fff", fontWeight:500}}>{s.home}–{s.away}</div>
                    <div style={{fontFamily:mono, fontSize:9, color:C.mute, marginTop:2}}>{pc1(s.prob)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* VALUE */}
            <div style={st.card}>
              <div style={{fontFamily:orb, fontWeight:700, fontSize:12, color:C.yellow, letterSpacing:1, marginBottom:6}}>
                CHECK THE ODDS FOR VALUE
              </div>
              <div style={{fontFamily:mono, fontSize:10.5, color:C.mute, lineHeight:1.6, marginBottom:14}}>
                Enter the decimal odds your bookmaker is showing. We strip their margin, compare to the model,
                and flag any bet priced in your favour.
              </div>

              <label style={st.label}>MATCH RESULT — HOME / DRAW / AWAY</label>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:12}}>
                <input style={st.input} inputMode="decimal" placeholder="1.85" value={odds.h} onChange={e=>setOdd("h",e.target.value)}/>
                <input style={st.input} inputMode="decimal" placeholder="3.60" value={odds.d} onChange={e=>setOdd("d",e.target.value)}/>
                <input style={st.input} inputMode="decimal" placeholder="4.20" value={odds.a} onChange={e=>setOdd("a",e.target.value)}/>
              </div>

              <label style={st.label}>OVER 2.5 / UNDER 2.5</label>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12}}>
                <input style={st.input} inputMode="decimal" placeholder="Over 1.90" value={odds.ov} onChange={e=>setOdd("ov",e.target.value)}/>
                <input style={st.input} inputMode="decimal" placeholder="Under 1.95" value={odds.un} onChange={e=>setOdd("un",e.target.value)}/>
              </div>

              <label style={st.label}>BOTH TEAMS SCORE — YES / NO</label>
              <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12}}>
                <input style={st.input} inputMode="decimal" placeholder="Yes 1.95" value={odds.by} onChange={e=>setOdd("by",e.target.value)}/>
                <input style={st.input} inputMode="decimal" placeholder="No 1.80" value={odds.bn} onChange={e=>setOdd("bn",e.target.value)}/>
              </div>

              <label style={st.label}>YOUR BANKROLL (OPTIONAL, TSH)</label>
              <input style={st.input} inputMode="numeric" placeholder="100000" value={bankroll} onChange={e=>setBankroll(e.target.value)}/>

              <button style={{...st.btn, background:"linear-gradient(135deg,#FFD600,#FF8F00)", color:"#1a1400",
                opacity:vLoading?0.6:1}} onClick={checkValue} disabled={vLoading}>
                {vLoading ? "CHECKING…" : "CHECK FOR VALUE"}
              </button>

              {vErr && <div style={{...st.notice, marginTop:12}}>{vErr}</div>}

              {val && <ValueResult res={val} /> }
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function BetRow({ b }){
  const isVal = b.is_value;
  const tierCol = b.risk_tier==="low" ? C.green : b.risk_tier==="medium" ? C.yellow : C.red;
  return (
    <div style={{border:`1px solid ${isVal?C.green+"66":"#ffffff10"}`, borderRadius:11, padding:12, marginTop:10,
      background:isVal ? "linear-gradient(180deg,#69FF4710,transparent)" : "#ffffff04"}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, flexWrap:"wrap"}}>
        <div style={{fontFamily:orb, fontWeight:700, fontSize:13, color:"#fff"}}>{b.label}</div>
        <div style={{display:"flex", alignItems:"center", gap:8}}>
          <div style={{fontFamily:orb, fontWeight:700, fontSize:15, color:b.edge>0?C.green:C.mute}}>
            {b.edge_pct>0?"+":""}{b.edge_pct}%
          </div>
          {isVal && <span style={st.badge(tierCol)}>{b.risk_tier} risk</span>}
        </div>
      </div>
      <div style={{display:"flex", gap:14, flexWrap:"wrap", marginTop:9, fontFamily:mono, fontSize:10, color:C.mute}}>
        <span>Model <b style={{color:"#fff"}}>{pc1(b.model_prob)}</b></span>
        <span>Fair <b style={{color:"#fff"}}>{(1/b.market_fair_prob).toFixed(2)}</b></span>
        <span>Yours <b style={{color:"#fff"}}>{b.best_odds}</b></span>
        {isVal && b.stake_amount!=null && <span>Stake <b style={{color:C.yellow}}>TSH {Number(b.stake_amount).toLocaleString()}</b></span>}
        {isVal && b.stake_amount==null && <span>Stake <b style={{color:C.yellow}}>{pc1(b.stake_fraction)}</b></span>}
      </div>
    </div>
  );
}

function ValueResult({ res }){
  const [open,setOpen]=useState(false);
  const value = res.value_bets||[];
  const all = res.all_selections||[];
  return (
    <div style={{marginTop:6}}>
      {value.length>0 ? (
        value.map((b,i)=><BetRow key={i} b={b}/>)
      ) : (
        <div style={{textAlign:"center", padding:"18px 8px", fontFamily:mono, fontSize:11, color:C.mute, lineHeight:1.6}}>
          <div style={{fontFamily:orb, fontSize:13, color:"#fff", marginBottom:6}}>NO VALUE AT THESE ODDS</div>
          The bookmaker's prices are fair or better here. Try other odds or another match.
        </div>
      )}
      <button onClick={()=>setOpen(o=>!o)} style={{background:"none", border:"none", color:C.cyan,
        fontFamily:mono, fontSize:10.5, cursor:"pointer", padding:"10px 0", letterSpacing:1}}>
        {open ? "HIDE ALL COMPARISONS ▴" : `SHOW ALL ${all.length} COMPARISONS ▾`}
      </button>
      {open && all.map((b,i)=><BetRow key={i} b={b}/>)}
    </div>
  );
}
