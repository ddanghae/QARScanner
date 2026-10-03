// Lazy same-origin Cup & Handle view; keeps its scanner DOM isolated from the dashboard.
export function initCupRadarTab({document:doc=document,window:win=window,isMainBusy,pauseMain,resumeMain,shouldResumeMain}){
 const frame=doc.getElementById('cup-radar-frame');let active=false,busy=false,blocking=false,loaded=false;
 function sync(){const next=active||busy;if(next&&!blocking)pauseMain();if(!next&&blocking&&shouldResumeMain())resumeMain();blocking=next;if(loaded)frame.contentWindow?.postMessage({type:'qar:cup-context',active,mainBusy:isMainBusy()},win.location.origin);}
 function onMessage(e){if(!loaded||e.origin!==win.location.origin||e.source!==frame.contentWindow)return;if(e.data?.type==='qar:cup-ready')sync();if(e.data?.type==='qar:cup-busy'&&typeof e.data.busy==='boolean'){busy=e.data.busy;sync();}}
 win.addEventListener('message',onMessage);frame.addEventListener('load',()=>{busy=false;sync();});
 return{select(value){active=value;if(active&&!loaded){loaded=true;frame.src=frame.dataset.src;}sync();},sync,isBusy:()=>busy,isBlocking:()=>blocking};
}
