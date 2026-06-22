import { useState, useEffect, useRef } from "react";
import { db } from "./firebase.js";
import {
  doc, getDoc, setDoc, onSnapshot
} from "firebase/firestore";
import PredictScreen from "./PredictScreen.jsx";

/* ═══════════════════════════════════════════════════════════
   ROLLOVER TRACKER — FIREBASE CLOUD SAVE EDITION
   Data saved to Firestore in real-time.
   Device ID = your unique Save Code.
═══════════════════════════════════════════════════════════ */

const MILESTONES = [100000,500000,1000000,5000000,10000000,50000000,100000000,500000000,1000000000];

function fmt(n, cur="TSH") {
  if (!n && n!==0) return `${cur} 0`;
  const a=Math.abs(n);
  let s;
  if(a>=1e12) s=(n/1e12).toFixed(3)+"T";
  else if(a>=1e9)  s=(n/1e9).toFixed(3)+"B";
  else if(a>=1e6)  s=(n/1e6).toFixed(3)+"M";
  else if(a>=1e3)  s=Math.round(n).toLocaleString();
  else s=Math.round(n)+"";
  return `${cur} ${s}`;
}

function riskInfo(streak, AB, SR) {
  const r = SR / Math.max(AB,1);
  if(streak>=10||r<0.05) return{label:"CRITICAL",short:"CRIT",color:"#DC3B3B",glow:"rgba(255,23,68,0.4)",bar:1};
  if(streak>=7 ||r<0.15) return{label:"HIGH RISK",short:"HIGH",color:"#E08A00",glow:"rgba(255,109,0,0.35)",bar:0.75};
  if(streak>=4 ||r<0.30) return{label:"MODERATE", short:"MOD", color:"#E08A00",glow:"rgba(255,214,0,0.3)",bar:0.5};
  return                       {label:"SAFE ZONE",short:"SAFE",color:"#2F37D9",glow:"rgba(47,55,217,0.3)",bar:0.25};
}

function calcWD(AB, day, lastWD, crossed, wdPct) {
  let wd=0, reasons=[];
  if(day%7===0 && day!==lastWD) {
    const w=AB*wdPct; wd+=w;
    reasons.push(`Weekly (${(wdPct*100).toFixed(0)}%): ${fmt(w)}`);
  }
  for(const ms of MILESTONES) {
    if(AB>=ms && !crossed.includes(ms)) {
      const w=AB*0.35; wd+=w;
      reasons.push(`Milestone ${fmt(ms)}: ${fmt(w)}`);
    }
  }
  return {wd, reasons};
}

/* ═══════════ AUTO-SETTLE — grade goals-family tips from free results ════════
   Reads the public international-results feed (CORS-open) and auto-marks each
   pending GOALS-based tip Won/Lost once its match has a final score. Corners,
   cards, halves and throw-ins have no free result data, so they stay manual. */
