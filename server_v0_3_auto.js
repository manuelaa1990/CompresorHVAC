const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

const localFallback = {
  model:"PA118M1C-3FZU", manufacturer:"GMCC", refrigerant:"R410A",
  type:"Rotary hermetic", voltage:"208–230 V", frequency:"60 Hz", phase:"1",
  capacity_kW:"3.39", capacity_BTUh:"11567", displacement_cm3_rev:"11.8",
  RLA_A:"5.4", LRA_A:"28", power_kW:"1.125", COP:"3.01",
  oil:"—", capacitor:"35 µF", max_discharge_C:"—",
  summary:"Registro local de demostración. Las cifras deben verificarse contra la fuente oficial y otras referencias.",
  test_conditions:"ASHRAE publicado por distribuidor: Tevap 7.2 °C; Tcond 54.4 °C; retorno 35 °C; líquido 46.1 °C; ambiente 35 °C."
};

function send(res,status,obj){
  const body=JSON.stringify(obj);
  res.writeHead(status,{
    "Content-Type":"application/json; charset=utf-8",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type",
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS"
  });
  res.end(body);
}
function text(res,status,msg){res.writeHead(status,{"Content-Type":"text/plain; charset=utf-8","Access-Control-Allow-Origin":"*"});res.end(msg)}

function cleanDomain(url){
  try{return new URL(url).hostname.replace(/^www\./,"")}catch{return ""}
}
function sourceType(r){
  const u=(r.url||"").toLowerCase(), t=(r.title||"").toLowerCase();
  if(/\.pdf($|\?)/i.test(u) || /datasheet|data sheet|catalog|catalogue|technical data/i.test(t)) return "PDF / datasheet";
  if(/manufacturer|compressor|gmcc|gree|embraco|tecumseh|danfoss|copeland|panasonic|huayi|secop|sanyo|bitzer|highly|rechi|lg|matsushita/i.test(t+" "+u)) return "manufacturer / official candidate";
  if(/distributor|supply|parts|hvac|refrigeration|store|shop/i.test(t+" "+u)) return "distributor";
  return "web";
}
function canonical(u){
  try{
    const x=new URL(u);
    x.hash="";
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid"].forEach(k=>x.searchParams.delete(k));
    return x.toString();
  }catch{return u}
}
function rankResult(r){
  const s=(r.title+" "+r.url+" "+r.content).toLowerCase();
  let score=Number(r.score||0)*100;
  if(/\.pdf($|\?)/.test(r.url||"")) score+=22;
  if(/datasheet|data sheet|technical|catalog|specification|specs/.test(s)) score+=15;
  if(/manufacturer|gmcc|gree|embraco|tecumseh|danfoss|copeland|panasonic|huayi|secop|sanyo|bitzer|highly|rechi|lg/.test(s)) score+=14;
  if(/amazon|ebay|alibaba/.test(s)) score-=8;
  return score;
}

