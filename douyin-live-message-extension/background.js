const RECEIVER = 'http://127.0.0.1:8890/api/douyin/comment';
const queue=[];let active=0;

function enqueue(data){queue.push({data,attempt:0});drain()}
function drain(){while(active<4&&queue.length){const job=queue.shift();active++;sendJob(job).finally(()=>{active--;drain()})}}
async function sendJob(job){
  try{
    const response=await fetch(RECEIVER,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(job.data)}),data=await response.json();
    if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);
    const state=await chrome.storage.local.get(['receivedCount','typeCounts']),typeCounts={comment:0,member:0,gift:0,follow:0,like:0,fansclub:0,...state.typeCounts},eventType=job.data.eventType||'comment';
    typeCounts[eventType]=(typeCounts[eventType]||0)+1;
    await updateStatus({receiverConnected:true,error:'',receivedCount:(state.receivedCount||0)+1,typeCounts,lastMessage:job.data,queueLength:queue.length});
  }catch(error){
    if(job.attempt<4){job.attempt++;setTimeout(()=>{queue.unshift(job);drain()},Math.min(3000,200*2**job.attempt))}
    else await updateStatus({receiverConnected:false,error:error.message,queueLength:queue.length});
  }
}

async function updateStatus(patch) {
  await chrome.storage.local.set({lastUpdate: new Date().toISOString(), ...patch});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if(message?.type==='connector-heartbeat'){
    const diagnostics={pageUrl:sender.tab?.url||'',mode:message.mode||'dom',connected:Boolean(message.hookConnected),reason:message.reason||'',candidateCount:message.candidateCount||0,newCount:message.newCount||0,moduleCount:message.moduleCount||0,visited:message.visited||0,tries:message.tries||0};
    updateStatus({pageConnected:true,pageUrl:diagnostics.pageUrl,lastHeartbeat:Date.now(),hookMode:diagnostics.mode,hookConnected:diagnostics.connected,hookDiagnostics:diagnostics});
    fetch('http://127.0.0.1:8890/api/douyin/debug',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(diagnostics)}).catch(()=>{});
    sendResponse({ok:true});
    return;
  }
  if(message?.type==='ws-debug'){
    fetch('http://127.0.0.1:8890/api/douyin/debug',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'websocket',pageUrl:sender.tab?.url||'',...message.data})}).catch(()=>{});
    sendResponse({ok:true});return;
  }
  if (message?.type !== 'douyin-comment') return;
  enqueue({...message.data,pageUrl:sender.tab?.url||''});sendResponse({ok:true,queued:true});return;
});