const RESULTS_CSV_URL = "https://raw.githubusercontent.com/martj42/international_results/master/results.csv";
const TEAM_ALIASES = {
  korearepublic:"southkorea", southkorea:"southkorea", koreadpr:"northkorea",
  usa:"unitedstates", unitedstatesofamerica:"unitedstates", unitedstates:"unitedstates",
  czechia:"czechrepublic", czechrepublic:"czechrepublic",
  turkiye:"turkey", turkey:"turkey", iran:"iran",
  ivorycoast:"ivorycoast", cotedivoire:"ivorycoast",
  drcongo:"drcongo", congodr:"drcongo",
  capeverde:"capeverde", caboverde:"capeverde",
  china:"chinapr", chinapr:"chinapr",
  bosnia:"bosniaandherzegovina", bosniaandherzegovina:"bosniaandherzegovina",
  uae:"unitedarabemirates", unitedarabemirates:"unitedarabemirates",
  northmacedonia:"northmacedonia", macedonia:"northmacedonia",
  republicofireland:"republicofireland", ireland:"republicofireland",
  curacao:"curacao",
};
function normTeam(x){
  let n=(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
  return TEAM_ALIASES[n]||n;
}
function _datesAround(d){
  if(!d) return [];
  const out=[]; const base=new Date(d+"T00:00:00Z");
  for(let i=-1;i<=1;i++){ const x=new Date(base); x.setUTCDate(x.getUTCDate()+i); out.push(x.toISOString().slice(0,10)); }
  return out;
}
let _resultsCache=null, _resultsAt=0;
async function fetchResults(){
  if(_resultsCache && Date.now()-_resultsAt < 30*60*1000) return _resultsCache;
  try{
    const txt = await fetch(RESULTS_CSV_URL).then(r=>r.text());
    const cutoff = new Date(Date.now()-150*24*3600*1000).toISOString().slice(0,10);
    const map = new Map();
    const lines = txt.split(/\r?\n/);
    for(let i=1;i<lines.length;i++){
      const c = lines[i].split(",");
      if(c.length<5) continue;
      const date=c[0]; if(date<cutoff) continue;
      const hs=c[3], as=c[4];
      if(hs===""||as===""||hs==="NA"||as==="NA") continue;
      const hg=parseInt(hs,10), ag=parseInt(as,10);
      if(!isFinite(hg)||!isFinite(ag)) continue;
      map.set(normTeam(c[1])+"|"+normTeam(c[2])+"|"+date, {hg,ag});
    }
    _resultsCache=map; _resultsAt=Date.now();
    return map;
  }catch(e){ return _resultsCache; }
}
function findResult(tip, map){
  if(!map) return null;
  const parts=(tip.match||"").split(/\s+vs\s+|\s+v\s+/i);
  const h=normTeam(tip.home_team || parts[0]);
  const a=normTeam(tip.away_team || parts[1]);
  if(!h||!a) return null;
  for(const d of _datesAround(tip.date)){
    const hit=map.get(h+"|"+a+"|"+d);
    if(hit) return hit;
  }
  return null;
}
function gradeTip(tip, sc){
  const hg=sc.hg, ag=sc.ag, total=hg+ag;
  const stype=(tip.settle_type||"").toLowerCase();
  const side=(tip.side||"").toLowerCase();
  const pickL=(tip.pick||"").toLowerCase();
  const W=b=>b?"WIN":"LOSS";
  let line = tip.line!=null ? parseFloat(tip.line) : null;
  if(line==null){ const m=pickL.match(/(\d+(?:\.\d)?)/); if(m) line=parseFloat(m[1]); }
  const actual = hg>ag?"home":ag>hg?"away":"draw";

  if(stype==="goals_ou" || (!stype && /goal/.test(pickL) && /(over|under)/.test(pickL))){
    if(line==null) return null;
    const over = side ? side==="over" : /over/.test(pickL);
    if(total===line) return null;
    return W(over ? total>line : total<line);
  }
  if(stype==="btts" || (!stype && /(btts|both teams)/.test(pickL))){
    const yes = side ? side==="yes" : !/\bno\b/.test(pickL);
    return W(yes ? (hg>0&&ag>0) : !(hg>0&&ag>0));
  }
  if(stype==="result"){ return side ? W(side===actual) : null; }
  if(stype==="double_chance"){
    const dc={"1x":["home","draw"],"12":["home","away"],"x2":["draw","away"]};
    return dc[side] ? W(dc[side].includes(actual)) : null;
  }
  if(stype==="dnb"){ if(actual==="draw") return null; return side?W(side===actual):null; }
  if(stype==="win_to_nil"){
    if(side==="home") return W(hg>ag && ag===0);
    if(side==="away") return W(ag>hg && hg===0);
    return null;
  }
  if(stype==="odd_even"){ const odd=total%2===1; return side?W(side==="odd"?odd:!odd):null; }
  if(stype==="clean_sheet"){
    if(side==="home"||/home/.test(pickL)) return W(ag===0);
    if(side==="away"||/away/.test(pickL)) return W(hg===0);
    return null;
  }
  if(stype==="correct_score"){
    const m=pickL.match(/(\d+)\s*[-:x]\s*(\d+)/);
    return m ? W(parseInt(m[1],10)===hg && parseInt(m[2],10)===ag) : null;
  }
  return null; // team_goals, halves, corners, cards, throw-ins, manual → stay manual
}

/* ── Tip archive helpers ───────────────────────────────────────────── */
function toArchiveEntry(r){
  const result = (r.result==="WIN"||r.result==="LOSS") ? r.result : (r.autoResult||"PENDING");
  const odds = r.odds||1.85;
  const profitTSH = r.profitTSH!=null ? r.profitTSH
    : (r.stake>0 ? (result==="WIN" ? r.stake*(odds-1) : result==="LOSS" ? -r.stake : 0) : 0);
  return {
    id:r.id, match:r.match||"", league:r.league||"", market:r.market||"", pick:r.pick||"",
    odds:r.odds||null, confidence:r.confidence||null, result, score:r.autoScore||r.score||"",
    stake:r.stake||0, profitTSH, settle_type:r.settle_type||"", date:r.date||"",
    autoGraded: !!r.autoResult && !(r.result==="WIN"||r.result==="LOSS"), archivedAt:Date.now(),
  };
}
// Separate finished tips (settled or auto-graded) from the rest. If olderThanDays
// is set, only finished tips that old are split off (recent ones stay in Results).
function splitDone(tipResults, olderThanDays){
  const now=Date.now();
  const oldEnough=(r)=>{
    if(olderThanDays==null) return true;
    const t=r.settledAt||r.autoSettledAt||(r.date?Date.parse(r.date+"T00:00:00Z"):now);
    return (now-t) > olderThanDays*24*3600*1000;
  };
  const done=[], keep=[];
  for(const r of (tipResults||[])){
    const isDone = r.result==="WIN"||r.result==="LOSS"||r.autoResult;
    if(isDone && oldEnough(r)) done.push(r); else keep.push(r);
  }
  return {keep, done};
}
function exportArchiveCSV(archive, plan){
  const esc=(v)=>{ const x=String(v==null?"":v); return /[",\n]/.test(x)?'"'+x.replace(/"/g,'""')+'"':x; };
  const head=["date","match","league","market","pick","odds","result","score","stake","profit","currency"];
  const rows=(archive||[]).map(a=>[a.date,a.match,a.league,a.market,a.pick,a.odds,a.result,a.score,a.stake,Math.round(a.profitTSH||0),(plan&&plan.currency)||"TSH"]);
  const csv=[head.join(","), ...rows.map(r=>r.map(esc).join(","))].join("\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  link.href=url; link.download=`rollover-tips-${((plan&&(plan.name||plan.label))||"archive").replace(/[^a-z0-9]/gi,"-")}-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
}

const TSH_TO_USD = 2650; // 1 USD ≈ 2650 TSH

function fmtDual(tsh) {
  const usd = tsh / TSH_TO_USD;
  return `${fmt(tsh)} (≈ $${usd.toFixed(2)})`;
}

// ── Smart Staking: Kelly Criterion ───────────────────────────────
function calcKellyStake(bankroll, confidence, odds, fraction=0.25) {
  if(!bankroll || !confidence || !odds || odds<=1) return 0;
  const p = confidenceToProb(confidence);
  const b = odds - 1;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  const quarterKelly = Math.max(0, kelly * fraction);
  return Math.round(bankroll * Math.min(quarterKelly, 0.02));
}

function confidenceToProb(confidence) {
  const x = Math.min(Math.max(confidence, 50), 98) / 100;
  const exp = -2.2 * x + 1.1;
  return Math.round((1 / (1 + Math.pow(Math.E, exp))) * 10000) / 10000;
}

function stakeRating(confidence) {
  if(confidence >= 85) return { label:"STRONG BET", color:"#159A56", pct:"1.5-2%" };
  if(confidence >= 75) return { label:"GOOD BET",   color:"#2F37D9", pct:"1-1.5%" };
  if(confidence >= 65) return { label:"MODERATE",   color:"#E08A00", pct:"0.5-1%" };
  return                      { label:"SKIP",        color:"#DC3B3B", pct:"0%" };
}

function makeState(starting) {
  return {day:1,AB:parseFloat(starting),SR:0,totalSR:0,streak:0,losses:0,lastWD:0,crossed:[],history:[],tipResults:[]};
}

// ── Unique device ID ────────────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem("rolloverDeviceId");
  if (!id) {
    id = "RO-" + Math.random().toString(36).substr(2,9).toUpperCase() +
         "-" + Math.random().toString(36).substr(2,5).toUpperCase();
    localStorage.setItem("rolloverDeviceId", id);
  }
  return id;
}

// ── Firestore helpers ────────────────────────────────────────────
async function fsLoad(deviceId) {
  try {
    const snap = await getDoc(doc(db, "users", deviceId));
    return snap.exists() ? snap.data().allPlans || {} : {};
  } catch(e) {
    console.error("Load error:", e);
    return {};
  }
}

async function fsSave(deviceId, allPlans) {
  try {
    await setDoc(doc(db, "users", deviceId), { allPlans, updatedAt: Date.now() });
  } catch(e) {
    console.error("Save error:", e);
    // Fallback to localStorage
    localStorage.setItem("allPlans_backup", JSON.stringify(allPlans));
  }
}

const PRESETS = [
  {id:"alpha",label:"ALPHA",color:"#2F37D9",glow:"rgba(47,55,217,0.5)",gradient:"linear-gradient(135deg,#2F37D9,#1E25B8)",odds:1.10,wdPct:0.25,emoji:"α"},
  {id:"beta", label:"BETA", color:"#159A56",glow:"rgba(105,255,71,0.5)",gradient:"linear-gradient(135deg,#159A56,#159A56)",odds:1.20,wdPct:0.25,emoji:"β"},
  {id:"gamma",label:"GAMMA",color:"#7C83F6",glow:"rgba(224,64,251,0.5)",gradient:"linear-gradient(135deg,#7C83F6,#AA00FF)",odds:1.50,wdPct:0.30,emoji:"γ"},
];
const TABS = ["TIPS","HISTORY","RESERVE","SETTINGS"];

// ── Animated counter ─────────────────────────────────────────────
function useCountUp(target, duration=700) {
  const [val, setVal] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    if(prev.current === target) return;
    const start=prev.current, diff=target-start, t0=Date.now();
    prev.current = target;
    const tick = () => {
      const p = Math.min((Date.now()-t0)/duration, 1);
      const e = 1-Math.pow(1-p, 4);
      setVal(start+diff*e);
      if(p<1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [target, duration]);
  return val;
}

// ── Particle burst ────────────────────────────────────────────────
function ParticleBurst({active, color, onDone}) {
  const parts = useRef(Array.from({length:22}, (_,i) => ({
    id:i, angle:(i/22)*360, speed:55+Math.random()*90, size:3+Math.random()*5
  }))).current;
  useEffect(() => { if(active){const t=setTimeout(onDone,900);return()=>clearTimeout(t);} },[active]);
  if(!active) return null;
  return (
    <div style={{position:"fixed",top:"50%",left:"50%",zIndex:500,pointerEvents:"none"}}>
      {parts.map(p => {
        const rad=p.angle*Math.PI/180;
        const x=Math.cos(rad)*p.speed, y=Math.sin(rad)*p.speed;
        return(
          <div key={p.id} style={{position:"absolute",width:p.size,height:p.size,borderRadius:"50%",
            background:color, boxShadow:`0 0 ${p.size*3}px ${color}`,
            animation:`particle-${p.id} 0.8s cubic-bezier(0,.9,.57,1) forwards`,
            transform:"translate(-50%,-50%)"}}/>
        );
      })}
      <style>{parts.map(p=>{const rad=p.angle*Math.PI/180;const x=Math.cos(rad)*p.speed,y=Math.sin(rad)*p.speed;
        return`@keyframes particle-${p.id}{0%{transform:translate(-50%,-50%) scale(1.2);opacity:1}100%{transform:translate(calc(-50% + ${x}px),calc(-50% + ${y}px)) scale(0);opacity:0}}`;
      }).join("")}</style>
    </div>
  );
}

// ── Grid background ───────────────────────────────────────────────
function GridBG({color="#2F37D9"}) {
  return(
    <div style={{position:"fixed",inset:0,zIndex:0,overflow:"hidden",pointerEvents:"none"}}>
      <div style={{position:"absolute",top:"35%",left:"50%",transform:"translate(-50%,-50%)",
        width:500,height:500,borderRadius:"50%",
        background:`radial-gradient(circle,${color}09 0%,transparent 70%)`,
        animation:"breathe 5s ease-in-out infinite"}}/>
      <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.035}}>
        <defs>
          <pattern id="g" width="36" height="36" patternUnits="userSpaceOnUse">
            <path d="M 36 0 L 0 0 0 36" fill="none" stroke={color} strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#g)"/>
      </svg>
      <div style={{position:"absolute",left:0,right:0,height:1,
        background:`linear-gradient(90deg,transparent,${color}25,transparent)`,
        animation:"scanline 7s linear infinite"}}/>
      <style>{`
        @keyframes breathe{0%,100%{opacity:.5;transform:translate(-50%,-50%) scale(1)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.15)}}
        @keyframes scanline{0%{top:-2px}100%{top:100vh}}
      `}</style>
    </div>
  );
}

// ── Shake hook ───────────────────────────────────────────────────
function useShake() {
  const [s, setS] = useState(false);
  const shake = () => { setS(true); setTimeout(()=>setS(false),500); };
  return [s, shake];
}

/* ═══════════════════ ROOT ══════════════════════════════════ */
export default function App() {
  const [deviceId]        = useState(() => getDeviceId());
  const [allPlans, setAll]= useState({});
  const [active,  setAct] = useState("alpha");
  const [view,    setView]= useState("loading");
  const [tab,     setTab] = useState("TODAY");
  const [toast,   setToast]= useState(null);
  const [burst,   setBurst]= useState(null);
  const [shaking, shake]  = useShake();
  const [setupId, setSId] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [showCode,setShowCode]= useState(false);
  const [restoreInput,setRI]  = useState("");
  const [restoreMode,setRM]   = useState(false);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem("rolloverTheme") || "light"; } catch(e) { return "light"; } });
  useEffect(() => { try { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("rolloverTheme", theme); } catch(e) {} }, [theme]);

  // ── Load from Firestore on mount ────────────────────────────────
  useEffect(() => {
    (async () => {
      const data = await fsLoad(deviceId);
      setAll(data);
      setView("home");
    })();
  }, [deviceId]);

  const showToast = (msg, type) => {
    setToast({msg,type}); setTimeout(()=>setToast(null),3200);
  };

  const persist = async (updated) => {
    setSyncing(true);
    setAll(updated);
    await fsSave(deviceId, updated);
    setSyncing(false);
  };

  const openPlan = (id) => {
    if(allPlans[id]) { setAct(id); setTab("TODAY"); setView("plan"); }
    else             { setSId(id); setView("setup"); }
  };

  const handleSetup = async (id, planData) => {
    const updated = {...allPlans, [id]:{plan:planData, state:makeState(planData.starting)}};
    await persist(updated);
    setAct(id); setTab("TODAY"); setView("plan");
  };

  const logTipResult = async (tipData) => {
    const {plan, state:st} = allPlans[active];
    const ns = {
      ...st,
      tipResults: [...(st.tipResults||[]), {
        ...tipData,
        id: Math.random().toString(36).substr(2,8),
        date: new Date().toISOString().split("T")[0],
        timestamp: Date.now(),
        profitTSH: tipData.result === "WIN"
          ? (tipData.stake * (tipData.odds - 1))
          : -tipData.stake,
        profitUSD: tipData.result === "WIN"
          ? (tipData.stake * (tipData.odds - 1)) / TSH_TO_USD
          : -tipData.stake / TSH_TO_USD,
      }]
    };
    const updated = {...allPlans, [active]:{plan, state:ns}};
    await persist(updated);
    showToast(
      tipData.result === "WIN"
        ? `✦ TIP WIN — +${fmt(tipData.stake*(tipData.odds-1))} profit`
        : `✕ TIP LOSS — -${fmt(tipData.stake)} lost`,
      tipData.result === "WIN" ? "win" : "loss"
    );
  };

  // Save fetched tips into the Results tracker as PENDING (deduped by match|market|pick).
  const tipKeyOf = (t)=>`${(t.match||"").toLowerCase()}|${(t.market||"").toLowerCase()}|${(t.pick||"").toLowerCase()}`;
  const trackTips = async (tips) => {
    const list = Array.isArray(tips) ? tips : [tips];
    const {plan, state:st} = allPlans[active];
    // 1. File finished tips from the previous batch into the permanent archive.
    const {keep, done} = splitDone(st.tipResults||[], null);
    const archive = [...(st.tipArchive||[]), ...done.map(toArchiveEntry)];
    // 2. Add the new tips as PENDING (dedup against active + archive).
    const have = new Set([...keep.map(tipKeyOf), ...archive.map(tipKeyOf)]);
    const additions = [];
    for(const t of list){
      const k = tipKeyOf(t);
      if(have.has(k)) continue;
      have.add(k);
      const odds = t.bookmaker_odds || parseFloat((t.odds_range||"").split("-")[0]) || null;
      additions.push({
        match:t.match||"", league:t.league||"", market:t.market||"", pick:t.pick||"",
        odds, stake:0, result:"PENDING", currency:plan.currency,
        confidence: t.confidence || null,
        settle_type: t.settle_type||"", line:(t.line!=null?t.line:null), side:t.side||null,
        home_team: t.home_team||"", away_team: t.away_team||"",
        id: Math.random().toString(36).substr(2,8),
        date: new Date().toISOString().split("T")[0], timestamp: Date.now(),
      });
    }
    const ns = {...st, tipResults:[...keep, ...additions], tipArchive: archive};
    await persist({...allPlans, [active]:{plan, state:ns}});
    const parts=[];
    if(done.length) parts.push(`${done.length} archived`);
    if(additions.length) parts.push(`${additions.length} new`);
    showToast(parts.length ? `✦ ${parts.join(" · ")} → Results` : "All tips already tracked", (additions.length||done.length)?"win":"info");
  };

  // Manually file all finished tips into the archive (Clear & Archive button).
  const archiveNow = async () => {
    const {plan, state:st} = allPlans[active];
    const {keep, done} = splitDone(st.tipResults||[], null);
    if(!done.length){ showToast("Nothing to archive yet", "info"); return; }
    const archive = [...(st.tipArchive||[]), ...done.map(toArchiveEntry)];
    await persist({...allPlans, [active]:{plan, state:{...st, tipResults:keep, tipArchive:archive}}});
    showToast(`✦ ${done.length} tip${done.length>1?"s":""} archived`, "win");
  };

  // Settle a pending tip (WIN/LOSS) with the stake actually placed.
  const settleTip = async (id, result, stake) => {
    const s = parseFloat(stake);
    if(!isFinite(s) || s<=0) return;
    const {plan, state:st} = allPlans[active];
    const tipResults = (st.tipResults||[]).map(r=>{
      if(r.id!==id) return r;
      const odds = r.odds || 1.85;
      const profitTSH = result==="WIN" ? s*(odds-1) : -s;
      return {...r, result, stake:s, profitTSH, profitUSD: profitTSH/TSH_TO_USD, settledAt: Date.now()};
    });
    await persist({...allPlans, [active]:{plan, state:{...st, tipResults}}});
    showToast(result==="WIN" ? "✦ Tip win logged" : "✕ Tip loss logged", result==="WIN"?"win":"loss");
  };

  // Drop a pending tip you didn't actually bet.
  const removeTip = async (id) => {
    const {plan, state:st} = allPlans[active];
    const tipResults = (st.tipResults||[]).filter(r=>r.id!==id);
    await persist({...allPlans, [active]:{plan, state:{...st, tipResults}}});
    showToast("Removed from tracker", "info");
  };

  // Auto-grade pending goals tips from the feed, then file finished tips older than 3 days.
  const maintainResults = async (planId) => {
    const entry = allPlans[planId]; if(!entry) return;
    const st = entry.state || {};
    let tipResults = st.tipResults || [];
    let changed=false;
    if(tipResults.some(r=>r.result==="PENDING" && !r.autoResult)){
      const map = await fetchResults();
      if(map){
        tipResults = tipResults.map(r=>{
          if(r.result!=="PENDING" || r.autoResult) return r;
          const sc=findResult(r,map); if(!sc) return r;
          const g=gradeTip(r,sc); if(!g) return r;
          changed=true;
          return {...r, autoResult:g, autoScore:`${sc.hg}-${sc.ag}`, autoSettledAt:Date.now()};
        });
      }
    }
    const {keep, done} = splitDone(tipResults, 3);
    let archive = st.tipArchive || [];
    if(done.length){ archive=[...archive, ...done.map(toArchiveEntry)]; tipResults=keep; changed=true; }
    if(changed){
      await persist({...allPlans, [planId]:{plan:entry.plan, state:{...st, tipResults, tipArchive:archive}}});
    }
  };

  useEffect(()=>{
    if(view==="plan" && tab==="RESULTS" && active && allPlans[active]){
      maintainResults(active);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[view, tab, active]);

  const logBet = async (result) => {
    const {plan, state:st} = allPlans[active];
    let ns = {...st, history:[...st.history], crossed:[...st.crossed]};
    const openAB = ns.AB;
    let wd=0, reasons=[];
    if(result==="WIN") {
      const w = calcWD(ns.AB, ns.day, ns.lastWD, ns.crossed, plan.wdPct);
      wd=w.wd; reasons=w.reasons;
      if(wd>0) {
        ns.AB-=wd; ns.SR+=wd; ns.totalSR+=wd;
        if(ns.day%7===0) ns.lastWD=ns.day;
        for(const ms of MILESTONES)
          if(openAB>=ms && !ns.crossed.includes(ms)) ns.crossed.push(ms);
      }
      ns.AB = ns.AB * plan.odds;
      ns.streak = (ns.streak||0)+1;
    } else {
      const rAB = ns.SR>0 ? ns.SR*0.6 : parseFloat(plan.starting);
      ns.SR     = ns.SR>0 ? ns.SR*0.4 : 0;
      ns.AB=rAB; ns.streak=0; ns.losses=(ns.losses||0)+1;
    }
    ns.history.push({day:ns.day,result,openAB,closeAB:ns.AB,closeSR:ns.SR,wd,reasons});
    ns.day+=1;
    const updated = {...allPlans, [active]:{plan, state:ns}};
    await persist(updated);
    if(result==="WIN") {
      const p=PRESETS.find(p=>p.id===active);
      setBurst({color:p.color});
      showToast(`✦ CHAIN HOLDS — ${fmt(ns.AB,plan.currency)}`, "win");
    } else {
      shake();
      showToast(`✕ CHAIN BROKE — Restarted ${fmt(ns.AB,plan.currency)}`, "loss");
    }
  };

  const deletePlan = async (id) => {
    const updated = {...allPlans};
    delete updated[id];
    await persist(updated);
    setView("home");
  };

  // ── Restore via Save Code ────────────────────────────────────────
  const handleRestore = async () => {
    const code = restoreInput.trim().toUpperCase();
    if(!code) return;
    showToast("Loading...", "info");
    const data = await fsLoad(code);
    if(Object.keys(data).length === 0) {
      showToast("No data found for that code.", "loss");
      return;
    }
    localStorage.setItem("rolloverDeviceId", code);
    setAll(data);
    setRM(false);
    setView("home");
    showToast("✦ Data restored successfully!", "win");
  };

  const go = (key) => {
    if(key==="plans"){ setView("home"); return; }
    if(key==="predict"){ setView("predict"); return; }
    const id = allPlans[active] ? active : Object.keys(allPlans)[0];
    if(!id){ setView("home"); return; }
    if(id!==active) setAct(id);
    setTab(key==="results"?"RESULTS":key==="archive"?"ARCHIVE":"TODAY");
    setView("plan");
  };
  const preset = PRESETS.find(p=>p.id===active) || PRESETS[0];

  return (
    <div style={{...S.root, animation:shaking?"shake 0.4s ease":"none"}}>
      <GlobalCSS/>
      <GridBG color={view==="plan" ? preset.color : "#2F37D9"}/>

      <button onClick={()=>setTheme(t=>t==="dark"?"light":"dark")} aria-label="Toggle light or dark theme"
        style={{position:"fixed",top:10,right:14,zIndex:500,width:34,height:34,borderRadius:"50%",
          border:"1px solid rgba(var(--ink-rgb),0.14)",background:"var(--surface)",
          boxShadow:"0 2px 10px rgba(0,0,0,0.10)",cursor:"pointer",display:"flex",
          alignItems:"center",justifyContent:"center",padding:0}}>
        {theme==="light"
          ? (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19"/></svg>)
          : (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.5 13A8 8 0 1 1 11 3.5 6.4 6.4 0 0 0 20.5 13z"/></svg>)}
      </button>

      {burst && <ParticleBurst active color={burst.color} onDone={()=>setBurst(null)}/>}

      {/* Sync indicator */}
      {syncing && (
        <div style={S.syncDot}>
          <div style={{width:6,height:6,borderRadius:"50%",background:"#2F37D9",animation:"pulse-dot 1s ease infinite"}}/>
          <span style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"#2F37D988",letterSpacing:2}}>SYNCING</span>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{...S.toast,
          background:toast.type==="win"?"linear-gradient(135deg,#2F37D918,#2F37D908)":
                     toast.type==="loss"?"linear-gradient(135deg,#DC3B3B18,#DC3B3B08)":
                     "linear-gradient(135deg,#E08A0018,#E08A0008)",
          border:`1px solid ${toast.type==="win"?"#2F37D9":toast.type==="loss"?"#DC3B3B":"#E08A00"}55`,
          color:toast.type==="win"?"#2F37D9":toast.type==="loss"?"#DC3B3B":"#E08A00",
          boxShadow:`0 0 30px ${toast.type==="win"?"#2F37D9":toast.type==="loss"?"#DC3B3B":"#E08A00"}33`}}>
          {toast.msg}
        </div>
      )}

      {/* Save Code Modal */}
      {showCode && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:14,color:"#2F37D9",letterSpacing:3,marginBottom:4}}>
              YOUR SAVE CODE
            </div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.267)",marginBottom:16,lineHeight:1.6}}>
              Write this code down. Use it to restore your data on any device or browser.
            </div>
            <div style={{background:"#2F37D90d",border:"1px solid #2F37D944",borderRadius:10,
              padding:"14px",textAlign:"center",marginBottom:16}}>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:16,
                color:"#2F37D9",letterSpacing:3,textShadow:"0 0 20px rgba(47,55,217,0.5)",
                wordBreak:"break-all"}}>
                {deviceId}
              </div>
            </div>
            <button onClick={()=>{navigator.clipboard?.writeText(deviceId);showToast("Code copied!","win");}}
              style={{...S.actionBtn,background:"linear-gradient(135deg,#2F37D922,#2F37D911)",
                border:"1px solid #2F37D944",color:"#2F37D9",width:"100%",marginBottom:10}}>
              📋 COPY CODE
            </button>
            <button onClick={()=>setShowCode(false)}
              style={{...S.actionBtn,background:"transparent",border:"1px solid rgba(var(--ink-rgb),0.067)",
                color:"rgba(var(--ink-rgb),0.267)",width:"100%"}}>
              CLOSE
            </button>
          </div>
        </div>
      )}

      {/* Restore Modal */}
      {restoreMode && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:14,color:"#E08A00",letterSpacing:3,marginBottom:4}}>
              RESTORE DATA
            </div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.267)",marginBottom:16,lineHeight:1.6}}>
              Enter your Save Code to load your data on this device.
            </div>
            <input
              value={restoreInput}
              onChange={e=>setRI(e.target.value.toUpperCase())}
              placeholder="e.g. RO-ABC123DEF-XYZ12"
              style={{...S.input,border:"1px solid #E08A0044",marginBottom:12,
                boxShadow:"0 0 20px rgba(255,214,0,0.08)"}}
            />
            <button onClick={handleRestore}
              style={{...S.actionBtn,background:"linear-gradient(135deg,#E08A00,#FF8F00)",
                color:"#000",fontWeight:700,width:"100%",marginBottom:10}}>
              🔓 RESTORE MY DATA
            </button>
            <button onClick={()=>setRM(false)}
              style={{...S.actionBtn,background:"transparent",border:"1px solid rgba(var(--ink-rgb),0.067)",
                color:"rgba(var(--ink-rgb),0.267)",width:"100%"}}>
              CANCEL
            </button>
          </div>
        </div>
      )}

      {view==="loading" && <SplashScreen/>}
      {view==="home"    && (
        <HomeScreen allPlans={allPlans} onOpen={openPlan}
          onShowCode={()=>setShowCode(true)}
          onRestore={()=>setRM(true)}
          onPredict={()=>setView("predict")}/>
      )}
      {view==="predict" && <PredictScreen onBack={()=>setView("home")}/>}
      {view==="setup"   && <SetupScreen presetId={setupId} onSetup={handleSetup} onBack={()=>setView("home")}/>}
      {view==="plan" && allPlans[active] && (
        <PlanView
          plan={allPlans[active].plan} st={allPlans[active].state}
          preset={preset} tab={tab} setTab={setTab}
          onBet={logBet} onBack={()=>setView("home")} onDelete={()=>deletePlan(active)}
          onLogTip={logTipResult}
          onTrack={trackTips} onSettle={settleTip} onRemove={removeTip}
          onArchive={archiveNow}/>
      )}

      {(view==="home"||view==="predict"||view==="plan") && <BottomNav view={view} tab={tab} go={go}/>}
    </div>
  );
}

