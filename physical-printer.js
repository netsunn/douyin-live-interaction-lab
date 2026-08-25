/**
 * 实体小票打印队列。
 *
 * 主要职责：
 * 1. 将进场、评论和礼物事件整理成适合小票打印的文字。
 * 2. 根据礼物名称选择对应图片。
 * 3. 使用单一 FIFO 队列串行调用 thermal_printer.py，避免多个任务争抢 USB 打印机。
 * 4. 提供启停、清空积压队列和状态查询能力。
 *
 * 环境变量：
 * - PHYSICAL_PRINTER_ENABLED：服务启动时是否允许实体打印，默认开启。
 * - PHYSICAL_PRINTER_QUEUE_LIMIT：普通消息最多积压数量，默认 100 条。
 */
const path = require('path');
const { spawn } = require('child_process');

const root = __dirname;
const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const printerScript = path.join(root, 'thermal_printer.py');
const printerName = process.env.PHYSICAL_PRINTER_NAME || 'Gprinter iSH58';
// enabled 是服务启动配置；active 是网页开关控制的当前运行状态。
const enabled = !/^(0|false|off)$/i.test(process.env.PHYSICAL_PRINTER_ENABLED || 'false');
let active = enabled;
const maxRegularJobs = Math.max(1, Number(process.env.PHYSICAL_PRINTER_QUEUE_LIMIT) || 100);

const queue = [];
let printing = false;
let lastJob = null;

function sanitize(value, fallback) {
  return String(value || fallback).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function countRegularJobs() {
  // 礼物属于高优先级消息，不计入普通消息积压上限。
  return queue.reduce((total, job) => total + (job.kind === 'gift' ? 0 : 1), 0);
}

function makeText(kind, event) {
  // 所有用户名统一使用方括号，便于在连续纸带上快速识别。
  const userName = sanitize(event.userName, '这位朋友');
  if (kind === 'gift') {
    const giftName = sanitize(event.giftName, '礼物');
    const count = Math.max(1, Math.min(9999, Number(event.count) || 1));
    return `感谢[${userName}]送的${count}个${giftName}`;
  }
  if (kind === 'member') return `欢迎[${userName}]来了`;
  if (kind === 'follow') return `感谢[${userName}]关注主播`;
  return `[${userName}]：${sanitize(event.content, '发来一条消息')}`;
}

function avatarImage(event) {
  // 礼物小票优先使用送礼用户头像；没有头像时使用通用礼物图兜底。
  const avatarUrl = String(event.avatarUrl || '').trim();
  if (/^https?:\/\//i.test(avatarUrl)) return avatarUrl.slice(0, 1000);
  return path.join(root, 'other-gift-print.png');
}

function printNext() {
  // 同一时间只启动一个 Python 进程；当前任务退出后再处理下一条。
  if (!active || printing || queue.length === 0) return;
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
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', error => {
    console.error(`[实体打印] 启动失败：${error.message}`);
  });
  child.on('close', code => {
    lastJob = {kind: job.kind, text: job.text, image: job.image || '', code, warning: stderr.trim(), finishedAt: new Date().toISOString()};
    if (code === 0) {
      console.log(`[实体打印] 已打印：${job.text}${job.image ? `；图片=${job.image}` : ''}`);
      if (stderr.trim()) console.warn(`[实体打印] 图片警告：${stderr.trim()}`);
    }
    else console.error(`[实体打印] 失败(${code})：${stderr.trim() || job.text}`);
    printing = false;
    setImmediate(printNext);
  });
}

function enqueue(kind, event) {
  if (!active) return false;
  const normalizedKind = kind === 'gift' ? 'gift' : kind === 'member' ? 'member' : kind === 'follow' ? 'follow' : 'comment';
  // 普通消息过多时移除最旧普通任务，但永远不主动丢弃礼物任务。
  if (normalizedKind !== 'gift' && countRegularJobs() >= maxRegularJobs) {
    const oldestRegularIndex = queue.findIndex(job => job.kind !== 'gift');
    if (oldestRegularIndex >= 0) queue.splice(oldestRegularIndex, 1);
    else return false;
    console.warn('[实体打印] 普通消息积压，已移除最旧的一条普通打印任务');
  }
  queue.push({
    kind: normalizedKind,
    text: makeText(normalizedKind, event),
    image: normalizedKind === 'gift' ? avatarImage(event) : '',
  });
  printNext();
  return true;
}

function enqueueText(text) {
  // 用于提交已经排版完成的普通文字，不附加用户名或礼物图片。
  if (!active) return false;
  const value = sanitize(text, '');
  if (!value) return false;
  if (countRegularJobs() >= maxRegularJobs) {
    const oldestRegularIndex = queue.findIndex(job => job.kind !== 'gift');
    if (oldestRegularIndex >= 0) queue.splice(oldestRegularIndex, 1);
    else return false;
  }
  queue.push({kind: 'idle', text: value, image: ''});
  printNext();
  return true;
}

function status() {
  // pending 不包含正在打印的任务，只表示仍在队列中等待的数量。
  return {enabled: active, printing, pending: queue.length, lastJob};
}

function reset(nextEnabled = false) {
  // 切换开关时立即清空积压；重新开启后不会补打旧消息。
  queue.length = 0;
  active = Boolean(nextEnabled);
  if (!active) clearWindowsQueue();
  if (active) printNext();
  return status();
}

function clearWindowsQueue() {
  // 关闭实体打印时同步取消 Windows 打印后台仍未执行的旧任务。
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `Get-PrintJob -PrinterName '${printerName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue`
  ], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('close', code => {
    if (code !== 0 && stderr.trim()) console.warn(`[实体打印] 清空 Windows 队列失败：${stderr.trim()}`);
    else console.log('[实体打印] 已停止接收并清空 Windows 打印队列');
  });
}

module.exports = {enqueue, enqueueText, status, reset};
