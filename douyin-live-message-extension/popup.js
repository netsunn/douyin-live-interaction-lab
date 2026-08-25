const RECEIVER_HEALTH='http://127.0.0.1:8890/health';

function setRow(id,labelId,ok,text){document.getElementById(id).classList.toggle('ok',ok);document.getElementById(labelId).textContent=text}

async function render(){
  const state=await chrome.storage.local.get(['receivedCount','typeCounts','lastMessage','error','lastHeartbeat','hookMode','hookConnected']);
  document.getElementById('version').textContent=`v${chrome.runtime.getManifest().version}`;
  const counts={comment:0,member:0,gift:0,follow:0,like:0,fansclub:0,...state.typeCounts};document.getElementById('count').textContent=`共 ${state.receivedCount||0} 条 · 评论 ${counts.comment} · 进场 ${counts.member} · 礼物 ${counts.gift} · 关注 ${counts.follow} · 点赞 ${counts.like} · 粉丝团 ${counts.fansclub}`;
  const pageOk=Date.now()-(state.lastHeartbeat||0)<15000;
  const pageText=!pageOk?'抖音页面监听未连接':state.hookConnected?'内部消息通道已连接':'DOM兜底监听已连接';setRow('pageState','pageLabel',pageOk,pageText);
  const message=document.getElementById('message');
  if(state.error){message.classList.add('error');message.textContent=state.error}
  else if(state.lastMessage){message.classList.remove('error');message.textContent=state.lastMessage.eventType==='gift'?`🎁 ${state.lastMessage.userName}：${state.lastMessage.giftName} × ${state.lastMessage.count}\n头像：${state.lastMessage.avatarDebug||'无诊断信息'}`:state.lastMessage.eventType==='like'?`👍 ${state.lastMessage.userName}：本次 ${state.lastMessage.count||1} 次${state.lastMessage.total?` · 直播间累计 ${state.lastMessage.total}`:''}`:`${state.lastMessage.userName}：${state.lastMessage.content}`}
  try{const response=await fetch(RECEIVER_HEALTH,{cache:'no-store'});if(!response.ok)throw new Error();setRow('receiverState','receiverLabel',true,'Python接收器已连接')}catch{setRow('receiverState','receiverLabel',false,'Python接收器未连接')}
}

render();setInterval(render,2000);