/* ═══════════════════ SPLASH ════════════════════════════════ */
function SplashScreen() {
  return (
    <div style={S.splash}>
      <div style={{textAlign:"center"}}>
        <div style={S.splashLogo}>ROLLOVER</div>
        <div style={S.splashSub}>SMART BETTING TRACKER</div>
        <div style={S.splashBar}><div style={S.splashFill}/></div>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,color:"rgba(var(--ink-rgb),0.133)",
          marginTop:16,letterSpacing:3,animation:"blink 1s step-end infinite"}}>
          CONNECTING TO CLOUD...
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════ HOME ══════════════════════════════════ */
function HomeScreen({allPlans, onOpen, onShowCode, onRestore, onPredict}) {
  const vals  = Object.values(allPlans);
  const total = vals.reduce((s,{state:st})=>s+st.AB+st.SR, 0);
  const cur   = vals[0]?.plan?.currency || "TSH";
  const animTotal = useCountUp(total);
  const allHist   = vals.flatMap(({state:st})=>st.history||[]);
  const wr = allHist.length ? (allHist.filter(h=>h.result==="WIN").length/allHist.length*100).toFixed(0)+"%" : "—";

  return (
    <div style={{...S.screen, animation:"fadeUp 0.5s ease"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",padding:"10px 2px 16px"}}>
        <div>
          <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:600,fontSize:23,letterSpacing:"-0.02em",color:"var(--ink)"}}>Plans</div>
          <div style={{fontSize:11,color:"var(--ink3)",fontWeight:500,marginTop:2,fontFamily:"'Inter',sans-serif"}}>{vals.length} active · cloud-synced</div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={onShowCode} style={S.headerBtn} title="Your Save Code">🔑</button>
          <button onClick={onRestore}  style={S.headerBtn} title="Restore Data">📲</button>
        </div>
      </div>

      {/* Combined value */}
      {vals.length>0 && (
        <div style={S.combinedCard}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",letterSpacing:3}}>COMBINED PORTFOLIO</div>
          <div style={S.combinedVal}>{fmt(animTotal, cur)}</div>
          <div style={{display:"flex",gap:20,marginTop:10}}>
            {[["ACTIVE",vals.length+"/3","#E08A00"],["BETS",allHist.length,"#2F37D9"],["WIN RATE",wr,"#159A56"]].map(([l,v,col],i)=>(
              <div key={i}>
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.133)",letterSpacing:2}}>{l}</div>
                <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:15,color:col,marginTop:2,fontWeight:700}}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {PRESETS.map((p,i) => {
        const exists = !!allPlans[p.id];
        const d=allPlans[p.id]; const st=d?.state; const pl=d?.plan;
        const tv = exists ? st.AB+st.SR : 0;
        const risk = exists ? riskInfo(st.streak||0,st.AB,st.SR) : null;
        const roi  = exists ? ((tv-pl.starting)/pl.starting*100).toFixed(1) : null;

        return (
          <button key={p.id} onClick={()=>onOpen(p.id)}
            style={{display:"block",width:"100%",background:"var(--surface)",
              border:"1px solid var(--hairline)",borderRadius:20,padding:18,marginBottom:13,
              boxShadow:"var(--shadow)",cursor:"pointer",textAlign:"left",
              animation:`fadeUp ${0.45+i*0.08}s ease`}}>
            {exists ? (
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:600,fontSize:19,letterSpacing:"-0.01em",color:"var(--ink)"}}>
                      {p.label.charAt(0)+p.label.slice(1).toLowerCase()}
                    </div>
                    <div style={{fontSize:11,color:"var(--ink3)",marginTop:3,fontFamily:"'Inter',sans-serif"}}>
                      Day {st.day-1} · ×{pl.odds} staking · {pl.currency}
                    </div>
                  </div>
                  <span style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:600,
                    padding:"3px 9px",borderRadius:999,whiteSpace:"nowrap",fontFamily:"'Inter',sans-serif",
                    background:risk.color+"22",color:risk.color}}>
                    {risk.short}
                  </span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",
                  borderTop:"1px solid var(--hairline)",paddingTop:13}}>
                  <div>
                    <div style={{fontSize:10,color:"var(--ink3)",fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",fontFamily:"'Inter',sans-serif"}}>Balance</div>
                    <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:600,fontSize:17,marginTop:3,color:"var(--ink)"}}>{fmt(tv,pl.currency)}</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:10,color:"var(--ink3)",fontWeight:600,letterSpacing:"0.08em",textTransform:"uppercase",fontFamily:"'Inter',sans-serif"}}>Profit</div>
                    <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:600,fontSize:17,marginTop:3,
                      color:parseFloat(roi)>=0?"var(--win)":"var(--loss)"}}>{(parseFloat(roi)>=0?"+":"")+roi+"%"}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:600,fontSize:19,color:"var(--ink)"}}>{p.label.charAt(0)+p.label.slice(1).toLowerCase()}</div>
                  <div style={{fontSize:11,color:"var(--ink3)",marginTop:3,fontFamily:"'Inter',sans-serif"}}>\u00d7{p.odds} odds \u00b7 tap to activate</div>
                </div>
                <span style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:600,padding:"3px 11px",
                  borderRadius:999,background:"var(--cobalt-soft)",color:"var(--cobalt-ink)",fontFamily:"'Inter',sans-serif"}}>+ Activate</span>
              </div>
            )}
          </button>
        );
      })}

      {vals.length===0 && (
        <div style={{textAlign:"center",padding:"40px 0",fontFamily:"'Inter',sans-serif",fontSize:11,color:"rgba(var(--ink-rgb),0.133)",lineHeight:2}}>
          Tap a plan above to activate it.<br/>All data auto-saves to the cloud.
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ PLAN VIEW ═════════════════════════════ */
function PlanView({plan,st,preset,tab,setTab,onBet,onBack,onDelete,onLogTip,onTrack,onSettle,onRemove,onArchive}) {
  const risk   = riskInfo(st.streak||0, st.AB, st.SR);
  const wdCalc = calcWD(st.AB, st.day, st.lastWD, st.crossed, plan.wdPct);
  const nextWD = 7 - ((st.day-1) % 7);
  return (
    <div style={{...S.screen,animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"6px 2px 16px"}}>
        <div>
          <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:600,fontSize:23,letterSpacing:"-0.02em",color:"var(--ink)"}}>
            {preset.label.charAt(0)+preset.label.slice(1).toLowerCase()}
          </div>
          <div style={{fontSize:11,color:"var(--ink3)",fontWeight:500,marginTop:2,fontFamily:"'Inter',sans-serif"}}>
            Day {st.day-1} · ×{plan.odds} · {plan.currency}
          </div>
        </div>
        <span style={{display:"inline-flex",alignItems:"center",fontSize:11,fontWeight:600,padding:"4px 11px",
          borderRadius:999,whiteSpace:"nowrap",fontFamily:"'Inter',sans-serif",marginTop:4,
          background:risk.color+"22",color:risk.color}}>
          {risk.short}
        </span>
      </div>
      <div style={{display:"flex",gap:2,marginBottom:16,background:"var(--seg-bg)",border:"1px solid var(--hairline)",borderRadius:13,padding:3,overflowX:"auto"}}>
        {["TIPS","HISTORY","RESERVE","SETTINGS"].map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{flex:"1 0 auto",padding:"8px 7px",borderRadius:10,border:"none",cursor:"pointer",
              fontFamily:"'Inter',sans-serif",fontSize:9.5,letterSpacing:0.2,transition:"all .18s",whiteSpace:"nowrap",
              background:tab===t?"var(--surface)":"transparent",
              color:tab===t?"var(--cobalt-ink)":"var(--ink3)",
              fontWeight:tab===t?"600":"500",
              boxShadow:tab===t?"0 1px 3px rgba(20,20,35,.12)":"none"}}>
            {t}
          </button>
        ))}
      </div>
      <div style={{animation:"fadeUp 0.2s ease"}}>
        {tab==="TODAY"     && <TodayTab    plan={plan} st={st} risk={risk} nextWD={nextWD} wdCalc={wdCalc} onBet={onBet} preset={preset}/>}
        {tab==="TIPS"      && <TipsTab     plan={plan} st={st} preset={preset} onTrack={onTrack}/>}
        {tab==="RESULTS"   && <ResultsTab  plan={plan} st={st} preset={preset} onLogTip={onLogTip} onSettle={onSettle} onRemove={onRemove} onArchive={onArchive}/>}
        {tab==="ARCHIVE"   && <ArchiveTab   plan={plan} st={st} preset={preset}/>}
        {tab==="HISTORY"   && <HistTab     plan={plan} st={st} preset={preset}/>}
        {tab==="RESERVE"   && <SRTab       plan={plan} st={st} preset={preset}/>}
        {tab==="SETTINGS"  && <SetTab      plan={plan} preset={preset} onDelete={onDelete}/>}
      </div>
    </div>
  );
}

