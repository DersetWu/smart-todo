/* ================================================================
   Smart Todo — Electron Main Process
   - System tray (minimize to icon)
   - Background running
   - Native notifications via IPC
   - Single instance lock
   ================================================================ */

const {
  app, BrowserWindow, Tray, Menu, Notification,
  nativeImage, ipcMain, powerMonitor, safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

// ===================== Consts =====================
const APP_NAME = 'Smart Todo';
const isDev = process.argv.includes('--dev');

let mainWindow = null;
let tray = null;
let isQuitting = false;
const MAX_TIMER_DELAY = 2147483647;
const VALID_CATEGORIES = new Set(['quick', 'planning', 'system']);

function logReminder(message) {
  try {
    const logPath = path.join(app.getPath('userData'), 'reminder.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch (error) {
    console.warn('[Reminder] Failed to write log:', error.message);
  }
}

function isTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  try {
    const senderUrl = new URL(event.senderFrame.url);
    return senderUrl.protocol === 'file:' && path.normalize(decodeURIComponent(senderUrl.pathname)).endsWith(path.normalize('index.html'));
  } catch (_) {
    return false;
  }
}

function assertTrustedSender(event) {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
}

function normalizeTodo(value) {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid todo');
  const id = Number(value.id);
  const text = String(value.text || '').trim().slice(0, 300);
  if (!Number.isSafeInteger(id) || !text) throw new TypeError('Invalid todo fields');
  const reminderPlan = value.reminderPlan && typeof value.reminderPlan === 'object' ? {
    type: ['time-window', 'fixed-time'].includes(value.reminderPlan.type) ? value.reminderPlan.type : null,
    time: typeof value.reminderPlan.time === 'string' ? value.reminderPlan.time.slice(0, 5) : null,
    startTime: typeof value.reminderPlan.startTime === 'string' ? value.reminderPlan.startTime.slice(0, 5) : null,
    endTime: typeof value.reminderPlan.endTime === 'string' ? value.reminderPlan.endTime.slice(0, 5) : null,
    intervalMinutes: Math.max(1, Math.min(1440, Number(value.reminderPlan.intervalMinutes) || 0)),
    weekdaysOnly: Boolean(value.reminderPlan.weekdaysOnly),
    until: typeof value.reminderPlan.until === 'string' ? value.reminderPlan.until.slice(0, 40) : null,
  } : null;
  return {
    id,
    text,
    title: String(value.title || '').slice(0, 80),
    done: Boolean(value.done),
    category: VALID_CATEGORIES.has(value.category) ? value.category : 'quick',
    dueDate: typeof value.dueDate === 'string' ? value.dueDate.slice(0, 40) : null,
    reminderAt: typeof value.reminderAt === 'string' ? value.reminderAt.slice(0, 40) : null,
    recurrence: ['minutely', 'hourly', 'daily', 'weekly', 'custom'].includes(value.recurrence) ? value.recurrence : null,
    recurrenceEnd: typeof value.recurrenceEnd === 'string' ? value.recurrenceEnd.slice(0, 40) : null,
    recurrenceInterval: Math.max(1, Math.min(365, Number(value.recurrenceInterval) || 1)),
    reminderPlan: reminderPlan?.type ? reminderPlan : null,
    reminderStyle: ['default', 'pink-bubble', 'lavender-bubble'].includes(value.reminderStyle) ? value.reminderStyle : 'default',
  };
}

function parseReminderTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError('Invalid reminder time');
  return timestamp;
}

function getAIConfigPath() {
  return path.join(app.getPath('userData'), 'ai-config.json');
}

function readAIConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(getAIConfigPath(), 'utf8'));
    let key = '';
    if (saved.encryptedKey && safeStorage.isEncryptionAvailable()) {
      key = safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64'));
    }
    return { endpoint: saved.endpoint || '', model: saved.model || '', provider: saved.provider || 'deepseek', key };
  } catch (_) {
    return { endpoint: '', model: '', provider: 'deepseek', key: '' };
  }
}

function writeAIConfig(config) {
  const current = readAIConfig();
  const key = typeof config.key === 'string' && config.key ? config.key : current.key;
  if (key && !safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable');
  const payload = {
    provider: config.provider === 'openai' ? 'openai' : 'deepseek',
    endpoint: String(config.endpoint || '').slice(0, 2048),
    model: String(config.model || '').slice(0, 120),
    encryptedKey: key ? safeStorage.encryptString(key).toString('base64') : '',
  };
  fs.writeFileSync(getAIConfigPath(), JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
  return { ...payload, encryptedKey: undefined, hasKey: Boolean(key) };
}

function validateAIEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('AI endpoint must use HTTPS');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Local AI endpoints are not allowed');
  if (net.isIP(host) && (
    host.startsWith('10.') || host.startsWith('127.') || host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1' || host.startsWith('fc') || host.startsWith('fd')
  )) throw new Error('Private-network AI endpoints are not allowed');
  return url.toString();
}

// ===================== App Icon =====================
const iconPath = path.join(__dirname, 'assets', 'icon.png');
const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');

function getAppIcon() {
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  // Fallback: purple square
  return nativeImage.createFromDataURL(
    'data:image/svg+xml,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="7" fill="#6366f1"/></svg>')
  );
}

