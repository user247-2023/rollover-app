import { useState, useEffect, useRef } from "react";
import { db } from "./firebase.js";
import { doc, getDoc, setDoc } from "firebase/firestore";

/* ═══════════════════════════════════════════════════════════════════
   ROLLOVER · MATCH INTELLIGENCE
   Two modes in one screen:
     • UPCOMING    — live fixtures + model/market/blended read + tips
     • PICK A MATCH — manual two-team analysis (unchanged behaviour)
   Talks to the Dixon-Coles + market-blend backend on Railway.
═══════════════════════════════════════════════════════════════════ */
const API = "https://web-production-6371a.up.railway.app";

const mono = "'DM Mono',monospace";
const orb  = "'Orbitron',monospace";
const C = {
  cyan:"#00E5FF", green:"#69FF47", red:"#FF5470", yellow:"#FFD600", gold:"#FFB300",
  mute:"#ffffff40", dim:"#ffffff9c", soft:"#ffffff66", line:"#ffffff14", panel:"#ffffff06",
};

const short = (n)=> n ? n.replace(/\s+FC$/,"").replace(/\s+(AFC|CF)$/,"") : n;
const pc  = (x)=> Math.round((x||0)*100)+"%";
const pc1 = (x)=> ((x||0)*100).toFixed(1)+"%";
const dec = (x)=> (x==null? "—" : Number(x).toFixed(2));

/* kickoff → friendly local label + relative hint */
function kickLabel(iso){
  if(!iso) return {when:"", rel:""};
  const d = new Date(iso); const now = new Date();
  const diff = d - now; const hrs = diff/3.6e6;
  const day = d.toLocaleDateString(undefined,{weekday:"short", day:"numeric", month:"short"});
  const time = d.toLocaleTimeString(undefined,{hour:"2-digit", minute:"2-digit"});
  const sameDay = d.toDateString()===now.toDateString();
  let rel = "";
  if(hrs < 0) rel = "live / done";
  else if(hrs < 1) rel = `in ${Math.max(1,Math.round(diff/6e4))}m`;
  else if(hrs < 24 && sameDay) rel = `in ${Math.round(hrs)}h`;
  else if(hrs < 48) rel = "tomorrow";
  return { when: sameDay ? `Today ${time}` : `${day} · ${time}`, rel };
}
const confColor = (c)=> c==="High"?C.green : c==="Medium"?C.cyan : C.gold;

/* ── Durable prediction archive: Firebase + free results feed ───────── */
function predDeviceId(){
  let id = localStorage.getItem("rolloverDeviceId");
  if(!id){ id = "RLV-"+Math.random().toString(36).slice(2,8).toUpperCase(); localStorage.setItem("rolloverDeviceId", id); }
  return id;
}
async function loadPredArchive(){
  try{ const snap = await getDoc(doc(db,"predictions",predDeviceId())); return snap.exists() ? (snap.data().log||[]) : []; }
  catch(e){ try{ return JSON.parse(localStorage.getItem("predArchive")||"[]"); }catch(_){ return []; } }
}
async function savePredArchive(log){
  try{ await setDoc(doc(db,"predictions",predDeviceId()), {log, updatedAt:Date.now()}); }
  catch(e){ try{ localStorage.setItem("predArchive", JSON.stringify(log)); }catch(_){ } }
}
const PRED_ALIASES = { korearepublic:"southkorea", southkorea:"southkorea", koreadpr:"northkorea",
  usa:"unitedstates", unitedstatesofamerica:"unitedstates", unitedstates:"unitedstates",
  czechia:"czechrepublic", czechrepublic:"czechrepublic", turkiye:"turkey", turkey:"turkey", iran:"iran",
  ivorycoast:"ivorycoast", cotedivoire:"ivorycoast", drcongo:"drcongo", congodr:"drcongo",
  capeverde:"capeverde", caboverde:"capeverde", china:"chinapr", chinapr:"chinapr",
  bosnia:"bosniaandherzegovina", bosniaandherzegovina:"bosniaandherzegovina",
  uae:"unitedarabemirates", unitedarabemirates:"unitedarabemirates",
  northmacedonia:"northmacedonia", macedonia:"northmacedonia",
  republicofireland:"republicofireland", ireland:"republicofireland", curacao:"curacao" };
function predNorm(x){ let n=(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,""); return PRED_ALIASES[n]||n; }
function predDates(d){ if(!d) return []; const out=[]; const base=new Date(d+"T00:00:00Z");
  for(let i=-1;i<=1;i++){ const x=new Date(base); x.setUTCDate(x.getUTCDate()+i); out.push(x.toISOString().slice(0,10)); } return out; }
let _predResults=null, _predAt=0;
async function predFetchResults(){
  if(_predResults && Date.now()-_predAt < 30*60*1000) return _predResults;
  try{
    const txt = await fetch("https://raw.githubusercontent.com/martj42/international_results/master/results.csv").then(r=>r.text());
    const cutoff = new Date(Date.now()-150*24*3600*1000).toISOString().slice(0,10);
    const map = new Map(); const lines = txt.split(/\r?\n/);
    for(let i=1;i<lines.length;i++){ const c=lines[i].split(","); if(c.length<5) continue; const date=c[0]; if(date<cutoff) continue;
      const hs=c[3], as=c[4]; if(hs===""||as===""||hs==="NA"||as==="NA") continue; const hg=parseInt(hs,10), ag=parseInt(as,10);
      if(!isFinite(hg)||!isFinite(ag)) continue; map.set(predNorm(c[1])+"|"+predNorm(c[2])+"|"+date,{hg,ag}); }
    _predResults=map; _predAt=Date.now(); return map;
  }catch(e){ return _predResults; }
}
function predFindScore(p, map){ if(!map) return null; const h=predNorm(p.home), a=predNorm(p.away); if(!h||!a) return null;
  for(const d of predDates(p.date)){ const hit=map.get(h+"|"+a+"|"+d); if(hit) return hit; } return null; }
const predArgmax = (o)=> !o ? null : (o.home>=o.draw && o.home>=o.away ? "home" : o.draw>=o.away ? "draw" : "away");
function predBrier(probs, actual){ if(!probs) return null; const y={home:0,draw:0,away:0}; y[actual]=1;
  return (probs.home-y.home)**2+(probs.draw-y.draw)**2+(probs.away-y.away)**2; }
