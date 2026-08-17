const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const electron = process.env.SMART_TODO_EXECUTABLE || require('electron');
const port = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-todo-smoke-'));
const appArgs = process.env.SMART_TODO_EXECUTABLE
  ? [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`]
  : [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '.'];
const child = spawn(electron, appArgs, {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findPage() {
  for (let i = 0; i < 50; i++) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
      const page = pages.find(item => item.type === 'page' && /index\.html(?:$|[?#])/.test(item.url));
      if (page) return page;
    } catch (_) {}
    await delay(200);
  }
  throw new Error('Electron renderer did not expose a debuggable page');
}

async function run() {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  function command(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Renderer evaluation failed');
    return result.result.value;
  }

  for (let i = 0; i < 50; i++) {
    if (await evaluate(`document.documentElement?.dataset.appReady === 'true'`)) break;
    if (i === 49) throw new Error('Smart Todo app did not become ready');
    await delay(100);
  }

  await evaluate(`document.querySelector('#testBtn').click()`);
  let selfTestToast = '';
  for (let i = 0; i < 50; i++) {
    selfTestToast = await evaluate(`[...document.querySelectorAll('.toast')].map(el => el.textContent).find(text => text.includes('页面自检')) || ''`);
    if (selfTestToast) break;
    await delay(100);
  }
  assert.match(selfTestToast, /^✅ 页面自检通过/);
  assert.match(selfTestToast, /提醒解析 4\/4/);
  assert.match(selfTestToast, /排程 通过/);

  await evaluate(`(() => {
    const input = document.querySelector('#todoInput');
    input.value = '每分钟测试';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#todoForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  let startButtonFound = false;
  for (let i = 0; i < 50; i++) {
    startButtonFound = await evaluate(`Boolean([...document.querySelectorAll('[data-action]')].find(el => el.textContent.includes('开始每分钟提醒')))`);
    if (startButtonFound) break;
    await delay(100);
  }
  assert.equal(startButtonFound, true, '页面应生成“开始每分钟提醒”按钮');
  await evaluate(`[...document.querySelectorAll('[data-action]')].find(el => el.textContent.includes('开始每分钟提醒')).click()`);
  await delay(500);

  const state = await evaluate(`(() => ({
    toast: [...document.querySelectorAll('.toast')].map(el => el.textContent).join(' | '),
    reminderTag: document.querySelector('[data-reminder-id]')?.textContent || '',
  }))()`);
  assert.match(state.toast, /已开始每分钟提醒/);
  assert.doesNotMatch(state.toast, /reminderStyle is not defined|异步错误/);
  assert.match(state.reminderTag, /今天/);

  ws.close();
}

async function stopChild() {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      delay(3000),
    ]);
  }
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== 'EPERM' || i === 4) throw error;
      await delay(200);
    }
  }
}

run()
  .then(() => {
    console.log('✔ Electron 真实页面：页面自检和每分钟提醒按钮均通过');
  })
  .catch(error => {
    console.error(error.stack || error.message);
    if (stderr.trim()) console.error(stderr.trim());
    process.exitCode = 1;
  })
  .finally(stopChild);