function getTrayIcon() {
  if (fs.existsSync(trayIconPath)) {
    return nativeImage.createFromPath(trayIconPath);
  }
  return getAppIcon().resize({ width: 32, height: 32 });
}

// ===================== Window =====================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 580,
    height: 720,
    minWidth: 360,
    minHeight: 500,
    title: APP_NAME,
    icon: getAppIcon(),
    show: true, // Show on first launch; user can minimize to tray
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true, // Save CPU when hidden
    },
  });

  // Clear cache to ensure latest code
  mainWindow.webContents.session.clearCache();
  mainWindow.loadURL(`file://${path.join(__dirname, 'index.html')}?v=${Date.now()}`);

  // Minimize to tray on close (don't quit)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('show', () => {
    tray?.setToolTip(APP_NAME + ' — 运行中');
  });

  // Open DevTools in dev mode
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.show();
  }
}

// ===================== Tray =====================
function createTray() {
  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME + ' — 运行中');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '📝 打开 Smart Todo',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: '✕ 完全退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Click tray icon to toggle window
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ===================== IPC: Notifications =====================
ipcMain.handle('show-notification', async (event, options = {}) => {
  assertTrustedSender(event);
  if (!Notification.isSupported()) return { success: false, reason: 'notifications not supported' };
  const title = String(options.title || '').slice(0, 100);
  const body = String(options.body || '').slice(0, 500);
  const style = ['default', 'pink-bubble', 'lavender-bubble'].includes(options.style) ? options.style : 'default';

  const n = new Notification({
    title: title || '🔔 Smart Todo 提醒',
    body: body || '到时间了！',
    icon: getTrayIcon(),
    urgency: 'critical',
    timeoutType: 'never', // Stay until user dismisses
  });

  n.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  n.show();
  return { success: true };
});

// Notification window "done" button
ipcMain.on('notif-done', (event, todoId) => {
  assertTrustedSender(event);
  mainWindow?.webContents.send('notif-mark-done', todoId);
});

ipcMain.handle('get-is-electron', (event) => { assertTrustedSender(event); return true; });

ipcMain.handle('get-ai-config', (event) => {
  assertTrustedSender(event);
  const config = readAIConfig();
  return { provider: config.provider, endpoint: config.endpoint, model: config.model, hasKey: Boolean(config.key) };
});

ipcMain.handle('save-ai-config', (event, config = {}) => {
  assertTrustedSender(event);
  if (config.endpoint) validateAIEndpoint(config.endpoint);
  return writeAIConfig(config);
});