function computeScorecard(archive){
  const tracked = archive.length;
  const settled = archive.filter(p=>p.result);
  const n = settled.length;
  if(n===0) return {tracked, settled:0, pending:tracked, recent:[],
    message:"Open the UPCOMING tab to log predictions \u2014 they'll be graded here automatically once those matches finish."};
  let bh=0, mh=0, mkh=0, mkn=0, brM=0, brB=0, brK=0, brKn=0;
  for(const p of settled){
    const actual=p.result;
    if(p.pick===actual) bh++;
    if(predArgmax(p.model)===actual) mh++;
    if(p.market){ mkn++; if(predArgmax(p.market)===actual) mkh++; }
    const bM=predBrier(p.model,actual), bB=predBrier(p.blend,actual), bK=predBrier(p.market,actual);
    if(bM!=null) brM+=bM; if(bB!=null) brB+=bB; if(bK!=null){ brK+=bK; brKn++; }
  }
  const recent = settled.slice().sort((a,b)=>(b.settledAt||0)-(a.settledAt||0)).slice(0,10)
    .map(p=>({match:`${p.home} v ${p.away}`, pick:p.pick, result:p.result, score:p.score, hit:p.pick===p.result}));
  const brierMarket = mkn ? brK/brKn : null;
  const brierBlend = brB/n;
  return {
    tracked, settled:n, pending:tracked-n,
    hit_rate: bh/n,
    market_favourite_hit_rate: mkn ? mkh/mkn : null,
    brier: { model: brM/n, blend: brierBlend, market: brierMarket },
    blend_beats_market: brierMarket!=null && brierBlend < brierMarket,
    by_competition: { internationals:{settled:n, hit_rate:bh/n}, clubs:{settled:0, hit_rate:null} },
    recent,
  };
}

const st = {
  wrap:{padding:"16px 16px 48px", position:"relative", zIndex:1},
  back:{background:"none",border:"none",color:"#00E5FF99",fontFamily:mono,fontSize:11,
    cursor:"pointer",padding:"4px 0",letterSpacing:2},
  title:{fontFamily:orb, fontWeight:900, fontSize:18, color:"#fff", letterSpacing:2, marginTop:10},
  titleGlow:{color:C.cyan, textShadow:"0 0 18px #00E5FF55"},
  sub:{fontFamily:mono, fontSize:9, color:C.soft, letterSpacing:2, marginBottom:16},
  label:{fontFamily:mono, fontSize:8, color:C.soft, letterSpacing:2, marginBottom:6, display:"block"},
  card:{background:C.panel, border:`1px solid ${C.line}`, borderRadius:16, padding:16, marginBottom:14},
  select:{width:"100%", background:"#0a1119", border:"1px solid #ffffff1f", borderRadius:10,
    padding:"12px", color:"#fff", fontFamily:mono, fontSize:13, WebkitAppearance:"none", appearance:"none"},
  input:{width:"100%", background:"#ffffff05", border:"1px solid #ffffff15", borderRadius:10,
    padding:"11px", color:"#fff", fontFamily:mono, fontSize:13},
  btn:{width:"100%", padding:"14px", borderRadius:12, border:"none", cursor:"pointer",
    fontFamily:orb, fontWeight:700, fontSize:13, letterSpacing:1,
    background:"linear-gradient(135deg,#00E5FF,#00B8D4)", color:"#001318", marginTop:14},
  seg:{display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
    fontFamily:orb, fontWeight:700, fontSize:13, minWidth:0},
  tile:{background:"#ffffff05", border:"1px solid #ffffff10", borderRadius:12, padding:"11px 8px", textAlign:"center"},
  tk:{fontFamily:mono, fontSize:7.5, color:C.soft, letterSpacing:1, marginBottom:5},
  tv:{fontFamily:orb, fontWeight:700, fontSize:16, color:"#fff"},
  notice:{fontFamily:mono, fontSize:11, lineHeight:1.6, padding:12, borderRadius:10,
    border:"1px solid #FF547033", background:"#FF547010", color:"#FF8A9C"},
  chip:(col)=>({fontFamily:orb, fontWeight:700, fontSize:8, letterSpacing:1, padding:"3px 9px",
    borderRadius:99, color:col, border:`1px solid ${col}55`, background:`${col}16`, whiteSpace:"nowrap"}),
  badge:(col)=>({fontFamily:orb, fontWeight:700, fontSize:8, letterSpacing:1, padding:"3px 8px",
    borderRadius:99, color:col, border:`1px solid ${col}55`, background:`${col}14`}),
};

/* tiny inline SVG icons (no emoji) */
const Icon = {
  clock:(c=C.soft)=>(<svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}>
    <circle cx="12" cy="12" r="9" stroke={c} strokeWidth="2"/><path d="M12 7v5l3 2" stroke={c} strokeWidth="2" strokeLinecap="round"/></svg>),
  pin:(c=C.soft)=>(<svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}>
    <path d="M12 22s7-7.6 7-13a7 7 0 1 0-14 0c0 5.4 7 13 7 13Z" stroke={c} strokeWidth="2"/><circle cx="12" cy="9" r="2.5" stroke={c} strokeWidth="2"/></svg>),
  chev:(c=C.cyan,open)=>(<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    style={{transition:"transform .25s ease", transform:open?"rotate(180deg)":"none"}}>
    <path d="M6 9l6 6 6-6" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>),
  spark:(c=C.gold)=>(<svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{flexShrink:0}}>
    <path d="M12 2l2.2 6.3L20 10l-5.8 1.7L12 18l-2.2-6.3L4 10l5.8-1.7L12 2Z" stroke={c} strokeWidth="1.6" strokeLinejoin="round"/></svg>),
};

