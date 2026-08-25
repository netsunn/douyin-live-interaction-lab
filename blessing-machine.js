(()=>{
  const root=document.getElementById('blessingMachine');if(!root)return;
  const audio=new Audio(),queue=[],seen=new Set();let running=false,unlocked=false,total=Number(localStorage.getItem('blessing-total')||0);
  const byId=id=>document.getElementById(id),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  window.LiveAudioFocus?.register(audio,{onState:state=>byId('blessingState').textContent=state});
  byId('blessingCount').textContent=`已祈福 ${total} 人`;

  function cleanName(value){return String(value||'这位朋友').replace(/[：:]$/,'').replace(/\s+/g,' ').trim().slice(0,24)}
  function updateQueue(){byId('blessingQueue').textContent=`等待队列 ${queue.length} 人`}
  async function unlock(){audio.src='data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA';audio.volume=.01;await audio.play();await wait(80);audio.pause();audio.currentTime=0;audio.volume=1;unlocked=true;byId('enableBlessingMachine').disabled=true;byId('enableBlessingMachine').textContent='祈福机已开启';byId('blessingState').textContent='等待小心心';if(queue.length)run()}
  byId('enableBlessingMachine').onclick=()=>unlock().catch(error=>{byId('blessingState').textContent=`开启失败：${error.message}`});
  window.addEventListener('live-audio-unlocked',()=>{unlocked=true;byId('enableBlessingMachine').disabled=true;byId('enableBlessingMachine').textContent='祈福机已开启';byId('blessingState').textContent='等待小心心';if(queue.length)run()});

  async function synthesize(text){const response=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice:'zh-CN-XiaoxiaoNeural',rate:'+30%',context:'reply'})});const data=await response.json();if(!response.ok)throw new Error(data.error||'祝福语音生成失败');return data.url}
  function enqueue(event){const id=String(event.id||`${event.userName}-${event.receivedAt||Date.now()}`);if(seen.has(id)||String(event.giftName||'').trim()!=='小心心')return;seen.add(id);if(seen.size>300)seen.delete(seen.values().next().value);const name=cleanName(event.userName),text=`祝${name}顺风顺水顺财神`;queue.push({name,text,audioPromise:synthesize(text)});updateQueue();byId('blessingState').textContent=unlocked?'祈福指令已入队':'收到小心心，请先开启祈福机';if(unlocked)run()}

  async function run(){
    if(running||!unlocked||!queue.length)return;running=true;const job=queue.shift();updateQueue();root.classList.remove('is-blessing');void root.offsetWidth;root.classList.add('is-blessing');byId('blessingLabel').textContent='小心心祈福';byId('blessingUser').textContent=job.name;byId('blessingText').textContent=`祝${job.name}顺风顺水顺财神`;byId('blessingState').textContent=`正在为 ${job.name} 祈福`;
    try{audio.src=await job.audioPromise;const play=async()=>{await audio.play();await new Promise(resolve=>{audio.onended=resolve;audio.onerror=resolve})};await Promise.all([window.LiveAudioFocus?.runExclusive?window.LiveAudioFocus.runExclusive(audio,play):play(),wait(3200)]);total++;localStorage.setItem('blessing-total',String(total));byId('blessingCount').textContent=`已祈福 ${total} 人`;byId('blessingState').textContent='祈福完成'}catch(error){byId('blessingState').textContent=`祈福失败：${error.message}`}finally{await wait(450);root.classList.remove('is-blessing');running=false;if(queue.length)run();else{byId('blessingLabel').textContent='等待小心心';byId('blessingText').textContent='福至 · 财来';byId('blessingUser').textContent='送出小心心即可祈福';byId('blessingState').textContent='等待小心心'}}
  }

  window.addEventListener('live-gift-received',event=>enqueue(event.detail||{}));
})();