// AI classification — forwards text + context to DeepSeek-compatible API
ipcMain.handle('ai-classify', async (event, { text, currentCategory } = {}) => {
  assertTrustedSender(event);
  const config = readAIConfig();
  if (!config.key || !config.endpoint) {
    return { error: 'AI not configured' };
  }
  try {
    const safeText = String(text || '').slice(0, 300);
    const safeCategory = VALID_CATEGORIES.has(currentCategory) ? currentCategory : 'quick';
    const endpoint = validateAIEndpoint(config.endpoint);
    const prompt = `你是一个任务分类助手。用户的输入是："${safeText}"。当前规则引擎判断为"${safeCategory}"类。

请做两件事：
1. 判断任务的正确分类，从 ["quick","planning","system"] 中选择。
   - quick: 碎片记录型（小事、买东西、回消息、取快递等，几分钟能完成）
   - planning: 日常规划型（有明确时间或截止日期的任务，如开会、提交报告）
   - system: 系统项目型（复杂、多步骤、需要拆解的任务）
2. 如果分类为 system，将其拆解为子任务（用中文顿号分隔的子步骤列表）。

请只回复 JSON，不要其他内容。格式：{"category":"planning","subtasks":[]}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.key}` },
      body: JSON.stringify({
        model: config.model || 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { error: `API error ${res.status}: ${errText.substring(0, 100)}` };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!VALID_CATEGORIES.has(parsed.category)) throw new Error('Invalid AI category');
        const subtasks = Array.isArray(parsed.subtasks)
          ? parsed.subtasks.slice(0, 20).map(item => String(item).trim().slice(0, 200)).filter(Boolean)
          : [];
        return { category: parsed.category, subtasks };
      } catch (_) {}
    }
    return { error: 'Failed to parse AI response', raw: content.substring(0, 200) };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('test-ai', async (event, draft = {}) => {
  assertTrustedSender(event);
  const stored = readAIConfig();
  const key = String(draft.key || stored.key || '');
  const endpoint = validateAIEndpoint(String(draft.endpoint || stored.endpoint || ''));
  if (!key) throw new Error('API Key is required');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: String(draft.model || stored.model || 'deepseek-chat').slice(0, 120), messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${(await res.text()).slice(0, 80)}`);
  return { success: true };
});

// Reminder scheduling — main process Node.js timers (Chromium setTimeout is unreliable)
const reminderTimers = new Map(); // todoId → timeoutId

function fireReminderToRenderer(todo) {
  logReminder(`FIRE: ${(todo.title || todo.text).slice(0, 80)}`);

  // Show a small notification window at bottom-right (instead of center dialog)
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const title = todo.title || todo.text || '到时间了';
  const body = '';
  const style = ['default', 'pink-bubble', 'lavender-bubble'].includes(todo.reminderStyle) ? todo.reminderStyle : 'default';
  const isBubble = style !== 'default';
  const winWidth = isBubble ? 380 : 340;
  const winHeight = isBubble ? 150 : 120;

  const notifWin = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: screenWidth - winWidth - 20,
    y: screenHeight - winHeight - 20,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    transparent: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  notifWin.loadFile(path.join(__dirname, 'notification.html'), { query: { title, body, style } });

  // System beep
  try { require('electron').shell.beep(); } catch(e) {}

  // Also notify renderer for recurrence + sound
  mainWindow?.webContents.send('reminder-fired', todo);
}

function armReminder(todo, timestamp) {
  const remaining = timestamp - Date.now();
  if (remaining <= 0) {
    reminderTimers.delete(todo.id);
    fireReminderToRenderer(todo);
    return;
  }
  const timeoutId = setTimeout(() => armReminder(todo, timestamp), Math.min(remaining, MAX_TIMER_DELAY));
  reminderTimers.set(todo.id, timeoutId);
}

ipcMain.handle('schedule-reminder', async (event, payload = {}) => {
  assertTrustedSender(event);
  const todo = normalizeTodo(payload.todo);
  const at = parseReminderTime(payload.reminderTime);
  // Cancel existing
  if (reminderTimers.has(todo.id)) {
    clearTimeout(reminderTimers.get(todo.id));
    reminderTimers.delete(todo.id);
  }

  const delay = at - Date.now();

  if (delay <= 0) { fireReminderToRenderer(todo); return { fired: true }; }

  logReminder(`SCHEDULE: ${todo.text.slice(0, 30)} in ${Math.round(delay / 1000)}s`);
  armReminder(todo, at);
  return { scheduled: true, delay };
});

ipcMain.handle('cancel-reminder', async (event, todoId) => {
  assertTrustedSender(event);
  todoId = Number(todoId);
  if (reminderTimers.has(todoId)) {
    clearTimeout(reminderTimers.get(todoId));
    reminderTimers.delete(todoId);
  }
  return { cancelled: true };
});

ipcMain.handle('reschedule-all', async (event, todos) => {
  assertTrustedSender(event);
  if (!Array.isArray(todos) || todos.length > 10000) throw new TypeError('Invalid todo list');
  // Cancel all existing
  reminderTimers.forEach((id) => clearTimeout(id));
  reminderTimers.clear();

  const now = Date.now();
  let count = 0;
  todos.forEach(rawTodo => {
    let todo;
    try { todo = normalizeTodo(rawTodo); } catch (_) { return; }
    if (!todo.reminderAt || todo.done) return;
    let at;
    try { at = parseReminderTime(todo.reminderAt); } catch (_) { return; }
    const delay = at - now;
    if (delay <= 0) {
      // Missed — fire immediately
      fireReminderToRenderer(todo);
      return;
    }
    armReminder(todo, at);
    count++;
  });
  return { count };
});

// ===================== App lifecycle =====================
app.whenReady().then(() => {
  // Required for Windows notifications to work
  app.setAppUserModelId('com.smarttodo.app');

  // Single instance lock
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  createWindow();
  createTray();
});

// Quit when all windows are closed (macOS behavior override)
app.on('window-all-closed', () => {
  // Don't quit — keep running in tray
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  } else {
    createWindow();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

// Prevent system sleep while app is running (optional: disable if CPU concern)
powerMonitor.on('suspend', () => {
  // Handle system sleep — timers will catch up on resume
});

powerMonitor.on('resume', () => {
  // Notify renderer to re-sync timers
  mainWindow?.webContents.send('system-resume');
});
