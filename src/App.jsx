import { useState, useEffect } from "react";

// ── Helpers ───────────────────────────────────────────────────────────────────
const MILESTONES = [100000,500000,1000000,5000000,10000000,50000000,100000000,500000000];

function fmt(n, cur = "TSH") {
  if (!n && n !== 0) return `${cur} 0`;
  const a = Math.abs(n);
  let s;
  if (a >= 1e12) s = (n/1e12).toFixed(2) + "T";
  else if (a >= 1e9)  s = (n/1e9).toFixed(2)  + "B";
  else if (a >= 1e6)  s = (n/1e6).toFixed(2)  + "M";
  else if (a >= 1e3)  s = Math.round(n).toLocaleString();
  else s = Math.round(n) + "";
  return `${cur} ${s}`;
}

function riskInfo(streak, AB, SR, day) {
  const r = SR / Math.max(AB, 1);
  if (streak >= 10 || r < 0.05) return { label:"EXTREME", color:"#FF1744", bg:"rgba(255,23,68,0.08)",  bar:1    };
  if (streak >= 7  || r < 0.15) return { label:"HIGH",    color:"#FF6B35", bg:"rgba(255,107,53,0.08)", bar:0.75 };
  if (streak >= 4  || r < 0.30) return { label:"MEDIUM",  color:"#FFC107", bg:"rgba(255,193,7,0.08)",  bar:0.5  };
  return                                { label:"LOW",     color:"#00E676", bg:"rgba(0,230,118,0.08)",  bar:0.25 };
}

function calcWD(AB, day, lastWD, crossed, wdPct) {
  let wd = 0, reasons = [];
  if (day % 7 === 0 && day !== lastWD) {
    const w = AB * wdPct; wd += w;
    reasons.push(`Weekly (${(wdPct*100).toFixed(0)}%): ${fmt(w)}`);
  }
  for (const ms of MILESTONES) {
    if (AB >= ms && !crossed.includes(ms)) {
      const w = AB * 0.35; wd += w;
      reasons.push(`Milestone ${fmt(ms)}: ${fmt(w)}`);
    }
  }
  return { wd, reasons };
}

// ── localStorage helpers ──────────────────────────────────────────────────────
function lsGet(key) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

const TABS = ["TODAY","HISTORY","RESERVE","SETTINGS"];
const defPlan  = { name:"My Rollover Plan", odds:1.20, starting:50000, currency:"TSH", wdPct:0.25 };
const defState = { day:1, AB:50000, SR:0, totalSR:0, streak:0, losses:0, lastWD:0, crossed:[], history:[] };

