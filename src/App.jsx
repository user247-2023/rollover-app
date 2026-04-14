import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════
   ROLLOVER TRACKER — DARK LUXURY TRADING TERMINAL
   Fonts: Orbitron (display) + DM Mono (data)
═══════════════════════════════════════════════════════════ */

const MILESTONES = [100000,500000,1000000,5000000,10000000,50000000,100000000,500000000,1000000000];

function fmt(n, cur="TSH") {
  if (!n && n!==0) return `${cur} 0`;
  const a=Math.abs(n);
  let s;
  if(a>=1e12) s=(n/1e12).toFixed(3)+"T";
  else if(a>=1e9) s=(n/1e9).toFixed(3)+"B";
  else if(a>=1e6) s=(n/1e6).toFixed(3)+"M";
  else if(a>=1e3) s=Math.round(n).toLocaleString();
  else s=Math.round(n)+"";
  return `${cur} ${s}`;
}

function riskInfo(streak,AB,SR){
  const r=SR/Math.max(AB,1);
  if(streak>=10||r<0.05) return{label:"CRITICAL",short:"CRIT",color:"#FF1744",glow:"rgba(255,23,68,0.4)",bar:1};
  if(streak>=7||r<0.15)  return{label:"HIGH RISK",short:"HIGH",color:"#FF6D00",glow:"rgba(255,109,0,0.35)",bar:0.75};
  if(streak>=4||r<0.30)  return{label:"MODERATE",short:"MOD",color:"#FFD600",glow:"rgba(255,214,0,0.3)",bar:0.5};
  return                        {label:"SAFE ZONE",short:"SAFE",color:"#00E5FF",glow:"rgba(0,229,255,0.3)",bar:0.25};
}

function calcWD(AB,day,lastWD,crossed,wdPct){
  let wd=0,reasons=[];
  if(day%7===0&&day!==lastWD){const w=AB*wdPct;wd+=w;reasons.push(`Weekly (${(wdPct*100).toFixed(0)}%): ${fmt(w)}`);}
  for(const ms of MILESTONES){if(AB>=ms&&!crossed.includes(ms)){const w=AB*0.35;wd+=w;reasons.push(`Milestone ${fmt(ms)}: ${fmt(w)}`);}}
  return{wd,reasons};
}

