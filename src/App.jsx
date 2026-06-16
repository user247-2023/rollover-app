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
  if(streak>=10||r<0.05) return{label:"CRITICAL",short:"CRIT",color:"#FF1744",glow:"rgba(255,23,68,0.4)",bar:1};
  if(streak>=7 ||r<0.15) return{label:"HIGH RISK",short:"HIGH",color:"#FF6D00",glow:"rgba(255,109,0,0.35)",bar:0.75};
  if(streak>=4 ||r<0.30) return{label:"MODERATE", short:"MOD", color:"#FFD600",glow:"rgba(255,214,0,0.3)",bar:0.5};
  return                       {label:"SAFE ZONE",short:"SAFE",color:"#00E5FF",glow:"rgba(0,229,255,0.3)",bar:0.25};
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
  if(confidence >= 85) return { label:"STRONG BET", color:"#69FF47", pct:"1.5-2%" };
  if(confidence >= 75) return { label:"GOOD BET",   color:"#00E5FF", pct:"1-1.5%" };
  if(confidence >= 65) return { label:"MODERATE",   color:"#FFD600", pct:"0.5-1%" };
  return                      { label:"SKIP",        color:"#FF1744", pct:"0%" };
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
  {id:"alpha",label:"ALPHA",color:"#00E5FF",glow:"rgba(0,229,255,0.5)",gradient:"linear-gradient(135deg,#00E5FF,#0091EA)",odds:1.10,wdPct:0.25,emoji:"α"},
  {id:"beta", label:"BETA", color:"#69FF47",glow:"rgba(105,255,71,0.5)",gradient:"linear-gradient(135deg,#69FF47,#00C853)",odds:1.20,wdPct:0.25,emoji:"β"},
  {id:"gamma",label:"GAMMA",color:"#E040FB",glow:"rgba(224,64,251,0.5)",gradient:"linear-gradient(135deg,#E040FB,#AA00FF)",odds:1.50,wdPct:0.30,emoji:"γ"},
];
const TABS = ["TODAY","TIPS","RESULTS","HISTORY","RESERVE","SETTINGS"];

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
function GridBG({color="#00E5FF"}) {
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
    const existing = st.tipResults || [];
    const have = new Set(existing.map(tipKeyOf));
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
        id: Math.random().toString(36).substr(2,8),
        date: new Date().toISOString().split("T")[0], timestamp: Date.now(),
      });
    }
    if(additions.length===0){ showToast("All tips already tracked", "info"); return; }
    const ns = {...st, tipResults:[...existing, ...additions]};
    await persist({...allPlans, [active]:{plan, state:ns}});
    showToast(`✦ Tracking ${additions.length} tip${additions.length>1?"s":""} → Results`, "win");
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

  const preset = PRESETS.find(p=>p.id===active) || PRESETS[0];

  return (
    <div style={{...S.root, animation:shaking?"shake 0.4s ease":"none"}}>
      <GlobalCSS/>
      <GridBG color={view==="plan" ? preset.color : "#00E5FF"}/>

      {burst && <ParticleBurst active color={burst.color} onDone={()=>setBurst(null)}/>}

      {/* Sync indicator */}
      {syncing && (
        <div style={S.syncDot}>
          <div style={{width:6,height:6,borderRadius:"50%",background:"#00E5FF",animation:"pulse-dot 1s ease infinite"}}/>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#00E5FF88",letterSpacing:2}}>SYNCING</span>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{...S.toast,
          background:toast.type==="win"?"linear-gradient(135deg,#00E5FF18,#00E5FF08)":
                     toast.type==="loss"?"linear-gradient(135deg,#FF174418,#FF174408)":
                     "linear-gradient(135deg,#FFD60018,#FFD60008)",
          border:`1px solid ${toast.type==="win"?"#00E5FF":toast.type==="loss"?"#FF1744":"#FFD600"}55`,
          color:toast.type==="win"?"#00E5FF":toast.type==="loss"?"#FF1744":"#FFD600",
          boxShadow:`0 0 30px ${toast.type==="win"?"#00E5FF":toast.type==="loss"?"#FF1744":"#FFD600"}33`}}>
          {toast.msg}
        </div>
      )}

      {/* Save Code Modal */}
      {showCode && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:14,color:"#00E5FF",letterSpacing:3,marginBottom:4}}>
              YOUR SAVE CODE
            </div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44",marginBottom:16,lineHeight:1.6}}>
              Write this code down. Use it to restore your data on any device or browser.
            </div>
            <div style={{background:"#00E5FF0d",border:"1px solid #00E5FF44",borderRadius:10,
              padding:"14px",textAlign:"center",marginBottom:16}}>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:16,
                color:"#00E5FF",letterSpacing:3,textShadow:"0 0 20px rgba(0,229,255,0.5)",
                wordBreak:"break-all"}}>
                {deviceId}
              </div>
            </div>
            <button onClick={()=>{navigator.clipboard?.writeText(deviceId);showToast("Code copied!","win");}}
              style={{...S.actionBtn,background:"linear-gradient(135deg,#00E5FF22,#00E5FF11)",
                border:"1px solid #00E5FF44",color:"#00E5FF",width:"100%",marginBottom:10}}>
              📋 COPY CODE
            </button>
            <button onClick={()=>setShowCode(false)}
              style={{...S.actionBtn,background:"transparent",border:"1px solid #ffffff11",
                color:"#ffffff44",width:"100%"}}>
              CLOSE
            </button>
          </div>
        </div>
      )}

      {/* Restore Modal */}
      {restoreMode && (
        <div style={S.modal}>
          <div style={S.modalBox}>
            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:14,color:"#FFD600",letterSpacing:3,marginBottom:4}}>
              RESTORE DATA
            </div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44",marginBottom:16,lineHeight:1.6}}>
              Enter your Save Code to load your data on this device.
            </div>
            <input
              value={restoreInput}
              onChange={e=>setRI(e.target.value.toUpperCase())}
              placeholder="e.g. RO-ABC123DEF-XYZ12"
              style={{...S.input,border:"1px solid #FFD60044",marginBottom:12,
                boxShadow:"0 0 20px rgba(255,214,0,0.08)"}}
            />
            <button onClick={handleRestore}
              style={{...S.actionBtn,background:"linear-gradient(135deg,#FFD600,#FF8F00)",
                color:"#000",fontWeight:700,width:"100%",marginBottom:10}}>
              🔓 RESTORE MY DATA
            </button>
            <button onClick={()=>setRM(false)}
              style={{...S.actionBtn,background:"transparent",border:"1px solid #ffffff11",
                color:"#ffffff44",width:"100%"}}>
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
          onTrack={trackTips} onSettle={settleTip} onRemove={removeTip}/>
      )}
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
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ffffff22",
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
      <div style={S.homeHeader}>
        <div>
          <div style={S.homeTitle}>ROLLOVER</div>
          <div style={S.homeSub}>CLOUD-SYNCED TRACKER</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:6,alignItems:"flex-end"}}>
          <div style={S.vBadge}>☁ CLOUD SAVE</div>
          <div style={{display:"flex",gap:6}}>
            <button onClick={onShowCode} style={S.headerBtn} title="Your Save Code">🔑</button>
            <button onClick={onRestore}  style={S.headerBtn} title="Restore Data">📲</button>
          </div>
        </div>
      </div>

      {/* Cloud save notice */}
      <div style={{...S.noticeBar,marginBottom:14}}>
        <span style={{fontSize:14}}>☁</span>
        <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#00E5FF88",letterSpacing:1}}>
          Data saved to cloud. Tap 🔑 to get your Save Code for any device.
        </span>
      </div>

      {/* Combined value */}
      {vals.length>0 && (
        <div style={S.combinedCard}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",letterSpacing:3}}>COMBINED PORTFOLIO</div>
          <div style={S.combinedVal}>{fmt(animTotal, cur)}</div>
          <div style={{display:"flex",gap:20,marginTop:10}}>
            {[["ACTIVE",vals.length+"/3","#FFD600"],["BETS",allHist.length,"#00E5FF"],["WIN RATE",wr,"#69FF47"]].map(([l,v,col],i)=>(
              <div key={i}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff22",letterSpacing:2}}>{l}</div>
                <div style={{fontFamily:"'Orbitron',monospace",fontSize:15,color:col,marginTop:2,fontWeight:700}}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Combined Results Summary */}
      {vals.length>0 && (() => {
        const allTips = vals.flatMap(({state:st})=>st.tipResults||[]);
        if(allTips.length===0) return null;
        const totalProfit = allTips.reduce((s,r)=>s+r.profitTSH,0);
        const totalStaked = allTips.reduce((s,r)=>s+r.stake,0);
        const tipWins = allTips.filter(r=>r.result==="WIN").length;
        const tipRoi = totalStaked>0?(totalProfit/totalStaked*100).toFixed(1):"0";
        const profitCol = totalProfit>=0?"#69FF47":"#FF1744";
        return (
          <div style={{...S.glassCard,border:"1px solid #FFD60033",
            background:"linear-gradient(135deg,#FFD60008,transparent)",marginBottom:14}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#FFD60088",
              letterSpacing:3,marginBottom:10}}>TIPS RESULTS SUMMARY</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
              {[
                ["BETS",allTips.length,"#00E5FF"],
                ["WINS",tipWins,"#69FF47"],
                ["ROI",(parseFloat(tipRoi)>=0?"+":"")+tipRoi+"%",profitCol],
                ["P&L",`${totalProfit>=0?"+":""}$${Math.abs(totalProfit/TSH_TO_USD).toFixed(0)}`,profitCol],
              ].map(([l,v,col])=>(
                <div key={l} style={{textAlign:"center"}}>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:7,color:"#ffffff33",letterSpacing:1}}>{l}</div>
                  <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:12,color:col,marginTop:3}}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <button onClick={onPredict} style={{width:"100%",background:"none",border:"none",padding:0,
        cursor:"pointer",marginBottom:14,textAlign:"left",animation:"fadeUp 0.45s ease"}}>
        <div style={{background:"linear-gradient(135deg,#00E5FF14,transparent)",border:"1px solid #00E5FF33",
          borderRadius:16,padding:16,display:"flex",alignItems:"center",justifyContent:"space-between",
          boxShadow:"0 0 30px rgba(0,229,255,0.06)"}}>
          <div>
            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:14,color:"#00E5FF",letterSpacing:1}}>⚽ MATCH PREDICTIONS</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff55",letterSpacing:1,marginTop:4}}>
              Win %, goals &amp; value · 18 leagues + World Cup
            </div>
          </div>
          <div style={{fontFamily:"'Orbitron',monospace",fontSize:20,color:"#00E5FF"}}>→</div>
        </div>
      </button>

      <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff22",letterSpacing:3,marginBottom:14,paddingLeft:2}}>
        SELECT PLAN
      </div>

      {PRESETS.map((p,i) => {
        const exists = !!allPlans[p.id];
        const d=allPlans[p.id]; const st=d?.state; const pl=d?.plan;
        const tv = exists ? st.AB+st.SR : 0;
        const risk = exists ? riskInfo(st.streak||0,st.AB,st.SR) : null;
        const roi  = exists ? ((tv-pl.starting)/pl.starting*100).toFixed(1) : null;

        return (
          <button key={p.id} onClick={()=>onOpen(p.id)}
            style={{width:"100%",background:"none",border:"none",padding:0,
              cursor:"pointer",marginBottom:12,textAlign:"left",
              animation:`fadeUp ${0.5+i*0.1}s ease`}}>
            <div style={{...S.planCard,
              border:`1px solid ${exists?p.color+"44":"#ffffff0d"}`,
              boxShadow:exists?`0 0 30px ${p.glow.replace("0.5","0.07")}, inset 0 0 30px ${p.glow.replace("0.5","0.02")}`:"none"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,
                background:exists?`linear-gradient(90deg,transparent,${p.color},transparent)`:"transparent"}}/>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{width:44,height:44,borderRadius:12,
                    background:exists?p.gradient:"linear-gradient(135deg,#ffffff06,#ffffff02)",
                    display:"flex",alignItems:"center",justifyContent:"center",
                    fontSize:20,fontFamily:"'Orbitron',monospace",
                    color:exists?"#000":"#ffffff22",fontWeight:900,
                    boxShadow:exists?`0 0 20px ${p.glow.replace("0.5","0.4")}`:"none"}}>
                    {p.emoji}
                  </div>
                  <div>
                    <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:16,
                      color:exists?p.color:"#ffffff22",letterSpacing:2}}>
                      PLAN {p.label}
                    </div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",marginTop:3}}>
                      {exists?`×${pl.odds} · ${pl.currency} · DAY ${st.day-1}`:`×${p.odds} · TAP TO ACTIVATE`}
                    </div>
                  </div>
                </div>
                {exists ? (
                  <div style={{padding:"4px 10px",borderRadius:20,fontFamily:"'DM Mono',monospace",
                    fontWeight:700,fontSize:9,letterSpacing:1,
                    background:`${risk.color}15`,color:risk.color,
                    border:`1px solid ${risk.color}44`}}>
                    {risk.short}
                  </div>
                ):(
                  <div style={{padding:"4px 12px",borderRadius:20,fontFamily:"'DM Mono',monospace",
                    fontSize:9,color:"#ffffff22",border:"1px solid #ffffff11"}}>
                    + ADD
                  </div>
                )}
              </div>
              {exists && (
                <>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:14}}>
                    {[["BANK",fmt(st.AB,pl.currency),p.color],
                      ["RESERVE",fmt(st.SR,pl.currency),"#FFD600"],
                      ["ROI",(parseFloat(roi)>=0?"+":"")+roi+"%",parseFloat(roi)>=0?"#69FF47":"#FF1744"]
                    ].map(([l,v,col],i)=>(
                      <div key={i} style={{background:"#ffffff05",borderRadius:8,padding:"8px 10px",border:`1px solid ${col}15`}}>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:7,color:"#ffffff33",letterSpacing:2,marginBottom:4}}>{l}</div>
                        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:10,color:col}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:16,marginTop:10,paddingTop:10,borderTop:"1px solid #ffffff06"}}>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33"}}>🔥 {st.streak||0}</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#69FF4766"}}>✓ {(st.history||[]).filter(h=>h.result==="WIN").length}W</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#FF174466"}}>✕ {st.losses||0}L</span>
                  </div>
                </>
              )}
            </div>
          </button>
        );
      })}

      {vals.length===0 && (
        <div style={{textAlign:"center",padding:"40px 0",fontFamily:"'DM Mono',monospace",fontSize:11,color:"#ffffff22",lineHeight:2}}>
          Tap a plan above to activate it.<br/>All data auto-saves to the cloud.
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ PLAN VIEW ═════════════════════════════ */
function PlanView({plan,st,preset,tab,setTab,onBet,onBack,onDelete,onLogTip,onTrack,onSettle,onRemove}) {
  const risk   = riskInfo(st.streak||0, st.AB, st.SR);
  const wdCalc = calcWD(st.AB, st.day, st.lastWD, st.crossed, plan.wdPct);
  const nextWD = 7 - ((st.day-1) % 7);
  return (
    <div style={{...S.screen,animation:"fadeUp 0.3s ease"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
        padding:"14px 0",borderBottom:`1px solid ${preset.color}22`,marginBottom:14}}>
        <button onClick={onBack} style={S.backBtn}>← PLANS</button>
        <div style={{textAlign:"center"}}>
          <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:18,
            color:preset.color,letterSpacing:3,textShadow:`0 0 20px ${preset.glow}`}}>
            {preset.emoji} {preset.label}
          </div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",marginTop:2}}>
            DAY {st.day-1} · ×{plan.odds} · {plan.currency}
          </div>
        </div>
        <div style={{padding:"5px 10px",borderRadius:20,fontFamily:"'DM Mono',monospace",
          fontWeight:700,fontSize:9,letterSpacing:1,
          background:`${risk.color}15`,color:risk.color,
          border:`1px solid ${risk.color}44`,boxShadow:`0 0 12px ${risk.color}33`}}>
          {risk.short}
        </div>
      </div>
      <div style={{display:"flex",gap:4,marginBottom:14,background:"#ffffff05",borderRadius:12,padding:4}}>
        {TABS.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{flex:1,padding:"8px 2px",borderRadius:8,border:"none",cursor:"pointer",
              fontFamily:"'DM Mono',monospace",fontSize:8,letterSpacing:0.5,transition:"all .25s",
              background:tab===t?preset.gradient:"transparent",
              color:tab===t?"#000000cc":preset.color+"55",
              fontWeight:tab===t?"700":"400",
              boxShadow:tab===t?`0 0 15px ${preset.glow}`:"none"}}>
            {t}
          </button>
        ))}
      </div>
      <div style={{animation:"fadeUp 0.2s ease"}}>
        {tab==="TODAY"     && <TodayTab    plan={plan} st={st} risk={risk} nextWD={nextWD} wdCalc={wdCalc} onBet={onBet} preset={preset}/>}
        {tab==="TIPS"      && <TipsTab     plan={plan} st={st} preset={preset} onTrack={onTrack}/>}
        {tab==="RESULTS"   && <ResultsTab  plan={plan} st={st} preset={preset} onLogTip={onLogTip} onSettle={onSettle} onRemove={onRemove}/>}
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
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44",letterSpacing:2}}>RISK ASSESSMENT</span>
          <span style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,color:risk.color,textShadow:`0 0 10px ${risk.glow}`}}>{risk.label}</span>
        </div>
        <div style={{display:"flex",gap:3,height:5,marginBottom:8}}>
          {[0.25,0.5,0.75,1].map((seg,i)=>(
            <div key={i} style={{flex:1,borderRadius:3,transition:"all .5s ease",
              background:risk.bar>=seg?(i===0?"#00E5FF":i===1?"#FFD600":i===2?"#FF6D00":"#FF1744"):"#ffffff0d",
              boxShadow:risk.bar>=seg?`0 0 8px ${i===0?"#00E5FF":i===1?"#FFD600":i===2?"#FF6D00":"#FF1744"}88`:"none"}}/>
          ))}
        </div>
        <div style={{display:"flex",justifyContent:"space-between"}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33"}}>🔥 {st.streak||0} streak</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33"}}>⏱ WD in {nextWD}d</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33"}}>✕ {st.losses||0} losses</span>
        </div>
      </div>

      {/* Bank hero */}
      <div style={{...S.glassCard,border:`1px solid ${preset.color}33`,
        background:`linear-gradient(135deg,${preset.color}09,#ffffff03)`,
        boxShadow:`0 0 40px ${preset.glow.replace("0.5","0.07")}`,marginBottom:10,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:-20,right:-20,width:80,height:80,borderRadius:"50%",
          background:`radial-gradient(circle,${preset.color}18,transparent)`,pointerEvents:"none"}}/>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:preset.color+"88",letterSpacing:3,marginBottom:4}}>◈ ACTIVE BANK</div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:28,
          color:preset.color,lineHeight:1,textShadow:`0 0 30px ${preset.glow}`}}>
          {fmt(animAB,plan.currency)}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:14}}>
          <div style={{background:"#ffffff05",borderRadius:10,padding:"10px 12px",border:"1px solid #FFD60022"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#FFD60066",letterSpacing:2,marginBottom:4}}>SAFE RESERVE</div>
            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,color:"#FFD600",fontSize:14}}>{fmt(animSR,plan.currency)}</div>
          </div>
          <div style={{background:"#ffffff05",borderRadius:10,padding:"10px 12px",border:"1px solid #69FF4722"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#69FF4766",letterSpacing:2,marginBottom:4}}>TOTAL VALUE</div>
            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,color:"#69FF47",fontSize:14}}>{fmt(animTV,plan.currency)}</div>
          </div>
        </div>
      </div>

      {/* Today's bet */}
      <div style={{...S.glassCard,marginBottom:10}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff22",letterSpacing:3,marginBottom:12}}>TODAY'S ROLLOVER — DAY {st.day}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {[["STAKE",fmt(st.AB,plan.currency),preset.color],
            ["WIN TARGET",fmt(pot,plan.currency),"#69FF47"],
            ["NET PROFIT","+"+fmt(pot-st.AB,plan.currency),"#69FF47"],
            ["ODDS","× "+plan.odds,"#FFD600"]
          ].map(([l,v,col],i)=>(
            <div key={i} style={{background:"#ffffff04",border:`1px solid ${col}18`,borderRadius:10,padding:"10px 12px",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${col}44,transparent)`}}/>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:col+"66",letterSpacing:2,marginBottom:6}}>{l}</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,color:col,fontSize:12}}>{v}</div>
            </div>
          ))}
        </div>
        {wdCalc.wd>0 && (
          <div style={{marginTop:10,background:"#FFD60008",border:"1px solid #FFD60033",borderRadius:10,padding:"10px 12px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:10,color:"#FFD600",letterSpacing:1,marginBottom:6}}>⚡ WITHDRAWAL TRIGGERED</div>
            {wdCalc.reasons.map((r,i)=>(
              <div key={i} style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#FFD60088",marginTop:2}}>› {r}</div>
            ))}
          </div>
        )}
      </div>

      {/* ROI */}
      <div style={{...S.glassCard,display:"flex",justifyContent:"space-between",alignItems:"center",
        marginBottom:10,padding:"12px 16px",
        background:parseFloat(roi)>=0?"linear-gradient(135deg,#69FF4707,transparent)":"linear-gradient(135deg,#FF174407,transparent)",
        border:`1px solid ${parseFloat(roi)>=0?"#69FF4722":"#FF174422"}`}}>
        <div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",letterSpacing:2}}>TOTAL RETURN</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",marginTop:2}}>Since Day 1</div>
        </div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:28,letterSpacing:1,
          color:parseFloat(roi)>=0?"#69FF47":"#FF1744",
          textShadow:`0 0 20px ${parseFloat(roi)>=0?"rgba(105,255,71,0.5)":"rgba(255,23,68,0.5)"}`}}>
          {parseFloat(roi)>=0?"+":""}{roi}%
        </div>
      </div>

      {(st.streak||0)>=7 && (
        <div style={{...S.glassCard,marginBottom:10,background:"linear-gradient(135deg,#FF6D0010,transparent)",
          border:"1px solid #FF6D0033",padding:"10px 14px"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:11,color:"#FF6D00",marginBottom:4}}>
            ⚠ STREAK ALERT — {st.streak} CONSECUTIVE WINS
          </div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#FF6D0088",lineHeight:1.6}}>
            Consider moving extra funds to Safe Reserve before today's bet.
          </div>
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:4}}>
        <button onClick={()=>onBet("WIN")} style={{...S.winBtn,boxShadow:"0 4px 30px rgba(105,255,71,0.3)"}}>
          <div style={{fontSize:26,marginBottom:4}}>✦</div>
          <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:18,letterSpacing:3}}>WIN</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,opacity:.7,marginTop:2}}>Roll profits forward</div>
          <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:"linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent)"}}/>
        </button>
        <button onClick={()=>onBet("LOSS")} style={{...S.lossBtn,boxShadow:"0 4px 30px rgba(255,23,68,0.3)"}}>
          <div style={{fontSize:26,marginBottom:4}}>✕</div>
          <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:18,letterSpacing:3}}>LOSS</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,opacity:.7,marginTop:2}}>Chain broke · SR restart</div>
          <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:"linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent)"}}/>
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════ HISTORY ═══════════════════════════════ */
/* ═══════════════════ RESULTS TAB ════════════════════════════ */
function ResultsTab({plan, st, preset, onLogTip, onSettle, onRemove}) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    match:"", league:"", market:"", pick:"", odds:"", stake:"", result:"WIN"
  });

  const all = (st.tipResults||[]);
  const pending = all.filter(r=>r.result==="PENDING").slice().reverse();
  const results = all.filter(r=>r.result==="WIN"||r.result==="LOSS").slice().reverse();
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
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:preset.color+"88",
          letterSpacing:3, marginBottom:12}}>TIPS PERFORMANCE TRACKER</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
          {[
            ["TOTAL P&L", `${totalProfit>=0?"+":""}${fmt(totalProfit,plan.currency)}`,
             totalProfit>=0?"#69FF47":"#FF1744"],
            ["USD P&L", `${totalProfit>=0?"+":"-"}$${Math.abs(totalProfit/TSH_TO_USD).toFixed(2)}`,
             totalProfit>=0?"#69FF47":"#FF1744"],
            ["WIN RATE", wr+"%", parseInt(wr)>=55?"#69FF47":parseInt(wr)>=45?"#FFD600":"#FF1744"],
            ["ROI", (parseFloat(roi)>=0?"+":"")+roi+"%",
             parseFloat(roi)>=0?"#69FF47":"#FF1744"],
            ["TOTAL STAKED", fmt(totalStaked,plan.currency), "#00E5FF"],
            ["BETS LOGGED", results.length, preset.color],
          ].map(([l,v,col])=>(
            <div key={l} style={{background:"#ffffff05",borderRadius:10,padding:"10px 12px",
              border:`1px solid ${col}18`}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:7,color:col+"66",
                letterSpacing:2,marginBottom:4}}>{l}</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:12,color:col}}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{display:"flex",gap:12,paddingTop:10,borderTop:"1px solid #ffffff08"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#69FF4788"}}>
            ✓ {wins.length} wins
          </div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#FF174488"}}>
            ✕ {losses.length} losses
          </div>
        </div>
      </div>

      {/* Pending tips pulled from GET TIPS — settle after each match */}
      {pending.length>0 && (
        <div style={{...S.glassCard, border:"1px solid #FFD60044",
          background:"linear-gradient(135deg,#FFD60008,transparent)", marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#FFD600aa",letterSpacing:2}}>
              PENDING TIPS · {pending.length}
            </div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33"}}>from GET TIPS</div>
          </div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44",lineHeight:1.6,marginBottom:12}}>
            Enter the stake you placed, then tap Win or Loss. Tap ✕ to drop a tip you didn’t bet.
          </div>
          {pending.map(t=> <PendingTipRow key={t.id} tip={t} preset={preset} onSettle={onSettle} onRemove={onRemove}/>)}
        </div>
      )}

      {/* Log a tip result button */}
      <button onClick={()=>setShowForm(!showForm)}
        style={{width:"100%",background:showForm?"#ffffff08":`linear-gradient(135deg,${preset.color}22,${preset.color}11)`,
          border:`1px solid ${preset.color}44`,borderRadius:12,color:preset.color,
          fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:11,
          padding:"12px",cursor:"pointer",letterSpacing:1,marginBottom:10}}>
        {showForm ? "✕ CANCEL" : "+ LOG TIP RESULT"}
      </button>

      {/* Log form */}
      {showForm && (
        <div style={{...S.glassCard,marginBottom:10,border:`1px solid ${preset.color}33`}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",
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
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff44",
                letterSpacing:1,marginBottom:4}}>{label}</div>
              <input type={type} placeholder={ph} value={form[k]}
                onChange={e=>setForm({...form,[k]:e.target.value})}
                style={{...S.input,border:`1px solid ${preset.color}33`,padding:"10px 12px",fontSize:12}}/>
            </div>
          ))}
          {/* Result toggle */}
          <div style={{marginBottom:12}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff44",
              letterSpacing:1,marginBottom:8}}>RESULT</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {["WIN","LOSS"].map(r=>(
                <button key={r} onClick={()=>setForm({...form,result:r})}
                  style={{padding:"10px",borderRadius:10,border:"none",cursor:"pointer",
                    fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,
                    background: form.result===r
                      ? (r==="WIN"?"linear-gradient(135deg,#69FF47,#00C853)":"linear-gradient(135deg,#FF1744,#B71C1C)")
                      : "#ffffff08",
                    color: form.result===r ? (r==="WIN"?"#001a00":"#fff") : "#ffffff44",
                  }}>
                  {r==="WIN"?"✦ WIN":"✕ LOSS"}
                </button>
              ))}
            </div>
          </div>
          {/* Preview profit */}
          {form.odds && form.stake && (
            <div style={{background:form.result==="WIN"?"#69FF4710":"#FF174410",
              borderRadius:8,padding:"8px 12px",marginBottom:12,
              border:`1px solid ${form.result==="WIN"?"#69FF4733":"#FF174433"}`}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,
                color:form.result==="WIN"?"#69FF47":"#FF1744"}}>
                {form.result==="WIN"
                  ? `Profit: +${fmt(parseFloat(form.stake)*(parseFloat(form.odds)-1),plan.currency)} (+$${(parseFloat(form.stake)*(parseFloat(form.odds)-1)/TSH_TO_USD).toFixed(2)})`
                  : `Loss: -${fmt(parseFloat(form.stake),plan.currency)} (-$${(parseFloat(form.stake)/TSH_TO_USD).toFixed(2)})`
                }
              </div>
            </div>
          )}
          <button onClick={handleLog}
            style={{width:"100%",background:preset.gradient,border:"none",borderRadius:10,
              color:"#000",fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:12,
              padding:"12px",cursor:"pointer",boxShadow:`0 0 20px ${preset.glow}`}}>
            SAVE RESULT
          </button>
        </div>
      )}

      {/* ROI by Market */}
      {Object.keys(byMarket).length > 0 && (
        <div style={{...S.glassCard,marginBottom:10}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",
            letterSpacing:2,marginBottom:10}}>ROI BY MARKET</div>
          {Object.entries(byMarket)
            .sort((a,b)=>b[1].profit-a[1].profit)
            .map(([market,data])=>{
              const mRoi = data.staked>0?(data.profit/data.staked*100).toFixed(1):"0";
              const col = parseFloat(mRoi)>=0?"#69FF47":"#FF1744";
              return (
                <div key={market} style={{display:"flex",justifyContent:"space-between",
                  alignItems:"center",padding:"8px 0",borderBottom:"1px solid #ffffff06"}}>
                  <div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff77"}}>{market}</div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",marginTop:2}}>
                      {data.wins}W {data.losses}L
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,color:col}}>
                      {parseFloat(mRoi)>=0?"+":""}{mRoi}%
                    </div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:col+"88",marginTop:2}}>
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
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",
            letterSpacing:2,marginBottom:10}}>ROI BY LEAGUE</div>
          {Object.entries(byLeague)
            .sort((a,b)=>b[1].profit-a[1].profit)
            .slice(0,8)
            .map(([league,data])=>{
              const lRoi = data.staked>0?(data.profit/data.staked*100).toFixed(1):"0";
              const col = parseFloat(lRoi)>=0?"#69FF47":"#FF1744";
              return (
                <div key={league} style={{display:"flex",justifyContent:"space-between",
                  alignItems:"center",padding:"8px 0",borderBottom:"1px solid #ffffff06"}}>
                  <div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff77"}}>{league}</div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",marginTop:2}}>
                      {data.wins}W {data.losses}L
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,color:col}}>
                      {parseFloat(lRoi)>=0?"+":""}{lRoi}%
                    </div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:col+"88",marginTop:2}}>
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
        <div style={{textAlign:"center",padding:"40px 0",fontFamily:"'DM Mono',monospace",
          fontSize:10,color:"#ffffff22",lineHeight:2}}>
          <div style={{fontSize:36,marginBottom:12,opacity:.3}}>📊</div>
          No settled results yet.<br/>
          {pending.length>0 ? "Settle your pending tips above after the matches finish." : "Pull tips in the TIPS tab — they’ll appear here to grade."}
        </div>
      ) : (
        <div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff22",
            letterSpacing:2,marginBottom:10}}>RECENT RESULTS</div>
          {results.slice(0,20).map((r,i)=>(
            <div key={r.id||i} style={{...S.glassCard,marginBottom:8,padding:"12px 14px",
              borderLeft:`2px solid ${r.result==="WIN"?"#69FF47":"#FF1744"}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div style={{flex:1,paddingRight:8}}>
                  <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,
                    color:"#ffffff",marginBottom:3}}>{r.match}</div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff44",marginBottom:4}}>
                    {r.league} · {r.market}
                  </div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff66"}}>
                    {r.pick} @ {r.odds} · Stake: {fmt(r.stake,plan.currency)}
                  </div>
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:14,
                    color:r.result==="WIN"?"#69FF47":"#FF1744",marginBottom:4}}>
                    {r.result==="WIN"?"✦ WIN":"✕ LOSS"}
                  </div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,
                    color:r.result==="WIN"?"#69FF47":"#FF1744"}}>
                    {r.profitTSH>=0?"+":""}{fmt(r.profitTSH,plan.currency)}
                  </div>
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,
                    color:r.result==="WIN"?"#69FF4788":"#FF174488"}}>
                    {r.profitTSH>=0?"+":"-"}${Math.abs(r.profitUSD).toFixed(2)}
                  </div>
                </div>
              </div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff22",
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
    <div style={{textAlign:"center",padding:"60px 0",color:"#ffffff22",fontFamily:"'DM Mono',monospace"}}>
      <div style={{fontSize:40,marginBottom:12,opacity:.3}}>◈</div>
      <div style={{letterSpacing:2}}>NO BETS LOGGED YET</div>
    </div>
  );
  return(
    <div>
      <div style={{...S.glassCard,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:0,marginBottom:12,padding:0,overflow:"hidden"}}>
        {[["BETS",hist.length,preset.color],["WIN RATE",wr+"%","#69FF47"],["LOSSES",st.losses||0,"#FF1744"]].map(([l,v,col],i)=>(
          <div key={i} style={{padding:"12px",borderRight:i<2?"1px solid #ffffff08":"none",textAlign:"center"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",letterSpacing:2,marginBottom:4}}>{l}</div>
            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:16,color:col}}>{v}</div>
          </div>
        ))}
      </div>
      {hist.map((h,i)=>(
        <div key={i} style={{...S.glassCard,marginBottom:8,padding:"12px 14px",
          borderLeft:`2px solid ${h.result==="WIN"?"#69FF47":"#FF1744"}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",marginBottom:4}}>DAY {h.day}</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,color:h.result==="WIN"?"#69FF47":"#FF1744"}}>
                {h.result==="WIN"?"✦ WIN":"✕ LOSS"}
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",marginBottom:4}}>{fmt(h.openAB,plan.currency)}</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,color:h.result==="WIN"?"#69FF47":"#FF1744"}}>→ {fmt(h.closeAB,plan.currency)}</div>
            </div>
          </div>
          {h.wd>0&&<div style={{marginTop:8,background:"#FFD60008",borderRadius:6,padding:"5px 8px",fontFamily:"'DM Mono',monospace",fontSize:9,color:"#FFD60088"}}>⚡ Withdrawn: {fmt(h.wd,plan.currency)}</div>}
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
      <div style={{...S.glassCard,border:"1px solid #FFD60033",background:"linear-gradient(135deg,#FFD60008,transparent)",marginBottom:10}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#FFD60066",letterSpacing:3,marginBottom:4}}>◈ SAFE RESERVE</div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:26,color:"#FFD600",textShadow:"0 0 30px rgba(255,214,0,0.6)"}}>
          {fmt(animSR,plan.currency)}
        </div>
        <div style={{marginTop:14}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44"}}>SR COVERAGE</span>
            <span style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,
              color:parseFloat(ratio)>30?"#69FF47":parseFloat(ratio)>10?"#FFD600":"#FF1744"}}>{ratio}%</span>
          </div>
          <div style={{height:6,background:"#ffffff0a",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${Math.min(parseFloat(ratio),100)}%`,borderRadius:3,transition:"width .8s ease",
              background:parseFloat(ratio)>30?"linear-gradient(90deg,#69FF47,#00C853)":parseFloat(ratio)>10?"linear-gradient(90deg,#FFD600,#FF8F00)":"linear-gradient(90deg,#FF1744,#D50000)",
              boxShadow:parseFloat(ratio)>30?"0 0 10px #69FF4788":parseFloat(ratio)>10?"0 0 10px #FFD60088":"0 0 10px #FF174488"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:10}}>
            <div><div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff22",letterSpacing:2}}>TOTAL TO SR</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,color:"#FFD600",marginTop:2}}>{fmt(st.totalSR||0,plan.currency)}</div></div>
            <div style={{textAlign:"right"}}><div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff22",letterSpacing:2}}>TOTAL ROI</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,color:parseFloat(roi)>=0?"#69FF47":"#FF1744",marginTop:2}}>
                {parseFloat(roi)>=0?"+":""}{roi}%
              </div></div>
          </div>
        </div>
      </div>
      <div style={S.glassCard}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff22",letterSpacing:3,marginBottom:12}}>METRICS</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {[["DAYS RUN",st.day-1,preset.color],["WINS",(st.history||[]).filter(h=>h.result==="WIN").length,"#69FF47"],
            ["LOSSES",st.losses||0,"#FF1744"],["STREAK",st.streak||0,"#FFD600"],
            ["TOTAL VALUE",fmt(total,plan.currency),"#69FF47"],["WD EVENTS",wdHist.length,"#FFD600"]
          ].map(([l,v,col],i)=>(
            <div key={i} style={{background:"#ffffff04",border:`1px solid ${col}15`,borderRadius:10,padding:"10px 12px",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${col}33,transparent)`}}/>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:col+"66",letterSpacing:2,marginBottom:6}}>{l}</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,color:col,fontSize:13}}>{v}</div>
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
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff22",letterSpacing:3,marginBottom:12}}>PLAN CONFIG</div>
        {[["Plan",`${preset.emoji} ${preset.label}`],["Odds","× "+plan.odds],
          ["Currency",plan.currency],["Starting",fmt(plan.starting,plan.currency)],
          ["Weekly WD",(plan.wdPct*100).toFixed(0)+"% of AB"],
          ["Milestone WD","35% at milestones"],["Loss Restart","60% of SR → AB"],["SR Protection","40% always kept"]
        ].map(([l,v],i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
            borderBottom:"1px solid #ffffff06",padding:"11px 0",fontFamily:"'DM Mono',monospace"}}>
            <span style={{fontSize:10,color:"#ffffff44"}}>{l}</span>
            <span style={{fontSize:11,fontWeight:700,color:preset.color}}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{marginTop:16}}>
        {!confirm?(
          <button onClick={()=>setConfirm(true)}
            style={{width:"100%",background:"linear-gradient(135deg,#FF174412,transparent)",
              border:"1px solid #FF174444",borderRadius:12,color:"#FF1744",
              fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:12,padding:"14px",cursor:"pointer",letterSpacing:1}}>
            ✕ DELETE THIS PLAN
          </button>
        ):(
          <div style={{...S.glassCard,border:"1px solid #FF174444"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:11,color:"#FF1744",marginBottom:14,letterSpacing:1}}>
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
          fontSize:28,fontFamily:"'Orbitron',monospace",fontWeight:900,color:"#000",
          boxShadow:`0 0 40px ${preset.glow}`}}>{preset.emoji}</div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:26,
          color:preset.color,letterSpacing:4,textShadow:`0 0 20px ${preset.glow}`}}>PLAN {preset.label}</div>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ffffff33",marginTop:6,letterSpacing:3}}>
          ×{preset.odds} ODDS · {preset.wdPct*100}% WEEKLY WD
        </div>
      </div>
      <div style={S.glassCard}>
        <div style={{display:"flex",gap:4,marginBottom:20}}>
          {fields.map((_,i)=>(
            <div key={i} style={{flex:1,height:3,borderRadius:2,transition:"all .4s ease",
              background:i<=step?preset.gradient:"#ffffff0d",
              boxShadow:i===step?`0 0 10px ${preset.glow}`:"none"}}/>
          ))}
        </div>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",letterSpacing:3,marginBottom:8}}>STEP {step+1} OF {fields.length}</div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:15,color:preset.color,letterSpacing:2,marginBottom:14}}>{fields[step].label}</div>
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          {[["ODDS","×"+preset.odds,preset.color],["WEEKLY WD",preset.wdPct*100+"%","#FFD600"]].map(([l,v,col],i)=>(
            <div key={i} style={{flex:1,background:`${col}0d`,border:`1px solid ${col}33`,borderRadius:10,padding:"8px",textAlign:"center"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:col+"66",letterSpacing:2,marginBottom:3}}>{l}</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,color:col}}>{v}</div>
            </div>
          ))}
        </div>
        <input type={fields[step].type} placeholder={fields[step].ph} value={form[fields[step].k]}
          onChange={e=>setForm({...form,[fields[step].k]:e.target.value})}
          onKeyDown={e=>e.key==="Enter"&&next()} autoFocus
          style={{...S.input,border:`1px solid ${preset.color}44`,boxShadow:`0 0 20px ${preset.glow.replace("0.5","0.08")}`}}/>
        <div style={{display:"flex",gap:10,marginTop:14}}>
          {step>0&&<button onClick={()=>setStep(s=>s-1)} style={{...S.winBtn,flex:1,background:"transparent",border:"1px solid #ffffff22",color:"#ffffff55",boxShadow:"none"}}>← BACK</button>}
          <button onClick={next} style={{...S.winBtn,flex:2,
            background:step===fields.length-1?preset.gradient:"linear-gradient(135deg,#ffffff12,#ffffff06)",
            color:step===fields.length-1?"#000":"#fff",
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
  "Over": "#69FF47", "Under": "#00E5FF", "BTTS": "#E040FB",
  "Both": "#E040FB", "First": "#FFD600", "Asian": "#FF6D00",
  "Total": "#FF6D00", "Either": "#E040FB"
};
function marketColor(market) {
  const key = Object.keys(MARKET_COLORS).find(k => market?.startsWith(k));
  return key ? MARKET_COLORS[key] : "#00E5FF";
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

  const FILTERS = ["ALL","🔥 CONFIRMED","LOW RISK","OVER GOALS","UNDER GOALS","BTTS","CORNERS","CARDS","1ST HALF"];
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
    return true;
  });

  const riskColor = r => r==="LOW"?"#69FF47":r==="MEDIUM"?"#FFD600":"#FF1744";

  return (
    <div>
      {/* Header card */}
      <div style={{...S.glassCard, background:`linear-gradient(135deg,${preset.color}0a,transparent)`,
        border:`1px solid ${preset.color}33`, marginBottom:12, padding:"14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,
              color:preset.color,letterSpacing:2}}>🤖 MULTI-AI GOALS TIPS</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44",marginTop:3,lineHeight:1.5}}>
              {activeAIs.length > 0
                ? activeAIs.join(" + ") + " active"
                : "Claude · Gemini · Groq · Goals only"}
            </div>
            {activeAIs.length > 0 && (
              <div style={{display:"flex",gap:5,marginTop:7,flexWrap:"wrap"}}>
                {activeAIs.map(ai=>(
                  <div key={ai} style={{padding:"2px 8px",borderRadius:20,
                    background:ai==="Claude"?"#00E5FF15":ai==="Gemini"?"#69FF4715":"#E040FB15",
                    border:`1px solid ${ai==="Claude"?"#00E5FF":ai==="Gemini"?"#69FF47":"#E040FB"}44`,
                    fontFamily:"'DM Mono',monospace",fontSize:8,letterSpacing:1,
                    color:ai==="Claude"?"#00E5FF":ai==="Gemini"?"#69FF47":"#E040FB"}}>
                    ✓ {ai}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",marginBottom:4}}>
              {lastFetch ? `Updated ${Math.round((Date.now()-lastFetch)/60000)}m ago` : "Not loaded"}
            </div>
            <button onClick={fetchTips} disabled={loading}
              style={{background:loading?"#ffffff0a":preset.gradient,
                border:"none",borderRadius:8,padding:"8px 14px",cursor:loading?"not-allowed":"pointer",
                fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:10,
                color:loading?"#ffffff44":"#000",letterSpacing:1,
                boxShadow:loading?"none":`0 0 20px ${preset.glow}`}}>
              {loading ? "⏳ LOADING..." : "⚡ GET TIPS"}
            </button>
          </div>
        </div>

        {/* Warning */}
        <div style={{marginTop:10,background:"#FFD60008",border:"1px solid #FFD60022",
          borderRadius:8,padding:"7px 10px",fontFamily:"'DM Mono',monospace",fontSize:8,
          color:"#FFD60088",lineHeight:1.6}}>
          ⚠ AI tips are analytical suggestions only, not guarantees. Always combine with your own research. Bet responsibly.
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div>
          {[1,2,3,4].map(i=>(
            <div key={i} style={{...S.glassCard,marginBottom:10,padding:14,opacity:0.6}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
                <div style={{background:"#ffffff08",borderRadius:4,height:12,width:"60%",animation:"pulse-load 1.5s ease infinite"}}/>
                <div style={{background:"#ffffff08",borderRadius:4,height:12,width:"15%",animation:"pulse-load 1.5s ease infinite"}}/>
              </div>
              <div style={{background:"#ffffff05",borderRadius:4,height:8,width:"40%",marginBottom:8,animation:"pulse-load 1.5s ease infinite"}}/>
              <div style={{background:"#ffffff05",borderRadius:4,height:8,width:"80%",animation:"pulse-load 1.5s ease infinite"}}/>
              <style>{`@keyframes pulse-load{0%,100%{opacity:.5}50%{opacity:1}}`}</style>
            </div>
          ))}
          <div style={{textAlign:"center",fontFamily:"'DM Mono',monospace",fontSize:10,
            color:"#ffffff33",padding:"8px 0",letterSpacing:2,animation:"blink 1s step-end infinite"}}>
            SEARCHING LIVE MATCHES & ANALYSING STATS...
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div style={{...S.glassCard,border:"1px solid #FF174444",
          background:"linear-gradient(135deg,#FF174408,transparent)",padding:14}}>
          <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:12,
            color:"#FF1744",marginBottom:8}}>✕ FAILED TO LOAD</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#FF174488",
            lineHeight:1.6,marginBottom:12,wordBreak:"break-word"}}>{String(error)}</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",
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
          <div style={{fontFamily:"'Orbitron',monospace",fontSize:14,color:preset.color,
            letterSpacing:3,marginBottom:8}}>NO TIPS LOADED</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ffffff33",
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
                cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:1,
                background:filter===f?preset.gradient:"#ffffff08",
                color:filter===f?"#000":"#ffffff55",
                boxShadow:filter===f?`0 0 12px ${preset.glow}`:"none",
                transition:"all .2s",flexShrink:0}}>
              {f}
            </button>
          ))}
        </div>
      )}

      {/* Tips count */}
      {tips.length>0 && !loading && (
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",
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
              background:`linear-gradient(135deg,${col}06,#0a0d14)`,
              transition:"all .25s"}}>

              {/* Top accent */}
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,
                background:`linear-gradient(90deg,transparent,${col}66,transparent)`}}/>

              {/* Header row */}
              <div style={{display:"flex",justifyContent:"space-between",
                alignItems:"flex-start",marginBottom:10}}>
                <div style={{flex:1,paddingRight:8}}>
                  <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,
                    fontSize:11,color:"#ffffff",letterSpacing:1,marginBottom:3}}>
                    {tip.match}
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:8,
                      color:"#ffffff44"}}>{tip.league}</span>
                    {tip.time&&<span style={{fontFamily:"'DM Mono',monospace",fontSize:8,
                      color:"#ffffff33"}}>· {tip.time}</span>}
                  </div>
                </div>
                {/* Confidence circle */}
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,flexShrink:0}}>
                  <div style={{width:42,height:42,borderRadius:"50%",
                    background:`conic-gradient(${col} ${conf*3.6}deg, #ffffff0d 0deg)`,
                    display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
                    <div style={{width:32,height:32,borderRadius:"50%",background:"#0a0d14",
                      display:"flex",alignItems:"center",justifyContent:"center"}}>
                      <span style={{fontFamily:"'Orbitron',monospace",fontWeight:900,
                        fontSize:9,color:col}}>{conf}</span>
                    </div>
                  </div>
                  <span style={{fontFamily:"'DM Mono',monospace",fontSize:7,color:"#ffffff33"}}>CONF%</span>
                </div>
              </div>

              {/* Pick badge */}
              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,flexWrap:"wrap"}}>
                {tip.confirmed && (
                  <div style={{padding:"4px 10px",borderRadius:20,
                    background:"linear-gradient(135deg,#FFD60033,#FF8F0022)",
                    border:"1px solid #FFD60066",
                    fontFamily:"'DM Mono',monospace",fontSize:8,color:"#FFD600",
                    letterSpacing:1,fontWeight:700}}>
                    🔥 ALL 3 AIs AGREE
                  </div>
                )}
                {!tip.confirmed && tip.multiAI && (
                  <div style={{padding:"4px 10px",borderRadius:20,
                    background:"#00E5FF12",border:"1px solid #00E5FF44",
                    fontFamily:"'DM Mono',monospace",fontSize:8,color:"#00E5FF",letterSpacing:1}}>
                    ✦ {tip.aiCount} AIs AGREE
                  </div>
                )}
                <div style={{background:`${col}18`,border:`1px solid ${col}44`,
                  borderRadius:8,padding:"6px 12px",
                  fontFamily:"'Orbitron',monospace",fontWeight:700,
                  fontSize:12,color:col,letterSpacing:1,
                  boxShadow:`0 0 15px ${col}33`}}>
                  {tip.pick}
                </div>
                <div style={{background:`${rCol}12`,border:`1px solid ${rCol}33`,
                  borderRadius:20,padding:"4px 10px",
                  fontFamily:"'DM Mono',monospace",fontSize:8,
                  color:rCol,letterSpacing:1}}>
                  {tip.risk} RISK
                </div>
                {/* Odds display - real or estimated */}
                {(tip.bookmaker_odds || tip.odds_range) && (
                  <div style={{
                    background: tip.real_odds_available ? "#69FF4720" : "#ffffff08",
                    border: tip.real_odds_available ? "1px solid #69FF4766" : "1px solid #ffffff22",
                    borderRadius:20, padding:"4px 10px",
                    fontFamily:"'DM Mono',monospace", fontSize:8,
                    color: tip.real_odds_available ? "#69FF47" : "#ffffff55",
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
                    background:"#FFD60020", border:"1px solid #FFD60066",
                    borderRadius:20, padding:"4px 10px",
                    fontFamily:"'DM Mono',monospace", fontSize:8,
                    color:"#FFD600", letterSpacing:1, fontWeight:700,
                  }}>
                    ⚡ {tip.edge_pct} EDGE
                  </div>
                )}
              </div>

              {/* Market tag + Smart Stake */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44"}}>
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
                      fontFamily:"'DM Mono',monospace", fontSize:8,
                      color:rating.color, letterSpacing:1,
                    }}>
                      💰 {fmt(stake, plan.currency)}
                    </div>
                  );
                })()}
              </div>

              {/* Confidence bar */}
              <div style={{height:3,background:"#ffffff08",borderRadius:2,marginBottom:10,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${conf}%`,borderRadius:2,
                  background:`linear-gradient(90deg,${col}88,${col})`,
                  boxShadow:`0 0 8px ${col}66`,transition:"width .8s ease"}}/>
              </div>

              {/* Expand arrow */}
              <div style={{textAlign:"center",fontFamily:"'DM Mono',monospace",
                fontSize:9,color:"#ffffff22",letterSpacing:2}}>
                {isExp?"▲ HIDE ANALYSIS":"▼ SEE ANALYSIS"}
              </div>

              {/* Expanded detail */}
              {isExp && (
                <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid #ffffff08",
                  animation:"fadeUp .2s ease"}}>
                  {/* Reasoning */}
                  <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,
                    color:"#ffffff77",lineHeight:1.7,marginBottom:12}}>
                    {tip.reasoning}
                  </div>

                  {/* Key stats */}
                  {tip.key_stats?.length>0 && (
                    <div>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,
                        color:col+"88",letterSpacing:2,marginBottom:8}}>KEY STATS</div>
                      {tip.key_stats.map((s,j)=>(
                        <div key={j} style={{display:"flex",gap:8,alignItems:"flex-start",
                          marginBottom:6}}>
                          <div style={{width:4,height:4,borderRadius:"50%",
                            background:col,marginTop:5,flexShrink:0}}/>
                          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,
                            color:"#ffffff55",lineHeight:1.5}}>{s}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Value Analysis - shown when real odds available */}
                  {tip.real_odds_available && (
                    <div style={{marginTop:10,background:"#FFD60008",borderRadius:8,
                      padding:"10px 12px",border:"1px solid #FFD60033"}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,
                        color:"#FFD60088",letterSpacing:2,marginBottom:8}}>VALUE ANALYSIS</div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                        {[
                          ["REAL ODDS", tip.bookmaker_odds, "#69FF47"],
                          ["OUR PROB", tip.predicted_probability ? `${(tip.predicted_probability*100).toFixed(0)}%` : "N/A", "#00E5FF"],
                          ["EDGE", tip.edge_pct || "N/A", tip.is_value_bet ? "#FFD600" : "#FF1744"],
                          ["STAKE", tip.recommended_stake_pct ? `${tip.recommended_stake_pct}% bankroll` : "Standard", "#E040FB"],
                        ].map(([l,v,c])=>(
                          <div key={l} style={{background:"#ffffff04",borderRadius:6,padding:"6px 8px"}}>
                            <div style={{fontFamily:"'DM Mono',monospace",fontSize:7,color:"#ffffff33",letterSpacing:2}}>{l}</div>
                            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,color:c,marginTop:2}}>{v}</div>
                          </div>
                        ))}
                      </div>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,
                        color:"#ffffff33",marginTop:8}}>
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
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,
                          color:rating.color,letterSpacing:2,marginBottom:8}}>
                          SMART STAKE (KELLY CRITERION)
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:6}}>
                          {[
                            ["STAKE", fmt(stake,plan.currency), rating.color],
                            ["USD", `$${(stake/TSH_TO_USD).toFixed(2)}`, rating.color],
                            ["EDGE", `${val>=0?"+":""}${(val*100).toFixed(1)}%`, val>=0?"#69FF47":"#FF1744"],
                          ].map(([l,v,c])=>(
                            <div key={l} style={{background:"#ffffff06",borderRadius:6,padding:"6px 8px",textAlign:"center"}}>
                              <div style={{fontFamily:"'DM Mono',monospace",fontSize:7,color:"#ffffff33",letterSpacing:1,marginBottom:3}}>{l}</div>
                              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:10,color:c}}>{v}</div>
                            </div>
                          ))}
                        </div>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,
                          color:rating.color,fontWeight:700}}>
                          {rating.label} · {rating.pct} of {fmt(bankroll,plan.currency)} bankroll
                        </div>
                      </div>
                    );
                  })()}

                  {/* AI Sources */}
                  {tip.ais && tip.ais.length > 0 && (
                    <div style={{marginTop:10,background:"#ffffff04",borderRadius:8,padding:"8px 10px",border:"1px solid #ffffff08"}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",letterSpacing:2,marginBottom:6}}>CONFIRMED BY</div>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        {tip.ais.map(ai=>(
                          <div key={ai} style={{padding:"3px 10px",borderRadius:20,
                            background:ai==="Claude"?"#00E5FF12":ai==="Gemini"?"#69FF4712":"#E040FB12",
                            border:`1px solid ${ai==="Claude"?"#00E5FF":ai==="Gemini"?"#69FF47":"#E040FB"}44`,
                            fontFamily:"'DM Mono',monospace",fontSize:9,
                            color:ai==="Claude"?"#00E5FF":ai==="Gemini"?"#69FF47":"#E040FB"}}>
                            ✓ {ai}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Match to plan */}
                  <div style={{marginTop:12,background:"#ffffff04",borderRadius:8,
                    padding:"8px 10px",border:"1px solid #ffffff08"}}>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,
                      color:"#ffffff33",letterSpacing:2,marginBottom:4}}>PLAN MATCH</div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff55",lineHeight:1.6}}>
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
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff18",
          textAlign:"center",padding:"8px 0 4px",lineHeight:1.7,letterSpacing:1}}>
          TIPS REFRESH EVERY 30 MIN · FOR RESEARCH PURPOSES ONLY<br/>
          NEVER BET MORE THAN YOUR DAILY ROLLOVER STAKE
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ GLOBAL CSS ════════════════════════════ */
function GlobalCSS(){return(<style>{`
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=DM+Mono:wght@400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#030508;-webkit-tap-highlight-color:transparent;overflow-x:hidden;}
  ::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-track{background:#030508;}
  ::-webkit-scrollbar-thumb{background:#00E5FF22;border-radius:2px;}
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
  root:{background:"#030508",minHeight:"100vh",maxWidth:430,margin:"0 auto",position:"relative"},
  screen:{padding:"0 16px 32px",paddingTop:16,position:"relative",zIndex:1},
  splash:{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",position:"relative",zIndex:1},
  splashLogo:{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:40,color:"#00E5FF",
    letterSpacing:6,textShadow:"0 0 40px rgba(0,229,255,0.8),0 0 80px rgba(0,229,255,0.4)",
    animation:"logoReveal 1.2s ease forwards"},
  splashSub:{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ffffff33",letterSpacing:4,marginTop:8},
  splashBar:{height:2,background:"#ffffff08",borderRadius:2,marginTop:24,overflow:"hidden"},
  splashFill:{height:"100%",background:"linear-gradient(90deg,#00E5FF,#E040FB)",borderRadius:2,animation:"barFill 1.6s ease forwards"},
  homeHeader:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"20px 0 16px",borderBottom:"1px solid #ffffff08",marginBottom:14},
  homeTitle:{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:30,color:"#00E5FF",letterSpacing:4,textShadow:"0 0 30px rgba(0,229,255,0.6)",lineHeight:1},
  homeSub:{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",letterSpacing:3,marginTop:4},
  vBadge:{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#00E5FF88",border:"1px solid #00E5FF33",borderRadius:20,padding:"3px 10px",letterSpacing:2},
  headerBtn:{background:"#ffffff08",border:"1px solid #ffffff11",borderRadius:8,padding:"5px 9px",cursor:"pointer",fontSize:14,color:"#fff"},
  noticeBar:{background:"linear-gradient(135deg,#00E5FF0a,transparent)",border:"1px solid #00E5FF18",borderRadius:10,padding:"8px 12px",display:"flex",alignItems:"center",gap:8},
  combinedCard:{background:"linear-gradient(135deg,#00E5FF08,#ffffff02)",border:"1px solid #00E5FF22",borderRadius:16,padding:"14px 16px",marginBottom:18,boxShadow:"0 0 30px rgba(0,229,255,0.05)"},
  combinedVal:{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:20,color:"#00E5FF",textShadow:"0 0 20px rgba(0,229,255,0.5)",marginTop:4},
  planCard:{background:"#0a0d14",borderRadius:16,padding:"16px 14px",position:"relative",overflow:"hidden",transition:"all .25s ease",animation:"float 4s ease-in-out infinite"},
  glassCard:{background:"linear-gradient(135deg,#0d1117,#0a0d14)",border:"1px solid #ffffff0d",borderRadius:14,padding:14,marginBottom:10,position:"relative",overflow:"hidden"},
  backBtn:{background:"none",border:"none",color:"#00E5FF88",fontFamily:"'DM Mono',monospace",fontSize:11,cursor:"pointer",padding:"4px 0",letterSpacing:2},
  winBtn:{background:"linear-gradient(135deg,#69FF47,#00C853)",border:"none",borderRadius:14,color:"#001a00",padding:"16px 8px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2,fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:12,transition:"all .2s",position:"relative",overflow:"hidden"},
  lossBtn:{background:"linear-gradient(135deg,#FF1744,#B71C1C)",border:"none",borderRadius:14,color:"#fff0f0",padding:"16px 8px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2,fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:12,transition:"all .2s",position:"relative",overflow:"hidden"},
  input:{width:"100%",background:"#ffffff05",border:"1px solid #ffffff15",borderRadius:10,padding:"14px",color:"#fff",fontFamily:"'DM Mono',monospace",fontSize:13},
  toast:{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",padding:"10px 20px",borderRadius:30,fontFamily:"'DM Mono',monospace",fontSize:10,fontWeight:700,zIndex:300,whiteSpace:"nowrap",maxWidth:"92vw",overflow:"hidden",textOverflow:"ellipsis",letterSpacing:1,backdropFilter:"blur(10px)"},
  syncDot:{position:"fixed",top:8,right:16,zIndex:400,display:"flex",alignItems:"center",gap:6},
  modal:{position:"fixed",inset:0,zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(3,5,8,0.85)",backdropFilter:"blur(12px)",padding:24},
  modalBox:{background:"linear-gradient(135deg,#0d1117,#0a0d14)",border:"1px solid #00E5FF22",borderRadius:18,padding:24,width:"100%",maxWidth:380},
  actionBtn:{padding:"12px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:"'DM Mono',monospace",fontSize:11,fontWeight:700,letterSpacing:1},
};


/* One pending tip awaiting its result (pulled from the TIPS tab) */
function PendingTipRow({ tip, preset, onSettle, onRemove }){
  const [stake, setStake] = useState("");
  const s = parseFloat(stake);
  const valid = isFinite(s) && s > 0;
  const odds = tip.odds || 1.85;
  return (
    <div style={{background:"#ffffff05",border:"1px solid #ffffff10",borderRadius:10,
      padding:"11px 12px",marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,color:"#fff",
            whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{tip.match}</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff44",marginTop:3}}>
            {tip.league}{tip.market?` · ${tip.market}`:""}
          </div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#00E5FFcc",marginTop:4}}>
            {tip.pick}{tip.odds?` @ ${tip.odds}`:""}
          </div>
        </div>
        <button onClick={()=>onRemove(tip.id)} title="Didn't bet this"
          style={{background:"none",border:"1px solid #ffffff22",borderRadius:8,color:"#ffffff55",
            fontFamily:"'DM Mono',monospace",fontSize:12,cursor:"pointer",padding:"2px 9px",flexShrink:0}}>✕</button>
      </div>
      <div style={{display:"flex",gap:8,marginTop:10,alignItems:"center"}}>
        <input type="number" inputMode="decimal" placeholder={`Stake (${tip.currency||"TSH"})`}
          value={stake} onChange={e=>setStake(e.target.value)}
          style={{...S.input,flex:1,padding:"9px 11px",fontSize:12,border:"1px solid #ffffff22"}}/>
        <button disabled={!valid} onClick={()=>onSettle(tip.id,"WIN",stake)}
          style={{padding:"9px 14px",borderRadius:9,border:"none",cursor:valid?"pointer":"not-allowed",
            fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,
            background:valid?"linear-gradient(135deg,#69FF47,#00C853)":"#ffffff08",
            color:valid?"#001a00":"#ffffff33"}}>WIN</button>
        <button disabled={!valid} onClick={()=>onSettle(tip.id,"LOSS",stake)}
          style={{padding:"9px 14px",borderRadius:9,border:"none",cursor:valid?"pointer":"not-allowed",
            fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,
            background:valid?"linear-gradient(135deg,#FF1744,#B71C1C)":"#ffffff08",
            color:valid?"#fff":"#ffffff33"}}>LOSS</button>
      </div>
      {valid && (
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8.5,color:"#ffffff44",marginTop:8}}>
          Win → +{fmt(s*(odds-1), tip.currency)} · Loss → −{fmt(s, tip.currency)}
        </div>
      )}
    </div>
  );
}