export default function App() {
  const [view, setView]   = useState("loading");
  const [tab,  setTab]    = useState("TODAY");
  const [plan, setPlan]   = useState(defPlan);
  const [st,   setSt]     = useState(defState);
  const [toast, setToast] = useState(null);
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    const p = lsGet("roPlan"), s = lsGet("roState");
    if (p && s) { setPlan(p); setSt(s); setView("app"); }
    else setView("setup");
  }, []);

  const persist = (p, s) => { lsSet("roPlan", p); lsSet("roState", s); };

  const showToast = (msg, type) => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  const handleSetup = (p) => {
    const s = { ...defState, AB: parseFloat(p.starting) };
    setPlan(p); setSt(s); persist(p, s); setView("app");
  };

  const logBet = (result) => {
    let ns = { ...st, history: [...st.history] };
    const openAB = ns.AB;
    let wd = 0, reasons = [];
    if (result === "WIN") {
      const w = calcWD(ns.AB, ns.day, ns.lastWD, ns.crossed, plan.wdPct);
      wd = w.wd; reasons = w.reasons;
      if (wd > 0) {
        ns.AB -= wd; ns.SR += wd; ns.totalSR += wd;
        if (ns.day % 7 === 0) ns.lastWD = ns.day;
        for (const ms of MILESTONES)
          if (openAB >= ms && !ns.crossed.includes(ms)) ns.crossed = [...ns.crossed, ms];
      }
      ns.AB = ns.AB * plan.odds;
      ns.streak = (ns.streak || 0) + 1;
    } else {
      const rAB = ns.SR > 0 ? ns.SR * 0.6 : parseFloat(plan.starting);
      ns.SR  = ns.SR > 0 ? ns.SR * 0.4 : 0;
      ns.AB  = rAB; ns.streak = 0; ns.losses = (ns.losses || 0) + 1;
    }
    ns.history.push({ day:ns.day, result, openAB, closeAB:ns.AB, closeSR:ns.SR, wd, reasons });
    ns.day += 1;
    setFlash(result); setTimeout(() => setFlash(null), 1600);
    setSt(ns); persist(plan, ns);
    showToast(
      result === "WIN" ? `✅ Bank → ${fmt(ns.AB, plan.currency)}` : `❌ Restarted @ ${fmt(ns.AB, plan.currency)}`,
      result === "WIN" ? "win" : "loss"
    );
  };

  const reset = () => {
    localStorage.removeItem("roPlan"); localStorage.removeItem("roState");
    setPlan(defPlan); setSt(defState); setView("setup");
  };

  if (view === "loading") return <Splash />;
  if (view === "setup")   return <Setup onSetup={handleSetup} />;

  const risk    = riskInfo(st.streak || 0, st.AB, st.SR, st.day);
  const wdCalc  = calcWD(st.AB, st.day, st.lastWD, st.crossed, plan.wdPct);
  const nextWD  = 7 - ((st.day - 1) % 7);

  return (
    <div style={C.wrap}>
      <style>{CSS}</style>

      {flash && (
        <div style={{ ...C.flash, background: flash==="WIN" ? "rgba(0,230,118,0.12)" : "rgba(255,23,68,0.12)" }}>
          <div style={{ fontSize:64, animation:"pop .5s ease" }}>{flash==="WIN" ? "✅" : "❌"}</div>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:26, letterSpacing:3, color: flash==="WIN" ? "#00E676" : "#FF1744" }}>
            {flash==="WIN" ? "CHAIN HOLDS!" : "CHAIN BROKE"}
          </div>
        </div>
      )}

      {toast && (
        <div style={{ ...C.toast, background: toast.type==="win" ? "#00E676" : toast.type==="loss" ? "#FF1744" : "#FFC107" }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={C.hdr}>
        <div>
          <div style={C.hTitle}>{plan.name}</div>
          <div style={C.hSub}>Day {st.day - 1} done · ×{plan.odds} · {plan.currency}</div>
        </div>
        <div style={{ ...C.badge, background: risk.bg, color: risk.color, border:`1px solid ${risk.color}44` }}>
          {risk.label}
        </div>
      </div>

      {/* Tabs */}
      <div style={C.tabWrap}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ ...C.tab, ...(tab===t ? { color:"#00E676", borderBottom:"2px solid #00E676" } : {}) }}>
            {t}
          </button>
        ))}
      </div>

      <div style={C.body}>
        {tab==="TODAY"   && <TodayTab   plan={plan} st={st} risk={risk} nextWD={nextWD} wdCalc={wdCalc} onBet={logBet} />}
        {tab==="HISTORY" && <HistTab    plan={plan} st={st} />}
        {tab==="RESERVE" && <SRTab      plan={plan} st={st} />}
        {tab==="SETTINGS"&& <SetTab     plan={plan} onReset={reset} />}
      </div>
    </div>
  );
}

