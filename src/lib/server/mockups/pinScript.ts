// THE SCRIPT ADDED TO A MEMBER'S VIEW OF A MOCKUP (AFB-20261107-0346, REWORKED IN AFB-20261107-1337)
// It runs sandboxed inside the mockup page and does four things only: it draws the numbered pins the board hands it, it reports a
// click while the person is placing a pin (a type, percent of the page, the click point in the frame and the frame size, plus a short
// element hint), it reports a drag of the pin being placed, and it reports a click on a pin as the id the board gave it. It also reports
// once what the page declares in <meta name="afb-config"> (screens and options) and applies a choice the board sends back, only for a key
// and value the page declared (AFB-20261109-0604). It never reads or sends anything else, and it only listens to its own parent window.
// Every value that comes from the board is checked here: numbers are clamped, ids and colours must match a strict shape, and nothing
// from the board is ever written as markup or into a style string. The board never sends the text or the author of a pin.

// -- CONSTANTS -- //

// The part both scripts share: reading what the page declares, and applying a choice from the board. Needs KEY, cfg, sendConfig and again()
const CONFIG_JS = `// WHAT THE PAGE OFFERS: its screens and its options, read once from <meta name="afb-config"> and reported to the board, which draws the controls
function pairs(a,max){
 var r=[];
 if(!Array.isArray(a))return r;
 a.slice(0,max).forEach(function(p){
  if(Array.isArray(p)&&typeof p[0]==='string'&&typeof p[1]==='string'&&KEY.test(p[0]))r.push([p[0],p[1].slice(0,32)])
 });
 return r
}
function has(list,v){return list.some(function(p){return p[0]===v})}
var HOOK_KEYS=['screen','state','surface','person','offline'];
function parseParams(raw){
 var out=Object.create(null);
 if(!raw||typeof raw!=='string')return out;
 var s=raw.charAt(0)==='?'||raw.charAt(0)==='#'?raw.slice(1):raw;
 if(!s)return out;
 s.split('&').forEach(function(part){
  if(!part)return;
  var eq=part.indexOf('=');
  if(eq===-1)return;
  var k,v;
  try{k=decodeURIComponent(part.slice(0,eq).replace(/\\+/g,' '));v=decodeURIComponent(part.slice(eq+1).replace(/\\+/g,' '))}catch(_){return}
  if(!KEY.test(k))return;
  var clean=v.trim().toLowerCase();
  if(k==='offline')clean=(clean==='1'||clean==='true'||clean==='offline')?'true':(clean==='0'||clean==='false'||clean==='online')?'false':'';
  if(KEY.test(clean))out[k]=clean
 });
 return out
}
function urlState(){
 var loc=typeof location!=='undefined'?location:null;
 var q=parseParams(loc&&loc.search||''),h=parseParams(loc&&loc.hash||''),merged=Object.create(null);
 Object.keys(q).forEach(function(k){merged[k]=q[k]});
 Object.keys(h).forEach(function(k){merged[k]=h[k]});
 return merged
}
function applyHookValue(key,value){
 var root=document.documentElement;
 root.setAttribute('data-'+key,value);
 if(typeof window.afbSet==='function'){
  try{window.afbSet(key,value)}catch(_){}
 }
}
function applyUrlHooks(current){
 var merged=urlState();
 HOOK_KEYS.forEach(function(k){
  if(!merged[k])return;
  if(k==='screen'&&cfg&&cfg.screens&&cfg.screens.length&&!has(cfg.screens,merged[k]))return;
  applyHookValue(k,merged[k]);
  if(current&&(k==='screen'||k==='state'))current[k]=merged[k]
 });
 if(cfg&&Array.isArray(cfg.options))cfg.options.forEach(function(o){
  var v=merged[o.key];
  if(!v||!has(o.values,v))return;
  applyHookValue(o.key,v);
  if(current)current[o.key]=v
 })
}
function setup(){
 var m=document.querySelector('meta[name="afb-config"]'),c;
 var root=document.documentElement,current={};
 if(m){
  try{c=JSON.parse(m.getAttribute('content')||'')}catch(_){c=null}
 }
 if(!c||typeof c!=='object'){
  applyUrlHooks(null);
  return
 }
 var seen={};
 cfg={screens:pairs(c.screens,12),options:[]};
 if(Array.isArray(c.options))c.options.slice(0,6).forEach(function(o){
  if(!o||typeof o.key!=='string'||!KEY.test(o.key)||o.key==='screen'||seen[o.key]||typeof o.label!=='string')return;
  var v=pairs(o.values,12);
  if(v.length<2)return;
  // The screens an option applies to: a list of declared screens, none given or an empty list meaning every screen. A bad list refuses the option
  var sc=null;
  if(o.screens!==undefined){
   if(!Array.isArray(o.screens)||o.screens.length>12)return;
   var ok=true,used=Object.create(null);
   o.screens.forEach(function(s){
    if(typeof s!=='string'||!KEY.test(s)||!has(cfg.screens,s)||used[s]===1)ok=false;
    else used[s]=1
   });
   if(!ok)return;
   if(o.screens.length)sc=o.screens.slice()
  }
  seen[o.key]=1;
  var entry={key:o.key,label:o.label.slice(0,32),values:v};
  if(sc)entry.screens=sc;
  cfg.options.push(entry)
 });
 cfg.options.forEach(function(o){
  var a=root.getAttribute('data-'+o.key);
  current[o.key]=a&&has(o.values,a)?a:o.values[0][0]
 });
 if(cfg.screens.length>1){
  var s=root.getAttribute('data-screen');
  current.screen=s&&has(cfg.screens,s)?s:cfg.screens[0][0]
 }
 applyUrlHooks(current);
 sendConfig=function(){parent.postMessage({type:'afb-config',config:cfg,current:current},'*')}
}
addEventListener('hashchange',function(){applyUrlHooks(null);again()});
// A bounded look at the page: the size of the document and a few computed styles of at most about 600 elements, enough to tell whether a choice changed anything
var probe=0;
function look(){
 var root=document.documentElement,all=document.body?document.body.getElementsByTagName('*'):[],n=all.length,step=Math.max(1,Math.ceil(n/600));
 var r=[root.scrollHeight,root.scrollWidth],list=[root];
 if(document.body)list.push(document.body);
 for(var i=0;i<n;i+=step)list.push(all[i]);
 list.forEach(function(el){
  var s=getComputedStyle(el);
  r.push(s.display,s.visibility,s.opacity,s.color,s.backgroundColor,s.height,s.width,s.colorScheme,s.fontFamily,s.fontSize,s.borderRadius,s.boxShadow,s.transform)
 });
 return r.join('|')
}
// The attribute the board wrote and the pin layer are the board's own changes, never the page's answer
function own(m,key){
 if(m.type==='attributes'&&m.target===document.documentElement&&m.attributeName==='data-'+key)return true;
 if(typeof layer==='undefined'||!layer)return false;
 // The layer itself being added to the page is the board's own change too
 if(m.addedNodes&&m.addedNodes.length===1&&m.addedNodes[0]===layer)return true;
 return layer.contains(m.target)
}
// The board asks for one choice: the key and value must be ones the page declared. A page with its own hook gets called, any other page gets the attribute.
// Then it checks that something changed, and tells the board when nothing did (or when the page's own hook threw), so a mockup that ignores the buttons is named
function choose(key,value){
 if(!cfg)return;
 var list=key==='screen'?cfg.screens:null;
 if(!list)cfg.options.forEach(function(o){if(o.key===key)list=o.values});
 if(!list||!has(list,value))return;
 var token=++probe,before='',failed=false,obs=null,moved=false;
 // The browser hands the records to this callback and empties its queue, so they are judged here as they arrive
 function judge(records){records.forEach(function(m){if(!own(m,key))moved=true})}
 try{before=look()}catch(_){}
 try{obs=new MutationObserver(function(records){judge(records)});obs.observe(document.documentElement,{attributes:true,childList:true,subtree:true,characterData:true})}catch(_){}
 try{
  if(typeof window.afbSet==='function')window.afbSet(key,value);
  else document.documentElement.setAttribute('data-'+key,value)
 }catch(_){failed=true}
 again();
 setTimeout(function(){
  if(obs){
   // Whatever has not been delivered yet is judged too
   try{judge(obs.takeRecords())}catch(_){}
   obs.disconnect()
  }
  if(token!==probe)return;
  var same=false;
  try{same=!moved&&before!==''&&look()===before}catch(_){}
  if(failed||same)parent.postMessage({type:'afb-unresponsive',key:key,reason:failed?'error':'none'},'*')
 },450)
}`;

