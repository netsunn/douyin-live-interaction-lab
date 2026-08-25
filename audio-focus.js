(()=>{
  const normalAudios=new Map();
  const pausedByExclusive=new Map();
  let exclusiveAudio=null;
  let exclusiveChain=Promise.resolve();

  function register(audio,options={}){
    if(!audio||normalAudios.has(audio))return;
    normalAudios.set(audio,options);
    audio.addEventListener('play',()=>{
      if(exclusiveAudio&&audio!==exclusiveAudio)audio.pause();
    });
  }

  function fade(audio,target,duration){return new Promise(resolve=>{const from=Math.max(0,Math.min(1,audio.volume)),safeTarget=Math.max(0,Math.min(1,target)),start=performance.now();const tick=()=>{const p=Math.max(0,Math.min(1,(performance.now()-start)/duration));audio.volume=Math.max(0,Math.min(1,from+(safeTarget-from)*p));if(p<1)setTimeout(tick,25);else resolve()};tick()})}

  async function waitForBoundary(audio, marks){
    const current=audio.currentTime, rate=audio.playbackRate||1, target=marks.find(x=>x.endTime>current+.08)?.endTime;
    if(!Number.isFinite(target)||((target-current)/rate)>4)return {mode:'fallback',resumeTime:Math.max(0,current-1.2)};
    window.dispatchEvent(new CustomEvent('gift-boundary-target',{detail:{audio,target,duration:audio.duration||0}}));
    const started=performance.now();
    return await new Promise(resolve=>{const check=()=>{if(audio.paused||audio.ended)return resolve({mode:'fallback',resumeTime:Math.max(0,audio.currentTime-1.2)});if(audio.currentTime>=target-.035)return resolve({mode:'boundary',resumeTime:target});if(performance.now()-started>4500)return resolve({mode:'fallback',resumeTime:Math.max(0,audio.currentTime-1.2)});setTimeout(check,30)};check()});
  }

  async function beginExclusive(audio){
    if(exclusiveAudio===audio)return;
    exclusiveAudio=audio;
    pausedByExclusive.clear();
    for(const [item,options] of normalAudios){
      if(item!==audio&&!item.paused&&!item.ended){
        options.onState?.('礼物已收到，等待当前句结束');
        const originalVolume=Math.max(0,Math.min(1,item.volume));
        const decision=await waitForBoundary(item,options.getSentenceMarks?.()||[]);
        if(decision.mode==='fallback')await fade(item,0,300);else item.currentTime=decision.resumeTime;
        item.pause();
        window.dispatchEvent(new CustomEvent('gift-boundary-clear',{detail:{audio:item}}));
        pausedByExclusive.set(item,{...decision,volume:originalVolume});
      }
    }
  }

  async function endExclusive(audio){
    if(exclusiveAudio!==audio)return;
    exclusiveAudio=null;
    const resume=[...pausedByExclusive.entries()];
    pausedByExclusive.clear();
    for(const [item,state] of resume){
      if(item.src&&item.paused&&!item.ended){
        try{item.currentTime=state.resumeTime;item.volume=state.mode==='fallback'?0:state.volume;await item.play();if(state.mode==='fallback')await fade(item,state.volume,350);normalAudios.get(item)?.onState?.('礼物感谢已结束，继续播放直播稿')}catch{}
      }
    }
  }

  function cancelResume(audio){pausedByExclusive.delete(audio)}
  function runExclusive(audio,task){const run=exclusiveChain.then(async()=>{await beginExclusive(audio);try{return await task()}finally{await endExclusive(audio)}});exclusiveChain=run.catch(()=>{});return run}
  window.LiveAudioFocus={register,beginExclusive,endExclusive,runExclusive,cancelResume,isExclusiveActive:()=>Boolean(exclusiveAudio)};
  register(document.getElementById('ttsAudio'));
  register(document.getElementById('scriptAudio'));
})();