/* ═══════════════════ TODAY ═════════════════════════════════ */
function TodayTab({plan,st,risk,nextWD,wdCalc,onBet,preset}) {
  const pot    = st.AB * plan.odds;
  const total  = st.AB + st.SR;
  const roi    = ((total-plan.starting)/plan.starting*100).toFixed(1);
  const animAB = useCountUp(st.AB);
  const animSR = useCountUp(st.SR);
  const animTV = useCountUp(total);
  return (
    <div>
      {/* Risk meter */}
      <div style={{...S.glassCard,border:`1px solid ${risk.color}33`,background:`linear-gradient(135deg,${risk.color}07,transparent)`,marginBottom:10,padding:"12px 14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <span style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.267)",letterSpacing:2}}>RISK ASSESSMENT</span>
          <span style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,color:risk.color,textShadow:`0 0 10px ${risk.glow}`}}>{risk.label}</span>
        </div>
        <div style={{display:"flex",gap:3,height:5,marginBottom:8}}>
          {[0.25,0.5,0.75,1].map((seg,i)=>(
            <div key={i} style={{flex:1,borderRadius:3,transition:"all .5s ease",
              background:risk.bar>=seg?(i===0?"#2F37D9":i===1?"#E08A00":i===2?"#E08A00":"#DC3B3B"):"rgba(var(--ink-rgb),0.051)",
              boxShadow:risk.bar>=seg?`0 0 8px ${i===0?"#2F37D9":i===1?"#E08A00":i===2?"#E08A00":"#DC3B3B"}88`:"none"}}/>
          ))}
        </div>
        <div style={{display:"flex",justifyContent:"space-between"}}>
          <span style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)"}}>🔥 {st.streak||0} streak</span>
          <span style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)"}}>⏱ WD in {nextWD}d</span>
          <span style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)"}}>✕ {st.losses||0} losses</span>
        </div>
      </div>

      {/* Bank hero */}
      <div style={{...S.glassCard,border:`1px solid ${preset.color}33`,
        background:`linear-gradient(135deg,${preset.color}09,rgba(var(--ink-rgb),0.012))`,
        boxShadow:`0 0 40px ${preset.glow.replace("0.5","0.07")}`,marginBottom:10,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:-20,right:-20,width:80,height:80,borderRadius:"50%",
          background:`radial-gradient(circle,${preset.color}18,transparent)`,pointerEvents:"none"}}/>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:preset.color+"88",letterSpacing:3,marginBottom:4}}>◈ ACTIVE BANK</div>
        <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:28,
          color:preset.color,lineHeight:1,textShadow:`0 0 30px ${preset.glow}`}}>
          {fmt(animAB,plan.currency)}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:14}}>
          <div style={{background:"rgba(var(--ink-rgb),0.02)",borderRadius:10,padding:"10px 12px",border:"1px solid #E08A0022"}}>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"#E08A0066",letterSpacing:2,marginBottom:4}}>SAFE RESERVE</div>
            <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,color:"#E08A00",fontSize:14}}>{fmt(animSR,plan.currency)}</div>
          </div>
          <div style={{background:"rgba(var(--ink-rgb),0.02)",borderRadius:10,padding:"10px 12px",border:"1px solid #159A5622"}}>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"#159A5666",letterSpacing:2,marginBottom:4}}>TOTAL VALUE</div>
            <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,color:"#159A56",fontSize:14}}>{fmt(animTV,plan.currency)}</div>
          </div>
        </div>
      </div>

      {/* Today's bet */}
      <div style={{...S.glassCard,marginBottom:10}}>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.133)",letterSpacing:3,marginBottom:12}}>TODAY'S ROLLOVER — DAY {st.day}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {[["STAKE",fmt(st.AB,plan.currency),preset.color],
            ["WIN TARGET",fmt(pot,plan.currency),"#159A56"],
            ["NET PROFIT","+"+fmt(pot-st.AB,plan.currency),"#159A56"],
            ["ODDS","× "+plan.odds,"#E08A00"]
          ].map(([l,v,col],i)=>(
            <div key={i} style={{background:"rgba(var(--ink-rgb),0.016)",border:`1px solid ${col}18`,borderRadius:10,padding:"10px 12px",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${col}44,transparent)`}}/>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:col+"66",letterSpacing:2,marginBottom:6}}>{l}</div>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,color:col,fontSize:12}}>{v}</div>
            </div>
          ))}
        </div>
        {wdCalc.wd>0 && (
          <div style={{marginTop:10,background:"#E08A0008",border:"1px solid #E08A0033",borderRadius:10,padding:"10px 12px"}}>
            <div style={{fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:10,color:"#E08A00",letterSpacing:1,marginBottom:6}}>⚡ WITHDRAWAL TRIGGERED</div>
            {wdCalc.reasons.map((r,i)=>(
              <div key={i} style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"#E08A0088",marginTop:2}}>› {r}</div>
            ))}
          </div>
        )}
      </div>

      {/* ROI */}
      <div style={{...S.glassCard,display:"flex",justifyContent:"space-between",alignItems:"center",
        marginBottom:10,padding:"12px 16px",
        background:parseFloat(roi)>=0?"linear-gradient(135deg,#159A5607,transparent)":"linear-gradient(135deg,#DC3B3B07,transparent)",
        border:`1px solid ${parseFloat(roi)>=0?"#159A5622":"#DC3B3B22"}`}}>
        <div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",letterSpacing:2}}>TOTAL RETURN</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)",marginTop:2}}>Since Day 1</div>
        </div>
        <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:28,letterSpacing:1,
          color:parseFloat(roi)>=0?"#159A56":"#DC3B3B",
          textShadow:`0 0 20px ${parseFloat(roi)>=0?"rgba(105,255,71,0.5)":"rgba(255,23,68,0.5)"}`}}>
          {parseFloat(roi)>=0?"+":""}{roi}%
        </div>
      </div>

      {(st.streak||0)>=7 && (
        <div style={{...S.glassCard,marginBottom:10,background:"linear-gradient(135deg,#E08A0010,transparent)",
          border:"1px solid #E08A0033",padding:"10px 14px"}}>
          <div style={{fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:11,color:"#E08A00",marginBottom:4}}>
            ⚠ STREAK ALERT — {st.streak} CONSECUTIVE WINS
          </div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"#E08A0088",lineHeight:1.6}}>
            Consider moving extra funds to Safe Reserve before today's bet.
          </div>
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:4}}>
        <button onClick={()=>onBet("WIN")} style={{...S.winBtn,boxShadow:"0 4px 30px rgba(105,255,71,0.3)"}}>
          <div style={{fontSize:26,marginBottom:4}}>✦</div>
          <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:18,letterSpacing:3}}>WIN</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,opacity:.7,marginTop:2}}>Roll profits forward</div>
          <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:"linear-gradient(90deg,transparent,rgba(var(--sheen-rgb),0.3),transparent)"}}/>
        </button>
        <button onClick={()=>onBet("LOSS")} style={{...S.lossBtn,boxShadow:"0 4px 30px rgba(255,23,68,0.3)"}}>
          <div style={{fontSize:26,marginBottom:4}}>✕</div>
          <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:18,letterSpacing:3}}>LOSS</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,opacity:.7,marginTop:2}}>Chain broke · SR restart</div>
          <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:"linear-gradient(90deg,transparent,rgba(var(--sheen-rgb),0.2),transparent)"}}/>
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════ HISTORY ═══════════════════════════════ */
/* ═══════════════════ RESULTS TAB ════════════════════════════ */
function ResultsTab({plan, st, preset, onLogTip, onSettle, onRemove, onArchive}) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    match:"", league:"", market:"", pick:"", odds:"", stake:"", result:"WIN"
  });

  const all = (st.tipResults||[]);
  const pending = all.filter(r=>r.result==="PENDING").slice().reverse();
  const results = all.filter(r=>r.result==="WIN"||r.result==="LOSS").slice().reverse();

  // Auto-graded accuracy = settled outcomes + pending tips already graded
  const gradedOutcomes = [
    ...results.map(r=>r.result),
    ...pending.filter(p=>p.autoResult).map(p=>p.autoResult),
  ];
  const gradedWins = gradedOutcomes.filter(o=>o==="WIN").length;
  const gradedTotal = gradedOutcomes.length;
  const tipAccuracy = gradedTotal ? Math.round(gradedWins/gradedTotal*100) : null;
  const autoPendingCount = pending.filter(p=>p.autoResult).length;
  const wins = results.filter(r=>r.result==="WIN");
  const losses = results.filter(r=>r.result==="LOSS");
  const totalProfit = results.reduce((s,r)=>s+r.profitTSH,0);
  const totalStaked = results.reduce((s,r)=>s+r.stake,0);
  const roi = totalStaked>0 ? (totalProfit/totalStaked*100).toFixed(1) : "0.0";
  const wr  = results.length>0 ? (wins.length/results.length*100).toFixed(0) : "0";

  // ROI by market
  const byMarket = {};
  results.forEach(r=>{
    const m = (r.market||"Other").split(" ")[0]+" "+(r.market||"").split(" ")[1]||"Other";
    if(!byMarket[m]) byMarket[m]={wins:0,losses:0,profit:0,staked:0};
    byMarket[m][r.result==="WIN"?"wins":"losses"]++;
    byMarket[m].profit += r.profitTSH;
    byMarket[m].staked += r.stake;
  });

  // ROI by league
  const byLeague = {};
  results.forEach(r=>{
    const lg = (r.league||"Other").split("(")[0].trim();
    if(!byLeague[lg]) byLeague[lg]={wins:0,losses:0,profit:0,staked:0};
    byLeague[lg][r.result==="WIN"?"wins":"losses"]++;
    byLeague[lg].profit += r.profitTSH;
    byLeague[lg].staked += r.stake;
  });

  const handleLog = () => {
    if(!form.match||!form.odds||!form.stake) return;
    onLogTip({
      match: form.match,
      league: form.league,
      market: form.market,
      pick: form.pick,
      odds: parseFloat(form.odds),
      stake: parseFloat(form.stake),
      result: form.result,
      currency: plan.currency,
    });
    setForm({match:"",league:"",market:"",pick:"",odds:"",stake:"",result:"WIN"});
    setShowForm(false);
  };

  return (
    <div>
      {/* Summary stats */}
      <div style={{...S.glassCard, border:`1px solid ${preset.color}33`,
        background:`linear-gradient(135deg,${preset.color}08,transparent)`, marginBottom:10}}>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:preset.color+"88",
          letterSpacing:3, marginBottom:12}}>TIPS PERFORMANCE TRACKER</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
          {[
            ["TOTAL P&L", `${totalProfit>=0?"+":""}${fmt(totalProfit,plan.currency)}`,
             totalProfit>=0?"#159A56":"#DC3B3B"],
            ["USD P&L", `${totalProfit>=0?"+":"-"}$${Math.abs(totalProfit/TSH_TO_USD).toFixed(2)}`,
             totalProfit>=0?"#159A56":"#DC3B3B"],
            ["WIN RATE", wr+"%", parseInt(wr)>=55?"#159A56":parseInt(wr)>=45?"#E08A00":"#DC3B3B"],
            ["ROI", (parseFloat(roi)>=0?"+":"")+roi+"%",
             parseFloat(roi)>=0?"#159A56":"#DC3B3B"],
            ["TOTAL STAKED", fmt(totalStaked,plan.currency), "#2F37D9"],
            ["BETS LOGGED", results.length, preset.color],
          ].map(([l,v,col])=>(
            <div key={l} style={{background:"rgba(var(--ink-rgb),0.02)",borderRadius:10,padding:"10px 12px",
              border:`1px solid ${col}18`}}>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:7,color:col+"66",
                letterSpacing:2,marginBottom:4}}>{l}</div>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:12,color:col}}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:12,paddingTop:10,borderTop:"1px solid rgba(var(--ink-rgb),0.031)"}}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"#159A5688"}}>
            ✓ {wins.length} wins
          </div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"#DC3B3B88"}}>
            ✕ {losses.length} losses
          </div>
        </div>
      </div>

      {/* Pending tips pulled from GET TIPS — settle after each match */}
      {/* Auto-graded tip accuracy — results caught automatically */}
      {gradedTotal>0 && (
        <div style={{...S.glassCard, border:"1px solid #2F37D933",
          background:"linear-gradient(135deg,#2F37D90a,transparent)", marginBottom:10,
          display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
          <div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"#2F37D999",letterSpacing:2,marginBottom:4}}>TIP ACCURACY · AUTO-GRADED</div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.4)"}}>
              {gradedWins}W · {gradedTotal-gradedWins}L · {gradedTotal} graded{autoPendingCount>0?` · ${autoPendingCount} pending`:""}
            </div>
          </div>
          <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:26,
            color: tipAccuracy>=55?"#159A56":tipAccuracy>=45?"#E08A00":"#DC3B3B"}}>{tipAccuracy}%</div>
        </div>
      )}

      {pending.length>0 && (
        <div style={{...S.glassCard, border:"1px solid #E08A0044",
          background:"linear-gradient(135deg,#E08A0008,transparent)", marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"#E08A00aa",letterSpacing:2}}>
              PENDING TIPS · {pending.length}
            </div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)"}}>from GET TIPS</div>
          </div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.267)",lineHeight:1.6,marginBottom:12}}>
            Enter the stake you placed, then tap Win or Loss. Tap ✕ to drop a tip you didn’t bet.
          </div>
          {pending.map(t=> <PendingTipRow key={t.id} tip={t} preset={preset} onSettle={onSettle} onRemove={onRemove}/>)}
        </div>
      )}

      {/* Clear & Archive finished tips */}
      {(st.tipResults||[]).some(r=>r.result==="WIN"||r.result==="LOSS"||r.autoResult) && (
        <button onClick={onArchive}
          style={{width:"100%",background:"rgba(var(--ink-rgb),0.024)",border:"1px solid rgba(var(--ink-rgb),0.133)",borderRadius:12,
            color:"rgba(var(--ink-rgb),0.6)",fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:10.5,
            padding:"11px",cursor:"pointer",letterSpacing:1,marginBottom:10}}>
          {"\u21b3 CLEAR & ARCHIVE FINISHED TIPS"}
        </button>
      )}

      {/* Log a tip result button */}
      <button onClick={()=>setShowForm(!showForm)}
        style={{width:"100%",background:showForm?"rgba(var(--ink-rgb),0.031)":`linear-gradient(135deg,${preset.color}22,${preset.color}11)`,
          border:`1px solid ${preset.color}44`,borderRadius:12,color:preset.color,
          fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:11,
          padding:"12px",cursor:"pointer",letterSpacing:1,marginBottom:10}}>
        {showForm ? "✕ CANCEL" : "+ LOG TIP RESULT"}
      </button>

      {/* Log form */}
      {showForm && (
        <div style={{...S.glassCard,marginBottom:10,border:`1px solid ${preset.color}33`}}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",
            letterSpacing:2,marginBottom:12}}>LOG A TIP RESULT</div>
          {[
            {k:"match",  label:"MATCH",  ph:"e.g. Arsenal vs Chelsea"},
            {k:"league", label:"LEAGUE", ph:"e.g. Premier League"},
            {k:"market", label:"MARKET", ph:"e.g. Over 2.5 Goals"},
            {k:"pick",   label:"PICK",   ph:"e.g. Over 2.5"},
            {k:"odds",   label:"ODDS",   ph:"e.g. 1.85",  type:"number"},
            {k:"stake",  label:"STAKE ("+plan.currency+")", ph:"e.g. 5000", type:"number"},
          ].map(({k,label,ph,type="text"})=>(
            <div key={k} style={{marginBottom:8}}>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.267)",
                letterSpacing:1,marginBottom:4}}>{label}</div>
              <input type={type} placeholder={ph} value={form[k]}
                onChange={e=>setForm({...form,[k]:e.target.value})}
                style={{...S.input,border:`1px solid ${preset.color}33`,padding:"10px 12px",fontSize:12}}/>
            </div>
          ))}
          {/* Result toggle */}
          <div style={{marginBottom:12}}>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.267)",
              letterSpacing:1,marginBottom:8}}>RESULT</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {["WIN","LOSS"].map(r=>(
                <button key={r} onClick={()=>setForm({...form,result:r})}
                  style={{padding:"10px",borderRadius:10,border:"none",cursor:"pointer",
                    fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:13,
                    background: form.result===r
                      ? (r==="WIN"?"linear-gradient(135deg,#159A56,#159A56)":"linear-gradient(135deg,#DC3B3B,#B0302F)")
                      : "rgba(var(--ink-rgb),0.031)",
                    color: form.result===r ? (r==="WIN"?"#001a00":"var(--ink)") : "rgba(var(--ink-rgb),0.267)",
                  }}>
                  {r==="WIN"?"✦ WIN":"✕ LOSS"}
                </button>
              ))}
            </div>
          </div>
          {/* Preview profit */}
          {form.odds && form.stake && (
            <div style={{background:form.result==="WIN"?"#159A5610":"#DC3B3B10",
              borderRadius:8,padding:"8px 12px",marginBottom:12,
              border:`1px solid ${form.result==="WIN"?"#159A5633":"#DC3B3B33"}`}}>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,
                color:form.result==="WIN"?"#159A56":"#DC3B3B"}}>
                {form.result==="WIN"
                  ? `Profit: +${fmt(parseFloat(form.stake)*(parseFloat(form.odds)-1),plan.currency)} (+$${(parseFloat(form.stake)*(parseFloat(form.odds)-1)/TSH_TO_USD).toFixed(2)})`
                  : `Loss: -${fmt(parseFloat(form.stake),plan.currency)} (-$${(parseFloat(form.stake)/TSH_TO_USD).toFixed(2)})`
                }
              </div>
            </div>
          )}
          <button onClick={handleLog}
            style={{width:"100%",background:preset.gradient,border:"none",borderRadius:10,
              color:"#000",fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:12,
              padding:"12px",cursor:"pointer",boxShadow:`0 0 20px ${preset.glow}`}}>
            SAVE RESULT
          </button>
        </div>
      )}

      {/* ROI by Market */}
      {Object.keys(byMarket).length > 0 && (
        <div style={{...S.glassCard,marginBottom:10}}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",
            letterSpacing:2,marginBottom:10}}>ROI BY MARKET</div>
          {Object.entries(byMarket)
            .sort((a,b)=>b[1].profit-a[1].profit)
            .map(([market,data])=>{
              const mRoi = data.staked>0?(data.profit/data.staked*100).toFixed(1):"0";
              const col = parseFloat(mRoi)>=0?"#159A56":"#DC3B3B";
              return (
                <div key={market} style={{display:"flex",justifyContent:"space-between",
                  alignItems:"center",padding:"8px 0",borderBottom:"1px solid rgba(var(--ink-rgb),0.024)"}}>
                  <div>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.467)"}}>{market}</div>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",marginTop:2}}>
                      {data.wins}W {data.losses}L
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,color:col}}>
                      {parseFloat(mRoi)>=0?"+":""}{mRoi}%
                    </div>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:col+"88",marginTop:2}}>
                      {fmt(data.profit,plan.currency)}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* ROI by League */}
      {Object.keys(byLeague).length > 0 && (
        <div style={{...S.glassCard,marginBottom:10}}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",
            letterSpacing:2,marginBottom:10}}>ROI BY LEAGUE</div>
          {Object.entries(byLeague)
            .sort((a,b)=>b[1].profit-a[1].profit)
            .slice(0,8)
            .map(([league,data])=>{
              const lRoi = data.staked>0?(data.profit/data.staked*100).toFixed(1):"0";
              const col = parseFloat(lRoi)>=0?"#159A56":"#DC3B3B";
              return (
                <div key={league} style={{display:"flex",justifyContent:"space-between",
                  alignItems:"center",padding:"8px 0",borderBottom:"1px solid rgba(var(--ink-rgb),0.024)"}}>
                  <div>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.467)"}}>{league}</div>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",marginTop:2}}>
                      {data.wins}W {data.losses}L
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,color:col}}>
                      {parseFloat(lRoi)>=0?"+":""}{lRoi}%
                    </div>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:col+"88",marginTop:2}}>
                      {fmt(data.profit,plan.currency)}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* Recent results list */}
      {results.length===0 ? (
        <div style={{textAlign:"center",padding:"40px 0",fontFamily:"'Inter',sans-serif",
          fontSize:10,color:"rgba(var(--ink-rgb),0.133)",lineHeight:2}}>
          <div style={{fontSize:36,marginBottom:12,opacity:.3}}>📊</div>
          No settled results yet.<br/>
          {pending.length>0 ? "Settle your pending tips above after the matches finish." : "Pull tips in the TIPS tab — they’ll appear here to grade."}
        </div>
      ) : (
        <div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.133)",
            letterSpacing:2,marginBottom:10}}>RECENT RESULTS</div>
          {results.slice(0,20).map((r,i)=>(
            <div key={r.id||i} style={{...S.glassCard,marginBottom:8,padding:"12px 14px",
              borderLeft:`2px solid ${r.result==="WIN"?"#159A56":"#DC3B3B"}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div style={{flex:1,paddingRight:8}}>
                  <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,
                    color:"var(--ink)",marginBottom:3}}>{r.match}</div>
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.267)",marginBottom:4}}>
                    {r.league} · {r.market}
                  </div>
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.4)"}}>
                    {r.pick} @ {r.odds} · Stake: {fmt(r.stake,plan.currency)}
                  </div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:14,
                    color:r.result==="WIN"?"#159A56":"#DC3B3B",marginBottom:4}}>
                    {r.result==="WIN"?"✦ WIN":"✕ LOSS"}
                  </div>
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,
                    color:r.result==="WIN"?"#159A56":"#DC3B3B"}}>
                    {r.profitTSH>=0?"+":""}{fmt(r.profitTSH,plan.currency)}
                  </div>
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,
                    color:r.result==="WIN"?"#159A5688":"#DC3B3B88"}}>
                    {r.profitTSH>=0?"+":"-"}${Math.abs(r.profitUSD).toFixed(2)}
                  </div>
                </div>
              </div>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.133)",
                marginTop:6}}>{r.date}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ HISTORY ═══════════════════════════════ */
