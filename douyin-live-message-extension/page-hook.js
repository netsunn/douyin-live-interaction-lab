(() => {
  if (window.__douyinDecodedMessageHook) return;
  window.__douyinDecodedMessageHook = true;
  const SOURCE='douyin-live-decoded-hook';
  const send=(type,data={})=>window.postMessage({source:SOURCE,type,...data},'*');
  const installWebSocketProbe=()=>{
    const NativeWebSocket=window.WebSocket;
    if(typeof NativeWebSocket!=='function'||NativeWebSocket.__douyinProbe)return;
    let socketId=0,sendSampleCount=0;
    const preview=async(value,full=false)=>{
      try{
        let bytes;
        if(value instanceof ArrayBuffer)bytes=new Uint8Array(value);
        else if(ArrayBuffer.isView(value))bytes=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
        else if(value instanceof Blob)bytes=new Uint8Array(await value.slice(0,full?100000:256).arrayBuffer());
        else return {kind:typeof value,size:String(value||'').length,text:String(value||'').slice(0,256)};
        const captured=bytes.slice(0,full?100000:256),binary=String.fromCharCode(...captured);
        return {kind:'binary',size:bytes.byteLength,captured:captured.byteLength,truncated:captured.byteLength<bytes.byteLength,hex:[...captured.slice(0,64)].map(x=>x.toString(16).padStart(2,'0')).join(''),base64:btoa(binary)};
      }catch(error){return {kind:'error',error:error.message}}
    };
    const Wrapped=new Proxy(NativeWebSocket,{construct(Target,args){
      const socket=Reflect.construct(Target,args),id=++socketId,url=String(args[0]||'');
      send('ws-debug',{stage:'open-request',id,url,protocols:Array.isArray(args[1])?args[1]:args[1]||''});
      socket.addEventListener('open',()=>send('ws-debug',{stage:'open',id,url:socket.url,protocol:socket.protocol,extensions:socket.extensions}));
      socket.addEventListener('close',event=>send('ws-debug',{stage:'close',id,url:socket.url,code:event.code,reason:event.reason,clean:event.wasClean}));
      socket.addEventListener('error',()=>send('ws-debug',{stage:'error',id,url:socket.url}));
      socket.addEventListener('message',async event=>{const isLive=/\/webcast\/im\/push\//.test(socket.url);if(!isLive)return;send('ws-debug',{stage:'receive',id,url:socket.url,frame:await preview(event.data,true)})});
      const nativeSend=socket.send;socket.send=function(data){if(sendSampleCount++<20)preview(data).then(frame=>send('ws-debug',{stage:'send',id,url:socket.url,frame}));return nativeSend.call(this,data)};
      return socket;
    }});
    Object.defineProperty(Wrapped,'__douyinProbe',{value:true});
    window.WebSocket=Wrapped;
    send('ws-debug',{stage:'installed'});
  };
  installWebSocketProbe();
  const text=value=>String(value??'').trim();
  const first=(object,paths)=>{for(const path of paths){let value=object;for(const key of path.split('.'))value=value?.[key];if(value!==undefined&&value!==null&&text(value))return value}return''};
  const numeric=value=>{
    if(typeof value==='number')return Number.isFinite(value)?value:0;
    if(typeof value==='bigint')return Number(value);
    if(typeof value==='string'){const result=Number(value);return Number.isFinite(result)?result:0}
    if(!value||typeof value!=='object')return 0;
    try{if(typeof value.toNumber==='function'){const result=value.toNumber();if(Number.isFinite(result))return result}}catch{}
    if(Number.isFinite(value.low)){const low=value.low>>>0,high=Number(value.high)||0;return high*4294967296+low}
    for(const key of ['value','valueOf','number']){try{const candidate=typeof value[key]==='function'?value[key]():value[key],result=Number(candidate);if(Number.isFinite(result))return result}catch{}}
    return 0;
  };
  const deepNumber=(root,keys,maxDepth=7)=>{const wanted=new Set(keys),seen=new WeakSet(),queue=[{value:root,depth:0}];while(queue.length){const {value,depth}=queue.shift();if(!value||typeof value!=='object'||seen.has(value)||depth>maxDepth)continue;seen.add(value);for(const [key,child] of Object.entries(value)){if(wanted.has(key)){const result=numeric(child);if(result>0)return result}if(child&&typeof child==='object'&&depth<maxDepth)queue.push({value:child,depth:depth+1})}}return 0};
  const findDeep=(root,predicate,maxDepth=7)=>{const seen=new WeakSet(),queue=[{value:root,depth:0}];while(queue.length){const {value,depth}=queue.shift();if(!value||typeof value!=='object'||seen.has(value)||depth>maxDepth)continue;seen.add(value);try{if(predicate(value))return value}catch{}if(depth===maxDepth)continue;for(const child of Array.isArray(value)?value:Object.values(value)){if(child&&typeof child==='object')queue.push({value:child,depth:depth+1})}}return null};
  const masked=value=>!value||/^[*＊·•\s]+$/.test(value)||((value.match(/[*＊]/g)||[]).length>=Math.max(2,value.replace(/\s/g,'').length-1));
  const userIdentity=user=>{const candidates=['nickname','nick_name','display_id','unique_id','short_id'].map(key=>text(user?.[key])).filter(Boolean),clear=candidates.find(value=>!masked(value));if(clear)return clear;const id=text(user?.id_str||user?.id||user?.uid);return id?`用户尾号${id.slice(-6)}`:(candidates[0]||'')};
  const avatarValues=user=>[user?.avatar_thumb,user?.avatarThumb,user?.avatar_medium,user?.avatarMedium,user?.avatar_large,user?.avatarLarge,user?.avatar_url,user?.avatarUrl,user?.avatar];
  const explicitAvatarUrl=value=>{
    const urls=typeof value==='string'?[value]:(value?.url_list||value?.urlList||value?.urls||[]);
    return (Array.isArray(urls)?urls:[]).find(url=>typeof url==='string'&&/^https?:\/\//.test(url)&&/(aweme-avatar|user-avatar|\/avatar\/|avatar_|[?&]sc=avatar)/i.test(url)&&!/(frame|border|badge|medal|grade|level|decoration|emoji)/i.test(url))||'';
  };
  const userScore=user=>{
    if(!user||typeof user!=='object')return-1;
    let score=0;
    if(text(user.nickname||user.nick_name))score+=8;
    if(text(user.id_str||user.id||user.uid||user.sec_uid||user.secUid))score+=5;
    if(avatarValues(user).some(explicitAvatarUrl))score+=20;
    if(user.short_id||user.display_id||user.unique_id)score+=3;
    if(user.gift||user.gift_info||user.gift_name||user.diamond_count)score-=10;
    return score;
  };
  const findGiftUser=root=>{
    const direct=[root?.user,root?.from_user,root?.fromUser,root?.message?.user,root?.common?.user,root?.base_message?.user].filter(Boolean);
    const seen=new WeakSet(),queue=[{value:root,depth:0}],candidates=[...direct];
    while(queue.length){const {value,depth}=queue.shift();if(!value||typeof value!=='object'||seen.has(value)||depth>7)continue;seen.add(value);if(userScore(value)>=8)candidates.push(value);if(depth<7)for(const child of Object.values(value))if(child&&typeof child==='object')queue.push({value:child,depth:depth+1})}
    return candidates.sort((a,b)=>userScore(b)-userScore(a))[0]||{};
  };
  const avatarUrl=user=>{
    const direct=avatarValues(user);
    const looksLikeAvatar=url=>/^https?:\/\//.test(url)&&/(aweme-avatar|user-avatar|\/avatar\/|avatar_|[?&]sc=avatar)/i.test(url)&&!/(frame|border|badge|medal|grade|level|decoration|emoji|webcast\/ff1eba79)/i.test(url);
    const pick=value=>{if(typeof value==='string'&&looksLikeAvatar(value))return value;const urls=value?.url_list||value?.urlList||value?.urls;if(Array.isArray(urls)){const url=urls.find(x=>typeof x==='string'&&looksLikeAvatar(x));if(url)return url}return''};
    for(const value of direct){const found=pick(value);if(found)return found}
    const seen=new WeakSet(),queue=[{value:user,depth:0}];
    while(queue.length){const {value,depth}=queue.shift();if(!value||typeof value!=='object'||seen.has(value)||depth>4)continue;seen.add(value);for(const [key,child] of Object.entries(value)){if(/avatar|portrait|head|profile.*image/i.test(key)&&!/frame|border|badge|medal|grade|level|decoration/i.test(key)){const found=pick(child);if(found)return found}if(child&&typeof child==='object')queue.push({value:child,depth:depth+1})}}
    return'';
  };
  let lastLikeTotal=0;
  const likeEvent=(data,userName)=>{const rawCount=deepNumber(data,['count','like_count','likeCount','like_count_inc','likeCountInc','delta','increment','repeat_count','repeatCount']),total=deepNumber(data,['total','total_count','totalCount','room_like_count','roomLikeCount','like_total','likeTotal']),totalDelta=total>lastLikeTotal&&lastLikeTotal>0?total-lastLikeTotal:0;if(total>lastLikeTotal)lastLikeTotal=total;const count=Math.max(1,Math.round(rawCount||totalDelta||1));return {eventType:'like',messageId:text(first(data,['msg_id','msgId','message_id','messageId','common.msg_id','common.msgId'])),userName,avatarUrl:'',content:`点赞了 ${count} 次`,count,total:Math.round(total),countSource:rawCount?'message':totalDelta?'total-delta':'unknown',receivedAt:new Date().toISOString()}};
  const normalize=(eventType,payload)=>{
    let data=Array.isArray(payload)?(payload.find(value=>value&&typeof value==='object'&&(value.user||value.from_user||value.content||value.gift||value.data||value.message))||payload[0]):payload;if(!data||typeof data!=='object')return null;
    for(let depth=0;depth<4;depth++){const nested=data.data||data.payload||(data.message&&typeof data.message==='object'?data.message:null);if(!nested||nested===data||typeof nested!=='object')break;if(data.user||data.content||data.gift||data.gift_id)break;data=nested}
    const user=eventType==='gift'?findGiftUser(data):(data.user||data.from_user||data.fromUser||data.member||data.message?.user||data.common?.user||data.base_message?.user||findDeep(data,value=>Boolean(value.nickname||value.nick_name||value.display_id||value.unique_id||value.short_id))||{});
    const userName=text(userIdentity(user)||first(data,['user_name','nickname']));
    if(!userName)return null;
    const avatar=avatarUrl(user);
    if(eventType==='comment'){
      const content=text(first(data,['content','text','message.content','chat_content']));
      return content?{eventType,messageId:text(first(data,['msg_id','msgId','message_id','messageId','common.msg_id','common.msgId'])),userName,avatarUrl:avatar,content,receivedAt:new Date().toISOString()}:null;
    }
    if(eventType==='member')return {eventType,messageId:text(first(data,['msg_id','msgId','message_id','messageId','common.msg_id','common.msgId'])),userName,avatarUrl:avatar,content:'进入了直播间',receivedAt:new Date().toISOString()};
    if(eventType==='like')return likeEvent(data,userName);
    if(eventType==='social'){
      const action=text(first(data,['action','action_type','actionType','type','content','display_text','displayText']));
      if(/like|digg|点赞/i.test(action)||['2','4'].includes(action)){eventType='like'}
      else if(/follow|关注/i.test(action)||['1','3'].includes(action)){eventType='follow'}
      else return null;
      if(eventType==='like')return likeEvent(data,userName);
    }
    if(eventType==='system'){
      const followCarrier=findDeep(data,value=>Object.values(value).some(child=>typeof child==='string'&&/关注了主播|关注了你|follow/i.test(child)));
      if(!followCarrier)return null;
      eventType='follow';
    }
    if(eventType==='follow'){
      return {eventType,messageId:text(first(data,['msg_id','msgId','message_id','messageId','common.msg_id','common.msgId'])),userName,avatarUrl:avatar,content:'关注了主播',receivedAt:new Date().toISOString()};
    }
    const giftCarrier=findDeep(data,value=>Boolean(value.gift||value.gift_info||value.gift_name||value.giftName||value.gift_id||value.giftId))||data;
    const gift=giftCarrier.gift||giftCarrier.gift_info||findDeep(giftCarrier,value=>Boolean((value.name||value.gift_name||value.giftName)&&(value.image||value.icon||value.describe||value.diamond_count||value.id||value.id_str)))||{};
    const giftName=text(first(gift,['name','gift_name','giftName','display_name','describe'])||first(giftCarrier,['gift_name','giftName','name'])||first(data,['gift_name','giftName','gift.name','gift_info.name'])||`礼物${first(giftCarrier,['gift_id','giftId','gift.id','gift_info.id'])||first(data,['gift_id','giftId','gift.id'])||''}`),count=Math.max(1,Number(first(giftCarrier,['combo_count','comboCount','repeat_count','repeatCount','group_count','groupCount','repeat_end','repeatEnd','count','quantity'])||first(data,['combo_count','comboCount','repeat_count','repeatCount','group_count','groupCount','repeat_end','repeatEnd','count','quantity'])||1));
    return {eventType:'gift',messageId:text(first(data,['msg_id','msgId','message_id','messageId','common.msg_id','common.msgId'])),userName,avatarUrl:avatar,content:`送出 ${giftName} × ${count}`,giftName,count,receivedAt:new Date().toISOString()};
  };
  const findCandidates=require=>{
    const seen=new WeakSet(),found=[],queue=[];for(const module of Object.values(require.c||{}))queue.push({value:module?.exports,depth:0});let visited=0,index=0;
    while(index<queue.length&&visited<250000&&found.length<50){const {value,depth}=queue[index++];if((typeof value!=='object'&&typeof value!=='function')||value===null||seen.has(value))continue;seen.add(value);visited++;
      try{if(typeof value.subscribe==='function'&&(typeof value.setWebsocketKey==='function'||typeof value.setImRequestPath==='function'||value.cachedHandler||value.polling||value.websocket||value.ws))found.push(value)}catch{}
      if(depth>=10)continue;let keys=[];try{keys=Object.keys(value).slice(0,250)}catch{}for(const key of keys){try{const child=value[key];if(child&&(typeof child==='object'||typeof child==='function'))queue.push({value:child,depth:depth+1})}catch{}}
    }
    findCandidates.lastVisited=visited;return found;
  };
  let tries=0,timer=0,statusTimer=0;const attached=new WeakSet();
  const attach=()=>{
    tries++;let require;
    try{const chunks=window.webpackChunkdouyin_live_v2;if(!chunks)throw new Error('webpack not ready');chunks.push([[`local_message_hook_${Date.now()}`],{},r=>{require=r}]);if(!require)throw new Error('runtime unavailable');const messages=findCandidates(require),moduleCount=Object.keys(require.c||{}).length,visited=findCandidates.lastVisited||0;if(!messages.length)throw new Error(`message sdk unavailable; modules=${moduleCount}; visited=${visited}`);let newCount=0;
      const subscriptions=[['WebcastChatMessage','comment'],['WebcastEmojiChatMessage','comment'],['WebcastExhibitionChatMessage','comment'],['WebcastMemberMessage','member'],['WebcastLikeMessage','like'],['WebcastLikeMessageV2','like'],['WebcastDiggMessage','like'],['WebcastSocialMessage','social'],['WebcastFollowMessage','follow'],['WebcastRoomMessage','system'],['WebcastNoticeMessage','system'],['WebcastCommonTextMessage','system'],['WebcastGiftMessage','gift'],['WebcastGiftMessageV2','gift'],['WebcastGiftTrayMessage','gift'],['WebcastGiftBroadcastMessage','gift']];
      for(const message of messages){if(attached.has(message))continue;attached.add(message);newCount++;for(const [method,eventType] of subscriptions){try{message.subscribe(method,payload=>{try{const data=normalize(eventType,payload);if(data)send('decoded-event',{data})}catch{}})}catch{}}}
      send('hook-status',{connected:true,mode:'sdk',candidateCount:messages.length,newCount,moduleCount,visited});clearInterval(statusTimer);statusTimer=setInterval(()=>send('hook-status',{connected:true,mode:'sdk',candidateCount:messages.length,newCount:0,moduleCount,visited}),5000);
    }catch(error){if(tries===1||tries%5===0)send('hook-status',{connected:false,mode:'dom',reason:error.message,tries})}
  };
  timer=setInterval(attach,5000);setTimeout(attach,300);
})();
