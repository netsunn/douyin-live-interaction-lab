const path = require('path')
const { spawn } = require('child_process')
const enabled = !/^(0|false|off)$/i.test(process.env.PHYSICAL_PRINTER_ENABLED || 'true')
const maxRegularJobs = Math.max(1, Number(process.env.PHYSICAL_PRINTER_QUEUE_LIMIT) || 100)
const queue = []
let printing = false
let active = enabled
const root = __dirname;
const python = path.join(root, '.venv', 'Scripts', 'python.exe')
const printerScript = path.join(root, 'thermal_printer.py')


function status() {
    return { enabled: active, printing, pending: queue.length };
}

function reset(nextEnabled = false) {
    queue.length = 0;
    active = Boolean(nextEnabled);
    if (active) printNext();
    return status();
}

function printNext() {
    if (!enabled || printing || queue.length === 0) return;
    printing = true;
    const job = queue.shift();
    const args = [printerScript, job.text];
    if (job.image) args.push('--image', job.image);
    const child = spawn(python, args, {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });
    child.on('error', error => {
        console.error(`[实体打印] 启动失败：${error.message}`);
    });

    child.on('close', code => {
        if (code === 0) console.log(`[实体打印] 已打印：${job.text}`);
        else console.error(`[实体打印] 失败(${code}): ${stderr.trim() || job.text}`);
        printing = false;
        // 继续打印下一条任务，比自己手动调用printNext好
        setImmediate(printNext);
    })
}

function sanitize(value, fallback) {
    return String(value || fallback).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function countRegularJobs() {
    // 统计非礼勿数量
    return queue.reduce((total, job) => total + (job.kind === 'gift' ? 0 : 1), 0);
}

 function makeText(kind, event) {
    const userName = sanitize(event.userName, '这位朋友');
    if(kind === 'gift') {
        const giftName = sanitize(event.giftName, '礼物');
        const count = Math.max(1, Math.min(9999, Number(event.count) || 1));
        return `感谢[${userName}]送的${count}个${giftName}`;
    }
    if (kind === 'member') return `欢迎[${userName}]来了`;
    return `[${userName}]：${sanitize(event.content, '发来一条消息')}`;
 }

 function giftImage(giftName) {
    const name = sanitize(giftName, '');
    if (name.includes('大啤酒')) return path.join(root, 'big-beer-print.jpg');
    if (name.includes('灯牌')) return path.join(root, 'light-sign-print.jpg');
    if (name.includes('小心心')) return path.join(root, 'heart-print.jpg');
    return path.join(root, 'other-gift-print.png');
}

function enqueue(kind, event) {
    if (!active) return false;
    const normalizedKind = kind === 'gift' ? 'gift' : kind === 'member' ? 'member' : 'comment';
    // 普通消息过多时移除最旧普通任务，但永远不主动丢弃礼物任务。
    if (normalizedKind !== 'gift' && countRegularJobs() >= maxRegularJobs) {
        // 找到最早的非礼物消息
        const oldestRegularIndex = queue.findIndex(job => job.kind !== 'gift');
        // 删除元素
        if (oldestRegularIndex >= 0) queue.splice(oldestRegularIndex, 1);
        else return false;
        console.warn('[实体打印] 普通消息积压，已移除最旧的一条普通打印任务');
    }
    queue.push({
        kind: normalizedKind,
        text: makeText(normalizedKind, event),
        image: normalizedKind === 'gift' ? giftImage(event.giftName) : '',
    });
    printNext();
    return true;
}

if (require.main === module) {
    //queue.push({ kind: 'member', text: '测试打印机2' });

    console.log(printerScript)
    //console.log(reset(true))
    //printNext()
    enqueue('member', { userName: '测试用户', text: '测试打印机2' });
    console.log('physical-printer2.js 仅作为模块使用，不可直接运行。')
}