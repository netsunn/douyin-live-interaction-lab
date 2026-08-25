(() => {
  if (window.__douyinLocalMessageConnector) return;
  window.__douyinLocalMessageConnector = true;

  const handled = new WeakMap();
  const recent = new Map();
  const avatarByName=new Map(),recentNames=new Set(),avatarPromises=new Map(),avatarRetryAfter=new Map(),giftNameByImage=new Map(),giftTrayTimers=new WeakMap(),giftTrayHandled=new WeakMap(),giftTrayPending=new WeakMap();let avatarJobChain=Promise.resolve();
  const sentRecent=new Map(),pendingWithoutAvatar=new Map();let hookMode='dom';
  const domFallbackEnabled=false;
  function sendNow(key,data){const now=Date.now(),previous=sentRecent.get(key)||0;if(now-previous<80)return;sentRecent.set(key,now);for(const [k,time] of sentRecent)if(now-time>30000)sentRecent.delete(k);chrome.runtime.sendMessage({type:'douyin-comment',data}).catch(()=>setTimeout(()=>chrome.runtime.sendMessage({type:'douyin-comment',data}).catch(()=>{}),250))}
  function deliver(data){
    if(!data)return;
    const key=data.messageId||`${data.eventType}\n${data.userName}\n${data.giftName||data.content}\n${data.count||''}`;
    if(data.avatarUrl){const pending=pendingWithoutAvatar.get(key);if(pending){clearTimeout(pending.timer);pendingWithoutAvatar.delete(key)}sendNow(key,data);return}
    if(sentRecent.has(key)||pendingWithoutAvatar.has(key))return;
    const timer=setTimeout(()=>{const pending=pendingWithoutAvatar.get(key);pendingWithoutAvatar.delete(key);if(pending)sendNow(key,pending.data)},2200);
    pendingWithoutAvatar.set(key,{data,timer});
  }
  window.addEventListener('message',event=>{if(event.source!==window||event.data?.source!=='douyin-live-decoded-hook')return;if(event.data.type==='decoded-event'){const data={...event.data.data,source:'sdk'};if(data.eventType==='gift')completeAndDeliver(data,findUserItem(data.userName));else deliver(data)}if(event.data.type==='hook-status'){hookMode=event.data.connected?'sdk':'dom';chrome.runtime.sendMessage({type:'connector-heartbeat',mode:hookMode,hookConnected:Boolean(event.data.connected),reason:event.data.reason||'',candidateCount:event.data.candidateCount||0,newCount:event.data.newCount||0,moduleCount:event.data.moduleCount||0,visited:event.data.visited||0,tries:event.data.tries||0}).catch(()=>{})}if(event.data.type==='ws-debug')chrome.runtime.sendMessage({type:'ws-debug',data:event.data}).catch(()=>{})});

  function visibleContent(node) {
    let text = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent || '';
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'IMG') text += child.getAttribute('alt') || '';
        else text += visibleContent(child);
      }
    }
    return text.trim();
  }

  function memberNameFrom(text){
    const value=text.replace(/\s+/g,' ').trim();
    if(!value||/严禁未成年人|谨防网络诈骗|理性消费/.test(value))return'';
    const patterns=[
      /^欢迎\s+(.+?)\s+(?:进入|来到|加入)(?:了)?直播间[！!~～。.]?$/,
      /^(.+?)(?:\s*通过\S*进入直播间|\s*进入了?直播间|\s*加入了?直播间|\s*来到了?直播间|\s*来了)[！!~～。.]?$/
    ];
    for(const pattern of patterns){const match=value.match(pattern);if(match?.[1])return match[1].replace(/^(?:欢迎|恭喜)\s*/,'').replace(/[：:\s]+$/,'').trim()}
    return'';
  }
  function followNameFrom(text){
    const value=text.replace(/\s+/g,' ').trim(),match=value.match(/(?:^|\s)(?:感谢\s*)?([^\s]{1,40}?)\s*(?:关注了主播|关注了你)[！!~～。.]?(?:\s|$)/);
    return match?.[1]?.replace(/^(?:欢迎|感谢)\s*/,'').replace(/[：:\s]+$/,'').trim()||'';
  }
  function likeFrom(text){
    const value=text.replace(/\s+/g,' ').trim(),match=value.match(/^(.+?)[：:]?(?:为主播)?点赞了(?:\s*[xX×*]?\s*(\d+))?/i);
    const name=match?.[1]?.replace(/[：:\s]+$/,'').trim();
    return name?{name,count:Math.max(1,Number(match[2])||1)}:null;
  }
  function scanFollowNotices(root=document){
    const candidates=[];
    if(root.nodeType===Node.ELEMENT_NODE&&/关注了主播|关注了你/.test(root.textContent||''))candidates.push(root);
    root.querySelectorAll?.('*').forEach(node=>{if(/关注了主播|关注了你/.test(node.textContent||'')&&node.children.length<=3)candidates.push(node)});
    for(const node of candidates){const value=(node.innerText||node.textContent||'').replace(/\s+/g,' ').trim(),name=followNameFrom(value);if(!name)continue;const key=`follow\n${name}\n${value}`,now=Date.now(),previous=recent.get(key)||0;if(now-previous<10000)continue;recent.set(key,now);rememberName(name);completeAndDeliver({eventType:'follow',userName:name.slice(0,80),avatarUrl:domAvatar(node,name),content:'关注了主播',receivedAt:new Date().toISOString()},node)}
  }

  function rememberName(name){if(!name)return;recentNames.add(name);if(recentNames.size>300)recentNames.delete(recentNames.values().next().value)}
  function scanProfileAvatars(root=document){
    root.querySelectorAll?.('img[src*="aweme-avatar"],img[src*="user-avatar"]').forEach(img=>{
      if(img.closest('#room_info_bar'))return;
      let card=img.parentElement;
      for(let i=0;card&&i<8;i++,card=card.parentElement){const text=(card.innerText||'').replace(/\s+/g,' ').trim();if(!text||!/粉丝|关注/.test(text))continue;const name=[...recentNames].sort((a,b)=>b.length-a.length).find(value=>text.includes(value));if(name){avatarByName.set(name,img.currentSrc||img.src);break}}
    });
  }
  function giftImageKey(url){try{return new URL(url,location.href).pathname}catch{return String(url||'')}}
  function scanGiftTrays(root=document){
    const cards=[];if(root.matches?.('#GiftTrayLayout .btjeRr_1,.GiftTrayPlugin .btjeRr_1'))cards.push(root);root.querySelectorAll?.('#GiftTrayLayout .btjeRr_1,.GiftTrayPlugin .btjeRr_1').forEach(card=>cards.push(card));
    for(const card of cards){
      const giftName=(card.querySelector('.UYA_fu_6')?.textContent||'').trim(),giftImg=card.querySelector('.rUafhWtz img');if(giftName&&giftImg)giftNameByImage.set(giftImageKey(giftImg.currentSrc||giftImg.src),giftName);
      const pendingUser=(card.querySelector('.P8WJFHfQ')?.textContent||'').trim(),pendingCount=Math.max(1,Number((card.querySelector('.PcBvEQw9')?.textContent||'1').replace(/\D/g,''))||1),pendingSignature=`${pendingUser}\n${giftName}\n${pendingCount}`;
      if(!pendingUser||!giftName||giftTrayHandled.get(card)===pendingSignature||giftTrayPending.get(card)===pendingSignature)continue;
      clearTimeout(giftTrayTimers.get(card));giftTrayPending.set(card,pendingSignature);giftTrayTimers.set(card,setTimeout(()=>{
        giftTrayPending.delete(card);const userName=(card.querySelector('.P8WJFHfQ')?.textContent||'').trim(),name=(card.querySelector('.UYA_fu_6')?.textContent||'').trim(),count=Math.max(1,Number((card.querySelector('.PcBvEQw9')?.textContent||'1').replace(/\D/g,''))||1),avatarElement=card.querySelector('[class*="avatar"] img,img[class*="avatar"]'),avatarUrl=avatarElement?.currentSrc||avatarElement?.src||'',signature=`${userName}\n${name}\n${count}`;
        if(!userName||!name||giftTrayHandled.get(card)===signature)return;giftTrayHandled.set(card,signature);rememberName(userName);completeAndDeliver({eventType:'gift',userName:userName.slice(0,80),avatarUrl,content:`送出 ${name} × ${count}`,giftName:name.slice(0,80),count,receivedAt:new Date().toISOString()},card);
      },700));
    }
  }
  function profileAvatarFor(name){
    for(const img of document.querySelectorAll('img[src*="aweme-avatar"],img[src*="user-avatar"]')){
      if(img.closest('#room_info_bar'))continue;
      const url=img.currentSrc||img.src||'';
      let card=img.parentElement;
      for(let i=0;card&&i<9;i++,card=card.parentElement){const text=(card.innerText||'').replace(/\s+/g,' ').trim();if(text.includes(name)&&/粉丝|关注/.test(text)){avatarByName.set(name,url);return url}}
    }
    return'';
  }
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function findUserItem(name){
    if(!name)return null;
    const chatItems=[...document.querySelectorAll('.webcast-chatroom___item')];
    const chatItem=chatItems.reverse().find(item=>(item.innerText||'').replace(/\s+/g,' ').includes(name));
    const chatName=chatItem?.querySelector?.('.v8LY0gZF');
    if(chatName)return chatName;
    const giftNames=[...document.querySelectorAll('#GiftTrayLayout .P8WJFHfQ,.GiftTrayPlugin .P8WJFHfQ')];
    const giftName=giftNames.reverse().find(node=>(node.textContent||'').replace(/\s+/g,' ').includes(name));
    if(giftName)return giftName;
    const normalized=name.replace(/\s+/g,' ').trim(),nodes=[...document.querySelectorAll('span,div,p,a,button')],visible=node=>{const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight},matches=nodes.filter(node=>{const text=(node.textContent||'').replace(/\s+/g,' ').trim();return visible(node)&&(text===normalized||text.startsWith(`${normalized} `)||text.startsWith(`${normalized}送出`))});
    return matches.sort((a,b)=>{const at=(a.textContent||'').trim(),bt=(b.textContent||'').trim();return Number(bt===normalized)-Number(at===normalized)||at.length-bt.length||a.children.length-b.children.length})[0]||null;
  }
  async function waitForUserItem(name,item){
    for(let i=0;i<16;i++){
      const target=findUserItem(name)||(item?.isConnected?item:null);
      if(target?.isConnected)return target;
      await wait(125);
    }
    return null;
  }
  function clickUserItem(target){
    if(!target?.isConnected)return false;
    try{target.scrollIntoView?.({block:'nearest',inline:'nearest'})}catch{}
    try{target.click();return true}catch{}
    try{HTMLElement.prototype.click.call(target);return true}catch{return false}
  }
  async function openProfileForAvatar(name,item){
    const existing=profileAvatarFor(name);if(existing)return existing;
    for(let attempt=1;attempt<=3;attempt++){
      const target=await waitForUserItem(name,item);
      if(!target){console.info('[头像获取] 未找到送礼昵称',name);return''}
      const clicked=clickUserItem(target);
      console.info(`[头像获取] 第 ${attempt} 次点击送礼昵称`,name,clicked,target.className||target.tagName);
      if(!clicked)return'';
      for(let i=0;i<20;i++){await wait(125);const found=profileAvatarFor(name);if(found){console.info('[头像获取] 资料卡头像获取成功',name,found);return found}}
    }
    console.info('[头像获取] 已点击昵称但资料卡头像未出现',name);
    return'';
  }
  function resolveAvatar(name,item){
    if(avatarByName.has(name))return Promise.resolve(avatarByName.get(name));
    if((avatarRetryAfter.get(name)||0)>Date.now())return Promise.resolve('');
    if(avatarPromises.has(name))return avatarPromises.get(name);
    const job=avatarJobChain.then(()=>openProfileForAvatar(name,item)).then(url=>{if(!url)avatarRetryAfter.set(name,Date.now()+3000);return url}).catch(error=>{console.warn('[头像获取] 处理失败',name,error);avatarRetryAfter.set(name,Date.now()+3000);return''}).finally(()=>avatarPromises.delete(name));
    avatarJobChain=job.then(()=>wait(80),()=>wait(80));avatarPromises.set(name,job);return job;
  }
  function completeAndDeliver(data,item){
    deliver(data);
  }
  function domAvatar(item,userName=''){
    if(userName&&avatarByName.has(userName))return avatarByName.get(userName);
    const images=[...item.querySelectorAll('img')];
    for(const img of images){const src=img.currentSrc||img.src||img.getAttribute('data-src')||img.srcset?.split(/[ ,]/).find(x=>/^https?:/.test(x))||'';const isContentImage=Boolean(img.closest('.webcast-chatroom___content-with-emoji-emoji'))||Boolean(img.alt);if(src&&!isContentImage&&!/new_user_grade|emoji|medal|badge|level_v/i.test(src))return src}
    for(const node of [item,...item.querySelectorAll('*')]){const raw=node.style?.backgroundImage||getComputedStyle(node).backgroundImage||'';const match=raw.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/i);if(match&&!/new_user_grade|emoji|medal|badge|level_v/i.test(match[1]))return match[1]}
    return'';
  }

  function parse(item) {
    if (!item) return null;
    const contentNode = item.querySelector('.webcast-chatroom___content-with-emoji-text');
    if (!contentNode) {
      const systemText=visibleContent(item).replace(/\s+/g,' ').trim();
      if(!systemText||handled.get(item)===systemText)return null;
      const like=likeFrom(systemText);if(like){handled.set(item,systemText);if(hookMode==='sdk')return null;return {eventType:'like',userName:like.name.slice(0,80),avatarUrl:'',content:`点赞了 ${like.count} 次`,count:like.count,countSource:'dom-unknown',receivedAt:new Date().toISOString()}}
      const followName=followNameFrom(systemText);if(followName){handled.set(item,systemText);rememberName(followName);return {eventType:'follow',userName:followName.slice(0,80),avatarUrl:domAvatar(item,followName),content:'关注了主播',receivedAt:new Date().toISOString()}}
      const gift=systemText.match(/^(.+?)[：:\s]+(?:送出了|送出|赠送|送给主播)\s*(.*)$/);
      if(gift){
        const countMatch=gift[2].match(/\s*[xX×]\s*(\d+)\s*$/),userName=gift[1].replace(/[：:\s]+$/,'').trim(),giftImage=item.querySelector('img.OE08lZUF'),mappedName=giftImage?giftNameByImage.get(giftImageKey(giftImage.currentSrc||giftImage.src)):null,giftName=mappedName||gift[2].replace(/\s*[xX×]\s*\d+\s*$/,'').trim(),count=Math.max(1,Number(countMatch?.[1])||1);
        if(userName&&giftName){
          const key=`gift\n${userName}\n${giftName}\n${count}`,now=Date.now(),previous=recent.get(key)||0;
          recent.set(key,now);
          handled.set(item,systemText);
          rememberName(userName);if(now-previous>=1500)return {eventType:'gift',userName:userName.slice(0,80),avatarUrl:domAvatar(item,userName),content:`送出 ${giftName} × ${count}`,giftName:giftName.slice(0,80),count,receivedAt:new Date().toISOString()};
        }
      }
      const entryText=(item.innerText||'').replace(/\s+/g,' ').trim();
      let userName=memberNameFrom(entryText);
      if(!userName)return null;
      if(/^[*＊·•\s]+$/.test(userName)||((userName.match(/[*＊]/g)||[]).length>=Math.max(2,userName.length-1))){const alternate=[...item.querySelectorAll('[title],[aria-label],img[alt]')].map(node=>(node.getAttribute('title')||node.getAttribute('aria-label')||node.getAttribute('alt')||'').trim()).find(value=>value&&!/^[*＊·•\s]+$/.test(value));if(alternate)userName=alternate}
      if(!userName)return null;
      const key=`member\n${userName}`,now=Date.now(),previous=recent.get(key)||0;
      recent.set(key,now);
      handled.set(item,systemText);
      if(now-previous<600)return null;
      rememberName(userName);return {eventType:'member',userName:userName.slice(0,80),avatarUrl:domAvatar(item,userName),content:'进入了直播间',receivedAt:new Date().toISOString()};
    }
    const content = visibleContent(contentNode);
    const fullText = (item.innerText || '').trim();
    const signature=`${fullText}\n${content}`;
    if(!content||handled.get(item)===signature)return null;
    const index = fullText.lastIndexOf(contentNode.innerText.trim());
    const userName = (index >= 0 ? fullText.slice(0, index) : '')
      .replace(/[：:\s]+$/, '')
      .replace(/^[-·\s]+/, '')
      .trim();
    if (!userName || !content) return null;
    const key = item.dataset.id||`${userName}\n${content}`;
    const now = Date.now(), previous = recent.get(key) || 0;
    recent.set(key, now);
    handled.set(item,signature);
    for (const [k, time] of recent) if (now - time > 10000) recent.delete(k);
    if (now - previous < 80) return null;
    rememberName(userName);return {eventType:'comment',messageId:item.dataset.id||'',userName: userName.slice(0, 80),avatarUrl:domAvatar(item,userName), content: content.slice(0, 500), receivedAt: new Date().toISOString()};
  }

  function scan(root) {
    if(!domFallbackEnabled)return;
    const items = [];
    if (root.matches?.('.webcast-chatroom___item')) items.push(root);
    root.querySelectorAll?.('.webcast-chatroom___item').forEach(item => items.push(item));
    for (const item of items) {
      const data = parse(item);
      if (data) completeAndDeliver(data,item);
    }
  }

  const observedRooms=new WeakSet();
  function observeRoom(chatroom){
    if(observedRooms.has(chatroom))return;
    observedRooms.add(chatroom);scan(chatroom);
    const pending=new Set(),flush=()=>{timer=0;for(const item of pending)scan(item);pending.clear()};let timer=0;
    new MutationObserver(records => {
      for (const record of records) {
        const targetItem=record.target.nodeType===Node.ELEMENT_NODE?record.target.closest?.('.webcast-chatroom___item'):record.target.parentElement?.closest('.webcast-chatroom___item');
        if(targetItem)pending.add(targetItem);
        for (const node of record.addedNodes) {
          const item=node.nodeType===Node.ELEMENT_NODE?(node.matches?.('.webcast-chatroom___item')?node:node.closest?.('.webcast-chatroom___item')):node.parentElement?.closest('.webcast-chatroom___item');
          if(item)pending.add(item);
          if(node.nodeType===Node.ELEMENT_NODE)node.querySelectorAll?.('.webcast-chatroom___item').forEach(x=>pending.add(x));
        }
      }
      if(!timer)timer=setTimeout(flush,10);
    }).observe(chatroom, {childList: true, subtree: true, characterData: true});
  }

  function connect() {
    const attachRooms=()=>document.querySelectorAll('.webcast-chatroom').forEach(observeRoom);
    attachRooms();if(domFallbackEnabled)scanFollowNotices(document);
    new MutationObserver(records=>{attachRooms();if(!domFallbackEnabled)return;for(const record of records){if(record.type==='characterData'&&record.target.parentElement)scanFollowNotices(record.target.parentElement);if(record.target.nodeType===Node.ELEMENT_NODE)scanGiftTrays(record.target);for(const node of record.addedNodes)if(node.nodeType===Node.ELEMENT_NODE){scanProfileAvatars(node);scanGiftTrays(node);scanFollowNotices(node)}}}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
    setInterval(()=>{document.querySelectorAll('.webcast-chatroom').forEach(room=>{observeRoom(room);scan(room)});if(domFallbackEnabled){scanProfileAvatars();scanGiftTrays()}},250);
    const heartbeat=()=>chrome.runtime.sendMessage({type:'connector-heartbeat',mode:hookMode,hookConnected:hookMode==='sdk'}).catch(()=>{});heartbeat();setInterval(heartbeat,5000);
    console.info('[抖音直播消息连接器] 已启用动态消息监听');
  }

  if(document.documentElement)connect();else document.addEventListener('DOMContentLoaded',connect,{once:true});
})();
