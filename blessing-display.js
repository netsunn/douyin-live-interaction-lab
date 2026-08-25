(() => {
  window.addEventListener("error", (event) => {
    console.error("[直播画面] 运行错误", event.error || event.message);
    const state = document.getElementById("connectionState");
    if (state) state.textContent = "页面处理异常，消息流仍在重连";
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[直播画面] 异步错误", event.reason);
  });
  const byId = (id) => document.getElementById(id),
    canvas = byId("printCanvas"),
    ctx = canvas.getContext("2d"),
    audio = new Audio();
  const messages = [],
    printQueue = [],
    speechQueue = [],
    memberSpeechNames = [],
    seen = new Set(),
    idleMessages = [
      "刚好路过的朋友，给主播留个表情吧～",
      "今天的好运，正在路上排队啦！",
      "看到这里的朋友，愿你今天有个小惊喜～",
      "评论区报个到，让我知道你来过啦！",
      "这张纸马上要写满了，下一条想看什么？",
      "悄悄问一句：你今天开心吗？",
      "给屏幕前的你送一份顺风顺水～",
      "如果这句话被你看到，说明好运已签到！",
      "来都来了，给主播点个小小的支持吧～",
      "现在的你，值得一杯好喝的和一点好运！",
      "给主播加个关注，主播祝你好运连连、每天都有小惊喜～",
      "给主播点点赞，主播祝你心想事成、顺顺利利～",
      "给主播送张人气票，主播祝你财运一路高升～",
      "点个关注留个赞，主播祝你生活甜甜、烦恼少少～",
      "人气票走一张，主播祝你福气满满、好运常伴～",
    ];
  let printing = false,
    speaking = false,
    currentSpeechType = "",
    currentSpeechStartedAt = 0,
    unlocked = false,
    audioContext = null,
    printerSoundBuffer = null,
    printerImageSoundBuffer = null,
    glassShatterBuffer = null,
    swordSwingBuffer = null,
    feed = 1,
    animationId = 0,
    finishFeedAnimation = null,
    memberSpeechTimer = 0,
    pendingSpeechCount = 0,
    idleMessageIndex = 0,
    lastRealEventAt = Date.now(),
    lastIdleMessageAt = 0;
  let printerSoundEnabled =
    localStorage.getItem("receipt-printer-sound-enabled") !== "false";
  let total = Number(localStorage.getItem("receipt-print-total") || 0),
    viewW = 0,
    viewH = 0,
    dpr = 1;
  const avatarMarbles = [];
  let marbleAnimationId = 0,
    lastMarbleFrame = 0,
    marbleSequence = 0;
  const scoreEvents = [],
    recentUsers = [],
    SCORE_WINDOW_MS = 5 * 60 * 1000;
  const sfxLast = Object.create(null);
  const activePrinterSources = new Set();
  let lastScoreTop = "",
    recentSequence = 0;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  byId("printCount").textContent = String(total);
  byId("printQueueState").textContent = "待打印 0 条";
  const giftPrintImages = {
    heart: new Image(),
    beer: new Image(),
    lightSign: new Image(),
    other: new Image(),
  };
  const weaponImages = {
    axe: "/weapon-1-axe.png",
    sickle: "/weapon-2-sickle.png",
    mace: "/weapon-3-mace.png",
    cleaver: "/weapon-4-cleaver.png",
    sword: "/weapon-5-sword.png",
  };
  giftPrintImages.heart.src = "/heart-print.jpg";
  giftPrintImages.beer.src = "/big-beer-print.jpg";
  giftPrintImages.lightSign.src = "/light-sign-print.jpg";
  giftPrintImages.other.src = "/other-gift-print.png";
  Object.values(giftPrintImages).forEach((img) => (img.onload = () => draw()));
  const scoreStampFrame = new Image();
  scoreStampFrame.src = "/score-stamp-frame.png";
  scoreStampFrame.onload = () => draw();
  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    viewW = r.width;
    viewH = r.height;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  new ResizeObserver(resize).observe(canvas);
  function clean(v, max = 36) {
    return String(v || "这位朋友")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }
  function speechSafe(v) {
    return String(v || "")
      .replace(/[*＊]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  function clock(v) {
    const d = v ? new Date(v) : new Date();
    return Number.isNaN(d.getTime())
      ? "--:--"
      : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  function remember(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 700) seen.delete(seen.values().next().value);
    return true;
  }
  function eventId(type, e) {
    return `${type}-${e.id || `${e.userName}-${e.receivedAt}-${e.content || e.giftName}`}`;
  }
  function updateSpeechCount() {
    byId("queueState").textContent = `待播报 ${pendingSpeechCount} 条`;
  }
  function updatePrintQueueCount() {
    byId("printQueueState").textContent = `待打印 ${printQueue.length} 条`;
  }
  function canPlaySfx(type, gap) {
    if (!audioContext || audioContext.state !== "running") return false;
    const now = performance.now();
    if (now - (sfxLast[type] || 0) < gap) return false;
    sfxLast[type] = now;
    return true;
  }
  function sfxTone(
    frequency,
    duration,
    gainValue,
    wave = "sine",
    endFrequency = frequency,
    delay = 0,
  ) {
    const start = audioContext.currentTime + delay,
      oscillator = audioContext.createOscillator(),
      gain = audioContext.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, endFrequency),
      start + duration,
    );
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }
  function sfxNoise(duration, gainValue, filterType, frequency) {
    const length = Math.ceil(audioContext.sampleRate * duration),
      buffer = audioContext.createBuffer(1, length, audioContext.sampleRate),
      data = buffer.getChannelData(0),
      source = audioContext.createBufferSource(),
      filter = audioContext.createBiquadFilter(),
      gain = audioContext.createGain(),
      now = audioContext.currentTime;
    for (let index = 0; index < length; index++)
      data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, 1.8);
    source.buffer = buffer;
    filter.type = filterType;
    filter.frequency.value = frequency;
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter).connect(gain).connect(audioContext.destination);
    source.start(now);
  }
  function collisionSfx(relativeSpeed = 120) {
    if (!canPlaySfx("collision", 62)) return;
    const strength = Math.max(0, Math.min(1, (relativeSpeed - 35) / 260)),
      base = (1450 - strength * 260) * (0.94 + Math.random() * 0.12),
      volume = 0.032 + strength * 0.04;
    // Several quickly fading inharmonic partials mimic a small glass marble clink.
    sfxTone(base, 0.095, volume, "sine", base * 0.94);
    sfxTone(base * 1.63, 0.07, volume * 0.52, "sine", base * 1.55, 0.002);
    sfxTone(base * 2.41, 0.045, volume * 0.25, "triangle", base * 2.28, 0.001);
    if (strength > 0.45)
      sfxNoise(0.035, 0.01 + strength * 0.012, "highpass", 2800);
  }
  function weaponHitSfx() {
    if (!canPlaySfx("weapon", 105)) return;
    if (swordSwingBuffer) {
      const source = audioContext.createBufferSource(),
        gain = audioContext.createGain(),
        now = audioContext.currentTime;
      source.buffer = swordSwingBuffer;
      source.playbackRate.value = 0.94 + Math.random() * 0.12;
      gain.gain.setValueAtTime(0.72, now);
      gain.gain.setValueAtTime(0.68, now + 0.38);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.47);
      source.connect(gain).connect(audioContext.destination);
      source.start(now);
      return;
    }
    sfxNoise(0.13, 0.045, "bandpass", 1850);
    sfxTone(720, 0.11, 0.025, "triangle", 240);
  }
  function mergeSfx() {
    if (!canPlaySfx("merge", 180)) return;
    sfxTone(440, 0.14, 0.04, "sine", 660);
    sfxTone(660, 0.17, 0.035, "sine", 990, 0.075);
  }
  function shatterSfx() {
    if (!canPlaySfx("shatter", 260) || !glassShatterBuffer) return;
    const source = audioContext.createBufferSource(),
      gain = audioContext.createGain(),
      now = audioContext.currentTime;
    source.buffer = glassShatterBuffer;
    source.playbackRate.value = 0.96 + Math.random() * 0.08;
    gain.gain.setValueAtTime(0.32, now);
    gain.gain.setValueAtTime(0.28, now + 1.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);
    source.connect(gain).connect(audioContext.destination);
    source.start(now);
  }
  function energySfx() {
    if (!canPlaySfx("energy", 220)) return;
    sfxTone(210, 0.2, 0.035, "sawtooth", 620);
  }
  let topKillCount = 0,
    topKillerName = "",
    killNoticeHideTimer = 0;
  function updateKillNotice(attacker) {
    attacker.killCount = (attacker.killCount || 0) + 1;
    if (attacker.killCount < topKillCount) return;
    topKillCount = attacker.killCount;
    topKillerName = attacker.name || "玩家";
    const notice = byId("killNotice");
    if (!notice) return;
    notice.replaceChildren();
    if (attacker.avatarUrl) {
      const avatar = document.createElement("img");
      avatar.className = "kill-avatar";
      avatar.src = attacker.avatarUrl;
      avatar.alt = "";
      avatar.referrerPolicy = "no-referrer";
      avatar.onerror = () => avatar.remove();
      notice.append(avatar);
    }
    const nameNode = document.createElement("span");
    nameNode.className = "kill-name";
    nameNode.textContent = topKillerName;
    const countNode = document.createElement("strong");
    countNode.className = "kill-count";
    countNode.textContent = String(topKillCount);
    const tailNode = document.createElement("span");
    tailNode.className = "kill-tail";
    tailNode.textContent = "连杀，杀疯了 🔥";
    notice.append(nameNode, countNode, tailNode);
    notice.classList.remove("is-visible");
    void notice.offsetWidth;
    notice.classList.add("is-visible");
    clearTimeout(killNoticeHideTimer);
    killNoticeHideTimer = setTimeout(() => {
      notice.classList.remove("is-visible");
    }, 5000);
  }
  function awardWeaponHit(attacker, target, now) {
    if (attacker.count < 2) return;
    const previous = attacker.weaponHits.get(target.id) || 0;
    if (now - previous < 1200) return;
    attacker.weaponHits.set(target.id, now);
    attacker.lastWeaponHitAt = now;
    weaponHitSfx();
    const weaponDamage = Math.min(
      5,
      Math.max(1, Math.floor(attacker.count) - 1),
    );
    const wasLethal = target.health <= weaponDamage;
    damageMarble(target, weaponDamage);
    if (wasLethal) updateKillNotice(attacker);
    updateScoreLeaderboard({
      rankUserName: attacker.name,
      rankPoints: 1,
      avatarUrl: attacker.avatarUrl,
    });
    const popup = document.createElement("b");
    popup.className = "weapon-score-pop";
    popup.textContent = "+1";
    popup.style.left = `${attacker.x + attacker.size * (0.55 + Math.random() * 0.38)}px`;
    popup.style.top = `${attacker.y + attacker.size * (0.08 + Math.random() * 0.2)}px`;
    byId("avatarMarbles").append(popup);
    setTimeout(() => popup.remove(), 850);
  }
  function renderMarbleHealth(marble) {
    const maxHealth = marble.maxHealth || 10,
      value = Math.max(0, Math.min(maxHealth, marble.health));
    marble.healthFill.style.width = `${(value / maxHealth) * 100}%`;
    marble.healthBar.setAttribute(
      "aria-label",
      `剩余血量 ${value}/${maxHealth}`,
    );
  }
  function destroyMarble(marble) {
    if (marble.removing) return;
    marble.removing = true;
    shatterSfx();
    marble.healthBar.style.visibility = "hidden";
    shatterMarble(marble);
    setTimeout(() => {
      const index = avatarMarbles.indexOf(marble);
      if (index >= 0) avatarMarbles.splice(index, 1);
      marble.node.remove();
      marble.healthBar.remove();
    }, 620);
  }
  function showDamagePopup(marble, amount) {
    const popup = document.createElement("b");
    popup.className = "damage-score-pop";
    popup.textContent = `-${amount}`;
    popup.style.left = `${marble.x + marble.size * (0.25 + Math.random() * 0.4)}px`;
    popup.style.top = `${marble.y + marble.size * 0.12}px`;
    byId("avatarMarbles").append(popup);
    setTimeout(() => popup.remove(), 760);
  }
  function damageMarble(marble, amount) {
    if (marble.removing) return;
    marble.health = Math.max(0, marble.health - amount);
    marble.lastDamageAt = performance.now();
    showDamagePopup(marble, amount);
    renderMarbleHealth(marble);
    marble.node.classList.remove("marble-damaged");
    void marble.node.offsetWidth;
    marble.node.classList.add("marble-damaged");
    setTimeout(() => marble.node.classList.remove("marble-damaged"), 240);
    if (marble.health <= 0) destroyMarble(marble);
  }
  function damageCollisionPair(a, b, now) {
    if (now - (a.collisionHits.get(b.id) || 0) < 650) return;
    a.collisionHits.set(b.id, now);
    b.collisionHits.set(a.id, now);
    collisionSfx(Math.hypot(a.vx - b.vx, a.vy - b.vy));
    damageMarble(a, 1);
    damageMarble(b, 1);
  }
  function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1,
      dy = y2 - y1,
      lengthSquared = dx * dx + dy * dy,
      t = lengthSquared
        ? Math.max(
            0,
            Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared),
          )
        : 0,
      nearestX = x1 + dx * t,
      nearestY = y1 + dy * t;
    return Math.hypot(px - nearestX, py - nearestY);
  }
  function processWeaponHits(now) {
    for (const attacker of avatarMarbles) {
      if (attacker.removing || attacker.count < 2) continue;
      const angle = (attacker.rotation * Math.PI) / 180,
        centerX = attacker.x + attacker.size / 2,
        centerY = attacker.y + attacker.size / 2,
        directionX = Math.cos(angle),
        directionY = Math.sin(angle),
        startX = centerX + directionX * attacker.size * 0.28,
        startY = centerY + directionY * attacker.size * 0.28,
        endX = centerX + directionX * attacker.size * 1.55,
        endY = centerY + directionY * attacker.size * 1.55;
      for (const target of avatarMarbles) {
        if (
          target === attacker ||
          target.removing ||
          target.name === attacker.name
        )
          continue;
        const targetX = target.x + target.size / 2,
          targetY = target.y + target.size / 2,
          hitDistance = distanceToSegment(
            targetX,
            targetY,
            startX,
            startY,
            endX,
            endY,
          );
        if (hitDistance <= target.size / 2 + 5)
          awardWeaponHit(attacker, target, now);
      }
    }
  }
  function shatterMarble(marble) {
    const polygons = [
        "polygon(0 0,52% 0,43% 38%,0 47%)",
        "polygon(52% 0,100% 0,100% 39%,43% 38%)",
        "polygon(0 47%,43% 38%,52% 66%,11% 100%,0 100%)",
        "polygon(43% 38%,100% 39%,100% 76%,52% 66%)",
        "polygon(11% 100%,52% 66%,66% 100%)",
        "polygon(52% 66%,100% 76%,100% 100%,66% 100%)",
      ],
      directions = [
        [-20, -22, -24],
        [23, -18, 27],
        [-27, 9, -18],
        [28, 5, 30],
        [-12, 28, 16],
        [18, 31, -22],
      ],
      imageUrl = marble.node.querySelector(":scope > img")?.currentSrc || "",
      initial = marble.node.querySelector(":scope > span")?.textContent || "友";
    marble.node.classList.add("marble-exit");
    polygons.forEach((clip, index) => {
      const shard = document.createElement("i"),
        [x, y, rotation] = directions[index];
      shard.className = "marble-shard";
      shard.style.clipPath = clip;
      shard.style.setProperty("--shard-x", `${x}px`);
      shard.style.setProperty("--shard-y", `${y}px`);
      shard.style.setProperty("--shard-r", `${rotation}deg`);
      if (imageUrl) shard.style.backgroundImage = `url("${imageUrl}")`;
      else {
        shard.classList.add("initial-shard");
        shard.textContent = initial;
      }
      marble.node.append(shard);
    });
  }
  function updateMarbleSkill(marble) {
    marble.node.classList.toggle("skill-impact", marble.count >= 2);
    marble.node.classList.toggle("skill-devour", marble.count >= 3);
    marble.node.classList.toggle("skill-magnet", marble.count >= 4);
    const weaponName =
      marble.count >= 6
        ? "sword"
        : marble.count >= 5
          ? "cleaver"
          : marble.count >= 4
            ? "mace"
            : marble.count >= 3
              ? "sickle"
              : marble.count >= 2
                ? "axe"
                : "none";
    marble.node.dataset.weapon = weaponName;
    const weaponImage = marble.node.querySelector(".marble-weapon > img"),
      weaponSource = weaponImages[weaponName];
    if (weaponSource && weaponImage.getAttribute("src") !== weaponSource)
      weaponImage.src = weaponSource;
    else if (!weaponSource) weaponImage.removeAttribute("src");
  }
  function resizeMarble(marble, centerX, centerY) {
    marble.size = Math.min(126, 42 * Math.sqrt(marble.count));
    marble.x = centerX - marble.size / 2;
    marble.y = centerY - marble.size / 2;
    marble.node.style.width = `${marble.size}px`;
    marble.node.style.height = `${marble.size}px`;
    updateMarbleSkill(marble);
  }
  function downgradeMarble(marble, now) {
    if (marble.count <= 1 || now - marble.lastWeaponHitAt < 5000) return;
    const centerX = marble.x + marble.size / 2,
      centerY = marble.y + marble.size / 2;
    marble.count = Math.max(1, Math.floor(marble.count) - 1);
    marble.maxHealth = 10 + Math.max(0, marble.count - 1) * 4;
    marble.health = Math.min(marble.health, marble.maxHealth);
    marble.lastWeaponHitAt = now;
    resizeMarble(marble, centerX, centerY);
    renderMarbleHealth(marble);
    marble.node.classList.remove("marble-downgrade");
    void marble.node.offsetWidth;
    marble.node.classList.add("marble-downgrade");
    setTimeout(() => marble.node.classList.remove("marble-downgrade"), 200);
  }
  function absorbMarbleEnergy(hunter, target, now) {
    const centerX = hunter.x + hunter.size / 2,
      centerY = hunter.y + hunter.size / 2,
      dx = target.x + target.size / 2 - centerX,
      dy = target.y + target.size / 2 - centerY,
      distance = Math.max(1, Math.hypot(dx, dy)),
      nx = dx / distance,
      ny = dy / distance;
    hunter.count = Math.min(
      6,
      hunter.count + Math.min(0.12, target.count * 0.08),
    );
    hunter.lastDevourAt = now;
    energySfx();
    hunter.vx -= nx * 28;
    hunter.vy -= ny * 28;
    target.vx += nx * 185;
    target.vy += ny * 185 - 55;
    resizeMarble(hunter, centerX, centerY);
    hunter.node.classList.remove("marble-devour");
    void hunter.node.offsetWidth;
    hunter.node.classList.add("marble-devour");
    setTimeout(() => hunter.node.classList.remove("marble-devour"), 520);
    target.node.classList.remove("marble-energy-hit");
    void target.node.offsetWidth;
    target.node.classList.add("marble-energy-hit");
    setTimeout(() => target.node.classList.remove("marble-energy-hit"), 360);
  }
  function mergeMarbles(a, b) {
    const total = Math.min(6, a.count + b.count),
      centerX = (a.x + a.size / 2 + b.x + b.size / 2) / 2,
      centerY = (a.y + a.size / 2 + b.y + b.size / 2) / 2;
    mergeSfx();
    a.vx = (a.vx * a.count + b.vx * b.count) / total;
    a.vy = (a.vy * a.count + b.vy * b.count) / total - 55;
    a.spin = (a.spin * a.count + b.spin * b.count) / total;
    a.count = total;
    a.maxHealth = 10 + Math.max(0, Math.floor(a.count) - 1) * 4;
    a.health = a.maxHealth;
    a.lastDamageAt = performance.now();
    renderMarbleHealth(a);
    resizeMarble(a, centerX, centerY);
    a.node.classList.remove("marble-merge");
    void a.node.offsetWidth;
    a.node.classList.add("marble-merge");
    setTimeout(() => a.node.classList.remove("marble-merge"), 460);
    const index = avatarMarbles.indexOf(b);
    if (index >= 0) avatarMarbles.splice(index, 1);
    b.node.remove();
    b.healthBar.remove();
  }
  function spawnAvatarMarble(name, avatarUrl, initialCount = 1) {
    const layer = byId("avatarMarbles"),
      scene = byId("printScene"),
      count = Math.min(6, Math.max(1, Number(initialCount) || 1)),
      size = Math.min(126, 42 * Math.sqrt(count)),
      direction = Math.random() < 0.5 ? -1 : 1,
      node = document.createElement("div"),
      img = document.createElement("img"),
      initial = document.createElement("span"),
      weapon = document.createElement("i"),
      weaponImage = document.createElement("img"),
      healthBar = document.createElement("i"),
      healthFill = document.createElement("i");
    node.className = "avatar-marble";
    img.referrerPolicy = "no-referrer";
    if (messageSettings.avatars && avatarUrl) img.src = avatarUrl;
    else node.classList.add("no-avatar");
    initial.textContent = (
      String(name).match(/[\p{Script=Han}A-Za-z0-9]/u)?.[0] ||
      [...String(name)][0] ||
      "友"
    ).toUpperCase();
    weapon.className = "marble-weapon";
    weaponImage.alt = "";
    weaponImage.draggable = false;
    weapon.append(weaponImage);
    healthBar.className = "marble-health";
    healthFill.className = "marble-health-fill";
    healthBar.append(healthFill);
    node.append(img, initial, weapon);
    layer.append(node, healthBar);
    const marble = {
      id: ++marbleSequence,
      node,
      x: Math.min(scene.clientWidth - size, 138),
      y: 39,
      vx: direction * (85 + Math.random() * 105),
      vy: 45 + Math.random() * 65,
      size,
      name: String(name),
      avatarUrl: messageSettings.avatars ? String(avatarUrl || "") : "",
      count,
      maxHealth: 10 + Math.max(0, Math.floor(count) - 1) * 4,
      health: 10 + Math.max(0, Math.floor(count) - 1) * 4,
      lastDamageAt: performance.now(),
      lastWeaponHitAt: performance.now(),
      healthBar,
      healthFill,
      rotation: 0,
      spin: direction * (90 + Math.random() * 150),
      removing: false,
      lastDevourAt: 0,
      weaponHits: new Map(),
      collisionHits: new Map(),
      killCount: 0,
    };
    node.dataset.count = String(marble.count);
    node.style.width = `${marble.size}px`;
    node.style.height = `${marble.size}px`;
    healthBar.style.width = `${marble.size * 0.8}px`;
    avatarMarbles.push(marble);
    updateMarbleSkill(marble);
    renderMarbleHealth(marble);
    if (!marbleAnimationId) {
      lastMarbleFrame = performance.now();
      marbleAnimationId = requestAnimationFrame(animateMarbles);
    }
  }
  function animateMarbles(now) {
    const scene = byId("printScene"),
      dt = Math.min(0.032, Math.max(0.001, (now - lastMarbleFrame) / 1000));
    lastMarbleFrame = now;
    avatarMarbles.forEach((marble) =>
      marble.node.classList.remove("marble-magnet-pulled"),
    );
    for (let i = 0; i < avatarMarbles.length; i++)
      for (let j = i + 1; j < avatarMarbles.length; j++) {
        const a = avatarMarbles[i],
          b = avatarMarbles[j];
        if (a.removing || b.removing || a.name !== b.name) continue;
        if (a.count < 4 && b.count < 4) continue;
        const dx = b.x + b.size / 2 - (a.x + a.size / 2),
          dy = b.y + b.size / 2 - (a.y + a.size / 2),
          distance = Math.max(1, Math.hypot(dx, dy));
        if (distance > 320) continue;
        const force = (1 - distance / 320) * 760 * dt,
          nx = dx / distance,
          ny = dy / distance;
        if (a.count >= 4) b.node.classList.add("marble-magnet-pulled");
        if (b.count >= 4) a.node.classList.add("marble-magnet-pulled");
        a.vx += nx * force;
        a.vy += ny * force;
        b.vx -= nx * force;
        b.vy -= ny * force;
      }
    for (const marble of avatarMarbles) {
      if (marble.removing) continue;
      downgradeMarble(marble, now);
      if (
        marble.health < marble.maxHealth &&
        now - marble.lastDamageAt >= 5000
      ) {
        marble.health = Math.min(marble.maxHealth, marble.health + 1);
        marble.lastDamageAt = now;
        renderMarbleHealth(marble);
      }
      marble.vy += 520 * dt;
      marble.x += marble.vx * dt;
      marble.y += marble.vy * dt;
      marble.rotation += marble.spin * dt;
      const maxX = scene.clientWidth - marble.size,
        maxY = scene.clientHeight - marble.size;
      if (marble.x < 0) {
        marble.x = 0;
        marble.vx = Math.abs(marble.vx) * 0.82;
        marble.spin = Math.abs(marble.spin);
      } else if (marble.x > maxX) {
        marble.x = maxX;
        marble.vx = -Math.abs(marble.vx) * 0.82;
        marble.spin = -Math.abs(marble.spin);
      }
      if (marble.y < 0) {
        marble.y = 0;
        marble.vy = Math.abs(marble.vy) * 0.78;
      } else if (marble.y > maxY) {
        marble.y = maxY;
        marble.vy = -Math.abs(marble.vy) * 0.72;
        marble.vx *= 0.94;
        if (Math.abs(marble.vy) < 28) marble.vy = 0;
      }
    }
    processWeaponHits(now);
    for (let i = 0; i < avatarMarbles.length; i++)
      for (let j = i + 1; j < avatarMarbles.length; j++) {
        const a = avatarMarbles[i],
          b = avatarMarbles[j],
          radius = (a.size + b.size) / 4,
          dx = b.x + b.size / 2 - (a.x + a.size / 2),
          dy = b.y + b.size / 2 - (a.y + a.size / 2),
          distance = Math.hypot(dx, dy);
        if (a.removing || b.removing) continue;
        if (distance >= radius * 2) continue;
        if (a.name === b.name) {
          mergeMarbles(a, b);
          j -= 1;
          continue;
        }
        const hitNx = distance > 0.001 ? dx / distance : 1,
          hitNy = distance > 0.001 ? dy / distance : 0,
          approachSpeed = (b.vx - a.vx) * hitNx + (b.vy - a.vy) * hitNy;
        if (approachSpeed < -8) {
          damageCollisionPair(a, b, now);
        }
        const aCanAbsorb =
            a.count >= 3 &&
            a.size >= b.size * 1.2 &&
            now - a.lastDevourAt >= 3000,
          bCanAbsorb =
            b.count >= 3 &&
            b.size >= a.size * 1.2 &&
            now - b.lastDevourAt >= 3000;
        if (aCanAbsorb || bCanAbsorb)
          absorbMarbleEnergy(aCanAbsorb ? a : b, aCanAbsorb ? b : a, now);
        const nx = distance > 0.001 ? dx / distance : 1,
          ny = distance > 0.001 ? dy / distance : 0,
          overlap = radius * 2 - Math.max(distance, 0.001);
        a.x -= (nx * overlap) / 2;
        a.y -= (ny * overlap) / 2;
        b.x += (nx * overlap) / 2;
        b.y += (ny * overlap) / 2;
        const relativeX = b.vx - a.vx,
          relativeY = b.vy - a.vy,
          closingSpeed = relativeX * nx + relativeY * ny;
        if (closingSpeed < 0) {
          const impactBoost = a.count >= 2 || b.count >= 2 ? 1.08 : 0.78,
            impulse = (-(1 + impactBoost) * closingSpeed) / 2;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;
          const tangentSpeed = relativeX * -ny + relativeY * nx;
          a.spin -= tangentSpeed * 0.7;
          b.spin += tangentSpeed * 0.7;
        }
      }
    for (const marble of avatarMarbles) {
      marble.node.style.transform = `translate3d(${marble.x}px,${marble.y}px,0) rotate(${marble.rotation}deg)`;
      marble.healthBar.style.width = `${marble.size * 0.8}px`;
      marble.healthBar.style.transform = `translate3d(${marble.x + marble.size * 0.1}px,${marble.y - 9}px,0)`;
    }
    marbleAnimationId = requestAnimationFrame(animateMarbles);
  }
  function updateRecentInteractions(item) {
    const name = String(item.rankUserName || "").trim();
    if (!name || item.type === "idle") return;
    const parsedAt = Date.parse(item.recentAt || ""),
      entry = {
        key: String(++recentSequence),
        name,
        avatarUrl: String(item.avatarUrl || ""),
        initialCount: item.type === "follow" ? 3 : item.type === "gift" ? 2 : 1,
        at: Number.isFinite(parsedAt) ? parsedAt : Date.now(),
        sequence: recentSequence,
      },
      list = byId("recentInteractions"),
      previous = [...list.children],
      previousKeys = new Set(recentUsers.map((user) => user.key)),
      oldRects = new Map(
        previous.map((row) => [row.dataset.key, row.getBoundingClientRect()]),
      );
    recentUsers.push(entry);
    recentUsers.sort((a, b) => b.at - a.at || b.sequence - a.sequence);
    const displaced = recentUsers
      .slice(4)
      .filter((user) => previousKeys.has(user.key));
    recentUsers.splice(4);
    displaced.forEach((user) =>
      spawnAvatarMarble(user.name, user.avatarUrl, user.initialCount),
    );
    const rows = recentUsers.map((user) => {
      let row = previous.find((node) => node.dataset.key === user.key);
      if (!row) {
        row = document.createElement("li");
        row.dataset.key = user.key;
        const img = document.createElement("img"),
          initial = document.createElement("span"),
          weapon = document.createElement("i"),
          weaponImage = document.createElement("img");
        img.referrerPolicy = "no-referrer";
        weapon.className = "recent-weapon";
        weaponImage.alt = "";
        weapon.append(weaponImage);
        row.append(img, initial, weapon);
      }
      const img = row.querySelector("img"),
        initial = row.querySelector("span");
      row.classList.toggle("no-avatar", !user.avatarUrl);
      row.classList.toggle("recent-level-2", user.initialCount >= 2);
      row.classList.toggle("recent-level-3", user.initialCount >= 3);
      row.dataset.level = String(user.initialCount);
      const recentWeaponImage = row.querySelector(".recent-weapon img");
      recentWeaponImage.src =
        user.initialCount >= 3 ? weaponImages.sickle : weaponImages.axe;
      if (user.avatarUrl) img.src = user.avatarUrl;
      else img.removeAttribute("src");
      initial.textContent = (
        user.name.match(/[\p{Script=Han}A-Za-z0-9]/u)?.[0] ||
        [...user.name][0] ||
        "友"
      ).toUpperCase();
      img.alt = user.avatarUrl ? user.name : "";
      return row;
    });
    list.replaceChildren(...rows);
    rows.forEach((row) => {
      const oldRect = oldRects.get(row.dataset.key);
      if (!oldRect) {
        row.classList.add("recent-enter");
        setTimeout(() => row.classList.remove("recent-enter"), 450);
        return;
      }
      const rect = row.getBoundingClientRect(),
        dx = oldRect.left - rect.left;
      if (Math.abs(dx) < 1) return;
      row.style.transition = "none";
      row.style.transform = `translateX(${dx}px)`;
      void row.offsetWidth;
      row.style.transition = "transform .46s cubic-bezier(.22,.8,.2,1)";
      row.style.transform = "translateX(0)";
      setTimeout(() => {
        row.style.transition = "";
        row.style.transform = "";
      }, 520);
    });
  }
  function updateScoreLeaderboard(item) {
    const name = String(item.rankUserName || ""),
      points = Math.max(0, Number(item.rankPoints) || 0),
      avatarUrl = String(item.avatarUrl || "");
    if (!name || !points) return;
    scoreEvents.push({ name, points, avatarUrl, at: Date.now() });
    renderScoreLeaderboard();
  }
  function currentScores() {
    const cutoff = Date.now() - SCORE_WINDOW_MS,
      scores = new Map();
    for (const event of scoreEvents) {
      if (event.at <= cutoff) continue;
      const current = scores.get(event.name) || { points: 0, avatarUrl: "" };
      current.points += event.points;
      if (event.avatarUrl) current.avatarUrl = event.avatarUrl;
      scores.set(event.name, current);
    }
    return scores;
  }
  function renderScoreLeaderboard() {
    const cutoff = Date.now() - SCORE_WINDOW_MS;
    while (scoreEvents.length && scoreEvents[0].at <= cutoff)
      scoreEvents.shift();
    const scores = currentScores();
    const top = [...scores]
        .sort(
          (a, b) =>
            b[1].points - a[1].points || a[0].localeCompare(b[0], "zh-CN"),
        )
        .slice(0, 3),
      signature = top
        .map(
          ([userName, data]) => `${userName}:${data.points}:${data.avatarUrl}`,
        )
        .join("\n");
    if (signature === lastScoreTop) return;
    lastScoreTop = signature;
    const list = byId("likeLeaderboard"),
      oldRows = new Map(
        [...list.children].map((row) => [row.dataset.user, row]),
      ),
      oldRects = new Map(
        [...oldRows].map(([userName, row]) => [
          userName,
          row.getBoundingClientRect(),
        ]),
      );
    const nextRows = top.map(([userName, data], index) => {
      let row = oldRows.get(userName),
        avatar,
        fallback,
        rankNumber;
      if (row) {
        avatar = row.querySelector("img");
        fallback = row.querySelector("b.avatar-initial");
        rankNumber = row.querySelector("em.rank-number");
      } else {
        row = document.createElement("li");
        row.dataset.user = userName;
        rankNumber = document.createElement("em");
        rankNumber.className = "rank-number";
        avatar = document.createElement("img");
        avatar.referrerPolicy = "no-referrer";
        fallback = document.createElement("b");
        fallback.className = "avatar-initial";
        row.append(
          rankNumber,
          avatar,
          fallback,
          document.createElement("span"),
        );
      }
      if (!rankNumber) {
        rankNumber = document.createElement("em");
        rankNumber.className = "rank-number";
        row.prepend(rankNumber);
      }
      if (!fallback) {
        fallback = document.createElement("b");
        fallback.className = "avatar-initial";
        row.insertBefore(fallback, row.querySelector("span"));
      }
      rankNumber.textContent = String(index + 1);
      rankNumber.dataset.rank = String(index + 1);
      row.classList.toggle("no-avatar", !data.avatarUrl);
      if (data.avatarUrl) avatar.src = data.avatarUrl;
      else avatar.removeAttribute("src");
      avatar.alt = data.avatarUrl ? `积分第${index + 1}名 ${userName}` : "";
      avatar.title = userName;
      fallback.textContent = (
        userName.match(/[\p{Script=Han}A-Za-z0-9]/u)?.[0] ||
        [...userName][0] ||
        "友"
      ).toUpperCase();
      row.querySelector("span").textContent = String(Math.round(data.points));
      return row;
    });
    const removed = [...oldRows].filter(
      ([userName]) => !top.some(([nextName]) => nextName === userName),
    );
    list.replaceChildren(...nextRows);
    const listRect = list.getBoundingClientRect();
    nextRows.forEach((row) => {
      const oldRect = oldRects.get(row.dataset.user);
      if (!oldRect) {
        row.classList.add("rank-enter");
        setTimeout(() => row.classList.remove("rank-enter"), 520);
        return;
      }
      const newRect = row.getBoundingClientRect(),
        deltaY = oldRect.top - newRect.top;
      if (Math.abs(deltaY) < 1) return;
      row.style.transition = "none";
      row.style.transform = `translateY(${deltaY}px)`;
      row.style.zIndex = "2";
      void row.offsetWidth;
      row.style.transition = "transform .56s cubic-bezier(.22,.8,.2,1)";
      row.style.transform = "translateY(0)";
      setTimeout(() => {
        row.style.transition = "";
        row.style.transform = "";
        row.style.zIndex = "";
      }, 620);
    });
    removed.forEach(([, row]) => {
      const oldRect = oldRects.get(row.dataset.user);
      row.classList.add("rank-leave");
      row.style.top = `${oldRect.top - listRect.top}px`;
      list.append(row);
      requestAnimationFrame(() => row.classList.add("rank-leave-active"));
      setTimeout(() => row.remove(), 480);
    });
  }
  setInterval(renderScoreLeaderboard, 1000);
  function enqueue(item) {
    if (!messageSettings.avatars) item.avatarUrl = "";
    updateRecentInteractions(item);
    updateScoreLeaderboard(item);
    if (item.avatarUrl) {
      item.avatarImage = new Image();
      item.avatarImage.referrerPolicy = "no-referrer";
      item.avatarImage.onload = () => draw();
      item.avatarImage.onerror = () => {
        item.avatarUrl = "";
        draw();
      };
      item.avatarImage.src = item.avatarUrl;
    }
    if (item.speech) {
      pendingSpeechCount++;
      updateSpeechCount();
      item.audioPromise = synthesize(item.speech).catch(() => null);
      // 语音队列独立于打印队列：消息一进来就排入播报，不等待走纸动画。
      speechQueue.push({
        type: item.type,
        text: item.speech,
        audioPromise: item.audioPromise,
        pendingCount: 1,
      });
      item.speechQueued = true;
      if (unlocked) runSpeech();
    }
    printQueue.push(item);
    updatePrintQueueCount();
    if (item.type !== "idle" && !item.physicalPrinted && item.text)
      fetch("/api/physical-printer/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: item.text }),
      }).catch(() => {});
    runPrinter();
  }
  function enqueueCopies(item, copies = 1) {
    for (let index = 0; index < copies; index++)
      enqueue({
        ...item,
        rankPoints: index === 0 ? item.rankPoints : 0,
        speech: index === 0 ? item.speech : "",
      });
  }
  function markRealActivity() {
    lastRealEventAt = Date.now();
    let cancelled = 0;
    for (let i = printQueue.length - 1; i >= 0; i--)
      if (printQueue[i].type === "idle") {
        if (printQueue[i].speech) cancelled++;
        printQueue.splice(i, 1);
        updatePrintQueueCount();
      }
    if (cancelled) {
      pendingSpeechCount = Math.max(0, pendingSpeechCount - cancelled);
      updateSpeechCount();
    }
  }
  function memberSpeechJob(names) {
    const unique = [...new Set(names)],
      shown = unique.slice(0, 5),
      more = Math.max(0, names.length - shown.length),
      text = more
        ? `欢迎${shown.join("、")}，还有${more}位朋友来了`
        : `欢迎${shown.join("、")}来了`;
    return {
      type: "member",
      kind: "member",
      names: [...names],
      text,
      pendingCount: names.length,
      audioPromise: synthesize(text).catch(() => null),
    };
  }
  function flushCompressedMembers() {
    memberSpeechTimer = 0;
    const names = memberSpeechNames.splice(0);
    let insertAt = speechQueue.length;
    for (let i = speechQueue.length - 1; i >= 0; i--) {
      const job = speechQueue[i];
      if (job.kind !== "member") continue;
      insertAt = i;
      names.unshift(...(job.names || []));
      speechQueue.splice(i, 1);
    }
    if (!names.length) return;
    speechQueue.splice(
      Math.min(insertAt, speechQueue.length),
      0,
      memberSpeechJob(names),
    );
    runSpeech();
  }
  function queueMemberSpeech(name) {
    const spokenName = speechSafe(name);
    if (!spokenName) return;
    pendingSpeechCount++;
    updateSpeechCount();
    if (pendingSpeechCount <= 10) {
      speechQueue.push(memberSpeechJob([spokenName]));
      runSpeech();
      return;
    }
    memberSpeechNames.push(spokenName);
    clearTimeout(memberSpeechTimer);
    memberSpeechTimer = setTimeout(flushCompressedMembers, 90);
  }
  function receiveComment(e) {
    if (
      e.replay ||
      messageSettings.types[e.eventType] === false ||
      !remember(eventId("c", e))
    )
      return;
    markRealActivity();
    const name = clean(e.userName, 18),
      isMember = e.eventType === "member",
      isFollow = e.eventType === "follow",
      isFansclub = e.eventType === "fansclub",
      isLike = e.eventType === "like",
      fansclubJoined = isFansclub && Number(e.fansclubType) === 2,
      likeCount = Math.max(1, Number(e.count) || 1),
      rankPoints = isFollow
        ? 10
        : fansclubJoined
          ? 20
          : isLike
            ? likeCount
            : isFansclub
              ? 0
              : 1,
      content = String(e.content || "")
        .replace(/\s+/g, " ")
        .trim(),
      text = isMember
        ? `欢迎［${name}］来了`
        : isFollow
          ? `感谢［${name}］关注主播`
          : isFansclub
            ? `感谢［${name}］${clean(content || "加入了粉丝团", 48)}`
            : isLike
              ? `［${name}］点赞了 ${likeCount} 次`
              : `［${name}］${clean(content, 48)}`,
      spokenName = speechSafe(name) || "这位朋友",
      spokenContent = speechSafe(clean(content, 80)),
      speech = isFollow
        ? `感谢${spokenName}关注主播`
        : isFansclub
          ? `感谢${spokenName}${speechSafe(content) || "加入粉丝团"}`
          : isLike
            ? `感谢${spokenName}点赞${likeCount}次`
            : !isMember && spokenContent
              ? `${spokenName}说，${spokenContent}`
              : "";
    enqueueCopies({
      type: isMember
        ? "member"
        : isFollow
          ? "follow"
          : isFansclub
            ? "fansclub"
            : isLike
              ? "like"
              : "comment",
      rankUserName: name,
      rankPoints,
      recentAt: e.receivedAt,
      time: clock(e.receivedAt),
      physicalPrinted: e.physicalPrinted,
      avatarUrl: e.avatarUrl || "",
      text,
      speech,
    });
    if (isMember) queueMemberSpeech(name);
  }
  function receiveGift(e) {
    if (
      e.replay ||
      messageSettings.types.gift === false ||
      !remember(eventId("g", e))
    )
      return;
    markRealActivity();
    const name = clean(e.userName, 18),
      gift = clean(e.giftName, 18),
      spokenName = speechSafe(name),
      spokenGift = speechSafe(gift),
      count = Math.max(1, Number(e.count) || 1),
      rankPoints = Math.max(0, Number(e.value) || 0) * count * 10,
      speech = `感谢${spokenName || "这位朋友"}送的${count}个${spokenGift || "礼物"}`,
      printImage = gift.includes("大啤酒")
        ? "beer"
        : gift.includes("灯牌")
          ? "lightSign"
          : gift.includes("小心心")
            ? "heart"
            : "other";
    enqueueCopies({
      type: "gift",
      rankUserName: name,
      rankPoints,
      recentAt: e.receivedAt,
      time: clock(e.receivedAt),
      physicalPrinted: e.physicalPrinted,
      avatarUrl: e.avatarUrl || "",
      text: `感谢［${name}］送的 ${count} 个 ${gift}`,
      speech,
      printImage,
    });
  }
  const simulationButtons = [...document.querySelectorAll("[data-simulate]")];
  let simulationSequence = 0;
  const simulationNamePrefixes = [
    "小",
    "好运",
    "星河",
    "晚风",
    "橘子",
    "山茶",
    "清欢",
    "月亮",
    "元气",
    "锦鲤",
  ];
  const simulationNameSuffixes = [
    "同学",
    "来了",
    "汽水",
    "小鹿",
    "不熬夜",
    "有好运",
    "看直播",
    "在路上",
    "甜甜",
    "超开心",
  ];
  const generatedSimulationNames = simulationNamePrefixes.flatMap((prefix) =>
    simulationNameSuffixes.map((suffix) => `${prefix}${suffix}`),
  );
  const simulationNames = [
    "潮汐数据局",
    "久月",
    "俗事与清欢",
    "蜗家16",
    "懒人种菜日记",
    "红配绿",
    "玥玥",
    "宏宁一个人",
    "小莳莳而",
    "阳光永恒",
    "飞呀皮卡丘",
    "who",
    "嘶嘶",
    "软毛星球",
    "小圆",
    "昭野",
    "啊哈",
    "致岚",
    "林哒美发日常",
    "Moon",
    "ZD",
    "人间浅遇Mia",
    "小梦",
    "暖乎乎",
    "阿兰说生活",
    "咿呀呀",
    "田玉",
    "Dream",
    "娃哈哈",
    "玲儿",
    "临叙",
    "单眼皮的一崽",
    "龙宝妈",
    "是悠悠呀",
    "一年五季",
    "小太阳",
    "麦穗",
    "小不点点点儿",
    "清晨雨旭",
    "美食",
    "与紫微相伴",
    "Lianyi",
    "可可",
    "咯咯哒",
    "红艳",
    "微笑",
    "简简东方红",
    "南瓜号",
    "半寸时光",
    "旺奶牛仔糖",
    "安心姐姐",
    "事事如意",
    "四月麦田1",
    "诚炫",
    "花间钩织手作",
    "琪宝儿",
    "夏天",
    "紫芋",
    "七七",
    "一杯清茶",
    "咕咕呱呱",
    "啦啦啦啦",
    "丹妹",
    "养生吴小狗",
    "Catherine",
    "鲤鱼爱做饭",
    "三个小乔",
    "小九没烦恼",
    "花开忘忧",
    "晓音",
    "小兔兔",
    "60后退休女人",
    "柚可",
    "意境",
    "月光散2",
    "如梦之华",
    "文锦",
    "静心养花",
    "菜菜",
    "清清",
    "小满吖",
    "爱玛电动车",
    "干饭超人有点困",
    "金融玲玲",
    "安夏",
    "Zia",
    "cm石头记",
    "星星星",
    "拾星海岸",
    "关必回",
    "晚风携财来",
    "是桃子妹妹",
    "Fy521",
    "梅宇婷",
    "奶茶",
    "又又又又",
    "LIULIU",
    "大倩啊",
    "岔岔",
    "小草",
  ];
  const simulationChatOpeners = [
    "这个玩法",
    "画面看起来",
    "刚进来就觉得",
    "主播这个点子",
    "弹珠碰撞的效果",
    "今天的直播",
    "这里的节奏",
    "这个排行榜",
    "头像升级以后",
    "第一次看到这种",
  ];
  const simulationChatEndings = [
    "挺有意思",
    "很有感觉",
    "看着很解压",
    "太有趣了",
    "越来越好看",
    "有点上头",
    "很适合放松",
    "希望我也能上榜",
    "继续保持呀",
    "我先点个赞",
  ];
  const simulationChats = simulationChatOpeners.flatMap((opener) =>
    simulationChatEndings.map((ending) => `${opener}${ending}`),
  );
  const simulationAvatars = [
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_o0AuBA7B7pvPXWHi5wlKCBMSBAIaxizKDA4AE.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_okSzEA6JMCA9FhIkDxftACgJIyrAshEb9AzOAf.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_2dcfdc16f7cf4f54840332e520a6fc0d.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_dc33080afc7a1cba87cd61278b8a6f32.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_o8AHCEDIDLspCCKugEfkAPAAFFSfAqAAJt89lc.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_osFUQAsUfA9lJ4MAE5tqD7pFQwefQENAB1GgID.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_ooFC7ADXfBVf2A8L9fsTOgIEAknFEBUhJIgAYX.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/douyin-user-file_641278311bb5d51322635cd3e022d304.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_c775c663ed385271008d4596e9443d0c.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/mosaic-legacy_30f810002c6495284cab6.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_oAA3BA0BlqvPvnBicibVBMMNBAIaBiy1VA6AE.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_b611017e35bf4ddcb1661c7cd4debbc3.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_c5c65e42af37484bbbe37a49f13d65a7.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/mosaic-legacy_2e51a00027e1b8437183e.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_o0ADfqAaEqSACLHCScynbAf9msA8AAKgAEKlIM.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_o0CI9AnsLBlbhApTc8pZNe3DAuHeIAlKAQgAOc.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_ok3AgfkGQg19BaAIABxiAeCNTAhiE6UEqy93AC.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_a646a56c2a8b4ef7a48d2758dcba4505.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oUFMEocBIPAIniUQAIhBiAVAaAPM3jGAnijyx.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_91971a4d921e4bfaa99a59cf476ab229.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oMemfAGlICIIAFAaeDAAQRALFIepQScWtat2IQ.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_ocSEI4CmAgAQ0G9mAEZCfAHA4WfD3FpQGCPy4A.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_oEkyIfGJQLAggfEcsAIEAUBAB7que7RlUUBDA9.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_1711845715177347eee49a3f10382bbd.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oMqireJEAN9HAItEqCFoAABDg3DYAATmfgYA09.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_085b6ea41c7947b7abae9b5648c5bd31.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_67e4cf81405c6a6a17306f316fcca6e2.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/mosaic-legacy_18c2a00066097bfbb8659.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oMLveAOQRAEJBpLAI64JB7mEGUEeQrfAB6UAIG.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_oQA6BAwyMnPPiHOio4Y024MMBAIahi8xkAjAE.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_ca62b40c466009a5ebf05c6be608262e.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_oEHAPFAA3ixyACDAa12ZeUgAaiEQfAsBIo7TM6.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_owNC2tIAC9wz0IMXAAAeNrNZAyAf3rhygEJI7Z.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_6ce97c32fa99471980f1f9ee3d92203f.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_cb20236508b298440ccf0e4f560d3e46.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_osEuZA9AEEAfsIA6AoAwX27geEF7ePODjLqLr7.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/mosaic-legacy_18b580004a7abc065c62a.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_b4e69c954c450e3c11014f52e7629cdd.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_6c0fd5827e193276d33d77b1bf7f0b36.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_b74e9f51d451bb3c9be86a5de2abceae.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_okPVgJnAAQmAeBqUGNbC9rH3gStfa7A4ADAgyI.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_ocUp9oAl6DaEAqgzAAIAUwlfJekgbFEDAYNCWa.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/d10819ebc6a960727f7de66e59dfca2d.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_7d3cdec0cb804e3facacd1b115e7e6fa.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_9aca7a18db8749ecb46b5d8a6e0c55fc.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_oMEIBARYILAxGKAgQ7fGQRkCgfDA49TqRJkeFh.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oUDZAEeAZI1wvFtAYD9fDdnmTTA7C9gsBpEdAA.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_osAVwWEweyAFxEHdAY9KoMfuATDCEEAIMANnfw.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_e45476c46919424992bd4a5dc93fea6c.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_a70ff846f9e741ae9abd442ff8ce64a6.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_o0AoAfcfDEAqFAoAu0E9PBECNCoIVxuw2491QA.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_oQHIAAfmEFAY96AwQ9KDnXTrGzwAEnpQSErfCi.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_oAaVPAAxLEMh1BqEySir0iAAIPdyAvcBVE79A.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_o862qqABfACfAdDSASgtSuQgGF9TtNHA0NEIAE.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_df3ad009623cdf486560184db5cab86a.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oQ5CA5FfCHfqFAA9ICQE9IwDgEUACtAMZKQrQA.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_ef9b2b83c59cb584a956b1cc82352f37.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_4b04304d88794c369bbbc3999249eada.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_3304867f33ea86f676eaa95293d3f99e.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oYQQDANDnCa3biAFEAAT3AIBAAqCfAegV9QEAn.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/mosaic-legacy_31ae0000628966d7e4dae.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oovVEViEANN4QFYkAABAI103ej0guCCAAliAfF.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_2c1f49e75b9a4c759d8ca516694a6675.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_oAGoXLwePAEwyMDZABezDFEnjiEeiAALaiAIm3.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_c492b7fdc0804327bc99cb323a64e2de.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_oYnBlebfAOGbJeAB5EdEAkE0DJQBvIpA7dEAS0.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_b9232295c707a323f68a94e408295a7a.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_o4b0O7ozAAAyAeoswEijIleB5fdIGHUiEAEBCI.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_ooAbeeM3Ax47YncfIC4BWjArDHDB9JHEAAE7E6.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oMEHqAfxEfIA2M7DBoAfEvFEIiATAP9SDCBTEt.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_oMC4eAzM0CJNiAoThUNJDhkhAyBfEAyXAIgAUJ.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oYAS9dmfe0iwCNAoCoBPWKi7ATlRgA0EVtZAIA.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oAeFWAdYeA5NCHjADBLeA24IMM9bIT7ADfiAEn.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_oQXAIvnkSgreB4AIAD3iAeCC4AciE2wwzNCCAD.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_25629ecfd2f947e0be3d327b5136a23e.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/douyin-user-file_50398c1e92cefceb9fc6369fac36f940.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_o4RGBf8MAi1CIJa3MA1giCN3Ene7AAX1AAkAXm.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_oIAfbiMgAjtetB0dI7ZAdIAXDqiAc0nCgACjER.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_2032b265d591582049efeb49c400b2e2.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_os66E02FgB79AI5PqAQAAUFeAJAqCVfoCIAqDA.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oYr2gkC9AAKn3MnMAAg8zxafQbeqkRDCVAznZA.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oc0gEkBkgbf9AEZvmAICgQFpAnARCVfVC8AzDA.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_febb31b811155fdda782dab99872bd9f.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_0141d28ae5ad4cb9b1bc8e0d42e73e66.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_0431e57b0b86069b042c1831cb9e3941.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_oEEHADSIsAFPAedfAg2ZhNpT6C9PTA1VEQsCAr.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_oo5Q6gGdILArQSKhyAIgAfDATkfhe2fDl2WDA1.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_8c98d4dc2b714250b0cc69860a7133f5.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_50e918fbdbe605dd410548dfa015b085.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_oEYVECO1EzAoa1AhADfEA9kADAdgDCyfIyNd4h.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_430eea15e3064eedb1a907cc679a2d91.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c000-ce_oArQIxn9AAKMeBDsEAwF5dk2EfzYpCEC4A5g0A.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_oQoKnAIeGADkgGAQEAAACB98ICFZ9P4EnAcRfA.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-avt-0015_d17db6472e16d4559d002e978fd35fcd.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_5bd07b9200144048bdb8a57c6b7e01c6.jpeg?from=3067671334",
    "https://p26.douyinpic.com/aweme/200x200/aweme-avatar/mosaic-legacy_2e9c10008bd4823ea778a.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_17892dbdc57b48b7899dc276f6d131fe.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_b12b7530d2324d2e9e122806eede1ccc.jpeg?from=3067671334",
    "https://p3.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813_ocAApQAo9DJAAeHIl9DnEefB7BtnHAFaRIbHrz.jpeg?from=3067671334",
    "https://p11.douyinpic.com/aweme/200x200/aweme-avatar/tos-cn-i-0813c001_8aca2fb6c7a545049880a4d8d965b081.jpeg?from=3067671334",
  ];
  function simulateMessage(type) {
    const avatarIndex = simulationSequence % simulationAvatars.length,
      sequence = simulationSequence++,
      name = simulationNames[sequence % simulationNames.length],
      chatContent = simulationChats[sequence % simulationChats.length],
      avatarUrl = simulationAvatars[avatarIndex],
      now = new Date().toISOString(),
      id = `simulation-${Date.now()}-${simulationSequence}`;
    if (type === "gift") {
      receiveGift({
        id,
        userName: name,
        giftName: simulationSequence % 2 ? "小心心" : "大啤酒",
        count: simulationSequence % 2 ? 1 : 2,
        value: simulationSequence % 2 ? 1 : 10,
        receivedAt: now,
        avatarUrl,
        physicalPrinted: true,
      });
      return;
    }
    const content =
      type === "comment"
        ? chatContent
        : type === "like"
          ? ""
          : type === "follow"
            ? ""
            : type === "fansclub"
              ? "加入了粉丝团"
              : "";
    receiveComment({
      id,
      eventType: type,
      userName: name,
      content,
      count: type === "like" ? 5 : 1,
      fansclubType: type === "fansclub" ? 2 : 0,
      receivedAt: now,
      avatarUrl,
      physicalPrinted: true,
    });
  }
  simulationButtons.forEach(
    (button) =>
      (button.onclick = () => simulateMessage(button.dataset.simulate)),
  );
  const simulationAutoToggle = byId("simulationAutoToggle"),
    simulationAutoState = byId("simulationAutoState");
  let simulationAutoTimer = 0;
  const simulationTypes = [
    "member",
    "comment",
    "like",
    "follow",
    "fansclub",
    "gift",
  ];
  function scheduleSimulation() {
    clearTimeout(simulationAutoTimer);
    if (!simulationAutoToggle.checked) return;
    // 模拟互动用于测试时保持轻快节奏：0.8～2.8 秒随机触发一次。
    const delay = 800 + Math.floor(Math.random() * 2000);
    simulationAutoState.textContent = `运行中 · 下一条约 ${Math.ceil(delay / 1000)} 秒`;
    simulationAutoTimer = setTimeout(() => {
      const available = simulationTypes.filter(
        (type) => type === "gift" || messageSettings.types[type] !== false,
      );
      simulateMessage(available[Math.floor(Math.random() * available.length)]);
      scheduleSimulation();
    }, delay);
  }
  simulationAutoToggle.onchange = () => {
    if (simulationAutoToggle.checked) {
      simulationAutoState.textContent = "启动中";
      scheduleSimulation();
    } else {
      clearTimeout(simulationAutoTimer);
      simulationAutoState.textContent = "已关闭";
    }
  };
  function carpet() {
    const g = ctx.createLinearGradient(0, 0, viewW, viewH);
    g.addColorStop(0, "#7d9187");
    g.addColorStop(0.42, "#a9b9aa");
    g.addColorStop(1, "#667d78");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
    const softLight = ctx.createRadialGradient(
      viewW * 0.46,
      viewH * 0.34,
      viewW * 0.04,
      viewW * 0.46,
      viewH * 0.34,
      viewH * 0.72,
    );
    softLight.addColorStop(0, "rgba(255,244,201,.22)");
    softLight.addColorStop(0.58, "rgba(224,239,218,.06)");
    softLight.addColorStop(1, "rgba(40,67,65,.18)");
    ctx.fillStyle = softLight;
    ctx.fillRect(0, 0, viewW, viewH);
    const sideShade = ctx.createLinearGradient(0, 0, viewW, 0);
    sideShade.addColorStop(0, "rgba(35,61,58,.16)");
    sideShade.addColorStop(0.18, "rgba(0,0,0,0)");
    sideShade.addColorStop(0.82, "rgba(0,0,0,0)");
    sideShade.addColorStop(1, "rgba(35,61,58,.18)");
    ctx.fillStyle = sideShade;
    ctx.fillRect(0, 0, viewW, viewH);
  }
  function paperGeometry(y) {
    const topY = -viewH * 0.025,
      bottomY = viewH * 1.025,
      t = (y - topY) / (bottomY - topY),
      topWidth = viewW * 0.43,
      bottomWidth = viewW * 0.94,
      width = topWidth + (bottomWidth - topWidth) * Math.max(0, Math.min(1, t));
    return { t, width, left: (viewW - width) / 2, right: (viewW + width) / 2 };
  }
  function paper() {
    const top = paperGeometry(0),
      bottom = paperGeometry(viewH),
      path = (offsetY = 0) => {
        ctx.beginPath();
        ctx.moveTo(top.left, offsetY);
        ctx.lineTo(top.right, offsetY);
        ctx.lineTo(bottom.right, viewH + offsetY);
        ctx.lineTo(bottom.left, viewH + offsetY);
        ctx.closePath();
      };
    ctx.save();
    path(2);
    ctx.shadowColor = "rgba(35,3,4,.38)";
    ctx.shadowBlur = viewW * 0.027;
    ctx.shadowOffsetY = viewH * 0.006;
    ctx.fillStyle = "rgba(61,8,8,.28)";
    ctx.fill();
    ctx.restore();
    ctx.save();
    path(1.2);
    ctx.fillStyle = "#c8c2ad";
    ctx.fill();
    ctx.restore();
    ctx.save();
    path();
    const pg = ctx.createLinearGradient(bottom.left, 0, bottom.right, 0);
    pg.addColorStop(0, "#ded9c6");
    pg.addColorStop(0.035, "#f2eedc");
    pg.addColorStop(0.16, "#fbf8e8");
    pg.addColorStop(0.5, "#fffdf0");
    pg.addColorStop(0.84, "#faf7e6");
    pg.addColorStop(0.965, "#eee9d7");
    pg.addColorStop(1, "#d7d0bb");
    ctx.fillStyle = pg;
    ctx.fill();
    ctx.clip();
    const paperLight = ctx.createRadialGradient(
      viewW * 0.52,
      viewH * 0.48,
      0,
      viewW * 0.52,
      viewH * 0.48,
      viewW * 0.72,
    );
    paperLight.addColorStop(0, "rgba(255,255,252,.12)");
    paperLight.addColorStop(0.78, "rgba(255,255,255,0)");
    paperLight.addColorStop(1, "rgba(96,80,59,.035)");
    ctx.fillStyle = paperLight;
    ctx.fillRect(0, 0, viewW, viewH);
    drawMessages();
    ctx.restore();
    ctx.save();
    path();
    ctx.strokeStyle = "rgba(255,255,246,.38)";
    ctx.lineWidth = 0.65;
    ctx.stroke();
    ctx.restore();
  }
  function lampBase() {
    const x = viewW * 0.94,
      y = viewH * 0.074,
      w = viewW * 0.34,
      h = viewH * 0.072;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.075);
    ctx.save();
    ctx.shadowColor = "rgba(37,5,5,.42)";
    ctx.shadowBlur = viewW * 0.032;
    ctx.shadowOffsetY = viewH * 0.009;
    ctx.beginPath();
    ctx.ellipse(0, h * 0.12, w * 0.54, h * 0.52, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(42,7,7,.3)";
    ctx.fill();
    ctx.restore();
    const stem = ctx.createLinearGradient(-w * 0.045, 0, w * 0.045, 0);
    stem.addColorStop(0, "#9e9789");
    stem.addColorStop(0.28, "#d8d1bf");
    stem.addColorStop(0.64, "#f0eadb");
    stem.addColorStop(1, "#938c80");
    ctx.fillStyle = stem;
    ctx.beginPath();
    ctx.roundRect(-w * 0.038, -h * 1.4, w * 0.076, h * 1.45, w * 0.035);
    ctx.fill();
    const base = ctx.createRadialGradient(
      -w * 0.14,
      -h * 0.2,
      w * 0.02,
      0,
      0,
      w * 0.58,
    );
    base.addColorStop(0, "#f1eadb");
    base.addColorStop(0.42, "#d8d0c0");
    base.addColorStop(0.82, "#b8b0a3");
    base.addColorStop(1, "#928b81");
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.53, h * 0.48, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(91,82,72,.5)";
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(
      -w * 0.11,
      -h * 0.13,
      w * 0.27,
      h * 0.17,
      0,
      Math.PI * 1.05,
      Math.PI * 1.82,
    );
    ctx.strokeStyle = "rgba(255,255,247,.46)";
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }
  function wrapText(text, maxWidth, font) {
    const chars = [...text],
      result = [];
    let line = "";
    ctx.save();
    ctx.font = font;
    for (const char of chars) {
      const next = line + char;
      if (line && ctx.measureText(next).width > maxWidth) {
        result.push(line);
        line = char;
      } else line = next;
    }
    if (line) result.push(line);
    ctx.restore();
    return result.length ? result : [""];
  }
  function snap(value) {
    return Math.round(value * dpr) / dpr;
  }
  function drawPerspectiveImage(
    img,
    topY,
    height,
    widthRatio = 0.62,
    reveal = 1,
  ) {
    if (!img.complete || !img.naturalWidth || height <= 0 || reveal <= 0)
      return;
    const rows = Math.max(24, Math.ceil(height / 2)),
      visibleRows = Math.max(1, Math.ceil(rows * Math.min(1, reveal)));
    ctx.save();
    for (let row = 0; row < visibleRows; row++) {
      const sy = (img.naturalHeight * row) / rows,
        dy = topY + (height * row) / rows,
        nextY = topY + (height * (row + 1)) / rows,
        geo = paperGeometry((dy + nextY) / 2),
        width = geo.width * widthRatio,
        left = (viewW - width) / 2;
      ctx.drawImage(
        img,
        0,
        sy,
        img.naturalWidth,
        img.naturalHeight / rows,
        left,
        dy,
        width,
        Math.max(1.5, nextY - dy + 0.5),
      );
    }
    ctx.restore();
  }
  function drawScoreStamp(points, avatarTop, avatarHeight, reveal = 1) {
    points = Math.max(0, Math.round(points || 0));
    if (
      !points ||
      reveal < 0.72 ||
      !scoreStampFrame.complete ||
      !scoreStampFrame.naturalWidth
    )
      return;
    const geo = paperGeometry(avatarTop + avatarHeight * 0.72),
      imageWidth = geo.width * 0.62,
      w = Math.max(70, Math.min(126, imageWidth * 0.48)),
      h = w * (scoreStampFrame.naturalHeight / scoreStampFrame.naturalWidth),
      x = viewW / 2 + imageWidth / 2 - w * 0.38,
      y = avatarTop + avatarHeight * 0.76;
    ctx.save();
    ctx.globalAlpha = Math.min(1, (reveal - 0.72) / 0.28) * 0.96;
    ctx.drawImage(scoreStampFrame, x - w / 2, y - h / 2, w, h);
    ctx.translate(x, y);
    ctx.rotate(-0.075);
    ctx.fillStyle = "#d92124";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `900 ${Math.max(13, h * 0.31)}px Impact,"Microsoft YaHei",sans-serif`;
    ctx.fillText(`${points}积分`, 0, 0);
    ctx.restore();
  }
  function drawMessages() {
    const bottomY = viewH * 0.925,
      gapNear = viewH * 0.047,
      minGap = viewH * 0.022,
      count = messages.length,
      scores = currentScores(),
      gapFor = (age) =>
        Math.max(minGap, gapNear * Math.pow(0.94, Math.max(0, age))),
      layouts = new Array(count);
    let cursor = bottomY;
    ctx.textBaseline = "middle";
    for (let age = 0; age < count; age++) {
      const index = count - 1 - age,
        item = messages[index],
        printImage = giftPrintImages[item.printImage],
        geo = paperGeometry(cursor),
        perspective = 0.52 + 0.48 * geo.t,
        fontSize = Math.round(viewH * 0.03 * perspective),
        margin = geo.width * (0.085 + 0.025 * (1 - geo.t)),
        weight = item.type === "gift" ? 700 : 600,
        font = `${weight} ${fontSize}px SimSun, "Microsoft YaHei", "Segoe UI Emoji", sans-serif`,
        wrapped = wrapText(item.text, geo.width - margin * 2, font),
        lineHeight = fontSize * 1.18,
        textHeight = Math.max(lineHeight, wrapped.length * lineHeight),
        imageHeight =
          printImage?.complete && printImage.naturalWidth
            ? ((geo.width * 0.62) /
                (printImage.naturalWidth / printImage.naturalHeight)) *
              0.58
            : 0,
        imageGap = imageHeight ? fontSize * 0.45 : 0,
        avatarHeight =
          item.type !== "gift" && item.avatarUrl ? geo.width * 0.62 * 0.58 : 0,
        avatarGap = avatarHeight ? fontSize * 0.45 : 0,
        blockHeight =
          textHeight + imageGap + imageHeight + avatarGap + avatarHeight,
        centerY = cursor - (blockHeight - lineHeight) / 2,
        rowGap = Math.max(gapFor(age), blockHeight + minGap * 0.35);
      layouts[index] = {
        centerY,
        fontSize,
        margin,
        weight,
        wrapped,
        lineHeight,
        textHeight,
        imageHeight,
        imageGap,
        avatarHeight,
        avatarGap,
        blockHeight,
        rowGap,
        finalGeo: geo,
        printImage,
        avatarImage: item.avatarImage,
        rankUserName: item.rankUserName,
      };
      cursor -= rowGap;
    }
    const shift = (1 - feed) * (layouts[count - 1]?.rowGap || gapNear);
    for (let i = 0; i < count; i++) {
      const layout = layouts[i],
        y = snap(layout.centerY + shift);
      if (y < -layout.blockHeight || y > viewH + layout.blockHeight) continue;
      const blockTop = y - layout.blockHeight / 2,
        imageTop = blockTop,
        avatarTop = blockTop + layout.imageHeight + layout.imageGap,
        textCenter =
          avatarTop +
          layout.avatarHeight +
          layout.avatarGap +
          layout.textHeight / 2,
        textGeo = paperGeometry(textCenter),
        x = snap(
          textGeo.left +
            textGeo.width * (layout.margin / layout.finalGeo.width),
        );
      const reveal = messages[i].revealProgress ?? 1;
      if (layout.imageHeight)
        drawPerspectiveImage(
          layout.printImage,
          imageTop,
          layout.imageHeight,
          0.62,
          reveal,
        );
      if (
        layout.avatarHeight &&
        layout.avatarImage?.complete &&
        layout.avatarImage.naturalWidth
      ) {
        drawPerspectiveImage(
          layout.avatarImage,
          avatarTop,
          layout.avatarHeight,
          0.62,
          reveal,
        );
        drawScoreStamp(
          scores.get(String(layout.rankUserName || ""))?.points,
          avatarTop,
          layout.avatarHeight,
          reveal,
        );
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        snap(textGeo.left + textGeo.width * 0.045),
        snap(textCenter - layout.textHeight * 0.62),
        snap(textGeo.width * 0.91),
        snap(layout.textHeight * 1.24 * reveal),
      );
      ctx.clip();
      ctx.translate(x, textCenter);
      ctx.transform(1, 0, -0.025 * (1 - layout.finalGeo.t), 1, 0, 0);
      ctx.font = `${layout.weight} ${layout.fontSize}px SimSun, "Microsoft YaHei", "Segoe UI Emoji", sans-serif`;
      ctx.fillStyle = messages[i].type === "gift" ? "#344886" : "#5265a0";
      ctx.shadowColor = "rgba(48,63,126,.2)";
      ctx.shadowBlur = 0.25;
      layout.wrapped.forEach((line, lineIndex) =>
        ctx.fillText(
          line,
          0,
          (lineIndex - (layout.wrapped.length - 1) / 2) * layout.lineHeight,
        ),
      );
      ctx.restore();
    }
  }
  function draw() {
    if (!viewW || !viewH) return;
    ctx.clearRect(0, 0, viewW, viewH);
    carpet();
    paper();
    lampBase();
  }
  function animateFeed(duration, item) {
    cancelAnimationFrame(animationId);
    feed = 0;
    item.revealProgress = 0;
    if (document.hidden) {
      feed = 1;
      item.revealProgress = 1;
      return Promise.resolve();
    }
    const start = performance.now();
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
          if (finished) return;
          finished = true;
          cancelAnimationFrame(animationId);
          feed = 1;
          item.revealProgress = 1;
          finishFeedAnimation = null;
          resolve();
        },
        frame = (now) => {
          const t = Math.min(1, (now - start) / duration);
          feed = 1 - Math.pow(1 - t, 3);
          item.revealProgress = t;
          draw();
          if (t < 1) animationId = requestAnimationFrame(frame);
          else finish();
        };
      finishFeedAnimation = finish;
      animationId = requestAnimationFrame(frame);
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      finishFeedAnimation?.();
    } else {
      draw();
      if (printQueue.length) runPrinter();
      if (unlocked && speechQueue.length) runSpeech();
    }
  });
  async function loadPrinterSounds() {
    if (
      printerSoundBuffer &&
      printerImageSoundBuffer &&
      glassShatterBuffer &&
      swordSwingBuffer
    )
      return;
    const [textResponse, imageResponse, shatterResponse, swordResponse] =
      await Promise.all([
        fetch("/printer-feed.mp3"),
        fetch("/printer-image.mp3"),
        fetch("/glass-shatter.mp3"),
        fetch("/sword-swing.mp3"),
      ]);
    if (
      !textResponse.ok ||
      !imageResponse.ok ||
      !shatterResponse.ok ||
      !swordResponse.ok
    )
      throw new Error("页面音效加载失败");
    [
      printerSoundBuffer,
      printerImageSoundBuffer,
      glassShatterBuffer,
      swordSwingBuffer,
    ] = await Promise.all([
      audioContext.decodeAudioData(await textResponse.arrayBuffer()),
      audioContext.decodeAudioData(await imageResponse.arrayBuffer()),
      audioContext.decodeAudioData(await shatterResponse.arrayBuffer()),
      audioContext.decodeAudioData(await swordResponse.arrayBuffer()),
    ]);
  }
  function printerNoise(printingImage = false) {
    if (!printerSoundEnabled) return;
    const buffer = printingImage ? printerImageSoundBuffer : printerSoundBuffer;
    if (!audioContext || !buffer) return;
    const src = audioContext.createBufferSource(),
      gain = audioContext.createGain(),
      playTime = buffer.duration,
      now = audioContext.currentTime;
    src.buffer = buffer;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.34, now + 0.018);
    gain.gain.setValueAtTime(0.3, now + Math.max(0.03, playTime - 0.055));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + playTime);
    src.connect(gain).connect(audioContext.destination);
    activePrinterSources.add(src);
    src.onended = () => activePrinterSources.delete(src);
    src.start(now);
    src.stop(now + playTime);
  }
  async function runPrinter() {
    if (printing || !printQueue.length) return;
    printing = true;
    const item = printQueue.shift();
    updatePrintQueueCount();
    const printsImage = Boolean(item.printImage || item.avatarUrl),
      baseDuration = printsImage
        ? 1100
        : Math.max(360, Math.min(1050, [...item.text].length * 42)),
      duration = Math.max(
        260,
        baseDuration - Math.min(540, printQueue.length * 24),
      );
    messages.push(item);
    if (messages.length > 80) messages.shift();
    printerNoise(printsImage);
    await animateFeed(duration, item);
    total++;
    localStorage.setItem("receipt-print-total", String(total));
    byId("printCount").textContent = String(total);
    byId("ariaLog").textContent = item.text;
    printing = false;
    if (unlocked && speechQueue.length) runSpeech();
    if (printQueue.length) runPrinter();
  }
  const ttsGenerationQueue = [],
    TTS_CONCURRENCY = 3;
  let ttsWorkersRunning = 0;
  async function synthesizeDirect(text, timeout = 15000) {
    const controller = new AbortController(),
      timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: "zh-CN-XiaoxiaoNeural",
          rate: "+75%",
          context: "reply",
        }),
        signal: controller.signal,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "语音生成失败");
      return d.url;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  function runTtsGenerationWorker() {
    if (ttsWorkersRunning >= TTS_CONCURRENCY) return;
    const task = ttsGenerationQueue.shift();
    if (!task) return;
    ttsWorkersRunning++;
    synthesizeDirect(task.text)
      .then(task.resolve, task.reject)
      .finally(() => {
        ttsWorkersRunning--;
        runTtsGenerationWorker();
      });
    runTtsGenerationWorker();
  }
  function synthesize(text) {
    return new Promise((resolve, reject) => {
      ttsGenerationQueue.push({ text, resolve, reject });
      runTtsGenerationWorker();
    });
  }
  async function playSpeechUrl(url) {
    const player = new Audio();
    player.preload = "auto";
    player.volume = 1;
    player.src = url;
    player.playbackRate = 1.25;
    await new Promise((resolve, reject) => {
      let finished = false,
        watchdog = 0,
        lastProgressAt = Date.now(),
        lastTime = -1;
      const cleanup = () => {
          clearInterval(watchdog);
          player.removeEventListener("ended", complete);
          player.removeEventListener("error", fail);
          player.removeEventListener("timeupdate", progress);
          player.removeEventListener("playing", progress);
          player.pause();
          player.removeAttribute("src");
          player.load();
        },
        complete = () => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve();
        },
        fail = () => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(new Error("语音播放失败"));
        },
        progress = () => {
          if (player.currentTime !== lastTime) {
            lastTime = player.currentTime;
            lastProgressAt = Date.now();
          }
        };
      player.addEventListener("ended", complete, { once: true });
      player.addEventListener("error", fail, { once: true });
      player.addEventListener("timeupdate", progress);
      player.addEventListener("playing", progress);
      watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt > 8000) fail();
      }, 1000);
      const playPromise = player.play();
      Promise.race([
        playPromise,
        wait(5000).then(() => {
          throw new Error("语音加载超时");
        }),
      ]).catch(fail);
    });
  }
  async function runSpeech() {
    if (speaking || !unlocked || !speechQueue.length) return;
    speaking = true;
    currentSpeechStartedAt = Date.now();
    const job = speechQueue.shift();
    currentSpeechType = job.type || job.kind || "";
    try {
      const url = await (job.audioPromise || synthesize(job.text));
      if (!url) throw new Error("语音生成失败");
      // 单条语音设置总时长上限，避免浏览器在加载/播放 pending 时卡死整个队列。
      const hardLimit = Math.max(
        20000,
        Math.min(90000, (job.text || "").length * 900),
      );
      await Promise.race([
        playSpeechUrl(url),
        wait(hardLimit).then(() => {
          throw new Error("语音播放超时，已跳过当前消息");
        }),
      ]);
    } catch {
    } finally {
      pendingSpeechCount = Math.max(
        0,
        pendingSpeechCount - (job.pendingCount || 1),
      );
      updateSpeechCount();
      currentSpeechType = "";
      currentSpeechStartedAt = 0;
      speaking = false;
      audio.playbackRate = 1;
      if (speechQueue.length) runSpeech();
      else if (printQueue.length) runPrinter();
    }
  }
  // 队列自愈：浏览器偶发丢失音频事件时，定时检查并重新拉起播报。
  setInterval(() => {
    if (!unlocked || !speechQueue.length) return;
    if (!speaking) {
      runSpeech();
      return;
    }
    if (
      currentSpeechStartedAt &&
      Date.now() - currentSpeechStartedAt > 100000
    ) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      speaking = false;
      currentSpeechType = "";
      runSpeech();
    }
  }, 1000);
  async function unlock() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    await loadPrinterSounds();
    audio.src =
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA";
    audio.volume = 0.01;
    await audio.play();
    await wait(60);
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    unlocked = true;
    byId("startDisplay").classList.add("is-hidden");
    printerNoise(false);
    runSpeech();
  }
  byId("startDisplay").onclick = () => unlock().catch(() => {});
  const printerSoundToggle = byId("printerSoundToggle");
  printerSoundToggle.checked = printerSoundEnabled;
  printerSoundToggle.onchange = () => {
    printerSoundEnabled = printerSoundToggle.checked;
    localStorage.setItem(
      "receipt-printer-sound-enabled",
      String(printerSoundEnabled),
    );
    if (!printerSoundEnabled) {
      activePrinterSources.forEach((source) => {
        try {
          source.stop();
        } catch {}
      });
      activePrinterSources.clear();
    }
  };
  const messageTypeToggles = [
      ...document.querySelectorAll("[data-message-type]"),
    ],
    avatarToggle = byId("avatarToggle");
  let messageSettings = {
    types: {
      comment: true,
      member: true,
      gift: true,
      follow: true,
      like: true,
      fansclub: true,
    },
    avatars: true,
  };
  function renderMessageSettings() {
    messageTypeToggles.forEach((input) => {
      input.checked =
        messageSettings.types[input.dataset.messageType] !== false;
    });
    avatarToggle.checked = messageSettings.avatars !== false;
  }
  function purgeMessageType(type) {
    let removed = 0;
    for (let i = printQueue.length - 1; i >= 0; i--)
      if (printQueue[i].type === type) {
        if (printQueue[i].speech) removed++;
        printQueue.splice(i, 1);
        updatePrintQueueCount();
      }
    for (let i = speechQueue.length - 1; i >= 0; i--) {
      const job = speechQueue[i];
      if ((job.type || job.kind) === type) {
        removed += job.pendingCount || 1;
        speechQueue.splice(i, 1);
      }
    }
    if (type === "member" && memberSpeechNames.length) {
      removed += memberSpeechNames.length;
      memberSpeechNames.length = 0;
      clearTimeout(memberSpeechTimer);
      memberSpeechTimer = 0;
    }
    pendingSpeechCount = Math.max(0, pendingSpeechCount - removed);
    updateSpeechCount();
    if (currentSpeechType === type && speaking) {
      const finish = audio.onended;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (finish) finish();
    }
  }
  async function saveMessageSettings() {
    const controls = [...messageTypeToggles, avatarToggle];
    controls.forEach((input) => (input.disabled = true));
    try {
      const r = await fetch("/api/message-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(messageSettings),
        }),
        d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "消息设置保存失败");
      messageSettings = { types: d.types, avatars: d.avatars };
      renderMessageSettings();
    } catch {
      renderMessageSettings();
    } finally {
      controls.forEach((input) => (input.disabled = false));
    }
  }
  fetch("/api/message-settings")
    .then((r) => r.json())
    .then((d) => {
      if (d.ok) {
        messageSettings = { types: d.types, avatars: d.avatars };
        renderMessageSettings();
      }
    })
    .catch(() => renderMessageSettings());
  messageTypeToggles.forEach(
    (input) =>
      (input.onchange = () => {
        const type = input.dataset.messageType;
        messageSettings.types[type] = input.checked;
        if (!input.checked) purgeMessageType(type);
        saveMessageSettings();
      }),
  );
  avatarToggle.onchange = () => {
    messageSettings.avatars = avatarToggle.checked;
    saveMessageSettings();
  };
  const printerToggle = byId("physicalPrinterToggle");
  fetch("/api/physical-printer/status")
    .then((r) => r.json())
    .then((d) => {
      printerToggle.checked = Boolean(d.enabled);
    })
    .catch(() => {
      printerToggle.checked = false;
    });
  printerToggle.onchange = async () => {
    printerToggle.disabled = true;
    try {
      const r = await fetch("/api/physical-printer/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: printerToggle.checked }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "实体打印设置失败");
    } catch {
      printerToggle.checked = !printerToggle.checked;
    } finally {
      printerToggle.disabled = false;
    }
  };
  // 冷场模拟消息已关闭，只展示直播间收到的真实进场、评论和礼物消息。
  const comments = new EventSource("/api/comment-events"),
    gifts = new EventSource("/api/gift-events");
  let cOpen = false,
    gOpen = false;
  const state = () =>
    (byId("connectionState").textContent =
      cOpen && gOpen ? "直播间已连接" : "消息流连接中");
  comments.onopen = () => {
    cOpen = true;
    state();
  };
  comments.addEventListener("comment", (e) => {
    try {
      receiveComment(JSON.parse(e.data));
    } catch {}
  });
  comments.onerror = () => {
    cOpen = false;
    state();
  };
  gifts.onopen = () => {
    gOpen = true;
    state();
  };
  gifts.addEventListener("gift", (e) => {
    try {
      receiveGift(JSON.parse(e.data));
    } catch {}
  });
  gifts.onerror = () => {
    gOpen = false;
    state();
  };
  window.addEventListener("load", resize);
  draw();
})();