const STYLE = `
@keyframes cardIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes barGrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes expandIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulseDot{0%,100%{opacity:1}50%{opacity:.25}}
.rl-card{animation:cardIn .45s cubic-bezier(.2,.7,.2,1) both}
.rl-bar{transform-origin:left center;animation:barGrow .65s cubic-bezier(.2,.8,.2,1) both}
.rl-exp{animation:expandIn .3s ease both}
.rl-press{transition:border-color .2s ease, background .2s ease, box-shadow .2s ease}
.rl-press:hover{border-color:#00E5FF44 !important; box-shadow:0 6px 28px #00000040}
.rl-skel{background:linear-gradient(90deg,#ffffff08 25%,#ffffff14 37%,#ffffff08 63%);
  background-size:200% 100%;animation:shimmer 1.4s infinite}
.rl-spin{width:15px;height:15px;border:2px solid #ffffff22;border-top-color:#00E5FF;border-radius:50%;
  display:inline-block;animation:spin .8s linear infinite;vertical-align:-3px}
.rl-tab{flex:1;padding:11px 8px;border:none;cursor:pointer;font-family:${orb};font-weight:700;
  font-size:11px;letter-spacing:1.5;border-radius:10px;transition:all .25s ease}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
`;

/* ─────────────────────────────────────────────────────────────────── */
export default function PredictScreen({ onBack }){
  const [mode, setMode] = useState("upcoming"); // upcoming | best | track | manual
  const TABS = [["upcoming","UPCOMING"],["best","TIPS"],["track","TRACK"],["manual","PICK"]];
  const [predArchive, setPredArchive] = useState([]);

  useEffect(()=>{ let live=true; loadPredArchive().then(a=>{ if(live) setPredArchive(a); }); return ()=>{live=false;}; },[]);

  // Log the blended predictions currently shown (dedup by event; keep earliest pre-kickoff snapshot).
  const logPredictions = (matches)=>{
    setPredArchive(prev=>{
      const have = new Map(prev.map(p=>[p.id,p]));
      let changed=false;
      for(const m of (matches||[])){
        if(!m.matched || !m.prediction || m.started) continue;
        const pr=m.prediction; const blend=pr.prediction_1x2||pr.model_1x2; if(!blend) continue;
        if(have.has(m.event_id)) continue;
        const pick=predArgmax(blend);
        have.set(m.event_id, { id:m.event_id, home:m.home, away:m.away, date:(m.kickoff||"").slice(0,10), kickoff:m.kickoff,
          pick, prob:blend[pick], model:pr.model_1x2, market:pr.market_1x2||null, blend,
          neutral:!!pr.neutral_venue, loggedAt:Date.now(), result:null, score:null });
        changed=true;
      }
      if(!changed) return prev;
      const next=[...have.values()]; savePredArchive(next); return next;
    });
  };

  // Grade logged predictions whose match has finished (free results feed).
  const settlePredictions = async ()=>{
    const map = await predFetchResults(); if(!map) return;
    setPredArchive(prev=>{
      let changed=false;
      const next = prev.map(p=>{
        if(p.result) return p;
        const sc=predFindScore(p,map); if(!sc) return p;
        const actual = sc.hg>sc.ag?"home":sc.ag>sc.hg?"away":"draw";
        changed=true;
        return {...p, result:actual, score:`${sc.hg}-${sc.ag}`, settledAt:Date.now()};
      });
      if(!changed) return prev;
      savePredArchive(next); return next;
    });
  };
  return (
    <div style={st.wrap}>
      <style>{STYLE}</style>
      <button onClick={onBack} style={st.back}>← BACK</button>

      <div style={st.title}>MATCH <span style={st.titleGlow}>INTELLIGENCE</span></div>
      <div style={st.sub}>MODEL · MARKET · BLENDED VERDICT</div>

      {/* mode toggle */}
      <div style={{display:"flex", gap:5, background:"#ffffff06", border:`1px solid ${C.line}`,
        borderRadius:13, padding:5, marginBottom:18}}>
        {TABS.map(([id,label])=>{
          const on = mode===id;
          return (
            <button key={id} className="rl-tab" onClick={()=>setMode(id)}
              style={{fontSize:9.5, letterSpacing:0.5, padding:"11px 4px", whiteSpace:"nowrap",
                background: on?"linear-gradient(135deg,#00E5FF,#00B8D4)":"transparent",
                color: on?"#001318":C.soft, boxShadow: on?"0 0 16px #00E5FF44":"none"}}>
              {label}
            </button>
          );
        })}
      </div>

      {mode==="upcoming" && <UpcomingTab onLog={logPredictions}/>}
      {mode==="best"     && <BestTipsTab/>}
      {mode==="track"    && <TrackRecordTab archive={predArchive} onSettle={settlePredictions}/>}
      {mode==="manual"   && <ManualTab/>}
    </div>
  );
}

/* ═══════════════════ UPCOMING ═══════════════════════════════════ */
function UpcomingTab({ onLog }){
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [bankroll, setBankroll] = useState("");

  useEffect(()=>{
    let live = true;
    setLoading(true); setErr("");
    fetch(`${API}/api/live/matches?hours=120`)
      .then(r=> r.ok ? r.json() : r.json().then(j=>Promise.reject(new Error(j.detail||"Could not load fixtures."))))
      .then(d=>{ if(live){ setData(d); if(onLog) onLog(d.matches||[]); } })
      .catch(e=>{ if(live) setErr(e.message); })
      .finally(()=>{ if(live) setLoading(false); });
    return ()=>{ live=false; };
  },[]);

  if(loading) return <SkeletonList/>;
  if(err) return <div style={st.notice}>{err}</div>;

  const matches = (data?.matches||[]);
  const budget = data?.budget;

  if(matches.length===0){
    return (
      <div style={{...st.card, textAlign:"center", padding:"30px 16px"}}>
        <div style={{fontFamily:orb, fontWeight:700, fontSize:14, color:"#fff", marginBottom:8}}>NO UPCOMING MATCHES</div>
        <div style={{fontFamily:mono, fontSize:11, color:C.dim, lineHeight:1.7}}>
          Nothing in the next few days yet. Knockout fixtures appear here once the draw is set.
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* optional bankroll, applied to every value check */}
      <div style={{...st.card, padding:"12px 14px", display:"flex", alignItems:"center", gap:10, marginBottom:14}}>
        <div style={{flex:1}}>
          <label style={st.label}>BANKROLL — OPTIONAL, FOR STAKE SIZING (TSH)</label>
          <input style={{...st.input, padding:"9px 11px"}} inputMode="numeric" placeholder="100000"
            value={bankroll} onChange={e=>setBankroll(e.target.value)}/>
        </div>
      </div>

      {matches.map((m,i)=>(
        <MatchCard key={m.event_id} m={m} hero={i===0} idx={i} bankroll={bankroll}/>
      ))}

      {budget && (
        <div style={{textAlign:"center", fontFamily:mono, fontSize:9, color:C.mute,
          letterSpacing:1, marginTop:6, lineHeight:1.7}}>
          ODDS FROM LIVE MARKET{budget.credits_remaining!=null?` · ${budget.credits_remaining} CREDITS LEFT`:""}
          <br/>PREDICTIONS BLEND THE MODEL WITH BOOKMAKER CONSENSUS
        </div>
      )}
    </div>
  );
}