/**
 * The script of a public link (AFB-20261110-0353). The same options and screens as a member sees, and nothing else: no pins, no
 * click or drag reports, no focus. It only reports the page's own declared config and applies a choice the board sends back.
 */
export const PUBLIC_SCRIPT = `<script>(function(){
var KEY=/^[a-z0-9][a-z0-9-]{0,23}$/,cfg=null,sendConfig=function(){};
function again(){}
${CONFIG_JS}
addEventListener('message',function(e){
 if(e.source!==parent)return;
 var d=e.data;
 if(!d||typeof d!=='object')return;
 if(d.type==='afb-set'&&typeof d.key==='string'&&typeof d.value==='string'&&KEY.test(d.key)&&KEY.test(d.value))choose(d.key,d.value)
});
document.addEventListener('keydown',function(e){
 if(e.metaKey||e.ctrlKey||e.altKey||e.repeat)return;
 var t=e.target,typing=t&&t.closest&&t.closest('input,textarea,select,[contenteditable="true"]');
 if(typing)return;
 if(e.key==='['||e.key===']')parent.postMessage({type:'afb-step',dir:e.key==='['?'prev':'next'},'*')
});
addEventListener('load',function(){setup();parent.postMessage({type:'afb-mockup-ready'},'*');sendConfig()})
})()</script>`;