function lsGet(k){try{const v=localStorage.getItem(k);return v?JSON.parse(v):null;}catch{return null;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch{}}
function makeState(s){return{day:1,AB:parseFloat(s),SR:0,totalSR:0,streak:0,losses:0,lastWD:0,crossed:[],history:[]};}

const PRESETS=[
  {id:"alpha",label:"ALPHA",color:"#00E5FF",glow:"rgba(0,229,255,0.5)",gradient:"linear-gradient(135deg,#00E5FF,#0091EA)",odds:1.10,wdPct:0.25,emoji:"α"},
  {id:"beta", label:"BETA", color:"#69FF47",glow:"rgba(105,255,71,0.5)",gradient:"linear-gradient(135deg,#69FF47,#00C853)",odds:1.20,wdPct:0.25,emoji:"β"},
  {id:"gamma",label:"GAMMA",color:"#E040FB",glow:"rgba(224,64,251,0.5)",gradient:"linear-gradient(135deg,#E040FB,#AA00FF)",odds:1.50,wdPct:0.30,emoji:"γ"},
];
const TABS=["TODAY","HISTORY","RESERVE","SETTINGS"];

/* ── Animated counter hook ────────────────────────────────── */
function useCountUp(target, duration=600){
  const [val,setVal]=useState(target);
  const prev=useRef(target);
  useEffect(()=>{
    if(prev.current===target){return;}
    const start=prev.current, diff=target-start, startTime=Date.now();
    prev.current=target;
    const tick=()=>{
      const elapsed=Date.now()-startTime, progress=Math.min(elapsed/duration,1);
      const ease=1-Math.pow(1-progress,4);
      setVal(start+diff*ease);
      if(progress<1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },[target,duration]);
  return val;
}

/* ── Particle burst ───────────────────────────────────────── */
function ParticleBurst({active,color,onDone}){
  const [particles]=useState(()=>Array.from({length:20},(_,i)=>({
    id:i, angle:(i/20)*360, speed:60+Math.random()*80, size:3+Math.random()*5
  })));
  useEffect(()=>{if(active){const t=setTimeout(onDone,1000);return()=>clearTimeout(t);}},[active]);
  if(!active) return null;
  return(
    <div style={{position:"fixed",top:"50%",left:"50%",zIndex:200,pointerEvents:"none"}}>
      {particles.map(p=>(
        <div key={p.id} style={{position:"absolute",width:p.size,height:p.size,borderRadius:"50%",
          background:color,boxShadow:`0 0 ${p.size*2}px ${color}`,
          animation:`burst-${p.id} 0.8s cubic-bezier(0,.9,.57,1) forwards`,
          transform:"translate(-50%,-50%)"
        }}/>
      ))}
      <style>{particles.map(p=>{
        const rad=p.angle*Math.PI/180;
        const x=Math.cos(rad)*p.speed, y=Math.sin(rad)*p.speed;
        return`@keyframes burst-${p.id}{0%{transform:translate(-50%,-50%) scale(1);opacity:1}100%{transform:translate(calc(-50% + ${x}px),calc(-50% + ${y}px)) scale(0);opacity:0}}`;
      }).join("")}</style>
    </div>
  );
}

/* ── Animated grid background ────────────────────────────── */
function GridBG({color="#00E5FF"}){
  return(
    <div style={{position:"fixed",inset:0,zIndex:0,overflow:"hidden",pointerEvents:"none"}}>
      {/* Radial glow */}
      <div style={{position:"absolute",top:"30%",left:"50%",transform:"translate(-50%,-50%)",
        width:600,height:600,borderRadius:"50%",
        background:`radial-gradient(circle, ${color}08 0%, transparent 70%)`,
        animation:"breathe 4s ease-in-out infinite"}}/>
      {/* Grid lines */}
      <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:0.04}}>
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke={color} strokeWidth="0.5"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)"/>
      </svg>
      {/* Scanline */}
      <div style={{position:"absolute",left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${color}30,transparent)`,animation:"scanline 6s linear infinite"}}/>
      <style>{`
        @keyframes breathe{0%,100%{opacity:.6;transform:translate(-50%,-50%) scale(1)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.1)}}
        @keyframes scanline{0%{top:-2px}100%{top:100vh}}
      `}</style>
    </div>
  );
}

/* ── Screen shake ─────────────────────────────────────────── */
function useShake(){
  const [shaking,setShaking]=useState(false);
  const shake=()=>{setShaking(true);setTimeout(()=>setShaking(false),500);};
  return[shaking,shake];
}

/* ═══════════════════════════════════════ ROOT APP ══════════ */
export default function App(){
  const [allPlans,setAllPlans]=useState({});
  const [active,setActive]=useState("alpha");
  const [view,setView]=useState("loading");
  const [tab,setTab]=useState("TODAY");
  const [toast,setToast]=useState(null);
  const [burst,setBurst]=useState(null);
  const [shaking,shake]=useShake();
  const [setupId,setSetupId]=useState(null);
  const [prevView,setPrevView]=useState(null);

  useEffect(()=>{
    setTimeout(()=>{
      const s=lsGet("allPlans")||{};
      setAllPlans(s);
      setView("home");
    },1800);
  },[]);

  const persist=u=>{lsSet("allPlans",u);};
  const showToast=(msg,type)=>{setToast({msg,type});setTimeout(()=>setToast(null),3000);};

  const navigate=(v,id=null)=>{
    setPrevView(view);
    if(id)setSetupId(id);
    if(id&&v==="plan"){setActive(id);setTab("TODAY");}
    setView(v);
  };

  const handleSetup=(id,planData)=>{
    const u={...allPlans,[id]:{plan:planData,state:makeState(planData.starting)}};
    setAllPlans(u);persist(u);navigate("plan",id);
  };

  const logBet=result=>{
    const{plan,state:st}=allPlans[active];
    let ns={...st,history:[...st.history],crossed:[...st.crossed]};
    const openAB=ns.AB;let wd=0,reasons=[];
    if(result==="WIN"){
      const w=calcWD(ns.AB,ns.day,ns.lastWD,ns.crossed,plan.wdPct);
      wd=w.wd;reasons=w.reasons;
      if(wd>0){ns.AB-=wd;ns.SR+=wd;ns.totalSR+=wd;if(ns.day%7===0)ns.lastWD=ns.day;for(const ms of MILESTONES)if(openAB>=ms&&!ns.crossed.includes(ms))ns.crossed.push(ms);}
      ns.AB=ns.AB*plan.odds;ns.streak=(ns.streak||0)+1;
    }else{
      const rAB=ns.SR>0?ns.SR*0.6:parseFloat(plan.starting);
      ns.SR=ns.SR>0?ns.SR*0.4:0;ns.AB=rAB;ns.streak=0;ns.losses=(ns.losses||0)+1;
    }
    ns.history.push({day:ns.day,result,openAB,closeAB:ns.AB,closeSR:ns.SR,wd,reasons});
    ns.day+=1;
    const u={...allPlans,[active]:{plan,state:ns}};
    setAllPlans(u);persist(u);
    if(result==="WIN"){
      const p=PRESETS.find(p=>p.id===active);
      setBurst({color:p.color});
      showToast(`CHAIN HOLDS — ${fmt(ns.AB,plan.currency)}`,"win");
    }else{
      shake();
      showToast(`CHAIN BROKE — Restarted ${fmt(ns.AB,plan.currency)}`,"loss");
    }
  };

  const deletePlan=id=>{const u={...allPlans};delete u[id];setAllPlans(u);persist(u);navigate("home");};

  const preset=PRESETS.find(p=>p.id===active)||PRESETS[0];

  return(
    <div style={{...S.root,animation:shaking?"shake 0.4s ease":"none"}}>
      <GlobalCSS/>
      <GridBG color={view==="plan"?preset.color:"#00E5FF"}/>

      {burst&&<ParticleBurst active={!!burst} color={burst?.color} onDone={()=>setBurst(null)}/>}

      {toast&&(
        <div style={{...S.toast,
          background:toast.type==="win"
            ?"linear-gradient(135deg,#00E5FF22,#00E5FF11)"
            :"linear-gradient(135deg,#FF174422,#FF174411)",
          border:`1px solid ${toast.type==="win"?"#00E5FF":"#FF1744"}66`,
          color:toast.type==="win"?"#00E5FF":"#FF1744",
          boxShadow:`0 0 30px ${toast.type==="win"?"#00E5FF":"#FF1744"}44`}}>
          {toast.type==="win"?"✦":"✕"} {toast.msg}
        </div>
      )}

      {view==="loading"&&<SplashScreen/>}
      {view==="home"&&<HomeScreen allPlans={allPlans} onOpen={id=>navigate("plan",id)} onAdd={id=>{setSetupId(id);setView("setup");}}/>}
      {view==="setup"&&<SetupScreen presetId={setupId} onSetup={handleSetup} onBack={()=>setView("home")}/>}
      {view==="plan"&&allPlans[active]&&(
        <PlanView plan={allPlans[active].plan} st={allPlans[active].state}
          preset={preset} tab={tab} setTab={setTab}
          onBet={logBet} onBack={()=>setView("home")} onDelete={()=>deletePlan(active)}/>
      )}
    </div>
  );
}

/* ═══════════════════ SPLASH ════════════════════════════════ */
function SplashScreen(){
  return(
    <div style={S.splash}>
      <div style={{textAlign:"center"}}>
        <div style={S.splashLogo}>ROLLOVER</div>
        <div style={S.splashSub}>SMART BETTING TRACKER</div>
        <div style={S.splashBar}>
          <div style={S.splashFill}/>
        </div>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ffffff33",marginTop:16,letterSpacing:3}}>
          INITIALIZING SYSTEM...
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════ HOME ══════════════════════════════════ */
function HomeScreen({allPlans,onOpen,onAdd}){
  const vals=Object.values(allPlans);
  const total=vals.reduce((s,{state:st})=>s+st.AB+st.SR,0);
  const cur=vals[0]?.plan?.currency||"TSH";
  const animTotal=useCountUp(total);

  return(
    <div style={{...S.screen,animation:"fadeUp 0.5s ease"}}>
      {/* Header */}
      <div style={S.homeHeader}>
        <div>
          <div style={S.homeTitle}>ROLLOVER</div>
          <div style={S.homeSub}>MULTI-PLAN TRACKER</div>
        </div>
        <div style={S.versionBadge}>v2.0</div>
      </div>

      {/* Combined value */}
      {vals.length>0&&(
        <div style={S.combinedCard}>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44",letterSpacing:3}}>COMBINED PORTFOLIO</div>
          <div style={S.combinedVal}>{fmt(animTotal,cur)}</div>
          <div style={{display:"flex",gap:20,marginTop:8}}>
            <div><div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",letterSpacing:2}}>ACTIVE PLANS</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontSize:16,color:"#FFD600",marginTop:2}}>{vals.length}/3</div></div>
            <div><div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",letterSpacing:2}}>TOTAL BETS</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontSize:16,color:"#00E5FF",marginTop:2}}>
                {vals.reduce((s,{state:st})=>s+(st.history||[]).length,0)}
              </div></div>
            <div><div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",letterSpacing:2}}>WIN RATE</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontSize:16,color:"#69FF47",marginTop:2}}>
                {(()=>{const h=vals.flatMap(({state:st})=>st.history||[]);return h.length?(h.filter(x=>x.result==="WIN").length/h.length*100).toFixed(0)+"%" :"—"})()}
              </div></div>
          </div>
        </div>
      )}

      <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff22",letterSpacing:3,marginBottom:14,paddingLeft:2}}>
        SELECT PLAN
      </div>

      {PRESETS.map((p,i)=>{
        const exists=!!allPlans[p.id];
        const d=allPlans[p.id];
        const st=d?.state; const pl=d?.plan;
        const tv=exists?st.AB+st.SR:0;
        const risk=exists?riskInfo(st.streak||0,st.AB,st.SR):null;
        const roi=exists?((tv-pl.starting)/pl.starting*100).toFixed(1):null;

        return(
          <button key={p.id} onClick={()=>exists?onOpen(p.id):onAdd(p.id)}
            style={{width:"100%",background:"none",border:"none",padding:0,cursor:"pointer",
              marginBottom:12,animation:`fadeUp ${0.5+i*0.1}s ease`,textAlign:"left"}}>
            <div style={{...S.planCard,border:`1px solid ${exists?p.color+"44":"#ffffff0d"}`,
              boxShadow:exists?`0 0 30px ${p.glow.replace("0.5","0.08")}, inset 0 0 30px ${p.glow.replace("0.5","0.03")}`:"none"}}>
              {/* Top accent line */}
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,
                background:exists?`linear-gradient(90deg,transparent,${p.color},transparent)`:"transparent"}}/>

              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{width:44,height:44,borderRadius:12,
                    background:exists?p.gradient:"linear-gradient(135deg,#ffffff08,#ffffff04)",
                    display:"flex",alignItems:"center",justifyContent:"center",
                    boxShadow:exists?`0 0 20px ${p.glow.replace("0.5","0.3")}`:"none",
                    fontSize:20,fontFamily:"'Orbitron',monospace",color:exists?"#000":"#ffffff22",fontWeight:900}}>
                    {p.emoji}
                  </div>
                  <div>
                    <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:16,
                      color:exists?p.color:"#ffffff22",letterSpacing:2}}>
                      PLAN {p.label}
                    </div>
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",marginTop:3}}>
                      {exists?`×${pl.odds} · ${pl.currency} · DAY ${st.day-1}`:`×${p.odds} odds · TAP TO ACTIVATE`}
                    </div>
                  </div>
                </div>
                {exists?(
                  <div style={{padding:"4px 10px",borderRadius:20,fontFamily:"'DM Mono',monospace",
                    fontWeight:700,fontSize:9,letterSpacing:1,
                    background:`${risk.color}15`,color:risk.color,
                    border:`1px solid ${risk.color}44`,
                    boxShadow:`0 0 10px ${risk.color}22`}}>
                    {risk.short}
                  </div>
                ):(
                  <div style={{padding:"4px 12px",borderRadius:20,fontFamily:"'DM Mono',monospace",
                    fontSize:9,color:"#ffffff22",border:"1px solid #ffffff11"}}>
                    + ADD
                  </div>
                )}
              </div>

              {exists&&(
                <>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:14}}>
                    {[["BANK",fmt(st.AB,pl.currency),p.color],
                      ["RESERVE",fmt(st.SR,pl.currency),"#FFD600"],
                      ["ROI",(parseFloat(roi)>=0?"+":"")+roi+"%",parseFloat(roi)>=0?"#69FF47":"#FF1744"]
                    ].map(([l,v,col],i)=>(
                      <div key={i} style={{background:"#ffffff05",borderRadius:8,padding:"8px 10px",border:"1px solid #ffffff08"}}>
                        <div style={{fontFamily:"'DM Mono',monospace",fontSize:7,color:"#ffffff33",letterSpacing:2,marginBottom:4}}>{l}</div>
                        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:10,color:col}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:16,marginTop:10,paddingTop:10,borderTop:"1px solid #ffffff08"}}>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33"}}>🔥 {st.streak||0} streak</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#69FF4766"}}>✓ {(st.history||[]).filter(h=>h.result==="WIN").length}W</span>
                    <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#FF174466"}}>✕ {st.losses||0}L</span>
                  </div>
                </>
              )}
            </div>
          </button>
        );
      })}

      {vals.length===0&&(
        <div style={{textAlign:"center",padding:"40px 0",fontFamily:"'DM Mono',monospace",fontSize:11,color:"#ffffff22",lineHeight:2}}>
          Activate a plan above to begin tracking.<br/>Run all 3 simultaneously.
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ PLAN VIEW ═════════════════════════════ */
function PlanView({plan,st,preset,tab,setTab,onBet,onBack,onDelete}){
  const risk=riskInfo(st.streak||0,st.AB,st.SR);
  const wdCalc=calcWD(st.AB,st.day,st.lastWD,st.crossed,plan.wdPct);
  const nextWD=7-((st.day-1)%7);

  return(
    <div style={{...S.screen,animation:"fadeUp 0.3s ease"}}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
        padding:"14px 0",borderBottom:`1px solid ${preset.color}22`,marginBottom:14}}>
        <button onClick={onBack} style={S.backBtn}>
          <span style={{marginRight:6}}>←</span> PLANS
        </button>
        <div style={{textAlign:"center"}}>
          <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:18,
            color:preset.color,letterSpacing:3,
            textShadow:`0 0 20px ${preset.glow}`}}>
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

      {/* Tabs */}
      <div style={{display:"flex",gap:4,marginBottom:14,background:"#ffffff05",borderRadius:12,padding:4}}>
        {TABS.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{flex:1,padding:"8px 4px",borderRadius:8,border:"none",cursor:"pointer",
              fontFamily:"'DM Mono',monospace",fontSize:9,letterSpacing:1,transition:"all .25s",
              background:tab===t?preset.gradient:"transparent",
              color:tab===t?"#000000cc":preset.color+"66",
              fontWeight:tab===t?"700":"400",
              boxShadow:tab===t?`0 0 15px ${preset.glow}`:"none"}}>
            {t}
          </button>
        ))}
      </div>

      <div style={{animation:"fadeUp 0.2s ease"}}>
        {tab==="TODAY"   &&<TodayTab    plan={plan} st={st} risk={risk} nextWD={nextWD} wdCalc={wdCalc} onBet={onBet} preset={preset}/>}
        {tab==="HISTORY" &&<HistTab     plan={plan} st={st} preset={preset}/>}
        {tab==="RESERVE" &&<SRTab       plan={plan} st={st} preset={preset}/>}
        {tab==="SETTINGS"&&<SetTab      plan={plan} preset={preset} onDelete={onDelete}/>}
      </div>
    </div>
  );
}

/* ═══════════════════ TODAY TAB ═════════════════════════════ */
function TodayTab({plan,st,risk,nextWD,wdCalc,onBet,preset}){
  const pot=st.AB*plan.odds;
  const profit=pot-st.AB;
  const total=st.AB+st.SR;
  const roi=((total-plan.starting)/plan.starting*100).toFixed(1);
  const animAB=useCountUp(st.AB,800);
  const animSR=useCountUp(st.SR,800);
  const animTotal=useCountUp(total,800);

  return(
    <div>
      {/* Risk meter */}
      <div style={{...S.glassCard,border:`1px solid ${risk.color}33`,
        background:`linear-gradient(135deg, ${risk.color}08, transparent)`,
        marginBottom:10,padding:"12px 14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44",letterSpacing:2}}>
            RISK ASSESSMENT
          </span>
          <span style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,
            color:risk.color,textShadow:`0 0 10px ${risk.glow}`}}>
            {risk.label}
          </span>
        </div>
        {/* Segmented risk bar */}
        <div style={{display:"flex",gap:3,height:5}}>
          {[0.25,0.5,0.75,1].map((seg,i)=>(
            <div key={i} style={{flex:1,borderRadius:3,
              background:risk.bar>=seg
                ?i===0?"#00E5FF":i===1?"#FFD600":i===2?"#FF6D00":"#FF1744"
                :"#ffffff0d",
              boxShadow:risk.bar>=seg?`0 0 8px ${i===0?"#00E5FF":i===1?"#FFD600":i===2?"#FF6D00":"#FF1744"}88`:"none",
              transition:"all .5s ease"}}/>
          ))}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:8}}>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33"}}>🔥 {st.streak||0} streak</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33"}}>⏱ WD in {nextWD}d</span>
          <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33"}}>✕ {st.losses||0} losses</span>
        </div>
      </div>

      {/* Bank card — main hero */}
      <div style={{...S.glassCard,border:`1px solid ${preset.color}33`,
        background:`linear-gradient(135deg,${preset.color}0a,#ffffff03)`,
        boxShadow:`0 0 40px ${preset.glow.replace("0.5","0.08")}, inset 0 0 40px ${preset.glow.replace("0.5","0.02")}`,
        marginBottom:10,position:"relative",overflow:"hidden"}}>
        {/* Decorative corner */}
        <div style={{position:"absolute",top:-20,right:-20,width:80,height:80,borderRadius:"50%",
          background:`radial-gradient(circle,${preset.color}15,transparent)`,pointerEvents:"none"}}/>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:preset.color+"88",letterSpacing:3,marginBottom:4}}>
          ◈ ACTIVE BANK
        </div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:28,
          color:preset.color,lineHeight:1,letterSpacing:1,
          textShadow:`0 0 30px ${preset.glow}`}}>
          {fmt(animAB,plan.currency)}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:14}}>
          <div style={{background:"#ffffff05",borderRadius:10,padding:"10px 12px",border:"1px solid #FFD60022"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#FFD60066",letterSpacing:2,marginBottom:4}}>SAFE RESERVE</div>
            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,color:"#FFD600",fontSize:14}}>{fmt(animSR,plan.currency)}</div>
          </div>
          <div style={{background:"#ffffff05",borderRadius:10,padding:"10px 12px",border:"1px solid #69FF4722"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#69FF4766",letterSpacing:2,marginBottom:4}}>TOTAL VALUE</div>
            <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,color:"#69FF47",fontSize:14}}>{fmt(animTotal,plan.currency)}</div>
          </div>
        </div>
      </div>

      {/* Bet panel */}
      <div style={{...S.glassCard,marginBottom:10}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff22",letterSpacing:3,marginBottom:12}}>
          TODAY'S ROLLOVER — DAY {st.day}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {[
            ["STAKE",      fmt(st.AB,plan.currency), preset.color],
            ["WIN TARGET", fmt(pot,plan.currency),   "#69FF47"],
            ["NET PROFIT", "+"+fmt(profit,plan.currency),"#69FF47"],
            ["ODDS",       "× "+plan.odds,           "#FFD600"],
          ].map(([l,v,col],i)=>(
            <div key={i} style={{background:"#ffffff04",border:`1px solid ${col}18`,
              borderRadius:10,padding:"10px 12px",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,
                background:`linear-gradient(90deg,transparent,${col}44,transparent)`}}/>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:col+"66",letterSpacing:2,marginBottom:6}}>{l}</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,color:col,fontSize:12}}>{v}</div>
            </div>
          ))}
        </div>

        {wdCalc.wd>0&&(
          <div style={{marginTop:10,background:"#FFD60008",border:"1px solid #FFD60033",
            borderRadius:10,padding:"10px 12px"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:10,
              color:"#FFD600",letterSpacing:1,marginBottom:6}}>
              ⚡ WITHDRAWAL TRIGGERED
            </div>
            {wdCalc.reasons.map((r,i)=>(
              <div key={i} style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#FFD60088",marginTop:2}}>
                › {r}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ROI strip */}
      <div style={{...S.glassCard,display:"flex",justifyContent:"space-between",alignItems:"center",
        marginBottom:10,padding:"12px 16px",
        background:parseFloat(roi)>=0?"linear-gradient(135deg,#69FF4708,transparent)":"linear-gradient(135deg,#FF174408,transparent)",
        border:`1px solid ${parseFloat(roi)>=0?"#69FF4722":"#FF174422"}`}}>
        <div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff33",letterSpacing:2}}>TOTAL RETURN</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44",marginTop:2}}>
            Since Day 1 · {plan.currency}
          </div>
        </div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:28,letterSpacing:1,
          color:parseFloat(roi)>=0?"#69FF47":"#FF1744",
          textShadow:`0 0 20px ${parseFloat(roi)>=0?"rgba(105,255,71,0.5)":"rgba(255,23,68,0.5)"}`}}>
          {parseFloat(roi)>=0?"+":""}{roi}%
        </div>
      </div>

      {/* Streak warning */}
      {(st.streak||0)>=7&&(
        <div style={{...S.glassCard,marginBottom:10,
          background:"linear-gradient(135deg,#FF6D0010,transparent)",
          border:"1px solid #FF6D0033",padding:"10px 14px",animation:"pulse-warn 2s ease infinite"}}>
          <div style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:11,color:"#FF6D00",marginBottom:4}}>
            ⚠ STREAK ALERT — {st.streak} CONSECUTIVE WINS
          </div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#FF6D0088",lineHeight:1.6}}>
            Extended streaks increase variance risk. Consider moving extra funds to Safe Reserve before placing today's bet.
          </div>
        </div>
      )}

      {/* WIN / LOSS buttons */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:4}}>
        <button onClick={()=>onBet("WIN")} style={{...S.winBtn,
          boxShadow:`0 4px 30px rgba(105,255,71,0.3), 0 0 60px rgba(105,255,71,0.1)`}}>
          <div style={{fontSize:28,marginBottom:4}}>✦</div>
          <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:18,letterSpacing:3}}>WIN</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,opacity:.7,marginTop:2}}>Roll all profits forward</div>
          <div style={{position:"absolute",top:0,left:0,right:0,height:1,
            background:"linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent)"}}/>
        </button>
        <button onClick={()=>onBet("LOSS")} style={{...S.lossBtn,
          boxShadow:`0 4px 30px rgba(255,23,68,0.3), 0 0 60px rgba(255,23,68,0.1)`}}>
          <div style={{fontSize:28,marginBottom:4}}>✕</div>
          <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:18,letterSpacing:3}}>LOSS</div>
          <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,opacity:.7,marginTop:2}}>Chain broke · Restart SR</div>
          <div style={{position:"absolute",top:0,left:0,right:0,height:1,
            background:"linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent)"}}/>
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════ HISTORY TAB ═══════════════════════════ */
function HistTab({plan,st,preset}){
  const hist=[...st.history].reverse();
  const wins=st.history.filter(h=>h.result==="WIN").length;
  const wr=hist.length>0?(wins/hist.length*100).toFixed(1):0;

  if(!hist.length) return(
    <div style={{textAlign:"center",padding:"60px 0",color:"#ffffff22",fontFamily:"'DM Mono',monospace"}}>
      <div style={{fontSize:40,marginBottom:12,opacity:.3}}>◈</div>
      <div style={{letterSpacing:2}}>NO BETS LOGGED YET</div>
    </div>
  );

  return(
    <div>
      {/* Stats bar */}
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
          borderLeft:`2px solid ${h.result==="WIN"?"#69FF47":"#FF1744"}`,
          animation:`fadeUp ${0.1+i*0.03}s ease`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",marginBottom:4}}>
                DAY {h.day}
              </div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,
                color:h.result==="WIN"?"#69FF47":"#FF1744"}}>
                {h.result==="WIN"?"✦ WIN":"✕ LOSS"}
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",marginBottom:4}}>
                {fmt(h.openAB,plan.currency)}
              </div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,
                color:h.result==="WIN"?"#69FF47":"#FF1744"}}>
                → {fmt(h.closeAB,plan.currency)}
              </div>
            </div>
          </div>
          {h.wd>0&&(
            <div style={{marginTop:8,background:"#FFD60008",borderRadius:6,padding:"5px 8px",
              fontFamily:"'DM Mono',monospace",fontSize:9,color:"#FFD60088"}}>
              ⚡ Withdrawn to SR: {fmt(h.wd,plan.currency)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════ RESERVE TAB ═══════════════════════════ */
function SRTab({plan,st,preset}){
  const total=st.AB+st.SR;
  const roi=((total-plan.starting)/plan.starting*100).toFixed(1);
  const ratio=(st.SR/Math.max(st.AB,1)*100).toFixed(1);
  const wdHist=(st.history||[]).filter(h=>h.wd>0);
  const animSR=useCountUp(st.SR,800);

  return(
    <div>
      {/* SR hero */}
      <div style={{...S.glassCard,border:"1px solid #FFD60033",
        background:"linear-gradient(135deg,#FFD60008,transparent)",
        boxShadow:"0 0 40px rgba(255,214,0,0.06)",marginBottom:10}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#FFD60066",letterSpacing:3,marginBottom:4}}>
          ◈ SAFE RESERVE
        </div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:26,
          color:"#FFD600",textShadow:"0 0 30px rgba(255,214,0,0.6)"}}>
          {fmt(animSR,plan.currency)}
        </div>

        {/* SR/AB ratio gauge */}
        <div style={{marginTop:14}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff44"}}>SR COVERAGE RATIO</span>
            <span style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:11,
              color:parseFloat(ratio)>30?"#69FF47":parseFloat(ratio)>10?"#FFD600":"#FF1744"}}>
              {ratio}%
            </span>
          </div>
          <div style={{height:6,background:"#ffffff0a",borderRadius:3,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${Math.min(parseFloat(ratio),100)}%`,borderRadius:3,
              background:parseFloat(ratio)>30?"linear-gradient(90deg,#69FF47,#00C853)":parseFloat(ratio)>10?"linear-gradient(90deg,#FFD600,#FF8F00)":"linear-gradient(90deg,#FF1744,#D50000)",
              transition:"width .8s ease",
              boxShadow:parseFloat(ratio)>30?"0 0 10px #69FF4788":parseFloat(ratio)>10?"0 0 10px #FFD60088":"0 0 10px #FF174488"}}/>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:10}}>
            <div>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff22",letterSpacing:2}}>TOTAL SENT TO SR</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,color:"#FFD600",marginTop:2}}>{fmt(st.totalSR||0,plan.currency)}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff22",letterSpacing:2}}>TOTAL ROI</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,
                color:parseFloat(roi)>=0?"#69FF47":"#FF1744",marginTop:2}}>
                {parseFloat(roi)>=0?"+":""}{roi}%
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{...S.glassCard,marginBottom:10}}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff22",letterSpacing:3,marginBottom:12}}>PERFORMANCE METRICS</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {[["DAYS RUN",st.day-1,preset.color],
            ["WINS",(st.history||[]).filter(h=>h.result==="WIN").length,"#69FF47"],
            ["LOSSES",st.losses||0,"#FF1744"],
            ["WIN STREAK",st.streak||0,"#FFD600"],
            ["TOTAL VALUE",fmt(total,plan.currency),"#69FF47"],
            ["WD EVENTS",wdHist.length,"#FFD600"],
          ].map(([l,v,col],i)=>(
            <div key={i} style={{background:"#ffffff04",border:`1px solid ${col}15`,borderRadius:10,padding:"10px 12px",position:"relative",overflow:"hidden"}}>
              <div style={{position:"absolute",top:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${col}33,transparent)`}}/>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:col+"66",letterSpacing:2,marginBottom:6}}>{l}</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,color:col,fontSize:13}}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Withdrawal log */}
      <div style={S.glassCard}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff22",letterSpacing:3,marginBottom:12}}>
          WITHDRAWAL LOG ({wdHist.length})
        </div>
        {!wdHist.length&&<div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ffffff15",textAlign:"center",padding:"16px 0"}}>NO WITHDRAWALS YET</div>}
        {wdHist.map((h,i)=>(
          <div key={i} style={{borderBottom:"1px solid #ffffff06",padding:"10px 0"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33"}}>DAY {h.day}</div>
                {(h.reasons||[]).map((r,j)=>(
                  <div key={j} style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:"#ffffff22",marginTop:2}}>› {r}</div>
                ))}
              </div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,
                color:"#FFD600",textShadow:"0 0 10px rgba(255,214,0,0.4)"}}>
                +{fmt(h.wd,plan.currency)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════ SETTINGS TAB ═════════════════════════ */
function SetTab({plan,preset,onDelete}){
  const [confirm,setConfirm]=useState(false);
  return(
    <div>
      <div style={S.glassCard}>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff22",letterSpacing:3,marginBottom:12}}>
          PLAN CONFIGURATION
        </div>
        {[["Plan",`${preset.emoji} PLAN ${preset.label}`],
          ["Odds","× "+plan.odds],["Currency",plan.currency],
          ["Starting Capital",fmt(plan.starting,plan.currency)],
          ["Weekly Withdrawal",(plan.wdPct*100).toFixed(0)+"% of AB"],
          ["Milestone WD","35% of AB at key milestones"],
          ["Loss Restart","60% of SR becomes new AB"],
          ["SR Protection","40% of SR always retained"],
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
            style={{width:"100%",background:"linear-gradient(135deg,#FF174415,transparent)",
              border:"1px solid #FF174444",borderRadius:12,color:"#FF1744",
              fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:12,
              padding:"14px",cursor:"pointer",letterSpacing:1}}>
            ✕ DELETE THIS PLAN
          </button>
        ):(
          <div style={{...S.glassCard,border:"1px solid #FF174444"}}>
            <div style={{fontFamily:"'DM Mono',monospace",fontWeight:700,fontSize:11,
              color:"#FF1744",marginBottom:14,letterSpacing:1}}>
              ⚠ DELETE PLAN {preset.label}? THIS CANNOT BE UNDONE.
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <button onClick={onDelete} style={{...S.lossBtn,padding:12,fontSize:11}}>CONFIRM DELETE</button>
              <button onClick={()=>setConfirm(false)} style={{...S.winBtn,padding:12,fontSize:11}}>CANCEL</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════ SETUP SCREEN ══════════════════════════ */
function SetupScreen({presetId,onSetup,onBack}){
  const preset=PRESETS.find(p=>p.id===presetId);
  const fields=[
    {k:"name",     label:"PLAN NAME",           ph:`e.g. My ${preset.label} Plan`,type:"text"},
    {k:"starting", label:"STARTING CAPITAL",    ph:"e.g. 50000",                  type:"number"},
    {k:"currency", label:"CURRENCY",            ph:"e.g. TSH",                    type:"text"},
  ];
  const [step,setStep]=useState(0);
  const [form,setForm]=useState({name:`Plan ${preset.label}`,starting:"50000",currency:"TSH"});
  const next=()=>{if(step<fields.length-1)setStep(s=>s+1);else onSetup(presetId,{...form,odds:preset.odds,starting:parseFloat(form.starting),wdPct:preset.wdPct});};

  return(
    <div style={{...S.screen,display:"flex",flexDirection:"column",justifyContent:"center",minHeight:"100vh",animation:"fadeUp .5s ease"}}>
      <button onClick={onBack} style={{...S.backBtn,alignSelf:"flex-start",marginBottom:32}}>← BACK</button>

      <div style={{textAlign:"center",marginBottom:32}}>
        <div style={{width:64,height:64,borderRadius:18,background:preset.gradient,
          display:"flex",alignItems:"center",justifyContent:"center",
          margin:"0 auto 16px",fontSize:28,fontFamily:"'Orbitron',monospace",fontWeight:900,
          color:"#000",boxShadow:`0 0 40px ${preset.glow}`}}>
          {preset.emoji}
        </div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:28,
          color:preset.color,letterSpacing:4,textShadow:`0 0 20px ${preset.glow}`}}>
          PLAN {preset.label}
        </div>
        <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ffffff33",marginTop:6,letterSpacing:3}}>
          ×{preset.odds} ODDS · {preset.wdPct*100}% WEEKLY WD
        </div>
      </div>

      <div style={S.glassCard}>
        {/* Progress */}
        <div style={{display:"flex",gap:4,marginBottom:20}}>
          {fields.map((_,i)=>(
            <div key={i} style={{flex:1,height:3,borderRadius:2,
              background:i<=step?preset.gradient:"#ffffff0d",
              boxShadow:i===step?`0 0 10px ${preset.glow}`:"none",
              transition:"all .4s ease"}}/>
          ))}
        </div>

        <div style={{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",letterSpacing:3,marginBottom:8}}>
          STEP {step+1} OF {fields.length}
        </div>
        <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:16,
          color:preset.color,letterSpacing:2,marginBottom:16}}>
          {fields[step].label}
        </div>

        {/* Preset info pills */}
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          {[["ODDS","×"+preset.odds,preset.color],["WEEKLY WD",preset.wdPct*100+"%","#FFD600"]].map(([l,v,col],i)=>(
            <div key={i} style={{flex:1,background:`${col}0d`,border:`1px solid ${col}33`,
              borderRadius:10,padding:"8px 10px",textAlign:"center"}}>
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:8,color:col+"66",letterSpacing:2,marginBottom:4}}>{l}</div>
              <div style={{fontFamily:"'Orbitron',monospace",fontWeight:700,fontSize:13,color:col}}>{v}</div>
            </div>
          ))}
        </div>

        <input
          type={fields[step].type} placeholder={fields[step].ph}
          value={form[fields[step].k]}
          onChange={e=>setForm({...form,[fields[step].k]:e.target.value})}
          onKeyDown={e=>e.key==="Enter"&&next()}
          autoFocus
          style={{...S.input,border:`1px solid ${preset.color}44`,
            boxShadow:`0 0 20px ${preset.glow.replace("0.5","0.08")}`}}
        />

        <div style={{display:"flex",gap:10,marginTop:14}}>
          {step>0&&(
            <button onClick={()=>setStep(s=>s-1)}
              style={{...S.winBtn,flex:1,background:"transparent",border:"1px solid #ffffff22",color:"#ffffff55",boxShadow:"none"}}>
              ← BACK
            </button>
          )}
          <button onClick={next}
            style={{...S.winBtn,flex:2,background:step===fields.length-1?preset.gradient:"linear-gradient(135deg,#ffffff15,#ffffff08)",
              color:step===fields.length-1?"#000":"#fff",
              boxShadow:step===fields.length-1?`0 4px 30px ${preset.glow}`:"none"}}>
            {step<fields.length-1?"NEXT →":"🚀 ACTIVATE PLAN"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════ GLOBAL CSS ════════════════════════════ */
function GlobalCSS(){return(<style>{`
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=DM+Mono:wght@400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#030508;-webkit-tap-highlight-color:transparent;overflow-x:hidden;}
  ::-webkit-scrollbar{width:3px;}
  ::-webkit-scrollbar-track{background:#030508;}
  ::-webkit-scrollbar-thumb{background:#00E5FF22;border-radius:2px;}
  ::-webkit-scrollbar-thumb:hover{background:#00E5FF44;}
  @keyframes fadeUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
  @keyframes logoReveal{0%{opacity:0;letter-spacing:20px}100%{opacity:1;letter-spacing:6px}}
  @keyframes barFill{0%{width:0}100%{width:100%}}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
  @keyframes pulse-warn{0%,100%{opacity:1}50%{opacity:.7}}
  @keyframes shake{0%,100%{transform:translateX(0)}15%{transform:translateX(-8px)}30%{transform:translateX(8px)}45%{transform:translateX(-6px)}60%{transform:translateX(6px)}75%{transform:translateX(-4px)}90%{transform:translateX(4px)}}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
  button:active{transform:scale(.97)!important;}
  input:focus{outline:none;}
`}</style>);}

/* ═══════════════════ STYLES ════════════════════════════════ */
const S={
  root:{background:"#030508",minHeight:"100vh",maxWidth:430,margin:"0 auto",position:"relative"},
  screen:{padding:"0 16px 32px",paddingTop:16,position:"relative",zIndex:1,maxWidth:430,margin:"0 auto"},
  splash:{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",position:"relative",zIndex:1},
  splashLogo:{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:42,color:"#00E5FF",
    letterSpacing:6,textShadow:"0 0 40px rgba(0,229,255,0.8), 0 0 80px rgba(0,229,255,0.4)",
    animation:"logoReveal 1.2s ease forwards"},
  splashSub:{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#ffffff33",letterSpacing:4,marginTop:8},
  splashBar:{height:2,background:"#ffffff08",borderRadius:2,marginTop:24,overflow:"hidden"},
  splashFill:{height:"100%",background:"linear-gradient(90deg,#00E5FF,#E040FB)",borderRadius:2,animation:"barFill 1.5s ease forwards"},
  homeHeader:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",
    padding:"20px 0 16px",borderBottom:"1px solid #ffffff08",marginBottom:16},
  homeTitle:{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:32,color:"#00E5FF",
    letterSpacing:4,textShadow:"0 0 30px rgba(0,229,255,0.6)",lineHeight:1},
  homeSub:{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#ffffff33",letterSpacing:3,marginTop:4},
  versionBadge:{fontFamily:"'DM Mono',monospace",fontSize:9,color:"#00E5FF44",
    border:"1px solid #00E5FF22",borderRadius:20,padding:"3px 10px",letterSpacing:2},
  combinedCard:{background:"linear-gradient(135deg,#00E5FF08,#ffffff03)",border:"1px solid #00E5FF22",
    borderRadius:16,padding:"14px 16px",marginBottom:18,
    boxShadow:"0 0 30px rgba(0,229,255,0.06)"},
  combinedVal:{fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:22,color:"#00E5FF",
    textShadow:"0 0 20px rgba(0,229,255,0.5)",marginTop:4},
  planCard:{background:"#0a0d14",borderRadius:16,padding:"16px 14px",
    position:"relative",overflow:"hidden",transition:"all .25s ease",animation:"float 4s ease-in-out infinite"},
  glassCard:{background:"linear-gradient(135deg,#0d1117,#0a0d14)",
    border:"1px solid #ffffff0d",borderRadius:14,padding:14,marginBottom:10,
    position:"relative",overflow:"hidden"},
  backBtn:{background:"none",border:"none",color:"#00E5FF88",fontFamily:"'DM Mono',monospace",
    fontSize:11,cursor:"pointer",padding:"4px 0",letterSpacing:2,display:"flex",alignItems:"center"},
  winBtn:{background:"linear-gradient(135deg,#69FF47,#00C853)",border:"none",borderRadius:14,
    color:"#001a00",padding:"16px 8px",cursor:"pointer",display:"flex",flexDirection:"column",
    alignItems:"center",gap:2,fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:12,
    transition:"all .2s",position:"relative",overflow:"hidden"},
  lossBtn:{background:"linear-gradient(135deg,#FF1744,#B71C1C)",border:"none",borderRadius:14,
    color:"#fff0f0",padding:"16px 8px",cursor:"pointer",display:"flex",flexDirection:"column",
    alignItems:"center",gap:2,fontFamily:"'Orbitron',monospace",fontWeight:900,fontSize:12,
    transition:"all .2s",position:"relative",overflow:"hidden"},
  input:{width:"100%",background:"#ffffff05",border:"1px solid #ffffff15",borderRadius:10,
    padding:"14px 14px",color:"#fff",fontFamily:"'DM Mono',monospace",fontSize:13},
  toast:{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",
    padding:"10px 20px",borderRadius:30,fontFamily:"'DM Mono',monospace",fontSize:10,
    fontWeight:700,zIndex:300,whiteSpace:"nowrap",maxWidth:"92vw",
    overflow:"hidden",textOverflow:"ellipsis",letterSpacing:1,backdropFilter:"blur(10px)"},
};