function SkeletonList(){
  return (
    <div>
      {[0,1,2].map(i=>(
        <div key={i} style={{...st.card, animationDelay:`${i*0.05}s`}}>
          <div className="rl-skel" style={{height:14, width:"60%", borderRadius:6, marginBottom:14}}/>
          <div className="rl-skel" style={{height:42, width:"100%", borderRadius:10, marginBottom:14}}/>
          <div className="rl-skel" style={{height:11, width:"45%", borderRadius:6}}/>
        </div>
      ))}
      <div style={{textAlign:"center", fontFamily:mono, fontSize:10, color:C.soft, letterSpacing:1, marginTop:4}}>
        <span className="rl-spin"/>  Loading fixtures &amp; odds…
      </div>
    </div>
  );
}

/* one fixture */
function MatchCard({ m, hero, idx, bankroll }){
  const [open, setOpen] = useState(false);
  const p = m.prediction;
  const k = kickLabel(m.kickoff);
  const matched = m.matched && p;

  // headline = blended verdict if we have it, else model
  const probs = matched ? (p.prediction_1x2 || p.model_1x2) : null;
  const tip = matched ? p.tips?.result_pick : null;
  const dcTip = matched ? p.tips?.double_chance_pick : null;
  const cCol = tip ? confColor(tip.confidence) : C.cyan;

  return (
    <div className="rl-card rl-press" onClick={()=> matched && setOpen(o=>!o)}
      style={{...st.card, marginBottom:14, cursor: matched?"pointer":"default",
        borderColor: hero ? "#00E5FF33" : C.line, animationDelay:`${Math.min(idx,8)*0.05}s`,
        background: hero ? "linear-gradient(180deg,#00E5FF0c,transparent 60%)" : C.panel}}>

      {/* header row */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10}}>
        <div style={{minWidth:0}}>
          {hero && <div style={{fontFamily:mono, fontSize:8, color:C.cyan, letterSpacing:3, marginBottom:6}}>NEXT UP</div>}
          <div style={{fontFamily:orb, fontWeight:700, fontSize: hero?17:15, color:"#fff", lineHeight:1.25}}>
            {short(m.home)} <span style={{color:C.mute, fontWeight:400}}>v</span> {short(m.away)}
          </div>
          <div style={{display:"flex", alignItems:"center", gap:6, marginTop:7, flexWrap:"wrap"}}>
            <span style={{display:"flex", alignItems:"center", gap:4, fontFamily:mono, fontSize:10, color:C.dim}}>
              {Icon.clock()} {k.when}
            </span>
            {k.rel && <span style={{fontFamily:mono, fontSize:9, color:C.cyan}}>· {k.rel}</span>}
            {p?.neutral_venue && <span style={{display:"flex", alignItems:"center", gap:3, fontFamily:mono, fontSize:9, color:C.soft}}>{Icon.pin()} neutral</span>}
          </div>
        </div>
        {matched && Icon.chev(C.cyan, open)}
      </div>

      {!matched ? (
        <div style={{fontFamily:mono, fontSize:10.5, color:C.soft, lineHeight:1.6, marginTop:12}}>
          Prediction unavailable — one of these teams isn’t in the model yet.
        </div>
      ) : (
        <>
          {/* OUR CALL verdict */}
          <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", gap:10,
            marginTop:14, padding:"11px 13px", borderRadius:12,
            background:`linear-gradient(135deg,${cCol}14,transparent)`, border:`1px solid ${cCol}33`}}>
            <div style={{minWidth:0}}>
              <div style={{fontFamily:mono, fontSize:8, color:C.soft, letterSpacing:2, marginBottom:3}}>OUR CALL</div>
              <div style={{fontFamily:orb, fontWeight:700, fontSize:14, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                {tipTeamLabel(tip, m)}
              </div>
            </div>
            <div style={{display:"flex", alignItems:"center", gap:8, flexShrink:0}}>
              <span style={st.chip(cCol)}>{tip.confidence}</span>
              <div style={{fontFamily:orb, fontWeight:900, fontSize:20, color:cCol}}>{pc(tip.prob)}</div>
            </div>
          </div>

          {/* blended 1X2 bar */}
          <ProbBar probs={probs}/>

          {/* model vs market divergence (the signature) */}
          {p.market_1x2 && <Divergence model={p.model_1x2} market={p.market_1x2} pick={tip.selection}/>}

          {/* double chance tip */}
          {dcTip && (
            <div style={{display:"flex", alignItems:"center", gap:8, marginTop:12, padding:"9px 12px",
              borderRadius:11, background:"#FFB30010", border:"1px solid #FFB30033"}}>
              {Icon.spark()}
              <div style={{fontFamily:mono, fontSize:10.5, color:C.dim, flex:1}}>
                <b style={{color:"#fff"}}>Safest:</b> {dcTip.label}
              </div>
              <div style={{fontFamily:orb, fontWeight:700, fontSize:12, color:C.gold}}>{pc(dcTip.prob)}</div>
              <div style={{fontFamily:mono, fontSize:9, color:C.soft}}>fair {dec(dcTip.fair_odds)}</div>
            </div>
          )}

          {/* expand affordance */}
          <div style={{textAlign:"center", marginTop:12, fontFamily:mono, fontSize:9.5, color:C.cyan, letterSpacing:1}}>
            {open ? "HIDE DETAIL ▴" : "TAP FOR MARKETS & VALUE ▾"}
          </div>

          {open && <CardDetail m={m} p={p} bankroll={bankroll}/>}
        </>
      )}
    </div>
  );
}

function tipTeamLabel(tip, m){
  if(!tip) return "";
  if(tip.selection==="1") return `${short(m.home)} win`;
  if(tip.selection==="2") return `${short(m.away)} win`;
  return "Draw";
}

