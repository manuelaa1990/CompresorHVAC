const http=require("http");
const {URL}=require("url");
const PORT=Number(process.env.PORT||3000);
const API_KEY=process.env.GEMINI_API_KEY;
const MODEL=process.env.GEMINI_MODEL||"gemini-2.5-flash";

const schema={
  type:"object",
  properties:{
    found:{type:"boolean"},
    summary:{type:"string"},
    confidence:{type:"string"},
    manufacturer:{type:"string"},
    model:{type:"string"},
    refrigerant:{type:"string"},
    type:{type:"string"},
    voltage:{type:"string"},
    frequency:{type:"string"},
    phase:{type:"string"},

    // Los campos numericos se devuelven como STRING para evitar
    // incompatibilidades del responseSchema REST con tipos nullable.
    capacity_kW:{type:"string"},
    capacity_BTUh:{type:"string"},
    displacement_cm3_rev:{type:"string"},
    RLA_A:{type:"string"},
    LRA_A:{type:"string"},
    power_kW:{type:"string"},
    COP:{type:"string"},
    oil:{type:"string"},
    capacitor:{type:"string"},
    max_discharge_C:{type:"string"},
    application_envelope:{type:"string"},
    test_conditions:{type:"string"},

    conflicts:{
      type:"array",
      items:{type:"string"}
    },

    envelope:{
      type:"object",
      properties:{
        application_class:{type:"string"},
        evap_min_C:{type:"string"},
        evap_max_C:{type:"string"},
        cond_min_C:{type:"string"},
        cond_max_C:{type:"string"},
        max_discharge_C:{type:"string"},
        max_pressure_ratio:{type:"string"},
        notes:{type:"string"},

        points:{
          type:"array",
          items:{
            type:"object",
            properties:{
              Tevap_C:{type:"string"},
              Tcond_C:{type:"string"},
              note:{type:"string"}
            },
            required:["Tevap_C","Tcond_C","note"]
          }
        },

        ashrae_tests:{
          type:"array",
          items:{
            type:"object",
            properties:{
              Tevap_C:{type:"string"},
              Tcond_C:{type:"string"},
              Treturn_C:{type:"string"},
              Tliquid_C:{type:"string"},
              ambient_C:{type:"string"},
              note:{type:"string"}
            },
            required:["Tevap_C","Tcond_C","Treturn_C","Tliquid_C","ambient_C","note"]
          }
        }
      },
      required:[
        "application_class","evap_min_C","evap_max_C","cond_min_C","cond_max_C",
        "max_discharge_C","max_pressure_ratio","notes","points","ashrae_tests"
      ]
    },

    sources:{
      type:"array",
      items:{
        type:"object",
        properties:{
          name:{type:"string"},
          url:{type:"string"},
          type:{type:"string"}
        },
        required:["name","url","type"]
      }
    }
  },
  required:[
    "found","summary","confidence","manufacturer","model","refrigerant","type",
    "voltage","frequency","phase","capacity_kW","capacity_BTUh",
    "displacement_cm3_rev","RLA_A","LRA_A","power_kW","COP","oil","capacitor",
    "max_discharge_C","application_envelope","test_conditions","conflicts",
    "envelope","sources"
  ]
};

const instructions=`Eres investigador tecnico HVAC/R. Identifica compresores y recupera datos publicados mediante busqueda web.
No inventes datos. Prioriza fabricante oficial, luego distribuidores tecnicos. Para cualquier dato numerico no publicado o no confiable, devuelve una cadena vacia "" (no cero y no null).
Busca modelo, fabricante, refrigerante, tipo, voltaje, frecuencia, fase, capacidad, potencia, COP,
desplazamiento, RLA, LRA, aceite, capacitor, aplicacion LBP/MBP/HBP/HMBP/CBP/A/C,
rango publicado de evaporacion y condensacion, temperatura maxima de descarga y relacion de presion
solo si estan publicadas, puntos de envelope solo si son confiables, y condiciones de prueba ASHRAE.
Un punto ASHRAE es un punto de ensayo, no un limite de envelope. No inventes poligonos.
Si hay conflictos entre fuentes, registralos en conflicts. No declares reemplazo autorizado.`;

async function searchGemini(p){
 if(!API_KEY) throw new Error("Falta GEMINI_API_KEY en Render.");
 const prompt=instructions+"\n\nConsulta:\n"+JSON.stringify(p,null,2);
 const body={contents:[{role:"user",parts:[{text:prompt}]}],tools:[{google_search:{}}],
 generationConfig:{temperature:0.1,responseMimeType:"application/json",responseSchema:schema}};
 const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(MODEL)+":generateContent?key="+encodeURIComponent(API_KEY),
 {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
 const t=await r.text();
 if(!r.ok) throw new Error("Gemini HTTP "+r.status+": "+t.slice(0,800));
 const j=JSON.parse(t), out=j.candidates?.[0]?.content?.parts?.map(x=>x.text||"").join("")||"";
 if(!out) throw new Error("Gemini no devolvio contenido.");
 return JSON.parse(out);
}
function json(res,status,obj){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Cache-Control":"no-store"});res.end(JSON.stringify(obj));}
function body(req){return new Promise((ok,no)=>{let s="";req.on("data",c=>{s+=c;if(s.length>2000000) no(new Error("Solicitud demasiado grande."))});req.on("end",()=>{try{ok(s?JSON.parse(s):{})}catch(e){no(new Error("JSON invalido."))}});req.on("error",no)})}
http.createServer(async(req,res)=>{
 const u=new URL(req.url,"http://localhost");
 if(req.method==="OPTIONS"){res.writeHead(204,{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"});return res.end()}
 if(req.method==="GET"&&u.pathname==="/"){res.writeHead(200,{"Content-Type":"text/plain; charset=utf-8","Access-Control-Allow-Origin":"*"});return res.end("HVAC/R Compressor Engine API OK")}
 if(req.method==="GET"&&u.pathname==="/health") return json(res,200,{ok:true,version:"3.1",model:MODEL,gemini_key_configured:Boolean(API_KEY)});
 if(req.method==="POST"&&u.pathname==="/api/compressor-search"){try{return json(res,200,{ok:true,data:await searchGemini(await body(req))})}catch(e){console.error(e);return json(res,500,{ok:false,error:e.message})}}
 return json(res,404,{ok:false,error:"Ruta no encontrada"});
}).listen(PORT,"0.0.0.0",()=>console.log("API en 0.0.0.0:"+PORT));