export const PIN_SCRIPT = `<script>(function(){
var on=false,pins=[],draft=null,accent=null,ink=null,reduced=false,layer=null,draftEl=null,frame=0,dragging=false;
var KEY=/^[a-z0-9][a-z0-9-]{0,23}$/,cfg=null,sendConfig=function(){};
var HEX=/^#[0-9a-f]{6}$/i,ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function num(v){return typeof v==='number'&&isFinite(v)}
function pct(v){return Math.min(100,Math.max(0,v))}
function size(){
 if(layer)layer.style.display='none';
 // clientWidth and clientHeight leave out the scrollbar, so the layer is never wider than the page and never adds a sideways scroll
 var d=document.documentElement,s={w:Math.max(d.scrollWidth,d.clientWidth,1),h:Math.max(d.scrollHeight,d.clientHeight,1)};
 if(layer)layer.style.display='block';
 return s
}
function marker(x,y,label,s){
 var m=document.createElement('div'),st=m.style;
 m.textContent=label;
 st.position='absolute';st.left=(x/100*s.w)+'px';st.top=(y/100*s.h)+'px';
 st.width='26px';st.height='26px';st.margin='-13px 0 0 -13px';st.boxSizing='border-box';
 st.borderRadius='50%';st.border='2px solid Canvas';st.boxShadow='0 0 0 1px GrayText';
 st.background=accent||'CanvasText';st.color=ink||'Canvas';
 st.font='600 12px/22px system-ui,sans-serif';st.textAlign='center';
 st.cursor='pointer';st.pointerEvents=on?'none':'auto';
 return m
}
function draw(){
 if(!layer){
  layer=document.createElement('div');
  layer.style.cssText='position:absolute;left:0;top:0;overflow:hidden;z-index:2147483647;pointer-events:none';
  document.body.appendChild(layer)
 }
 layer.textContent='';draftEl=null;
 var s=size();
 layer.style.width=s.w+'px';layer.style.height=s.h+'px';layer.style.display='block';
 pins.forEach(function(p){
  var m=marker(p.x,p.y,String(p.n),s);
  m.setAttribute('data-id',p.id);
  if(p.done){m.style.opacity='0.45';m.style.background='GrayText'}
  m.addEventListener('click',function(e){
   if(on)return;
   e.preventDefault();e.stopPropagation();
   parent.postMessage({type:'afb-pin-click',id:p.id},'*')
  });
  layer.appendChild(m)
 });
 if(draft){
  var d=marker(draft.x,draft.y,'+',s),c=accent||'CanvasText';
  d.style.background='Canvas';d.style.color=c;d.style.border='2px solid '+c;d.style.cursor='grab';d.style.touchAction='none';d.style.pointerEvents='auto';
  d.setAttribute('data-draft','1');
  drag(d);
  layer.appendChild(d);draftEl=d
 }
}
function drag(el){
 el.addEventListener('pointerdown',function(e){
  e.preventDefault();e.stopPropagation();
  try{el.setPointerCapture(e.pointerId)}catch(_){}
  el.style.cursor='grabbing';dragging=true;
  function move(m){
   var s=size();
   draft={x:pct(Math.round(m.pageX/s.w*10000)/100),y:pct(Math.round(m.pageY/s.h*10000)/100)};
   el.style.left=(draft.x/100*s.w)+'px';el.style.top=(draft.y/100*s.h)+'px';
   if(!frame)frame=requestAnimationFrame(function(){
    frame=0;
    parent.postMessage({type:'afb-pin-move',x:draft.x,y:draft.y,clientX:m.clientX,clientY:m.clientY,viewW:innerWidth,viewH:innerHeight},'*')
   })
  }
  function up(){dragging=false;el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.style.cursor='grab'}
  el.addEventListener('pointermove',move);el.addEventListener('pointerup',up)
 })
}
function hint(el){
 if(!el||!el.tagName)return'';
 var t=el.tagName.toLowerCase();
 if(el.id)t+='#'+String(el.id).slice(0,40);
 var c=typeof el.className==='string'?el.className.trim().split(/\\s+/)[0]:'';
 if(c)t+='.'+c.slice(0,40);
 var x=(el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,40);
 return(t+(x?' "'+x+'"':'')).slice(0,120)
}
function focusPin(id){
 if(!layer)return;
 var el=layer.querySelector('[data-id="'+id+'"]');
 if(!el)return;
 el.scrollIntoView({block:'center',inline:'center',behavior:reduced?'auto':'smooth'});
 var c=accent||'CanvasText';
 if(el.animate&&!reduced)el.animate([{boxShadow:'0 0 0 0 '+c},{boxShadow:'0 0 0 18px transparent'}],{duration:800,iterations:2});
 else{el.style.outline='3px solid '+c;setTimeout(function(){el.style.outline=''},1500)}
}
${CONFIG_JS}
addEventListener('message',function(e){
 if(e.source!==parent)return;
 var d=e.data;
 if(!d||typeof d!=='object')return;
 if(d.type==='afb-set'){
  if(typeof d.key==='string'&&typeof d.value==='string'&&KEY.test(d.key)&&KEY.test(d.value))choose(d.key,d.value)
 }else if(d.type==='afb-pin-mode'){
  on=d.on===true;document.documentElement.style.cursor=on?'crosshair':'';draw()
 }else if(d.type==='afb-pins'&&Array.isArray(d.pins)){
  accent=typeof d.accent==='string'&&HEX.test(d.accent)?d.accent:null;
  ink=typeof d.ink==='string'&&HEX.test(d.ink)?d.ink:null;
  reduced=d.reduced===true;
  pins=d.pins.slice(0,200).filter(function(p){
   return p&&typeof p.id==='string'&&ID.test(p.id)&&num(p.x)&&num(p.y)&&Number.isInteger(p.n)&&p.n>0&&p.n<10000
  }).map(function(p){return{id:p.id,x:pct(p.x),y:pct(p.y),n:p.n,done:p.done===true}});
  // While the pin being placed is dragged the frame keeps its own position, so the board's echo never cuts the drag short
  if(dragging)return;
  var q=d.draft;
  draft=q&&num(q.x)&&num(q.y)?{x:pct(q.x),y:pct(q.y)}:null;
  draw()
 }else if(d.type==='afb-pin-focus'&&typeof d.id==='string'&&ID.test(d.id)){
  reduced=d.reduced===true;focusPin(d.id)
 }
});
document.addEventListener('click',function(e){
 if(!on)return;
 if(draftEl&&draftEl.contains(e.target))return;
 e.preventDefault();e.stopPropagation();
 var s=size();
 parent.postMessage({
  type:'afb-mockup-pin',
  x:pct(Math.round(e.pageX/s.w*10000)/100),y:pct(Math.round(e.pageY/s.h*10000)/100),
  clientX:e.clientX,clientY:e.clientY,viewW:innerWidth,viewH:innerHeight,
  hint:hint(e.target)
 },'*')
},true);
document.addEventListener('keydown',function(e){
 if(e.metaKey||e.ctrlKey||e.altKey||e.repeat)return;
 var t=e.target,typing=t&&t.closest&&t.closest('input,textarea,select,[contenteditable="true"]');
 if(typing)return;
 if(e.key==='['||e.key===']')parent.postMessage({type:'afb-step',dir:e.key==='['?'prev':'next'},'*');
 if(e.key==='Escape'||e.key==='c'||e.key==='C')parent.postMessage({type:'afb-pin-key',key:e.key==='Escape'?'Escape':'c'},'*')
});
function again(){if(!frame)frame=requestAnimationFrame(function(){frame=0;draw()})}
addEventListener('resize',again);
if(window.ResizeObserver)new ResizeObserver(again).observe(document.documentElement);
addEventListener('load',function(){setup();draw();parent.postMessage({type:'afb-mockup-ready'},'*');sendConfig()})
})()</script>`;