function ProbBar({ probs }){
  const h=probs.home||0.001, d=probs.draw||0.001, a=probs.away||0.001;
  return (
    <div className="rl-bar" style={{display:"flex", height:42, borderRadius:11, overflow:"hidden",
      border:`1px solid ${C.line}`, marginTop:13}}>
      <div style={{...st.seg, flexGrow:h, background:"linear-gradient(135deg,#69FF47,#34D399)", color:"#052b00"}}>
        {pc(h)}<span style={{fontSize:7.5,fontWeight:500}}>HOME</span></div>
      <div style={{...st.seg, flexGrow:d, background:"#2b3547", color:"#fff"}}>
        {pc(d)}<span style={{fontSize:7.5,fontWeight:500,opacity:.7}}>DRAW</span></div>
      <div style={{...st.seg, flexGrow:a, background:"linear-gradient(135deg,#FF5470,#FB7185)", color:"#2b0008"}}>
        {pc(a)}<span style={{fontSize:7.5,fontWeight:500}}>AWAY</span></div>
    </div>
  );
}

/* Model vs Market for the picked side — the value signal made visible */
function Divergence({ model, market, pick }){
  const key = pick==="2" ? "away" : pick==="X" ? "draw" : "home";
  const mod = model[key], mkt = market[key];
  const edge = mod - mkt;
  const eCol = Math.abs(edge) < 0.03 ? C.soft : edge > 0 ? C.green : C.red;
  const sideName = key==="home"?"Home":key==="away"?"Away":"Draw";
  return (
    <div style={{display:"flex", alignItems:"center", gap:12, marginTop:11, fontFamily:mono, fontSize:10, color:C.soft}}>
      <span style={{letterSpacing:1, fontSize:8, color:C.mute}}>{sideName.toUpperCase()}</span>
      <span>Model <b style={{color:"#fff"}}>{pc(mod)}</b></span>
      <span>Market <b style={{color:"#fff"}}>{pc(mkt)}</b></span>
      <span style={{marginLeft:"auto", color:eCol, fontFamily:orb, fontWeight:700, fontSize:11}}>
        {edge>0?"+":""}{Math.round(edge*100)}%
      </span>
    </div>
  );
}

function CardDetail({ m, p, bankroll }){
  const ou = p.over_under_2_5, btts = p.btts, ts = p.top_score;
  return (
    <div className="rl-exp" style={{marginTop:14, paddingTop:14, borderTop:`1px solid ${C.line}`}}
      onClick={e=>e.stopPropagation()}>
      <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:4}}>
        <div style={st.tile}><div style={st.tk}>OVER 2.5</div><div style={st.tv}>{pc(ou?.over)}</div></div>
        <div style={st.tile}><div style={st.tk}>BTTS</div><div style={st.tv}>{pc(btts?.yes)}</div></div>
        <div style={st.tile}><div style={st.tk}>LIKELY</div><div style={st.tv}>{ts? `${ts.home}–${ts.away}`:"—"}</div></div>
      </div>
      <ValueVerdict eventId={m.event_id} bankroll={bankroll}/>
    </div>
  );
}