async function tavilySearch(query){
  const resp=await fetch("https://api.tavily.com/search",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${TAVILY_API_KEY}`},
    body:JSON.stringify({
      query,
      search_depth:"advanced",
      max_results:10,
      include_answer:false,
      include_raw_content:false,
      include_images:false
    })
  });
  const txt=await resp.text();
  let data; try{data=JSON.parse(txt)}catch{throw new Error(`Tavily HTTP ${resp.status}: ${txt.slice(0,300)}`)}
  if(!resp.ok) throw new Error(data.detail || data.error || `Tavily HTTP ${resp.status}`);
  return data.results || [];
}

function buildQuery(p){
  const parts=[`"${p.requested_model||p.query}"`,"refrigeration compressor","specifications","datasheet"];
  if(p.refrigerant) parts.push(p.refrigerant);
  if(p.application) parts.push(p.application);
  if(p.capacity_BTUh) parts.push(`${p.capacity_BTUh} BTU`);
  if(p.voltage) parts.push(p.voltage);
  return parts.join(" ");
}

function normalizeRefs(results,query){
  const map=new Map();
  for(const r of results){
    if(!r.url) continue;
    const key=canonical(r.url);
    const item={
      title:r.title||r.url,url:r.url,canonical_url:key,
      domain:cleanDomain(r.url),snippet:r.content||"",
      score:rankResult(r),query,source_type:sourceType(r)
    };
    const old=map.get(key);
    if(!old || item.score>old.score) map.set(key,item);
  }
  return [...map.values()].sort((a,b)=>b.score-a.score).slice(0,10);
}

function promptForGemini(p, refs){
  const context=refs.map((r,i)=>`SOURCE ${i+1}
TITLE: ${r.title}
URL: ${r.url}
DOMAIN: ${r.domain}
SNIPPET: ${r.snippet}`).join("\n\n");
  return `You are an HVAC/R compressor technical data analyst.
Use ONLY the supplied web search references. Do not invent missing values.
The requested compressor is: ${p.requested_model||p.query}.
User constraints: refrigerant=${p.refrigerant||""}; application=${p.application||""}; capacity_BTUh=${p.capacity_BTUh||""}; voltage=${p.voltage||""}; Tevap_C=${p.Tevap_C||""}; Tcond_C=${p.Tcond_C||""}.

Return a compact JSON object with these keys:
model, manufacturer, refrigerant, type, voltage, frequency, phase, capacity_kW, capacity_BTUh, displacement_cm3_rev, RLA_A, LRA_A, power_kW, COP, oil, capacitor, max_discharge_C, summary, test_conditions, application_envelope, conflicts, sources.
All numeric fields must be strings; use "" when not reliably supported.
application_envelope must contain: application_class, evap_min_C, evap_max_C, cond_min_C, cond_max_C, max_discharge_C, max_pressure_ratio, notes, points, ashrae_tests, status.
points must contain Tevap_C,Tcond_C,note. ashrae_tests must contain Tevap_C,Tcond_C,Treturn_C,Tliquid_C,ambient_C,note.
conflicts must contain field,description.
sources must contain name,url,type.
Distinguish ASHRAE rating/test points from true envelope limits. If sources disagree, preserve the conflict rather than choosing silently.

WEB REFERENCES:
${context}`;
}

async function geminiAnalyze(p, refs){
  if(!GEMINI_API_KEY || !refs.length) return null;
  const body={
    contents:[{parts:[{text:promptForGemini(p,refs)}]}],
    generationConfig:{
      responseMimeType:"application/json"
    }
  };
  const resp=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
  });
  const txt=await resp.text();
  let data; try{data=JSON.parse(txt)}catch{throw new Error(`Gemini HTTP ${resp.status}: ${txt.slice(0,300)}`)}
  if(!resp.ok) throw new Error(data.error?.message || `Gemini HTTP ${resp.status}`);
  const out=data.candidates?.[0]?.content?.parts?.map(x=>x.text||"").join("")||"";
  if(!out) return null;
  try{return JSON.parse(out)}catch{return null}
}

async function handleSearch(p){
  if(!TAVILY_API_KEY) {
    return {
      found:false, search_provider:"tavily", analysis_available:false,
      references:[], sources:[], record:null, envelope:null, conflicts:[],
      error:"TAVILY_API_KEY no está configurada en el backend."
    };
  }
  const query=buildQuery(p);
  const raw=await tavilySearch(query);
  const references=normalizeRefs(raw,query);

  let record=null,envelope=null,conflicts=[],sources=references.map(r=>({name:r.title,url:r.url,type:r.source_type}));
  let analysis_error="";
  if(GEMINI_API_KEY && references.length){
    try{
      const a=await geminiAnalyze(p,references.slice(0,8));
      if(a){
        record={
          model:a.model||p.requested_model||p.query, manufacturer:a.manufacturer||"",
          refrigerant:a.refrigerant||"", type:a.type||"", voltage:a.voltage||"",
          frequency:a.frequency||"", phase:a.phase||"", capacity_kW:a.capacity_kW||"",
          capacity_BTUh:a.capacity_BTUh||"", displacement_cm3_rev:a.displacement_cm3_rev||"",
          RLA_A:a.RLA_A||"", LRA_A:a.LRA_A||"", power_kW:a.power_kW||"",
          COP:a.COP||"", oil:a.oil||"", capacitor:a.capacitor||"",
          max_discharge_C:a.max_discharge_C||"", summary:a.summary||"",
          test_conditions:a.test_conditions||""
        };
        envelope=a.application_envelope||null;
        conflicts=Array.isArray(a.conflicts)?a.conflicts:[];
        if(Array.isArray(a.sources)&&a.sources.length) sources=a.sources;
      }
    }catch(e){analysis_error=e.message}
  }
  return {
    found:references.length>0, search_provider:"tavily",
    analysis_available:Boolean(record), analysis_error,
    references, sources, record, envelope, conflicts,
    query
  };
}

const server=http.createServer(async (req,res)=>{
  if(req.method==="OPTIONS"){res.writeHead(204,{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"});return res.end()}
  const u=new URL(req.url,`http://${req.headers.host||"localhost"}`);
  if(req.method==="GET" && u.pathname==="/"){
    return text(res,200,"HVAC/R Compressor Engine V0.3 AUTO SEARCH");
  }
  if(req.method==="GET" && u.pathname==="/health"){
    return send(res,200,{
      ok:true,version:"0.3-auto-search",search_provider:"Tavily",
      tavily_key_configured:Boolean(TAVILY_API_KEY),
      gemini_key_configured:Boolean(GEMINI_API_KEY),
      gemini_model:GEMINI_MODEL
    });
  }
  if(req.method==="POST" && u.pathname==="/api/compressor-search"){
    let raw="";
    req.on("data",c=>raw+=c);
    req.on("end",async()=>{
      try{
        const p=JSON.parse(raw||"{}");
        const query=String(p.requested_model||p.query||"").trim();
        if(!query) return send(res,400,{error:"Falta query/requested_model."});
        p.query=query;p.requested_model=query;
        const out=await handleSearch(p);
        if(!out.found && out.error) return send(res,503,out);
        return send(res,200,out);
      }catch(e){return send(res,500,{error:e.message})}
    });
    return;
  }
  text(res,404,"Not found");
});

server.listen(PORT,()=>console.log(`HVAC/R Compressor Engine V0.3 AUTO SEARCH listening on ${PORT}`));