function HistTab({plan,st,preset}) {
  const hist = [...st.history].reverse();
  const wins = st.history.filter(h=>h.result==="WIN").length;
  const wr   = hist.length>0?(wins/hist.length*100).toFixed(1):0;
  if(!hist.length) return(
    <div style={{textAlign:"center",padding:"60px 0",color:"rgba(var(--ink-rgb),0.133)",fontFamily:"'Inter',sans-serif"}}>
      <div style={{fontSize:40,marginBottom:12,opacity:.3}}>◈</div>
      <div style={{letterSpacing:2}}>NO BETS LOGGED YET</div>
    </div>
  );
  return(
    <div>
      <div style={{...S.glassCard,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:0,marginBottom:12,padding:0,overflow:"hidden"}}>
        {[["BETS",hist.length,preset.color],["WIN RATE",wr+"%","#159A56"],["LOSSES",st.losses||0,"#DC3B3B"]].map(([l,v,col],i)=>(
          <div key={i} style={{padding:"12px",borderRight:i<2?"1px solid rgba(var(--ink-rgb),0.031)":"none",textAlign:"center"}}>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",letterSpacing:2,marginBottom:4}}>{l}</div>
            <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:16,color:col}}>{v}</div>
          </div>
        ))}
      </div>
      {hist.map((h,i)=>(
        <div key={i} style={{...S.glassCard,marginBottom:8,padding:"12px 14px",
          borderLeft:`2px solid ${h.result==="WIN"?"#159A56":"#DC3B3B"}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)",marginBottom:4}}>DAY {h.day}</div>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:13,color:h.result==="WIN"?"#159A56":"#DC3B3B"}}>
                {h.result==="WIN"?"✦ WIN":"✕ LOSS"}
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)",marginBottom:4}}>{fmt(h.openAB,plan.currency)}</div>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,color:h.result==="WIN"?"#159A56":"#DC3B3B"}}>→ {fmt(h.closeAB,plan.currency)}</div>
            </div>
          </div>
          {h.wd>0&&<div style={{marginTop:8,background:"#E08A0008",borderRadius:6,padding:"5px 8px",fontFamily:"'Inter',sans-serif",fontSize:9,color:"#E08A0088"}}>⚡ Withdrawn: {fmt(h.wd,plan.currency)}</div>}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════ RESERVE ═══════════════════════════════ */
function SRTab({plan,st,preset}) {
  const total  = st.AB+st.SR;
  const roi    = ((total-plan.starting)/plan.starting*100).toFixed(1);
  const ratio  = (st.SR/Math.max(st.AB,1)*100).toFixed(1);
  const wdHist = (st.history||[]).filter(h=>h.wd>0);
  const animSR = useCountUp(st.SR);
  return(
    <div>
      <div style={{...S.glassCard,border:"1px solid #E08A0033",background:"linear-gradient(135deg,#E08A0008,transparent)",marginBottom:10}}>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"#E08A0066",letterSpacing:3,marginBottom:4}}>◈ SAFE RESERVE</div>
        <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:26,color:"#E08A00",textShadow:"0 0 30px rgba(255,214,0,0.6)"}}>
          {fmt(animSR,plan.currency)}
        </div>
        <div style={{marginTop:14}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.267)"}}>SR COVERAGE</span>
            <span style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,
              color:parseFloat(ratio)>30?"#159A56":parseFloat(ratio)>10?"#E08A00":"#DC3B3B"}}>{ratio}%</span>
          </div>
          <div style={{height:6,background:"rgba(var(--ink-rgb),0.039)",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${Math.min(parseFloat(ratio),100)}%`,borderRadius:3,transition:"width .8s ease",
              background:parseFloat(ratio)>30?"linear-gradient(90deg,#159A56,#159A56)":parseFloat(ratio)>10?"linear-gradient(90deg,#E08A00,#FF8F00)":"linear-gradient(90deg,#DC3B3B,#D50000)",
              boxShadow:parseFloat(ratio)>30?"0 0 10px #159A5688":parseFloat(ratio)>10?"0 0 10px #E08A0088":"0 0 10px #DC3B3B88"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:10}}>
            <div><div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.133)",letterSpacing:2}}>TOTAL TO SR</div>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:13,color:"#E08A00",marginTop:2}}>{fmt(st.totalSR||0,plan.currency)}</div></div>
            <div style={{textAlign:"right"}}><div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.133)",letterSpacing:2}}>TOTAL ROI</div>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:13,color:parseFloat(roi)>=0?"#159A56":"#DC3B3B",marginTop:2}}>
                {parseFloat(roi)>=0?"+":""}{roi}%
              </div></div>
          </div>
        </div>
      </div>
      <div style={S.glassCard}>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.133)",letterSpacing:3,marginBottom:12}}>METRICS</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {[["DAYS RUN",st.day-1,preset.color],["WINS",(st.history||[]).filter(h=>h.result==="WIN").length,"#159A56"],
            ["LOSSES",st.losses||0,"#DC3B3B"],["STREAK",st.streak||0,"#E08A00"],
            ["TOTAL VALUE",fmt(total,plan.currency),"#159A56"],["WD EVENTS",wdHist.length,"#E08A00"]
          ].map(([l,v,col],i)=>(
            <div key={i} style={{background:"rgba(var(--ink-rgb),0.016)",border:`1px solid ${col}15`,borderRadius:10,padding:"10px 12px",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${col}33,transparent)`}}/>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:col+"66",letterSpacing:2,marginBottom:6}}>{l}</div>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,color:col,fontSize:13}}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════ SETTINGS ══════════════════════════════ */
function SetTab({plan,preset,onDelete}) {
  const [confirm,setConfirm]=useState(false);
  return(
    <div>
      <div style={S.glassCard}>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.133)",letterSpacing:3,marginBottom:12}}>PLAN CONFIG</div>
        {[["Plan",`${preset.emoji} ${preset.label}`],["Odds","× "+plan.odds],
          ["Currency",plan.currency],["Starting",fmt(plan.starting,plan.currency)],
          ["Weekly WD",(plan.wdPct*100).toFixed(0)+"% of AB"],
          ["Milestone WD","35% at milestones"],["Loss Restart","60% of SR → AB"],["SR Protection","40% always kept"]
        ].map(([l,v],i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            borderBottom:"1px solid rgba(var(--ink-rgb),0.024)",padding:"11px 0",fontFamily:"'Inter',sans-serif"}}>
            <span style={{fontSize:10,color:"rgba(var(--ink-rgb),0.267)"}}>{l}</span>
            <span style={{fontSize:11,fontWeight:700,color:preset.color}}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{marginTop:16}}>
        {!confirm?(
          <button onClick={()=>setConfirm(true)}
            style={{width:"100%",background:"linear-gradient(135deg,#DC3B3B12,transparent)",
              border:"1px solid #DC3B3B44",borderRadius:12,color:"#DC3B3B",
              fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:12,padding:"14px",cursor:"pointer",letterSpacing:1}}>
            ✕ DELETE THIS PLAN
          </button>
        ):(
          <div style={{...S.glassCard,border:"1px solid #DC3B3B44"}}>
            <div style={{fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:11,color:"#DC3B3B",marginBottom:14,letterSpacing:1}}>
              ⚠ DELETE PLAN {preset.label}? CANNOT BE UNDONE.
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <button onClick={onDelete} style={{...S.lossBtn,padding:12,fontSize:11}}>CONFIRM</button>
              <button onClick={()=>setConfirm(false)} style={{...S.winBtn,padding:12,fontSize:11}}>CANCEL</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════ SETUP ═════════════════════════════════ */
function SetupScreen({presetId,onSetup,onBack}) {
  const preset = PRESETS.find(p=>p.id===presetId);
  const fields = [
    {k:"name",     label:"PLAN NAME",        ph:`My ${preset.label} Plan`, type:"text"},
    {k:"starting", label:"STARTING CAPITAL", ph:"e.g. 50000",              type:"number"},
    {k:"currency", label:"CURRENCY",         ph:"e.g. TSH",                type:"text"},
  ];
  const [step,setStep] = useState(0);
  const [form,setForm] = useState({name:`Plan ${preset.label}`,starting:"50000",currency:"TSH"});
  const next = () => {
    if(step<fields.length-1) setStep(s=>s+1);
    else onSetup(presetId, {...form, odds:preset.odds, starting:parseFloat(form.starting), wdPct:preset.wdPct});
  };
  return(
    <div style={{...S.screen,display:"flex",flexDirection:"column",justifyContent:"center",minHeight:"100vh",animation:"fadeUp .5s ease"}}>
      <button onClick={onBack} style={{...S.backBtn,alignSelf:"flex-start",marginBottom:32}}>← BACK</button>
      <div style={{textAlign:"center",marginBottom:32}}>
        <div style={{width:64,height:64,borderRadius:18,background:preset.gradient,display:"flex",
          alignItems:"center",justifyContent:"center",margin:"0 auto 16px",
          fontSize:28,fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,color:"#000",
          boxShadow:`0 0 40px ${preset.glow}`}}>{preset.emoji}</div>
        <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:26,
          color:preset.color,letterSpacing:4,textShadow:`0 0 20px ${preset.glow}`}}>PLAN {preset.label}</div>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,color:"rgba(var(--ink-rgb),0.2)",marginTop:6,letterSpacing:3}}>
          ×{preset.odds} ODDS · {preset.wdPct*100}% WEEKLY WD
        </div>
      </div>
      <div style={S.glassCard}>
        <div style={{display:"flex",gap:4,marginBottom:20}}>
          {fields.map((_,i)=>(
            <div key={i} style={{flex:1,height:3,borderRadius:2,transition:"all .4s ease",
              background:i<=step?preset.gradient:"rgba(var(--ink-rgb),0.051)",
              boxShadow:i===step?`0 0 10px ${preset.glow}`:"none"}}/>
          ))}
        </div>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)",letterSpacing:3,marginBottom:8}}>STEP {step+1} OF {fields.length}</div>
        <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:15,color:preset.color,letterSpacing:2,marginBottom:14}}>{fields[step].label}</div>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          {[["ODDS","×"+preset.odds,preset.color],["WEEKLY WD",preset.wdPct*100+"%","#E08A00"]].map(([l,v,col],i)=>(
            <div key={i} style={{flex:1,background:`${col}0d`,border:`1px solid ${col}33`,borderRadius:10,padding:"8px",textAlign:"center"}}>
              <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:col+"66",letterSpacing:2,marginBottom:3}}>{l}</div>
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:13,color:col}}>{v}</div>
            </div>
          ))}
        </div>
        <input type={fields[step].type} placeholder={fields[step].ph} value={form[fields[step].k]}
          onChange={e=>setForm({...form,[fields[step].k]:e.target.value})}
          onKeyDown={e=>e.key==="Enter"&&next()} autoFocus
          style={{...S.input,border:`1px solid ${preset.color}44`,boxShadow:`0 0 20px ${preset.glow.replace("0.5","0.08")}`}}/>
        <div style={{display:"flex",gap:10,marginTop:14}}>
          {step>0&&<button onClick={()=>setStep(s=>s-1)} style={{...S.winBtn,flex:1,background:"transparent",border:"1px solid rgba(var(--ink-rgb),0.133)",color:"rgba(var(--ink-rgb),0.333)",boxShadow:"none"}}>← BACK</button>}
          <button onClick={next} style={{...S.winBtn,flex:2,
            background:step===fields.length-1?preset.gradient:"linear-gradient(135deg,rgba(var(--ink-rgb),0.071),rgba(var(--ink-rgb),0.024))",
            color:step===fields.length-1?"#000":"var(--ink)",
            boxShadow:step===fields.length-1?`0 4px 30px ${preset.glow}`:"none"}}>
            {step<fields.length-1?"NEXT →":"🚀 ACTIVATE PLAN"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════ TIPS TAB ══════════════════════════════ */
const MARKET_COLORS = {
  "Over": "#159A56", "Under": "#2F37D9", "BTTS": "#7C83F6",
  "Both": "#7C83F6", "First": "#E08A00", "Asian": "#E08A00",
  "Total": "#E08A00", "Either": "#7C83F6",
  "Corners": "#E08A00", "Cards": "#DC3B3B", "Fouls": "#FF8A65",
  "Offsides": "#40C4FF", "Shots": "#E08A00", "Throw": "#B388FF",
  "Highest": "#E08A00", "Clean": "#159A56"
};
function marketColor(market) {
  const key = Object.keys(MARKET_COLORS).find(k => market?.startsWith(k));
  return key ? MARKET_COLORS[key] : "#2F37D9";
}

function TipsTab({ plan, st, preset, onTrack }) {
  const bankroll = st ? (st.AB + st.SR) : 0;
  const [tips,     setTips]     = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [lastFetch,setLastFetch]= useState(null);
  const [expanded, setExpanded] = useState(null);
  const [filter,   setFilter]   = useState("ALL");
  const [activeAIs,setActiveAIs]= useState([]);
  const [fixtures, setFixtures] = useState("");

  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  }); // e.g. "2026-04-15" in user's local timezone
  const PLANS_ODDS = { alpha:1.10, beta:1.20, gamma:1.50 };

  const fetchTips = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/tips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Send the user's LOCAL date, not server UTC date
          date: new Date().toLocaleDateString("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        }),
      });
      // Safely handle non-JSON responses
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch(e) { throw new Error("Server returned an unexpected response. Check Vercel logs."); }
      if (data.error) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
      if (data.message) { setError(data.message); setLoading(false); return; }
      setTips(data.tips || []);
      if (onTrack && (data.tips||[]).length) onTrack(data.tips);
      setActiveAIs(data.activeAIs || []);
      setFixtures(data.fixtureSource || "");
      setLastFetch(Date.now());
    } catch (e) {
      setError(e.message || "Failed to load tips. Check your API key.");
    }
    setLoading(false);
  };

  const FILTERS = ["ALL","🔥 CONFIRMED","LOW RISK","OVER GOALS","UNDER GOALS","BTTS","CORNERS","CARDS","FOULS","OFFSIDES","SHOTS","THROW-INS","ODD/EVEN","HALVES","1ST HALF"];
  const filtered = tips.filter(t => {
    if(filter==="ALL") return true;
    if(filter==="🔥 CONFIRMED")  return t.confirmed || t.multiAI;
    if(filter==="LOW RISK")      return t.risk==="LOW";
    if(filter==="OVER GOALS")    return (t.pick||"").toUpperCase().includes("OVER") && (t.market||"").toUpperCase().includes("GOAL");
    if(filter==="UNDER GOALS")   return (t.pick||"").toUpperCase().includes("UNDER") && (t.market||"").toUpperCase().includes("GOAL");
    if(filter==="BTTS")          return (t.market||"").toUpperCase().includes("BTTS") || (t.market||"").includes("Both Teams");
    if(filter==="CORNERS")       return (t.market||"").toUpperCase().includes("CORNER");
    if(filter==="CARDS")         return (t.market||"").toUpperCase().includes("CARD");
    if(filter==="1ST HALF")      return (t.market||"").toUpperCase().includes("FIRST HALF") || (t.market||"").toUpperCase().includes("1ST HALF");
    if(filter==="FOULS")         return (t.market||"").toUpperCase().includes("FOUL");
    if(filter==="OFFSIDES")      return (t.market||"").toUpperCase().includes("OFFSIDE");
    if(filter==="SHOTS")         return (t.market||"").toUpperCase().includes("SHOT");
    if(filter==="THROW-INS")     return (t.market||"").toUpperCase().includes("THROW");
    if(filter==="ODD/EVEN")      return (t.market||"").toUpperCase().includes("ODD") || (t.market||"").toUpperCase().includes("EVEN");
    if(filter==="HALVES")        return (t.market||"").toUpperCase().includes("HIGHEST");
    return true;
  });

  const riskColor = r => r==="LOW"?"#159A56":r==="MEDIUM"?"#E08A00":"#DC3B3B";

  return (
    <div>
      {/* Header card */}
      <div style={{...S.glassCard, background:`linear-gradient(135deg,${preset.color}0a,transparent)`,
        border:`1px solid ${preset.color}33`, marginBottom:12, padding:"14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:13,
              color:preset.color,letterSpacing:2}}>🤖 MULTI-AI GOALS TIPS</div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.267)",marginTop:3,lineHeight:1.5}}>
              {activeAIs.length > 0
                ? activeAIs.join(" + ") + " active"
                : "Claude · Gemini · Groq · Goals only"}
            </div>
            {activeAIs.length > 0 && (
              <div style={{display:"flex",gap:5,marginTop:7,flexWrap:"wrap"}}>
                {activeAIs.map(ai=>(
                  <div key={ai} style={{padding:"2px 8px",borderRadius:20,
                    background:ai==="Claude"?"#2F37D915":ai==="Gemini"?"#159A5615":"#7C83F615",
                    border:`1px solid ${ai==="Claude"?"#2F37D9":ai==="Gemini"?"#159A56":"#7C83F6"}44`,
                    fontFamily:"'Inter',sans-serif",fontSize:8,letterSpacing:1,
                    color:ai==="Claude"?"#2F37D9":ai==="Gemini"?"#159A56":"#7C83F6"}}>
                    ✓ {ai}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",marginBottom:4}}>
              {lastFetch ? `Updated ${Math.round((Date.now()-lastFetch)/60000)}m ago` : "Not loaded"}
            </div>
            <button onClick={fetchTips} disabled={loading}
              style={{background:loading?"rgba(var(--ink-rgb),0.039)":preset.gradient,
                border:"none",borderRadius:8,padding:"8px 14px",cursor:loading?"not-allowed":"pointer",
                fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:10,
                color:loading?"rgba(var(--ink-rgb),0.267)":"#000",letterSpacing:1,
                boxShadow:loading?"none":`0 0 20px ${preset.glow}`}}>
              {loading ? "⏳ LOADING..." : "⚡ GET TIPS"}
            </button>
          </div>
        </div>

        {/* Warning */}
        <div style={{marginTop:10,background:"#E08A0008",border:"1px solid #E08A0022",
          borderRadius:8,padding:"7px 10px",fontFamily:"'Inter',sans-serif",fontSize:8,
          color:"#E08A0088",lineHeight:1.6}}>
          ⚠ AI tips are analytical suggestions only, not guarantees. Always combine with your own research. Bet responsibly.
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div>
          {[1,2,3,4].map(i=>(
            <div key={i} style={{...S.glassCard,marginBottom:10,padding:14,opacity:0.6}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                <div style={{background:"rgba(var(--ink-rgb),0.031)",borderRadius:4,height:12,width:"60%",animation:"pulse-load 1.5s ease infinite"}}/>
                <div style={{background:"rgba(var(--ink-rgb),0.031)",borderRadius:4,height:12,width:"15%",animation:"pulse-load 1.5s ease infinite"}}/>
              </div>
              <div style={{background:"rgba(var(--ink-rgb),0.02)",borderRadius:4,height:8,width:"40%",marginBottom:8,animation:"pulse-load 1.5s ease infinite"}}/>
              <div style={{background:"rgba(var(--ink-rgb),0.02)",borderRadius:4,height:8,width:"80%",animation:"pulse-load 1.5s ease infinite"}}/>
              <style>{`@keyframes pulse-load{0%,100%{opacity:.5}50%{opacity:1}}`}</style>
            </div>
          ))}
          <div style={{textAlign:"center",fontFamily:"'Inter',sans-serif",fontSize:10,
            color:"rgba(var(--ink-rgb),0.2)",padding:"8px 0",letterSpacing:2,animation:"blink 1s step-end infinite"}}>
            SEARCHING LIVE MATCHES & ANALYSING STATS...
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div style={{...S.glassCard,border:"1px solid #DC3B3B44",
          background:"linear-gradient(135deg,#DC3B3B08,transparent)",padding:14}}>
          <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:12,
            color:"#DC3B3B",marginBottom:8}}>✕ FAILED TO LOAD</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,color:"#DC3B3B88",
            lineHeight:1.6,marginBottom:12,wordBreak:"break-word"}}>{String(error)}</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)",
            lineHeight:1.7}}>
            Make sure you have added your ANTHROPIC_API_KEY to Vercel:<br/>
            Vercel Dashboard → Your Project → Settings → Environment Variables<br/>
            Key: ANTHROPIC_API_KEY | Value: sk-ant-...
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && tips.length===0 && (
        <div style={{textAlign:"center",padding:"50px 0"}}>
          <div style={{fontSize:48,marginBottom:16}}>⚽</div>
          <div style={{fontFamily:"'Space Grotesk',sans-serif",fontSize:14,color:preset.color,
            letterSpacing:3,marginBottom:8}}>NO TIPS LOADED</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,color:"rgba(var(--ink-rgb),0.2)",
            lineHeight:1.8,marginBottom:20}}>
            Tap GET TIPS above to fetch<br/>today's AI-analysed goals markets
          </div>
        </div>
      )}

      {/* Filter pills */}
      {tips.length>0 && !loading && (
        <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:6,marginBottom:12,
          scrollbarWidth:"none"}}>
          {FILTERS.map(f=>(
            <button key={f} onClick={()=>setFilter(f)}
              style={{whiteSpace:"nowrap",padding:"5px 12px",borderRadius:20,border:"none",
                cursor:"pointer",fontFamily:"'Inter',sans-serif",fontSize:9,letterSpacing:1,
                background:filter===f?preset.gradient:"rgba(var(--ink-rgb),0.031)",
                color:filter===f?"#000":"rgba(var(--ink-rgb),0.333)",
                boxShadow:filter===f?`0 0 12px ${preset.glow}`:"none",
                transition:"all .2s",flexShrink:0}}>
              {f}
            </button>
          ))}
        </div>
      )}

      {/* Tips count */}
      {tips.length>0 && !loading && (
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)",
          letterSpacing:2,marginBottom:10}}>
          {filtered.length} TIP{filtered.length!==1?"S":""} ·{" "}
          {lastFetch && (() => {
            const d = new Date(tips[0]?.generatedAt||Date.now());
            return today === tips[0]?.match ? "TODAY" : "UPCOMING FIXTURES";
          })()}
          {" "}· {today}
        </div>
      )}

      {/* Tip cards */}
      {!loading && filtered.map((tip, i) => {
        const col  = marketColor(tip.market);
        const rCol = riskColor(tip.risk);
        const isExp= expanded===tip.id;
        const conf = tip.confidence || 70;

        return (
          <button key={tip.id||i} onClick={()=>setExpanded(isExp?null:tip.id)}
            style={{width:"100%",background:"none",border:"none",padding:0,
              cursor:"pointer",marginBottom:10,textAlign:"left",
              animation:`fadeUp ${0.2+i*0.05}s ease`}}>
            <div style={{...S.glassCard,marginBottom:0,padding:"14px",
              border:`1px solid ${col}22`,
              background:`linear-gradient(135deg,${col}06,var(--surface))`,
              transition:"all .25s"}}>

              {/* Top accent */}
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,
                background:`linear-gradient(90deg,transparent,${col}66,transparent)`}}/>

              {/* Header row */}
              <div style={{display:"flex",justifyContent:"space-between",
                alignItems:"flex-start",marginBottom:10}}>
                <div style={{flex:1,paddingRight:8}}>
                  <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,
                    fontSize:11,color:"var(--ink)",letterSpacing:1,marginBottom:3}}>
                    {tip.match}
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <span style={{fontFamily:"'Inter',sans-serif",fontSize:8,
                      color:"rgba(var(--ink-rgb),0.267)"}}>{tip.league}</span>
                    {tip.time&&<span style={{fontFamily:"'Inter',sans-serif",fontSize:8,
                      color:"rgba(var(--ink-rgb),0.2)"}}>· {tip.time}</span>}
                  </div>
                </div>
                {/* Confidence circle */}
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,flexShrink:0}}>
                  <div style={{width:42,height:42,borderRadius:"50%",
                    background:`conic-gradient(${col} ${conf*3.6}deg, rgba(var(--ink-rgb),0.051) 0deg)`,
                    display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
                    <div style={{width:32,height:32,borderRadius:"50%",background:"var(--surface)",
                      display:"flex",alignItems:"center",justifyContent:"center"}}>
                      <span style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,
                        fontSize:9,color:col}}>{conf}</span>
                    </div>
                  </div>
                  <span style={{fontFamily:"'Inter',sans-serif",fontSize:7,color:"rgba(var(--ink-rgb),0.2)"}}>CONF%</span>
                </div>
              </div>

              {/* Pick badge */}
              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,flexWrap:"wrap"}}>
                {tip.confirmed && (
                  <div style={{padding:"4px 10px",borderRadius:20,
                    background:"linear-gradient(135deg,#E08A0033,#FF8F0022)",
                    border:"1px solid #E08A0066",
                    fontFamily:"'Inter',sans-serif",fontSize:8,color:"#E08A00",
                    letterSpacing:1,fontWeight:700}}>
                    🔥 ALL 3 AIs AGREE
                  </div>
                )}
                {!tip.confirmed && tip.multiAI && (
                  <div style={{padding:"4px 10px",borderRadius:20,
                    background:"#2F37D912",border:"1px solid #2F37D944",
                    fontFamily:"'Inter',sans-serif",fontSize:8,color:"#2F37D9",letterSpacing:1}}>
                    ✦ {tip.aiCount} AIs AGREE
                  </div>
                )}
                <div style={{background:`${col}18`,border:`1px solid ${col}44`,
                  borderRadius:8,padding:"6px 12px",
                  fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,
                  fontSize:12,color:col,letterSpacing:1,
                  boxShadow:`0 0 15px ${col}33`}}>
                  {tip.pick}
                </div>
                <div style={{background:`${rCol}12`,border:`1px solid ${rCol}33`,
                  borderRadius:20,padding:"4px 10px",
                  fontFamily:"'Inter',sans-serif",fontSize:8,
                  color:rCol,letterSpacing:1}}>
                  {tip.risk} RISK
                </div>
                {/* Odds display - real or estimated */}
                {(tip.bookmaker_odds || tip.odds_range) && (
                  <div style={{
                    background: tip.real_odds_available ? "#159A5620" : "rgba(var(--ink-rgb),0.031)",
                    border: tip.real_odds_available ? "1px solid #159A5666" : "1px solid rgba(var(--ink-rgb),0.133)",
                    borderRadius:20, padding:"4px 10px",
                    fontFamily:"'Inter',sans-serif", fontSize:8,
                    color: tip.real_odds_available ? "#159A56" : "rgba(var(--ink-rgb),0.333)",
                    letterSpacing:1
                  }}>
                    {tip.real_odds_available
                      ? `✓ ${tip.bookmaker_odds} (Live)`
                      : `~${tip.odds_range}`}
                  </div>
                )}

                {/* Value badge - show for all tips with positive edge */}
                {tip.edge_pct && tip.value > 0 && (
                  <div style={{
                    background:"#E08A0020", border:"1px solid #E08A0066",
                    borderRadius:20, padding:"4px 10px",
                    fontFamily:"'Inter',sans-serif", fontSize:8,
                    color:"#E08A00", letterSpacing:1, fontWeight:700,
                  }}>
                    ⚡ {tip.edge_pct} EDGE
                  </div>
                )}
              </div>

              {/* Market tag + Smart Stake */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.267)"}}>
                  📊 {tip.market}
                </div>
                {bankroll > 0 && (() => {
                  const odds = tip.bookmaker_odds || parseFloat((tip.odds_range||"1.85").split("-")[0]) || 1.85;
                  const stake = calcKellyStake(bankroll, conf, odds);
                  const rating = stakeRating(conf);
                  if(stake <= 0) return null;
                  return (
                    <div style={{
                      background:`${rating.color}18`,
                      border:`1px solid ${rating.color}44`,
                      borderRadius:20, padding:"3px 10px",
                      fontFamily:"'Inter',sans-serif", fontSize:8,
                      color:rating.color, letterSpacing:1,
                    }}>
                      💰 {fmt(stake, plan.currency)}
                    </div>
                  );
                })()}
              </div>

              {/* Confidence bar */}
              <div style={{height:3,background:"rgba(var(--ink-rgb),0.031)",borderRadius:2,marginBottom:10,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${conf}%`,borderRadius:2,
                  background:`linear-gradient(90deg,${col}88,${col})`,
                  boxShadow:`0 0 8px ${col}66`,transition:"width .8s ease"}}/>
              </div>

              {/* Expand arrow */}
              <div style={{textAlign:"center",fontFamily:"'Inter',sans-serif",
                fontSize:9,color:"rgba(var(--ink-rgb),0.133)",letterSpacing:2}}>
                {isExp?"▲ HIDE ANALYSIS":"▼ SEE ANALYSIS"}
              </div>

              {/* Expanded detail */}
              {isExp && (
                <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(var(--ink-rgb),0.031)",
                  animation:"fadeUp .2s ease"}}>
                  {/* Reasoning */}
                  <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,
                    color:"rgba(var(--ink-rgb),0.467)",lineHeight:1.7,marginBottom:12}}>
                    {tip.reasoning}
                  </div>

                  {/* Key stats */}
                  {tip.key_stats?.length>0 && (
                    <div>
                      <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,
                        color:col+"88",letterSpacing:2,marginBottom:8}}>KEY STATS</div>
                      {tip.key_stats.map((s,j)=>(
                        <div key={j} style={{display:"flex",gap:8,alignItems:"flex-start",
                          marginBottom:6}}>
                          <div style={{width:4,height:4,borderRadius:"50%",
                            background:col,marginTop:5,flexShrink:0}}/>
                          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,
                            color:"rgba(var(--ink-rgb),0.333)",lineHeight:1.5}}>{s}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Value Analysis - shown when real odds available */}
                  {tip.real_odds_available && (
                    <div style={{marginTop:10,background:"#E08A0008",borderRadius:8,
                      padding:"10px 12px",border:"1px solid #E08A0033"}}>
                      <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,
                        color:"#E08A0088",letterSpacing:2,marginBottom:8}}>VALUE ANALYSIS</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                        {[
                          ["REAL ODDS", tip.bookmaker_odds, "#159A56"],
                          ["OUR PROB", tip.predicted_probability ? `${(tip.predicted_probability*100).toFixed(0)}%` : "N/A", "#2F37D9"],
                          ["EDGE", tip.edge_pct || "N/A", tip.is_value_bet ? "#E08A00" : "#DC3B3B"],
                          ["STAKE", tip.recommended_stake_pct ? `${tip.recommended_stake_pct}% bankroll` : "Standard", "#7C83F6"],
                        ].map(([l,v,c])=>(
                          <div key={l} style={{background:"rgba(var(--ink-rgb),0.016)",borderRadius:6,padding:"6px 8px"}}>
                            <div style={{fontFamily:"'Inter',sans-serif",fontSize:7,color:"rgba(var(--ink-rgb),0.2)",letterSpacing:2}}>{l}</div>
                            <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,color:c,marginTop:2}}>{v}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,
                        color:"rgba(var(--ink-rgb),0.2)",marginTop:8}}>
                        Source: {tip.odds_source || "The Odds API"}
                      </div>
                    </div>
                  )}

                  {/* Smart Stake Card */}
                  {bankroll > 0 && (() => {
                    const odds = tip.bookmaker_odds || parseFloat((tip.odds_range||"1.85").split("-")[0]) || 1.85;
                    const stake = calcKellyStake(bankroll, conf, odds);
                    const prob = confidenceToProb(conf);
                    const val = (prob * odds) - 1;
                    const rating = stakeRating(conf);
                    return (
                      <div style={{marginTop:10,background:`${rating.color}10`,
                        border:`1px solid ${rating.color}33`,borderRadius:8,padding:"10px 12px"}}>
                        <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,
                          color:rating.color,letterSpacing:2,marginBottom:8}}>
                          SMART STAKE (KELLY CRITERION)
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:6}}>
                          {[
                            ["STAKE", fmt(stake,plan.currency), rating.color],
                            ["USD", `$${(stake/TSH_TO_USD).toFixed(2)}`, rating.color],
                            ["EDGE", `${val>=0?"+":""}${(val*100).toFixed(1)}%`, val>=0?"#159A56":"#DC3B3B"],
                          ].map(([l,v,c])=>(
                            <div key={l} style={{background:"rgba(var(--ink-rgb),0.024)",borderRadius:6,padding:"6px 8px",textAlign:"center"}}>
                              <div style={{fontFamily:"'Inter',sans-serif",fontSize:7,color:"rgba(var(--ink-rgb),0.2)",letterSpacing:1,marginBottom:3}}>{l}</div>
                              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:10,color:c}}>{v}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,
                          color:rating.color,fontWeight:700}}>
                          {rating.label} · {rating.pct} of {fmt(bankroll,plan.currency)} bankroll
                        </div>
                      </div>
                    );
                  })()}

                  {/* AI Sources */}
                  {tip.ais && tip.ais.length > 0 && (
                    <div style={{marginTop:10,background:"rgba(var(--ink-rgb),0.016)",borderRadius:8,padding:"8px 10px",border:"1px solid rgba(var(--ink-rgb),0.031)"}}>
                      <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.2)",letterSpacing:2,marginBottom:6}}>CONFIRMED BY</div>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        {tip.ais.map(ai=>(
                          <div key={ai} style={{padding:"3px 10px",borderRadius:20,
                            background:ai==="Claude"?"#2F37D912":ai==="Gemini"?"#159A5612":"#7C83F612",
                            border:`1px solid ${ai==="Claude"?"#2F37D9":ai==="Gemini"?"#159A56":"#7C83F6"}44`,
                            fontFamily:"'Inter',sans-serif",fontSize:9,
                            color:ai==="Claude"?"#2F37D9":ai==="Gemini"?"#159A56":"#7C83F6"}}>
                            ✓ {ai}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Match to plan */}
                  <div style={{marginTop:12,background:"rgba(var(--ink-rgb),0.016)",borderRadius:8,
                    padding:"8px 10px",border:"1px solid rgba(var(--ink-rgb),0.031)"}}>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,
                      color:"rgba(var(--ink-rgb),0.2)",letterSpacing:2,marginBottom:4}}>PLAN MATCH</div>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.333)",lineHeight:1.6}}>
                      {(() => {
                        const o = tip.bookmaker_odds || parseFloat((tip.odds_range||"").split("-")[0]);
                        if(o >= 1.05 && o <= 1.15) return "✦ Fits Plan ALPHA (×1.10)";
                        if(o >= 1.15 && o <= 1.25) return "✦ Fits Plan BETA (×1.20)";
                        if(o >= 1.40 && o <= 1.60) return "✦ Fits Plan GAMMA (×1.50)";
                        return "✦ Check odds with your bookmaker";
                      })()}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </button>
        );
      })}

      {/* Footer note */}
      {tips.length>0 && !loading && (
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.094)",
          textAlign:"center",padding:"8px 0 4px",lineHeight:1.7,letterSpacing:1}}>
          TIPS REFRESH EVERY 30 MIN · FOR RESEARCH PURPOSES ONLY<br/>
          NEVER BET MORE THAN YOUR DAILY ROLLOVER STAKE
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ GLOBAL CSS ════════════════════════════ */
function BottomNav({view, tab, go}){
  const items=[
    {k:"plans",   label:"Plans",   on:view==="home",
      d:(<><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></>)},
    {k:"predict", label:"Predict", on:view==="predict",
      d:(<><path d="M3 17l5-6 4 4 6-8"/><path d="M19 7v4h-4"/></>)},
    {k:"results", label:"Results", on:view==="plan"&&tab==="RESULTS",
      d:(<><path d="M4 6h11M4 12h11M4 18h7"/><path d="M19 7l2 2-2 2"/></>)},
    {k:"archive", label:"Archive", on:view==="plan"&&tab==="ARCHIVE",
      d:(<><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/></>)},
    {k:"stake",   label:"Stake",   on:view==="plan"&&tab==="TODAY",
      d:(<><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M8 15h2M14 11v4"/></>)},
  ];
  return (
    <nav style={{position:"fixed",bottom:12,left:0,right:0,margin:"0 auto",width:"calc(100% - 24px)",maxWidth:406,
      height:70,background:"var(--navbg)",backdropFilter:"saturate(160%) blur(14px)",WebkitBackdropFilter:"saturate(160%) blur(14px)",
      border:"1px solid var(--hairline)",borderRadius:24,display:"flex",padding:"0 6px",
      boxShadow:"0 6px 22px rgba(20,20,35,.12)",zIndex:100}}>
      {items.map(it=>(
        <button key={it.k} onClick={()=>go(it.k)}
          style={{flex:1,background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",
            alignItems:"center",justifyContent:"center",gap:4,paddingTop:3,
            color:it.on?"var(--cobalt)":"var(--ink3)",fontFamily:"'Inter',sans-serif",fontSize:9.5,fontWeight:600,letterSpacing:0.2}}>
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke={it.on?"var(--cobalt)":"var(--ink3)"} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{it.d}</svg>
          {it.label}
        </button>
      ))}
    </nav>
  );
}

function GlobalCSS(){return(<style>{`
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap');
  :root{
    --paper:#F4F4F1; --surface:#FFFFFF; --hairline:#E8E8E3;
    --ink-rgb:24,25,29; --ink:#18191D; --ink2:#5C5D64; --ink3:#9B9CA3; --sheen-rgb:24,25,29;
    --cobalt:#2F37D9; --cobalt-soft:#EDEEFB; --cobalt-ink:#2A31C2;
    --amber:#E08A00; --amber-soft:#FBF1DE;
    --win:#159A56; --win-soft:#E4F4EC; --loss:#DC3B3B; --loss-soft:#FBE9E9;
    --field:#FBFBF9; --seg-bg:#EAEAE5; --track2:#F1F1EC;
    --navbg:rgba(255,255,255,.86); --shadow:0 1px 2px rgba(20,20,35,.05),0 8px 26px rgba(20,20,35,.045);
  }
  :root[data-theme="dark"]{
    --paper:#0F1014; --surface:#181A20; --hairline:#272A31;
    --ink-rgb:241,242,239; --ink:#F1F2EF; --ink2:#A0A2AA; --ink3:#6E7079; --sheen-rgb:255,255,255;
    --cobalt:#6B72F0; --cobalt-soft:#1E2140; --cobalt-ink:#9197FF;
    --amber:#F2A52B; --amber-soft:#3A2C12;
    --win:#34C77B; --win-soft:#102A1D; --loss:#FF5D5D; --loss-soft:#321818;
    --field:#1E2127; --seg-bg:#23262D; --track2:#23262D;
    --navbg:rgba(20,22,27,.9); --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.5);
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--paper);color:var(--ink);-webkit-tap-highlight-color:transparent;overflow-x:hidden;transition:background-color .25s ease,color .25s ease;}
  ::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-track{background:var(--paper);}
  ::-webkit-scrollbar-thumb{background:#2F37D922;border-radius:2px;}
  @keyframes fadeUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes logoReveal{0%{opacity:0;letter-spacing:20px}100%{opacity:1;letter-spacing:6px}}
  @keyframes barFill{0%{width:0}100%{width:100%}}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
  @keyframes shake{0%,100%{transform:translateX(0)}15%{transform:translateX(-8px)}30%{transform:translateX(8px)}45%{transform:translateX(-6px)}60%{transform:translateX(6px)}75%{transform:translateX(-4px)}90%{transform:translateX(4px)}}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
  @keyframes pulse-dot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
  button:active{transform:scale(.97)!important;}input:focus{outline:none;}
`}</style>);}

/* ═══════════════════ STYLES ════════════════════════════════ */
const S={
  root:{background:"var(--paper)",minHeight:"100vh",maxWidth:430,margin:"0 auto",position:"relative"},
  screen:{padding:"0 16px 112px",paddingTop:16,position:"relative",zIndex:1},
  splash:{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",position:"relative",zIndex:1},
  splashLogo:{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:40,color:"#2F37D9",
    letterSpacing:6,textShadow:"0 0 40px rgba(47,55,217,0.8),0 0 80px rgba(47,55,217,0.4)",
    animation:"logoReveal 1.2s ease forwards"},
  splashSub:{fontFamily:"'Inter',sans-serif",fontSize:10,color:"rgba(var(--ink-rgb),0.2)",letterSpacing:4,marginTop:8},
  splashBar:{height:2,background:"rgba(var(--ink-rgb),0.031)",borderRadius:2,marginTop:24,overflow:"hidden"},
  splashFill:{height:"100%",background:"linear-gradient(90deg,#2F37D9,#7C83F6)",borderRadius:2,animation:"barFill 1.6s ease forwards"},
  homeHeader:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"20px 0 16px",borderBottom:"1px solid rgba(var(--ink-rgb),0.031)",marginBottom:14},
  homeTitle:{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:30,color:"#2F37D9",letterSpacing:4,textShadow:"0 0 30px rgba(47,55,217,0.6)",lineHeight:1},
  homeSub:{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.2)",letterSpacing:3,marginTop:4},
  vBadge:{fontFamily:"'Inter',sans-serif",fontSize:8,color:"#2F37D988",border:"1px solid #2F37D933",borderRadius:20,padding:"3px 10px",letterSpacing:2},
  headerBtn:{background:"rgba(var(--ink-rgb),0.031)",border:"1px solid rgba(var(--ink-rgb),0.067)",borderRadius:8,padding:"5px 9px",cursor:"pointer",fontSize:14,color:"var(--ink)"},
  noticeBar:{background:"linear-gradient(135deg,#2F37D90a,transparent)",border:"1px solid #2F37D918",borderRadius:10,padding:"8px 12px",display:"flex",alignItems:"center",gap:8},
  combinedCard:{background:"linear-gradient(135deg,#2F37D908,rgba(var(--ink-rgb),0.008))",border:"1px solid #2F37D922",borderRadius:16,padding:"14px 16px",marginBottom:18,boxShadow:"0 0 30px rgba(47,55,217,0.05)"},
  combinedVal:{fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:20,color:"#2F37D9",textShadow:"0 0 20px rgba(47,55,217,0.5)",marginTop:4},
  planCard:{background:"var(--surface)",borderRadius:16,padding:"16px 14px",position:"relative",overflow:"hidden",transition:"all .25s ease",animation:"float 4s ease-in-out infinite"},
  glassCard:{background:"linear-gradient(135deg,var(--surface),var(--surface))",border:"1px solid rgba(var(--ink-rgb),0.051)",borderRadius:14,padding:14,marginBottom:10,position:"relative",overflow:"hidden"},
  backBtn:{background:"none",border:"none",color:"#2F37D988",fontFamily:"'Inter',sans-serif",fontSize:11,cursor:"pointer",padding:"4px 0",letterSpacing:2},
  winBtn:{background:"linear-gradient(135deg,#159A56,#159A56)",border:"none",borderRadius:14,color:"#001a00",padding:"16px 8px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2,fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:12,transition:"all .2s",position:"relative",overflow:"hidden"},
  lossBtn:{background:"linear-gradient(135deg,#DC3B3B,#B0302F)",border:"none",borderRadius:14,color:"#fff0f0",padding:"16px 8px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2,fontFamily:"'Space Grotesk',sans-serif",fontWeight:900,fontSize:12,transition:"all .2s",position:"relative",overflow:"hidden"},
  input:{width:"100%",background:"rgba(var(--ink-rgb),0.02)",border:"1px solid rgba(var(--ink-rgb),0.082)",borderRadius:10,padding:"14px",color:"var(--ink)",fontFamily:"'Inter',sans-serif",fontSize:13},
  toast:{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",padding:"10px 20px",borderRadius:30,fontFamily:"'Inter',sans-serif",fontSize:10,fontWeight:700,zIndex:300,whiteSpace:"nowrap",maxWidth:"92vw",overflow:"hidden",textOverflow:"ellipsis",letterSpacing:1,backdropFilter:"blur(10px)"},
  syncDot:{position:"fixed",top:13,right:56,zIndex:400,display:"flex",alignItems:"center",gap:6},
  modal:{position:"fixed",inset:0,zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(3,5,8,0.85)",backdropFilter:"blur(12px)",padding:24},
  modalBox:{background:"linear-gradient(135deg,var(--surface),var(--surface))",border:"1px solid #2F37D922",borderRadius:18,padding:24,width:"100%",maxWidth:380},
  actionBtn:{padding:"12px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:"'Inter',sans-serif",fontSize:11,fontWeight:700,letterSpacing:1},
};


/* One pending tip awaiting its result (pulled from the TIPS tab) */
/* ═══════════════════ ARCHIVE TAB ════════════════════════════ */
function ArchiveTab({plan, st, preset}){
  const [q, setQ] = useState("");
  const archive = (st.tipArchive||[]);
  const wins = archive.filter(a=>a.result==="WIN").length;
  const losses = archive.filter(a=>a.result==="LOSS").length;
  const graded = wins+losses;
  const acc = graded ? Math.round(wins/graded*100) : null;
  const staked = archive.filter(a=>a.stake>0);
  const totalStake = staked.reduce((s,a)=>s+(a.stake||0),0);
  const totalProfit = archive.reduce((s,a)=>s+(a.profitTSH||0),0);
  const roi = totalStake>0 ? (totalProfit/totalStake*100) : null;

  const breakdown = (keyFn)=>{
    const m={};
    for(const a of archive){
      if(a.result!=="WIN" && a.result!=="LOSS") continue;
      const k=(keyFn(a)||"Other").trim()||"Other";
      if(!m[k]) m[k]={w:0,l:0};
      m[k][a.result==="WIN"?"w":"l"]++;
    }
    return Object.entries(m).map(([k,v])=>({k,w:v.w,l:v.l,n:v.w+v.l,acc:Math.round(v.w/(v.w+v.l)*100)}))
      .sort((a,b)=>b.n-a.n);
  };
  const marketBreak = breakdown(a=> (a.market||"").replace(/[0-9.]+/g,"").replace(/\s+/g," ").trim() || a.market);
  const leagueBreak = breakdown(a=> a.league);

  const ql=q.toLowerCase();
  const hist = archive.slice().sort((a,b)=>(b.archivedAt||0)-(a.archivedAt||0))
    .filter(a=> !ql || (`${a.match} ${a.league} ${a.market} ${a.pick}`).toLowerCase().includes(ql));

  const tk={fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.333)",letterSpacing:2,marginBottom:4};
  const tv={fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:18,color:"var(--ink)"};
  const accCol=(p)=> p>=55?"#159A56":p>=45?"#E08A00":"#DC3B3B";

  if(archive.length===0){
    return (
      <div style={{...S.glassCard, textAlign:"center", padding:"30px 18px"}}>
        <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:14,color:"var(--ink)",marginBottom:8}}>ARCHIVE EMPTY</div>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:11,color:"rgba(var(--ink-rgb),0.4)",lineHeight:1.7}}>
          Finished tips move here automatically when you pull new tips, or when you tap
          {" \u201cClear & Archive\u201d"} in Results. Your full history and accuracy breakdowns build up here for analysis.
        </div>
      </div>
    );
  }

  const BreakBlock = ({title, rows})=> (
    <div style={{...S.glassCard, marginBottom:12}}>
      <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:preset.color,letterSpacing:2,marginBottom:12}}>{title}</div>
      {rows.slice(0,12).map((r,i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",
          borderBottom:i<Math.min(rows.length,12)-1?"1px solid rgba(var(--ink-rgb),0.051)":"none"}}>
          <div style={{flex:1,minWidth:0,fontFamily:"'Inter',sans-serif",fontSize:10,color:"rgba(var(--ink-rgb),0.8)",
            whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.k}</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"rgba(var(--ink-rgb),0.333)"}}>{r.w}W-{r.l}L</div>
          <div style={{width:42,textAlign:"right",fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:12,color:accCol(r.acc)}}>{r.acc}%</div>
        </div>
      ))}
    </div>
  );

  return (
    <div>
      {/* lifetime summary */}
      <div style={S.glassCard}>
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:preset.color,
          letterSpacing:3,marginBottom:14}}>ARCHIVE · LIFETIME</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          <div style={{...S.glassCard,margin:0,padding:"12px"}}>
            <div style={tk}>TIP ACCURACY</div>
            <div style={{...tv,color:acc!=null?accCol(acc):"var(--ink)"}}>{acc!=null?acc+"%":"—"}</div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.267)",marginTop:3}}>{wins}W · {losses}L</div>
          </div>
          <div style={{...S.glassCard,margin:0,padding:"12px"}}>
            <div style={tk}>TIPS ARCHIVED</div>
            <div style={{...tv,color:preset.color}}>{archive.length}</div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.267)",marginTop:3}}>{graded} graded</div>
          </div>
          <div style={{...S.glassCard,margin:0,padding:"12px"}}>
            <div style={tk}>P&L (STAKED)</div>
            <div style={{...tv,color:totalProfit>=0?"#159A56":"#DC3B3B"}}>{totalProfit>=0?"+":""}{fmt(Math.round(totalProfit), plan.currency)}</div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.267)",marginTop:3}}>{staked.length} staked</div>
          </div>
          <div style={{...S.glassCard,margin:0,padding:"12px"}}>
            <div style={tk}>ROI</div>
            <div style={{...tv,color:roi==null?"var(--ink)":roi>=0?"#159A56":"#DC3B3B"}}>{roi==null?"—":(roi>=0?"+":"")+roi.toFixed(1)+"%"}</div>
            <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.267)",marginTop:3}}>on {fmt(Math.round(totalStake), plan.currency)}</div>
          </div>
        </div>
        <button onClick={()=>exportArchiveCSV(archive, plan)}
          style={{width:"100%",background:`linear-gradient(135deg,${preset.color}22,${preset.color}11)`,
            border:`1px solid ${preset.color}55`,borderRadius:10,color:preset.color,
            fontFamily:"'Inter',sans-serif",fontWeight:700,fontSize:11,padding:"11px",cursor:"pointer",letterSpacing:1}}>
          {"\u2b07 EXPORT CSV FOR ANALYSIS"}
        </button>
      </div>

      {marketBreak.length>0 && <BreakBlock title="ACCURACY BY MARKET" rows={marketBreak}/>}
      {leagueBreak.length>0 && <BreakBlock title="ACCURACY BY LEAGUE" rows={leagueBreak}/>}

      {/* history + search */}
      <div style={S.glassCard}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:preset.color,letterSpacing:2}}>HISTORY · {archive.length}</div>
        </div>
        <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search match, league, market…"
          style={{...S.input,marginBottom:12,fontSize:12,padding:"9px 11px"}}/>
        {hist.length===0 && <div style={{fontFamily:"'Inter',sans-serif",fontSize:10,color:"rgba(var(--ink-rgb),0.267)",textAlign:"center",padding:"14px 0"}}>No matches.</div>}
        {hist.slice(0,200).map((a,i)=>{
          const col = a.result==="WIN"?"#159A56":a.result==="LOSS"?"#DC3B3B":"rgba(var(--ink-rgb),0.333)";
          return (
            <div key={a.id||i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",
              borderBottom:i<Math.min(hist.length,200)-1?"1px solid rgba(var(--ink-rgb),0.051)":"none"}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:10.5,color:"var(--ink)",
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{a.match}</div>
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:8.5,color:"rgba(var(--ink-rgb),0.333)",marginTop:3,
                  whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  {a.pick}{a.score?` · ${a.score}`:""}{a.date?` · ${a.date}`:""}
                </div>
              </div>
              {a.stake>0 && (
                <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:a.profitTSH>=0?"#159A56":"#DC3B3B",flexShrink:0}}>
                  {a.profitTSH>=0?"+":""}{fmt(Math.round(a.profitTSH), plan.currency)}
                </div>
              )}
              <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,color:col,flexShrink:0,width:16,textAlign:"center"}}>
                {a.result==="WIN"?"\u2713":a.result==="LOSS"?"\u2715":"\u00b7"}
              </div>
            </div>
          );
        })}
        {hist.length>200 && <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.267)",textAlign:"center",marginTop:10}}>Showing 200 of {hist.length} — export CSV for the full set.</div>}
      </div>
    </div>
  );
}