/* live value verdict — reads odds already stored on the server (no quota cost) */
function ValueVerdict({ eventId, bankroll }){
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(()=>{
    let live = true; setLoading(true); setErr("");
    const q = (isFinite(parseFloat(bankroll)) && parseFloat(bankroll)>0) ? `?bankroll=${parseFloat(bankroll)}` : "";
    fetch(`${API}/api/live/value/${eventId}${q}`)
      .then(r=> r.ok ? r.json() : r.json().then(j=>Promise.reject(new Error(j.detail||"No value data."))))
      .then(d=>{ if(live) setRes(d); })
      .catch(e=>{ if(live) setErr(e.message); })
      .finally(()=>{ if(live) setLoading(false); });
    return ()=>{ live=false; };
  },[eventId, bankroll]);

  if(loading) return <div style={{textAlign:"center", padding:"14px 0", fontFamily:mono, fontSize:10, color:C.soft}}><span className="rl-spin"/>  Checking the market…</div>;
  if(err) return <div style={{...st.notice, marginTop:12}}>{err}</div>;

  const value = res?.value_bets||[];
  return (
    <div style={{marginTop:14}}>
      <div style={{fontFamily:mono, fontSize:8, color:C.soft, letterSpacing:2, marginBottom:8}}>
        VALUE vs {res?.event?.books_count||0} BOOKMAKERS
      </div>
      {value.length>0 ? value.map((b,i)=><BetRow key={i} b={b}/>) : (
        <div style={{textAlign:"center", padding:"14px 8px", fontFamily:mono, fontSize:10.5, color:C.dim, lineHeight:1.6}}>
          <div style={{fontFamily:orb, fontSize:12, color:"#fff", marginBottom:5}}>NO EDGE RIGHT NOW</div>
          The market’s prices match the model here. That’s the system being honest, not a fault.
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ PICK A MATCH (manual, preserved) ═════════════ */
function ManualTab(){
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

  useEffect(()=>{
    fetch(`${API}/api/goals/leagues`).then(r=>r.json()).then(d=> setLeagues(d.leagues||[])).catch(()=>{});
  },[]);

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
      const nq = isIntl ? "&neutral=true" : "";
      const r = await fetch(`${API}/api/goals/predict?league=${league}&home_team=${encodeURIComponent(home)}&away_team=${encodeURIComponent(away)}${nq}`);
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
    setVLoading(true); setVErr(""); setVal(null);
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
    <div>
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
        {isIntl && !teamsLoading && (
          <div style={{fontFamily:mono, fontSize:9.5, color:C.soft, marginTop:10, lineHeight:1.5}}>
            International matches are treated as neutral-venue (no home-ground boost).
          </div>
        )}

        <button style={{...st.btn, opacity:(pLoading||teamsLoading)?0.6:1}}
          onClick={readMatch} disabled={pLoading||teamsLoading}>
          {pLoading ? "READING…" : "READ THE MATCH"}
        </button>
      </div>

      {pErr && <div style={st.notice}>{pErr}</div>}

      {pred && (() => {
        const h=pred["1x2"].home, d=pred["1x2"].draw, a=pred["1x2"].away;
        const eg=pred.expected_goals, ou=pred.over_under, btts=pred.btts;
        const sc=pred.correct_score||[];
        const rTip = pred.tips?.result_pick, dTip = pred.tips?.double_chance_pick;
        const cCol = rTip ? confColor(rTip.confidence) : C.cyan;
        return (
          <div style={{animation:"fadeUp .4s ease"}}>
            <div style={st.card}>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline", flexWrap:"wrap"}}>
                <div style={{fontFamily:orb, fontWeight:700, fontSize:15, color:"#fff"}}>
                  {short(home)} <span style={{color:C.mute}}>v</span> {short(away)}
                </div>
                <div style={{fontFamily:mono, fontSize:11, color:C.soft}}>xG {eg.home.toFixed(2)} – {eg.away.toFixed(2)}</div>
              </div>

              <ProbBar probs={pred["1x2"]}/>

              {/* tips strip */}
              {rTip && (
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:12}}>
                  <div style={{padding:"10px 12px", borderRadius:11, background:`${cCol}12`, border:`1px solid ${cCol}33`}}>
                    <div style={{fontFamily:mono, fontSize:8, color:C.soft, letterSpacing:1, marginBottom:4}}>RESULT TIP · {rTip.confidence.toUpperCase()}</div>
                    <div style={{fontFamily:orb, fontWeight:700, fontSize:12, color:"#fff"}}>{rTip.label} · {pc(rTip.prob)}</div>
                  </div>
                  {dTip && (
                    <div style={{padding:"10px 12px", borderRadius:11, background:"#FFB30012", border:"1px solid #FFB30033"}}>
                      <div style={{fontFamily:mono, fontSize:8, color:C.soft, letterSpacing:1, marginBottom:4}}>DOUBLE CHANCE</div>
                      <div style={{fontFamily:orb, fontWeight:700, fontSize:12, color:C.gold}}>{dTip.label} · {pc(dTip.prob)}</div>
                    </div>
                  )}
                </div>
              )}

              <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginTop:12}}>
                <div style={st.tile}><div style={st.tk}>OVER 2.5</div><div style={st.tv}>{pc(ou["2.5"].over)}</div></div>
                <div style={st.tile}><div style={st.tk}>BTTS</div><div style={st.tv}>{pc(btts.yes)}</div></div>
                <div style={st.tile}><div style={st.tk}>OVER 1.5</div><div style={st.tv}>{pc(ou["1.5"].over)}</div></div>
              </div>

              <div style={{fontFamily:mono, fontSize:8, color:C.soft, letterSpacing:2, margin:"16px 0 8px"}}>LIKELY SCORES</div>
              <div style={{display:"flex", gap:7, flexWrap:"wrap"}}>
                {sc.map((s,i)=>(
                  <div key={i} style={{flex:1, minWidth:60, textAlign:"center", padding:"8px 4px", borderRadius:10,
                    border:`1px solid ${i===0?C.cyan:"#ffffff10"}`, background:i===0?"#00E5FF12":"#ffffff05"}}>
                    <div style={{fontFamily:mono, fontSize:15, color:"#fff", fontWeight:500}}>{s.home}–{s.away}</div>
                    <div style={{fontFamily:mono, fontSize:9, color:C.soft, marginTop:2}}>{pc1(s.prob)}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={st.card}>
              <div style={{fontFamily:orb, fontWeight:700, fontSize:12, color:C.yellow, letterSpacing:1, marginBottom:6}}>
                CHECK THE ODDS FOR VALUE
              </div>
              <div style={{fontFamily:mono, fontSize:10.5, color:C.dim, lineHeight:1.6, marginBottom:14}}>
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

/* shared value-bet row + manual value list */
function BetRow({ b }){
  const isVal = b.is_value;
  const tierCol = b.risk_tier==="low" ? C.green : b.risk_tier==="medium" ? C.yellow : C.red;
  return (
    <div style={{border:`1px solid ${isVal?C.green+"66":"#ffffff10"}`, borderRadius:12, padding:12, marginTop:10,
      background:isVal ? "linear-gradient(180deg,#69FF4710,transparent)" : "#ffffff04"}}>
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, flexWrap:"wrap"}}>
        <div style={{fontFamily:orb, fontWeight:700, fontSize:13, color:"#fff"}}>{b.label}</div>
        <div style={{display:"flex", alignItems:"center", gap:8}}>
          <div style={{fontFamily:orb, fontWeight:700, fontSize:15, color:b.edge>0?C.green:C.soft}}>
            {b.edge_pct>0?"+":""}{b.edge_pct}%
          </div>
          {isVal && <span style={st.badge(tierCol)}>{b.risk_tier} risk</span>}
        </div>
      </div>
      <div style={{display:"flex", gap:14, flexWrap:"wrap", marginTop:9, fontFamily:mono, fontSize:10, color:C.soft}}>
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
      {value.length>0 ? value.map((b,i)=><BetRow key={i} b={b}/>) : (
        <div style={{textAlign:"center", padding:"18px 8px", fontFamily:mono, fontSize:11, color:C.dim, lineHeight:1.6}}>
          <div style={{fontFamily:orb, fontSize:13, color:"#fff", marginBottom:6}}>NO VALUE AT THESE ODDS</div>
          The bookmaker’s prices are fair or better here. Try other odds or another match.
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

/* ═══════════════════ BEST TIPS ═══════════════════════════════════ */
/* Ranks the strongest calls across every upcoming match in one view:
   – Highest confidence: blended top picks, sorted by probability
   – Biggest disagreement: where the model most diverges from the market   */
function BestTipsTab(){
  const [matches, setMatches] = useState(null);
  const [err, setErr] = useState("");

  useEffect(()=>{
    let live=true;
    fetch(`${API}/api/live/matches?hours=120`)
      .then(r=> r.ok ? r.json() : r.json().then(j=>Promise.reject(new Error(j.detail||"Could not load fixtures."))))
      .then(d=>{ if(live) setMatches(d.matches||[]); })
      .catch(e=>{ if(live) setErr(e.message); });
    return ()=>{ live=false; };
  },[]);

  if(err) return <div style={st.notice}>{err}</div>;
  if(matches===null) return <SkeletonList/>;

  const ok = matches.filter(m=> m.matched && m.prediction && m.prediction.tips);
  if(ok.length===0){
    return <div style={{...st.card, textAlign:"center", padding:"30px 16px", fontFamily:mono, fontSize:11, color:C.dim, lineHeight:1.7}}>
      No tips yet — fixtures appear here once odds are in.</div>;
  }

  // strongest = highest blended pick probability
  const strongest = [...ok].sort((a,b)=> b.prediction.tips.result_pick.prob - a.prediction.tips.result_pick.prob).slice(0,6);

  // value = biggest positive (model − market) on any outcome
  const valued = ok.map(m=>{
    const e = m.prediction.model_vs_market_edge || {};
    let best={k:null,v:-9}; for(const k of ["home","draw","away"]) if((e[k]??-9)>best.v) best={k,v:e[k]};
    return {m, key:best.k, edge:best.v};
  }).filter(x=> x.key && x.edge >= 0.03)
    .sort((a,b)=> b.edge - a.edge).slice(0,6);

  const sideLabel = (m,k)=> k==="home"? short(m.home) : k==="away"? short(m.away) : "Draw";

  return (
    <div>
      <SectionHead title="HIGHEST CONFIDENCE" hint="Where the blended model is most sure" col={C.cyan}/>
      {strongest.map((m,i)=>{
        const t=m.prediction.tips.result_pick; const k=kickLabel(m.kickoff); const cCol=confColor(t.confidence);
        return (
          <div key={m.event_id} className="rl-card" style={{...st.card, padding:"13px 14px", marginBottom:10, animationDelay:`${i*0.04}s`}}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:10}}>
              <div style={{minWidth:0}}>
                <div style={{fontFamily:orb, fontWeight:700, fontSize:13, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                  {short(m.home)} <span style={{color:C.mute, fontWeight:400}}>v</span> {short(m.away)}
                </div>
                <div style={{fontFamily:mono, fontSize:9.5, color:C.soft, marginTop:4}}>{k.when}{k.rel?` · ${k.rel}`:""}</div>
              </div>
              <div style={{textAlign:"right", flexShrink:0}}>
                <div style={{fontFamily:orb, fontWeight:700, fontSize:12, color:"#fff"}}>{t.label}</div>
                <div style={{display:"flex", alignItems:"center", gap:7, justifyContent:"flex-end", marginTop:4}}>
                  <span style={st.chip(cCol)}>{t.confidence}</span>
                  <span style={{fontFamily:orb, fontWeight:900, fontSize:15, color:cCol}}>{pc(t.prob)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <div style={{height:8}}/>
      <SectionHead title="BIGGEST MARKET DISAGREEMENT" hint="Model rates these higher than the bookies — possible value" col={C.gold}/>
      {valued.length===0 ? (
        <div style={{...st.card, textAlign:"center", padding:"20px 14px", fontFamily:mono, fontSize:10.5, color:C.dim, lineHeight:1.6}}>
          The model broadly agrees with the market right now. No standout disagreements — that’s normal.
        </div>
      ) : valued.map(({m,key,edge},i)=>{
        const e=m.prediction; const mod=e.model_1x2[key], mkt=e.market_1x2?.[key];
        return (
          <div key={m.event_id} className="rl-card" style={{...st.card, padding:"13px 14px", marginBottom:10,
            border:"1px solid #FFB30033", background:"linear-gradient(135deg,#FFB30010,transparent)", animationDelay:`${i*0.04}s`}}>
            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:10}}>
              <div style={{minWidth:0}}>
                <div style={{fontFamily:orb, fontWeight:700, fontSize:13, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>
                  {short(m.home)} <span style={{color:C.mute, fontWeight:400}}>v</span> {short(m.away)}
                </div>
                <div style={{fontFamily:mono, fontSize:9.5, color:C.soft, marginTop:4}}>
                  {sideLabel(m,key)} — model <b style={{color:"#fff"}}>{pc(mod)}</b> vs market <b style={{color:"#fff"}}>{pc(mkt)}</b>
                </div>
              </div>
              <div style={{fontFamily:orb, fontWeight:900, fontSize:16, color:C.gold, flexShrink:0}}>+{Math.round(edge*100)}%</div>
            </div>
          </div>
        );
      })}

      <div style={{textAlign:"center", fontFamily:mono, fontSize:9, color:C.mute, letterSpacing:1, marginTop:8, lineHeight:1.7}}>
        DISAGREEMENT IS A SIGNAL, NOT A GUARANTEE · ALWAYS YOUR CALL
      </div>
    </div>
  );
}

function SectionHead({ title, hint, col }){
  return (
    <div style={{marginBottom:10}}>
      <div style={{fontFamily:orb, fontWeight:700, fontSize:11, color:col, letterSpacing:1.5}}>{title}</div>
      <div style={{fontFamily:mono, fontSize:9, color:C.soft, marginTop:3}}>{hint}</div>
    </div>
  );
}

/* ═══════════════════ TRACK RECORD ════════════════════════════════ */
/* Live scorecard: how the predictions are actually doing vs results & market */
function TrackRecordTab({ archive, onSettle }){
  const [settling, setSettling] = useState(true);

  useEffect(()=>{
    let live=true;
    Promise.resolve(onSettle && onSettle()).finally(()=>{ if(live) setSettling(false); });
    return ()=>{ live=false; };
  },[]);

  const sc = computeScorecard(archive||[]);
  if(settling && (archive||[]).length===0) return (
    <div style={{textAlign:"center", padding:"40px 0", fontFamily:mono, fontSize:11, color:C.soft}}>
      <span className="rl-spin"/>  Checking results…
    </div>
  );

  const counts = (
    <div style={{display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:14}}>
      <div style={st.tile}><div style={st.tk}>TRACKED</div><div style={st.tv}>{sc.tracked}</div></div>
      <div style={st.tile}><div style={st.tk}>GRADED</div><div style={{...st.tv, color:C.cyan}}>{sc.settled}</div></div>
      <div style={st.tile}><div style={st.tk}>PENDING</div><div style={st.tv}>{sc.pending}</div></div>
    </div>
  );

  if(!sc.settled){
    return (
      <div>
        {counts}
        <div style={{...st.card, textAlign:"center", padding:"26px 18px"}}>
          <div style={{fontFamily:orb, fontWeight:700, fontSize:14, color:"#fff", marginBottom:8}}>GATHERING RESULTS</div>
          <div style={{fontFamily:mono, fontSize:11, color:C.dim, lineHeight:1.7}}>
            {sc.message || "Your first graded predictions appear here once logged matches finish."}
          </div>
        </div>
        <RecordFooter/>
      </div>
    );
  }

  const hr = sc.hit_rate, mf = sc.market_favourite_hit_rate;
  const beat = (hr!=null && mf!=null) ? hr - mf : null;
  const beatCol = beat==null ? C.soft : beat>=0 ? C.green : C.red;
  const b = sc.brier || {};
  const bMax = Math.max(b.model||0, b.blend||0, b.market||0, 0.0001);
  const brierBar = (label,v,col)=> v==null ? null : (
    <div style={{marginBottom:9}}>
      <div style={{display:"flex", justifyContent:"space-between", fontFamily:mono, fontSize:9.5, color:C.dim, marginBottom:4}}>
        <span>{label}</span><span style={{color:"#fff"}}>{v.toFixed(3)}</span>
      </div>
      <div style={{height:7, borderRadius:6, background:"#ffffff08", overflow:"hidden"}}>
        <div className="rl-bar" style={{height:"100%", width:`${(v/bMax)*100}%`, background:col, borderRadius:6}}/>
      </div>
    </div>
  );

  return (
    <div>
      {counts}

      {/* hero hit-rate */}
      <div style={{...st.card, textAlign:"center", padding:"20px 16px"}}>
        <div style={{fontFamily:mono, fontSize:8.5, color:C.soft, letterSpacing:2, marginBottom:6}}>BLENDED TOP-PICK ACCURACY</div>
        <div style={{fontFamily:orb, fontWeight:900, fontSize:40, color:C.cyan, textShadow:"0 0 24px #00E5FF44", lineHeight:1}}>{pc(hr)}</div>
        {mf!=null && (
          <div style={{fontFamily:mono, fontSize:10.5, color:C.dim, marginTop:12}}>
            vs market favourite <b style={{color:"#fff"}}>{pc(mf)}</b>
            <span style={{color:beatCol, fontFamily:orb, fontWeight:700, marginLeft:8}}>
              {beat>=0?"+":""}{Math.round(beat*100)}%
            </span>
          </div>
        )}
        <div style={{fontFamily:mono, fontSize:9, color:C.soft, marginTop:6}}>across {sc.settled} graded prediction{sc.settled===1?"":"s"}</div>
      </div>

      {/* sharpness vs market */}
      {(b.blend!=null) && (
        <div style={st.card}>
          <div style={{fontFamily:orb, fontWeight:700, fontSize:11, color:"#fff", letterSpacing:1, marginBottom:4}}>SHARPNESS (BRIER — LOWER IS BETTER)</div>
          <div style={{fontFamily:mono, fontSize:9.5, color:C.soft, marginBottom:14, lineHeight:1.5}}>How tight the probabilities were against what actually happened.</div>
          {brierBar("Model only", b.model, "#2b3547")}
          {brierBar("Blended (our call)", b.blend, C.cyan)}
          {brierBar("Bookmaker market", b.market, C.gold)}
          {b.market!=null && (
            <div style={{marginTop:10, padding:"10px 12px", borderRadius:11, textAlign:"center",
              border:`1px solid ${sc.blend_beats_market?C.green:C.soft}44`,
              background: sc.blend_beats_market? "linear-gradient(135deg,#69FF4712,transparent)" : "#ffffff05"}}>
              <span style={{fontFamily:orb, fontWeight:700, fontSize:11, color: sc.blend_beats_market?C.green:C.dim}}>
                {sc.blend_beats_market ? "✓ BLEND IS BEATING THE MARKET" : "MARKET STILL SHARPER — KEEP WATCHING"}
              </span>
            </div>
          )}
        </div>
      )}

      {/* by competition */}
      {sc.by_competition && (sc.by_competition.internationals.settled>0 || sc.by_competition.clubs.settled>0) && (
        <div style={st.card}>
          <div style={{fontFamily:orb, fontWeight:700, fontSize:11, color:"#fff", letterSpacing:1, marginBottom:12}}>BY COMPETITION</div>
          {["internationals","clubs"].map(key=>{
            const c=sc.by_competition[key]; if(!c || c.settled===0) return null;
            return (
              <div key={key} style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0",
                borderBottom: key==="internationals" && sc.by_competition.clubs.settled>0 ? `1px solid ${C.line}`:"none"}}>
                <span style={{fontFamily:mono, fontSize:11, color:C.dim, textTransform:"capitalize"}}>{key}</span>
                <span style={{fontFamily:mono, fontSize:10, color:C.soft}}>
                  <b style={{color:"#fff", fontFamily:orb, fontSize:13}}>{pc(c.hit_rate)}</b> · {c.settled} graded
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* recent results */}
      {sc.recent && sc.recent.length>0 && (
        <div style={st.card}>
          <div style={{fontFamily:orb, fontWeight:700, fontSize:11, color:"#fff", letterSpacing:1, marginBottom:10}}>RECENT RESULTS</div>
          {sc.recent.map((r,i)=>(
            <div key={i} style={{display:"flex", justifyContent:"space-between", alignItems:"center", gap:8,
              padding:"9px 0", borderBottom: i<sc.recent.length-1?`1px solid ${C.line}`:"none"}}>
              <div style={{minWidth:0}}>
                <div style={{fontFamily:mono, fontSize:11, color:"#fff", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"}}>{r.match}</div>
                <div style={{fontFamily:mono, fontSize:9, color:C.soft, marginTop:3}}>
                  picked {String(r.pick||"").toUpperCase()} · ended {String(r.result||"").toUpperCase()} {r.score?`(${r.score})`:""}
                </div>
              </div>
              <span style={{fontFamily:orb, fontWeight:700, fontSize:13, flexShrink:0, color: r.hit?C.green:C.red}}>{r.hit?"✓":"✗"}</span>
            </div>
          ))}
        </div>
      )}

      <RecordFooter/>
    </div>
  );
}

function RecordFooter(){
  return (
    <div style={{textAlign:"center", fontFamily:mono, fontSize:9, color:C.mute, letterSpacing:1, marginTop:6, lineHeight:1.7}}>
      EACH PREDICTION IS FROZEN BEFORE KICKOFF, THEN GRADED ON THE RESULT
    </div>
  );
}
