(()=>{
  const audio=new Audio(),pending=[],queue=[],recent=new Map();let timer=0,busy=false,lastState='等待开启',lastText='',unlocked=false,synthesizing=0;
  window.LiveAudioFocus?.register(audio,{onState:state=>setState(state)});
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  function setState(text){lastState=text||lastState;const chip=document.getElementById('douyinStreamState'),status=document.getElementById('memberAnnouncerState');if(chip&&text)chip.textContent=text;if(status)status.textContent=`进场播报：${text||'待机'}`}
  function cleanName(value){return String(value||'').replace(/[：:]$/,'').replace(/\s+/g,' ').trim().slice(0,30)}
  function makeText(names){const unique=[...new Set(names.map(cleanName).filter(Boolean))];if(!unique.length)return'';if(unique.length<=4)return`欢迎${unique.join('、')}来了`;return`欢迎${unique.slice(0,4).join('、')}，还有${unique.length-4}位朋友来了`}
  async function synthesize(text){synthesizing++;try{const response=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice:'zh-CN-XiaoxiaoNeural',rate:'+40%',context:'reply'})});const data=await response.json();if(!response.ok)throw new Error(data.error||'进场欢迎语音生成失败');return data.url}finally{synthesizing--}}
  function createJob(names){const job={names:[...names],text:makeText(names),ready:false,version:1},version=1;job.promise=synthesize(job.text).then(url=>{if(job.version===version)job.ready=true;return url});return job}
  function refreshJob(job,names){job.names.push(...names);job.text=makeText(job.names);job.ready=false;const version=++job.version;job.promise=synthesize(job.text).then(url=>{if(job.version===version)job.ready=true;return url})}
  function flush(){timer=0;const names=pending.splice(0);if(!names.length)return;if(queue.length>=2)refreshJob(queue[queue.length-1],names);else queue.push(createJob(names));if(unlocked)run();else setState('等待点击“开启进场播报”')}
  function receive(event){const name=cleanName(event.userName),now=Date.now();if(!name||now-(recent.get(name)||0)<45000)return;recent.set(name,now);for(const [key,time] of recent)if(now-time>120000)recent.delete(key);pending.push(name);if(!timer)timer=setTimeout(flush,900)}

  async function run(){
    if(!unlocked||busy||!queue.length)return;busy=true;let failed=false;const job=queue.shift(),text=job.text;lastText=text;if(!job.ready)setState(`等待语音生成：${text.replace(/来了$/,'')}`);
    try{
      audio.src=await job.promise;
      const play=async()=>{setState(`正在播报：${text}`);await audio.play();await new Promise(resolve=>{audio.onended=resolve;audio.onerror=resolve})};
      if(window.LiveAudioFocus?.runExclusive)await window.LiveAudioFocus.runExclusive(audio,play);else await play();
    }catch(error){failed=true;setState(`失败：${error.message}`)}finally{busy=false;if(queue.length)run();else if(!failed)setState('待机')}
  }

  window.addEventListener('live-member-entered',event=>receive(event.detail||{}));
  document.getElementById('enableMemberAnnouncer')?.addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{audio.src='data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA';audio.volume=.01;await audio.play();await wait(80);audio.pause();audio.currentTime=0;audio.volume=1;unlocked=true;window.dispatchEvent(new CustomEvent('live-audio-unlocked'));button.textContent='进场播报已开启';setState('已开启，等待用户进场');if(queue.length)run()}
    catch(error){button.disabled=false;setState(`开启失败：${error.message}`)}
  });
  window.LiveMemberAnnouncer={audio,getState:()=>({unlocked,busy,synthesizing,lastState,lastText,pending:pending.length,queued:queue.length,ready:queue.filter(job=>job.ready).length,src:audio.currentSrc||audio.src,paused:audio.paused,currentTime:audio.currentTime,duration:audio.duration})};
})();