function PendingTipRow({ tip, preset, onSettle, onRemove }){
  const [stake, setStake] = useState("");
  const s = parseFloat(stake);
  const valid = isFinite(s) && s > 0;
  const odds = tip.odds || 1.85;
  const auto = tip.autoResult; // "WIN" | "LOSS" | undefined
  const autoCol = auto==="WIN" ? "#159A56" : "#DC3B3B";
  return (
    <div style={{background: auto?`${autoCol}0c`:"rgba(var(--ink-rgb),0.02)",
      border:`1px solid ${auto?autoCol+"44":"rgba(var(--ink-rgb),0.063)"}`,borderRadius:10,
      padding:"11px 12px",marginBottom:8}}>
      {auto && (
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,
          padding:"7px 10px",borderRadius:8,background:`${autoCol}14`,border:`1px solid ${autoCol}33`}}>
          <span style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,color:autoCol}}>
            {auto==="WIN"?"✓ TIP WON":"✕ TIP LOST"}{tip.autoScore?` · ${tip.autoScore}`:""}
          </span>
          <span style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.4)",marginLeft:"auto"}}>auto-graded</span>
        </div>
      )}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,color:"var(--ink)",
            whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{tip.match}</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:8,color:"rgba(var(--ink-rgb),0.267)",marginTop:3}}>
            {tip.league}{tip.market?` · ${tip.market}`:""}
          </div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:9,color:"#2F37D9cc",marginTop:4}}>
            {tip.pick}{tip.odds?` @ ${tip.odds}`:""}
          </div>
        </div>
        <button onClick={()=>onRemove(tip.id)} title="Didn't bet this"
          style={{background:"none",border:"1px solid rgba(var(--ink-rgb),0.133)",borderRadius:8,color:"rgba(var(--ink-rgb),0.333)",
            fontFamily:"'Inter',sans-serif",fontSize:12,cursor:"pointer",padding:"2px 9px",flexShrink:0}}>✕</button>
      </div>
      <div style={{display:"flex",gap:8,marginTop:10,alignItems:"center"}}>
        <input type="number" inputMode="decimal" placeholder={`Stake (${tip.currency||"TSH"})`}
          value={stake} onChange={e=>setStake(e.target.value)}
          style={{...S.input,flex:1,padding:"9px 11px",fontSize:12,border:"1px solid rgba(var(--ink-rgb),0.133)"}}/>
        <button disabled={!valid} onClick={()=>onSettle(tip.id,"WIN",stake)}
          style={{padding:"9px 14px",borderRadius:9,border:"none",cursor:valid?"pointer":"not-allowed",
            fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,
            background:valid?"linear-gradient(135deg,#159A56,#159A56)":"rgba(var(--ink-rgb),0.031)",
            color:valid?"#001a00":"rgba(var(--ink-rgb),0.2)",
            boxShadow: auto==="WIN" ? "0 0 0 2px #159A5699" : "none"}}>WIN</button>
        <button disabled={!valid} onClick={()=>onSettle(tip.id,"LOSS",stake)}
          style={{padding:"9px 14px",borderRadius:9,border:"none",cursor:valid?"pointer":"not-allowed",
            fontFamily:"'Space Grotesk',sans-serif",fontWeight:700,fontSize:11,
            background:valid?"linear-gradient(135deg,#DC3B3B,#B0302F)":"rgba(var(--ink-rgb),0.031)",
            color:valid?"var(--ink)":"rgba(var(--ink-rgb),0.2)",
            boxShadow: auto==="LOSS" ? "0 0 0 2px #DC3B3B99" : "none"}}>LOSS</button>
      </div>
      {auto && !valid && (
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:8.5,color:"rgba(var(--ink-rgb),0.4)",marginTop:8}}>
          Result is already in your accuracy. Add your stake to log the P&L too.
        </div>
      )}
      {valid && (
        <div style={{fontFamily:"'Inter',sans-serif",fontSize:8.5,color:"rgba(var(--ink-rgb),0.267)",marginTop:8}}>
          Win → +{fmt(s*(odds-1), tip.currency)} · Loss → −{fmt(s, tip.currency)}
        </div>
      )}
    </div>
  );
}