// ── TODAY ─────────────────────────────────────────────────────────────────────
function TodayTab({ plan, st, risk, nextWD, wdCalc, onBet }) {
  const pot   = st.AB * plan.odds;
  const profit= pot - st.AB;
  const total = st.AB + st.SR;
  const roi   = ((total - plan.starting) / plan.starting * 100).toFixed(1);

  return (
    <div style={{ animation:"up .3s ease" }}>
      {/* Risk */}
      <div style={{ ...C.card, background:risk.bg, border:`1px solid ${risk.color}22`, padding:"12px 14px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={C.mono10}>RISK — DAY {st.day}</span>
          <span style={{ ...C.mono10, fontWeight:700, color:risk.color, fontSize:12 }}>{risk.label}</span>
        </div>
        <div style={{ margin:"8px 0 6px", height:4, background:"#111", borderRadius:2 }}>
          <div style={{ height:"100%", borderRadius:2, background:risk.color, width:`${risk.bar*100}%`, transition:"width .5s ease" }} />
        </div>
        <div style={{ display:"flex", gap:16 }}>
          <span style={C.mono9}>🔥 Streak: {st.streak||0}</span>
          <span style={C.mono9}>📅 WD in {nextWD}d</span>
          <span style={C.mono9}>📉 Losses: {st.losses||0}</span>
        </div>
      </div>

      {/* Bank card */}
      <div style={{ ...C.card, background:"linear-gradient(135deg,#050f1a,#0a1f35)", border:"1px solid #0d2a45" }}>
        <div style={C.mono9gray}>ACTIVE BANK</div>
        <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:32, color:"#00E676", letterSpacing:2, lineHeight:1.1, marginTop:4 }}>
          {fmt(st.AB, plan.currency)}
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:12 }}>
          <div>
            <div style={C.mono9gray}>SAFE RESERVE</div>
            <div style={{ ...C.mono13, color:"#F39C12", marginTop:2 }}>{fmt(st.SR, plan.currency)}</div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={C.mono9gray}>TOTAL VALUE</div>
            <div style={{ ...C.mono13, color:"#00E676", marginTop:2 }}>{fmt(total, plan.currency)}</div>
          </div>
        </div>
      </div>

      {/* Bet info */}
      <div style={C.card}>
        <div style={C.ctitle}>TODAY'S BET — DAY {st.day}</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:10 }}>
          {[["STAKE", fmt(st.AB,plan.currency), "#2E86C1"],
            ["IF WIN", fmt(pot,plan.currency), "#00E676"],
            ["PROFIT", "+"+fmt(profit,plan.currency), "#00E676"],
            ["ODDS", "× "+plan.odds, "#F39C12"]
          ].map(([l,v,col],i) => (
            <div key={i} style={{ background:"#050a0f", border:"1px solid #0d2137", borderRadius:8, padding:"10px" }}>
              <div style={C.mono9gray}>{l}</div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontWeight:700, color:col, fontSize:12, marginTop:4 }}>{v}</div>
            </div>
          ))}
        </div>
        {wdCalc.wd > 0 && (
          <div style={{ marginTop:10, background:"#1a1400", border:"1px solid #F39C1244", borderRadius:8, padding:10 }}>
            <div style={{ ...C.mono10, fontWeight:700, color:"#F39C12" }}>⚡ WITHDRAWAL DUE TODAY</div>
            {wdCalc.reasons.map((r,i) => (
              <div key={i} style={{ ...C.mono9, color:"#888", marginTop:3 }}>→ {r}</div>
            ))}
          </div>
        )}
      </div>

      {/* ROI */}
      <div style={{ ...C.card, display:"flex", justifyContent:"space-between", alignItems:"center",
        background: parseFloat(roi)>=0 ? "linear-gradient(135deg,#001a08,#002a12)" : "linear-gradient(135deg,#1a0008,#2a0012)",
        border:`1px solid ${parseFloat(roi)>=0?"#00E67622":"#FF174422"}` }}>
        <span style={C.mono9gray}>TOTAL ROI</span>
        <span style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:26, letterSpacing:2,
          color: parseFloat(roi)>=0 ? "#00E676" : "#FF1744" }}>
          {parseFloat(roi)>=0?"+":""}{roi}%
        </span>
      </div>

      {/* Streak warning */}
      {(st.streak||0) >= 7 && (
        <div style={{ ...C.card, background:"#1a0800", border:"1px solid #FF6B3544", padding:"10px 14px" }}>
          <div style={{ ...C.mono10, fontWeight:700, color:"#FF6B35" }}>⚠️ {st.streak} WIN STREAK — HIGH RISK</div>
          <div style={{ ...C.mono9, color:"#888", marginTop:4, lineHeight:1.5 }}>Withdraw extra to SR before betting today.</div>
        </div>
      )}

      {/* Win / Loss */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginTop:4 }}>
        <button onClick={() => onBet("WIN")}  style={C.winBtn}>
          <div style={{ fontSize:26 }}>✅</div>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:20, letterSpacing:2 }}>WIN</div>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:9, opacity:.7 }}>Bet won · Roll profits</div>
        </button>
        <button onClick={() => onBet("LOSS")} style={C.lossBtn}>
          <div style={{ fontSize:26 }}>❌</div>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:20, letterSpacing:2 }}>LOSS</div>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:9, opacity:.7 }}>Chain broke · Restart SR</div>
        </button>
      </div>
    </div>
  );
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
function HistTab({ plan, st }) {
  const hist = [...st.history].reverse();
  const wins = st.history.filter(h => h.result==="WIN").length;
  if (!hist.length) return (
    <div style={{ textAlign:"center", paddingTop:60, color:"#333", fontFamily:"'Space Mono',monospace" }}>
      <div style={{ fontSize:40 }}>📋</div>
      <div style={{ marginTop:12, fontSize:12 }}>No bets logged yet</div>
    </div>
  );
  return (
    <div style={{ animation:"up .3s ease" }}>
      <div style={{ ...C.mono9, color:"#444", marginBottom:10, letterSpacing:1 }}>
        {hist.length} BETS · {wins}W / {st.losses||0}L · WR {hist.length > 0 ? (wins/hist.length*100).toFixed(1) : 0}%
      </div>
      {hist.map((h,i) => (
        <div key={i} style={{ ...C.card, borderLeft:`3px solid ${h.result==="WIN"?"#00E676":"#FF1744"}`, paddingLeft:12 }}>
          <div style={{ display:"flex", justifyContent:"space-between" }}>
            <div>
              <div style={C.mono9gray}>Day {h.day}</div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontWeight:700, fontSize:12, marginTop:2,
                color: h.result==="WIN" ? "#00E676" : "#FF1744" }}>
                {h.result==="WIN" ? "✅ WIN" : "❌ LOSS"}
              </div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={C.mono9gray}>{fmt(h.openAB, plan.currency)}</div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontWeight:700, fontSize:11, marginTop:2,
                color: h.result==="WIN" ? "#00E676" : "#FF1744" }}>
                → {fmt(h.closeAB, plan.currency)}
              </div>
            </div>
          </div>
          {h.wd > 0 && (
            <div style={{ marginTop:6, background:"#1a1400", borderRadius:4, padding:"4px 8px",
              fontFamily:"'Space Mono',monospace", fontSize:10, color:"#F39C12" }}>
              💰 To SR: {fmt(h.wd, plan.currency)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── RESERVE ───────────────────────────────────────────────────────────────────
function SRTab({ plan, st }) {
  const total  = st.AB + st.SR;
  const roi    = ((total - plan.starting) / plan.starting * 100).toFixed(1);
  const ratio  = (st.SR / Math.max(st.AB,1) * 100).toFixed(1);
  const wdHist = (st.history||[]).filter(h => h.wd > 0);

  return (
    <div style={{ animation:"up .3s ease" }}>
      <div style={{ ...C.card, background:"linear-gradient(135deg,#1a1000,#2a1f00)", border:"1px solid #F39C1222" }}>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:9, color:"#F39C12", letterSpacing:2 }}>SAFE RESERVE</div>
        <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:32, color:"#F39C12", letterSpacing:2, lineHeight:1.1, marginTop:4 }}>
          {fmt(st.SR, plan.currency)}
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:12 }}>
          <div>
            <div style={C.mono9gray}>SR/AB RATIO</div>
            <div style={{ ...C.mono13, color: parseFloat(ratio)>30?"#00E676":parseFloat(ratio)>10?"#FFC107":"#FF1744", marginTop:2 }}>
              {ratio}%
            </div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={C.mono9gray}>TOTAL SENT TO SR</div>
            <div style={{ ...C.mono13, color:"#F39C12", marginTop:2 }}>{fmt(st.totalSR||0, plan.currency)}</div>
          </div>
        </div>
      </div>

      <div style={C.card}>
        <div style={C.ctitle}>PLAN STATS</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:10 }}>
          {[["DAYS RUN", st.day-1, "#2E86C1"],
            ["WINS", (st.history||[]).filter(h=>h.result==="WIN").length, "#00E676"],
            ["LOSSES", st.losses||0, "#FF1744"],
            ["STREAK", st.streak||0, "#F39C12"],
            ["TOTAL VALUE", fmt(total,plan.currency), "#00E676"],
            ["ROI", (parseFloat(roi)>=0?"+":"")+roi+"%", "#00E676"]
          ].map(([l,v,col],i) => (
            <div key={i} style={{ background:"#050a0f", border:"1px solid #0d2137", borderRadius:8, padding:"10px" }}>
              <div style={C.mono9gray}>{l}</div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontWeight:700, color:col, fontSize:12, marginTop:4 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={C.card}>
        <div style={C.ctitle}>WITHDRAWAL LOG ({wdHist.length})</div>
        {!wdHist.length && <div style={{ ...C.mono9, color:"#333", marginTop:10 }}>No withdrawals yet</div>}
        {wdHist.map((h,i) => (
          <div key={i} style={{ borderBottom:"1px solid #0d2137", padding:"8px 0", fontFamily:"'Space Mono',monospace" }}>
            <div style={{ display:"flex", justifyContent:"space-between" }}>
              <span style={{ color:"#555", fontSize:10 }}>Day {h.day}</span>
              <span style={{ color:"#F39C12", fontWeight:700, fontSize:11 }}>+{fmt(h.wd, plan.currency)}</span>
            </div>
            {(h.reasons||[]).map((r,j) => (
              <div key={j} style={{ color:"#444", fontSize:9, marginTop:2 }}>→ {r}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function SetTab({ plan, onReset }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div style={{ animation:"up .3s ease" }}>
      <div style={C.card}>
        <div style={C.ctitle}>YOUR PLAN CONFIG</div>
        {[["Plan Name", plan.name], ["Odds", "× "+plan.odds], ["Currency", plan.currency],
          ["Starting Capital", fmt(plan.starting, plan.currency)],
          ["Weekly WD %", (plan.wdPct*100).toFixed(0)+"%"],
          ["Milestone WD", "35% of AB"], ["Loss Restart", "60% of SR → new AB"],
          ["SR Retained", "40% stays protected after loss"]
        ].map(([l,v],i) => (
          <div key={i} style={{ display:"flex", justifyContent:"space-between", borderBottom:"1px solid #0d2137",
            padding:"9px 0", fontFamily:"'Space Mono',monospace" }}>
            <span style={{ color:"#555", fontSize:10 }}>{l}</span>
            <span style={{ color:"#2E86C1", fontSize:11, fontWeight:700 }}>{v}</span>
          </div>
        ))}
      </div>

      <div style={C.card}>
        <div style={C.ctitle}>TELEGRAM BOT COMMANDS</div>
        <div style={{ fontFamily:"'Space Mono',monospace", fontSize:10, color:"#555", lineHeight:1.8, marginTop:8 }}>
          {["/today","/win","/loss","/reserve","/history","/stats"].map(cmd => (
            <div key={cmd} style={{ color:"#2E86C1", fontWeight:700 }}>{cmd}</div>
          ))}
        </div>
      </div>

      <div style={{ marginTop:16 }}>
        {!confirm ? (
          <button onClick={() => setConfirm(true)}
            style={{ ...C.lossBtn, width:"100%", padding:14, justifyContent:"center" }}>
            🗑️ Reset Plan & Start Over
          </button>
        ) : (
          <div style={C.card}>
            <div style={{ color:"#FF1744", fontFamily:"'Space Mono',monospace", fontWeight:700, marginBottom:12, fontSize:12 }}>
              ⚠️ All data will be deleted. Sure?
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
              <button onClick={onReset}           style={{ ...C.lossBtn, padding:12, justifyContent:"center" }}>YES, RESET</button>
              <button onClick={() => setConfirm(false)} style={{ ...C.winBtn,  padding:12, justifyContent:"center" }}>CANCEL</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── SETUP ─────────────────────────────────────────────────────────────────────
function Setup({ onSetup }) {
  const fields = [
    { k:"name",     label:"Plan Name",           ph:"e.g. My Rollover Plan",   type:"text"   },
    { k:"starting", label:"Starting Capital",    ph:"e.g. 50000",              type:"number" },
    { k:"odds",     label:"Daily Bet Odds",      ph:"e.g. 1.10 / 1.20 / 1.50",type:"number" },
    { k:"currency", label:"Currency",            ph:"e.g. TSH",                type:"text"   },
    { k:"wdPct",    label:"Weekly Withdrawal %", ph:"e.g. 25",                 type:"number" },
  ];
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ name:"My Rollover Plan", starting:"50000", odds:"1.20", currency:"TSH", wdPct:"25" });

  const next = () => {
    if (step < fields.length - 1) setStep(s => s + 1);
    else onSetup({ ...form, odds:parseFloat(form.odds), starting:parseFloat(form.starting), wdPct:parseFloat(form.wdPct)/100 });
  };

  return (
    <div style={{ ...C.wrap, display:"flex", flexDirection:"column", justifyContent:"center", padding:24, minHeight:"100vh" }}>
      <style>{CSS}</style>
      <div style={{ textAlign:"center", marginBottom:36 }}>
        <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:52, color:"#00E676", letterSpacing:5, lineHeight:1 }}>ROLLOVER</div>
        <div style={{ fontFamily:"'Space Mono',monospace", color:"#444", fontSize:11, letterSpacing:3, marginTop:4 }}>SMART BETTING TRACKER</div>
      </div>
      <div style={C.card}>
        <div style={{ ...C.mono9, color:"#444", letterSpacing:1, marginBottom:14 }}>
          STEP {step+1} / {fields.length} — {fields[step].label.toUpperCase()}
        </div>
        <div style={{ height:3, background:"#111", borderRadius:2, marginBottom:20 }}>
          <div style={{ height:"100%", background:"#00E676", borderRadius:2,
            width:`${((step+1)/fields.length)*100}%`, transition:"width .35s ease" }} />
        </div>
        <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:20, color:"#fff", letterSpacing:2, marginBottom:12 }}>
          {fields[step].label}
        </div>
        <input
          type={fields[step].type} placeholder={fields[step].ph}
          value={form[fields[step].k]}
          onChange={e => setForm({ ...form, [fields[step].k]: e.target.value })}
          onKeyDown={e => e.key==="Enter" && next()}
          style={C.input} autoFocus
        />
        <div style={{ display:"flex", gap:10, marginTop:14 }}>
          {step > 0 && (
            <button onClick={() => setStep(s => s-1)}
              style={{ ...C.winBtn, flex:1, background:"transparent", border:"1px solid #2E86C1", color:"#2E86C1" }}>
              ← BACK
            </button>
          )}
          <button onClick={next}
            style={{ ...C.winBtn, flex:2, background: step===fields.length-1
              ? "linear-gradient(135deg,#00E676,#1E8449)"
              : "linear-gradient(135deg,#2E86C1,#1A3C5E)" }}>
            {step < fields.length-1 ? "NEXT →" : "🚀 START PLAN"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div style={{ ...C.wrap, display:"flex", alignItems:"center", justifyContent:"center", minHeight:"100vh" }}>
      <style>{CSS}</style>
      <div style={{ textAlign:"center" }}>
        <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:52, color:"#00E676", letterSpacing:5, animation:"pulse 1s infinite" }}>
          ROLLOVER
        </div>
        <div style={{ fontFamily:"'Space Mono',monospace", color:"#333", fontSize:11, marginTop:8 }}>Loading...</div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const C = {
  wrap:    { background:"#050a0f", minHeight:"100vh", maxWidth:430, margin:"0 auto", position:"relative", paddingBottom:24 },
  hdr:     { background:"linear-gradient(135deg,#050a0f,#0a1628)", padding:"14px 16px 12px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid #0d2137" },
  hTitle:  { fontFamily:"'Bebas Neue',sans-serif", fontSize:20, color:"#fff", letterSpacing:2 },
  hSub:    { fontFamily:"'Space Mono',monospace", fontSize:9, color:"#444", marginTop:2, letterSpacing:1 },
  badge:   { padding:"4px 10px", borderRadius:20, fontFamily:"'Space Mono',monospace", fontWeight:700, fontSize:10, letterSpacing:1 },
  tabWrap: { display:"flex", background:"#080e16", borderBottom:"1px solid #0d2137" },
  tab:     { flex:1, padding:"10px 0", background:"none", border:"none", borderBottom:"2px solid transparent", color:"#333", fontFamily:"'Space Mono',monospace", fontSize:9, cursor:"pointer", letterSpacing:1, transition:"all .2s" },
  body:    { padding:"12px 14px" },
  card:    { background:"#080e16", border:"1px solid #0d2137", borderRadius:12, padding:14, marginBottom:10 },
  ctitle:  { fontFamily:"'Space Mono',monospace", fontSize:9, color:"#444", letterSpacing:2, marginBottom:2 },
  mono9:   { fontFamily:"'Space Mono',monospace", fontSize:9, letterSpacing:1 },
  mono9gray:{ fontFamily:"'Space Mono',monospace", fontSize:9, color:"#555", letterSpacing:1, marginBottom:2 },
  mono10:  { fontFamily:"'Space Mono',monospace", fontSize:10, letterSpacing:1 },
  mono13:  { fontFamily:"'Space Mono',monospace", fontWeight:700, fontSize:13 },
  winBtn:  { background:"linear-gradient(135deg,#00E676,#1E8449)", border:"none", borderRadius:12, color:"#fff", padding:"14px 8px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:4, fontFamily:"'Space Mono',monospace", fontSize:11, boxShadow:"0 4px 15px rgba(0,230,118,0.15)", transition:"transform .1s" },
  lossBtn: { background:"linear-gradient(135deg,#FF1744,#7f0d22)", border:"none", borderRadius:12, color:"#fff", padding:"14px 8px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:4, fontFamily:"'Space Mono',monospace", fontSize:11, boxShadow:"0 4px 15px rgba(255,23,68,0.15)", transition:"transform .1s" },
  input:   { width:"100%", background:"#050a0f", border:"1px solid #1e3a5f", borderRadius:8, padding:"13px 12px", color:"#fff", fontFamily:"'Space Mono',monospace", fontSize:13, outline:"none" },
  flash:   { position:"fixed", top:0, left:0, right:0, bottom:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", zIndex:100, backdropFilter:"blur(10px)", gap:12 },
  toast:   { position:"fixed", top:16, left:"50%", transform:"translateX(-50%)", padding:"9px 18px", borderRadius:20, fontFamily:"'Space Mono',monospace", fontSize:10, color:"#000", fontWeight:700, zIndex:200, whiteSpace:"nowrap", maxWidth:"90vw", overflow:"hidden", textOverflow:"ellipsis" },
  input2:  { width:"100%", background:"#050a0f", border:"1px solid #1e3a5f", borderRadius:8, padding:"13px 12px", color:"#fff", fontFamily:"'Space Mono',monospace", fontSize:13, outline:"none" },
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&display=swap');
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:#050a0f; -webkit-tap-highlight-color:transparent; }
  @keyframes pop   { 0%{transform:scale(0)} 60%{transform:scale(1.2)} 100%{transform:scale(1)} }
  @keyframes up    { from{transform:translateY(16px);opacity:0} to{transform:translateY(0);opacity:1} }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-track{background:#050a0f} ::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:2px}
  button:active { transform:scale(.97) }
  input:focus   { border-color:#2E86C1 !important; }
`;
