const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const notification = fs.readFileSync(path.join(root, 'notification.html'), 'utf8');

function loadEngines() {
  const classifierStart = html.indexOf('const Classifier =');
  const extractorEndMarker = 'return { extract };\n})();';
  const extractorEnd = html.indexOf(extractorEndMarker, classifierStart) + extractorEndMarker.length;
  assert.ok(classifierStart >= 0 && extractorEnd > classifierStart, 'engine source can be located');
  const source = `${html.slice(classifierStart, extractorEnd)}; globalThis.engines = { Classifier, Extractor };`;
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.engines;
}

function loadReminderManager(windowOverrides = {}) {
  const start = html.indexOf('const ReminderManager =');
  const endMarker = 'return {\n    requestPermission,';
  const returnStart = html.indexOf(endMarker, start);
  const end = html.indexOf('};\n})();', returnStart) + '};\n})();'.length;
  assert.ok(start >= 0 && returnStart > start && end > returnStart, 'reminder manager source can be located');
  const source = `${html.slice(start, end)}; globalThis.ReminderManager = ReminderManager;`;
  const context = {
    console,
    window: { ...windowOverrides },
    Notification: { permission: 'denied' },
    TodoDB: { put: async () => {} },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.ReminderManager;
}

test('electron notification receives the configured reminder style', async () => {
  const calls = [];
  const ReminderManager = loadReminderManager({
    electronAPI: {
      showNotification: async payload => {
        calls.push(payload);
        return { success: true };
      },
    },
  });

  await ReminderManager.showNotification({ id: 1, title: '测试事项' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].style, 'default');
});

test('start recurring reminder schedules through Electron without reminder style scope errors', async () => {
  const scheduled = [];
  const ReminderManager = loadReminderManager({
    electronAPI: {
      cancelReminder: () => {},
      scheduleReminder: async (todo, reminderAt) => {
        scheduled.push({ todo: { ...todo }, reminderAt });
        return { success: true };
      },
    },
  });
  const todo = {
    id: 2,
    text: '每分钟提醒我',
    title: '每分钟提醒我',
    recurrence: 'minutely',
    recurrenceInterval: 1,
  };
  const firstReminder = new Date(Date.now() + 60_000);

  await ReminderManager.scheduleReminder(todo, firstReminder);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].todo.reminderStyle, 'default');
  assert.equal(todo.reminderAt, firstReminder.toISOString());

  ReminderManager.setReminderStyle('pink-bubble');
  await ReminderManager.scheduleReminder(todo, new Date(Date.now() + 120_000));
  assert.equal(scheduled[1].todo.reminderStyle, 'pink-bubble');
});

test('rule engine classifies representative tasks', () => {
  const { Classifier } = loadEngines();
  assert.equal(Classifier.classify('买牛奶').category, 'quick');
  assert.equal(Classifier.classify('明天下午3点开会').category, 'planning');
  assert.equal(Classifier.classify('设计并开发新的数据迁移系统方案').category, 'system');
});

test('extractor rejects impossible calendar dates', () => {
  const { Extractor } = loadEngines();
  assert.equal(Extractor.extract('2月31日提醒我开会', 'planning').dueDate, null);
});

test('extractor understands time-window reminders that start today', () => {
  const { Extractor } = loadEngines();
  const drink = Extractor.extract('每天9:30~18:00提醒每间隔一小时提醒测试事项甲', 'quick');
  assert.equal(drink.recurrence, 'custom');
  assert.deepEqual(
    {
      startTime: drink.reminderPlan.startTime,
      endTime: drink.reminderPlan.endTime,
      intervalMinutes: drink.reminderPlan.intervalMinutes,
      weekdaysOnly: drink.reminderPlan.weekdaysOnly,
    },
    { startTime: '09:30', endTime: '18:00', intervalMinutes: 60, weekdaysOnly: false }
  );

  const stretch = Extractor.extract('每天9:30~18:00提醒每隔30分钟处理测试事项乙，工作日内提醒，为期一年', 'quick');
  assert.equal(stretch.reminderPlan.intervalMinutes, 30);
  assert.equal(stretch.reminderPlan.weekdaysOnly, true);
  assert.ok(stretch.reminderPlan.until);
});

test('time-window reminder plans choose the next in-window slot', () => {
  const ReminderManager = loadReminderManager();
  const todo = {
    reminderPlan: {
      type: 'time-window',
      startTime: '09:30',
      endTime: '18:00',
      intervalMinutes: 30,
      weekdaysOnly: true,
      until: null,
    },
  };

  assert.equal(
    ReminderManager.computeNextReminderTime(todo, new Date('2026-08-04T10:10:00')).toISOString(),
    new Date('2026-08-04T10:30:00').toISOString()
  );
  assert.equal(
    ReminderManager.computeNextReminderTime(todo, new Date('2026-08-08T10:10:00')).toISOString(),
    new Date('2026-08-10T09:30:00').toISOString()
  );
});

test('fixed daily workday reminders keep their exact clock time', () => {
  const { Extractor } = loadEngines();
  const ReminderManager = loadReminderManager();
  const checkout = Extractor.extract('我希望能每天提醒我在18:00时打卡签退', 'quick');
  assert.equal(checkout.title, '打卡签退');
  assert.deepEqual(
    {
      type: checkout.reminderPlan.type,
      time: checkout.reminderPlan.time,
      weekdaysOnly: checkout.reminderPlan.weekdaysOnly,
      dueDate: checkout.dueDate,
    },
    { type: 'fixed-time', time: '18:00', weekdaysOnly: false, dueDate: null }
  );

  const todo = { reminderPlan: checkout.reminderPlan };
  assert.equal(
    ReminderManager.computeNextReminderTime(todo, new Date('2026-08-04T14:10:00')).toISOString(),
    new Date('2026-08-04T18:00:00').toISOString()
  );
  assert.equal(
    ReminderManager.computeNextReminderTime(todo, new Date('2026-08-04T18:10:00')).toISOString(),
    new Date('2026-08-05T18:00:00').toISOString()
  );

  const timesheet = Extractor.extract('我希望能每天提醒我在17:45时处理测试事项丁', 'quick');
  assert.equal(timesheet.title, '处理测试事项丁');
  assert.equal(timesheet.reminderPlan.time, '17:45');
  assert.equal(timesheet.reminderPlan.weekdaysOnly, false);
});

test('natural time-window reminder wording extracts the intended action', () => {
  const { Extractor } = loadEngines();
  const water = Extractor.extract('我希望能每天9:30~18:00期间提醒我每1小时喝一杯水（工作日）', 'quick');
  assert.equal(water.title, '喝一杯水');
  assert.deepEqual(
    {
      type: water.reminderPlan.type,
      startTime: water.reminderPlan.startTime,
      endTime: water.reminderPlan.endTime,
      intervalMinutes: water.reminderPlan.intervalMinutes,
      weekdaysOnly: water.reminderPlan.weekdaysOnly,
    },
    { type: 'time-window', startTime: '09:30', endTime: '18:00', intervalMinutes: 60, weekdaysOnly: true }
  );
});

test('requested workday reminder scenarios preserve schedule and popup keyword', () => {
  const { Extractor } = loadEngines();
  const ReminderManager = loadReminderManager();
  const scenarios = [
    {
      text: '每天9:30~18:00（工作日），每小时提醒我测试事项甲',
      title: '测试事项甲',
      plan: { type: 'time-window', startTime: '09:30', endTime: '18:00', intervalMinutes: 60, weekdaysOnly: true },
      from: '2026-08-13T10:10:00',
      next: '2026-08-13T10:30:00',
    },
    {
      text: '每天9:30~18:00（工作日），每半小时提醒我测试事项乙',
      title: '测试事项乙',
      plan: { type: 'time-window', startTime: '09:30', endTime: '18:00', intervalMinutes: 30, weekdaysOnly: true },
      from: '2026-08-13T10:10:00',
      next: '2026-08-13T10:30:00',
    },
    {
      text: '每天18:00（工作日），每小时提醒我测试事项丙',
      title: '测试事项丙',
      plan: { type: 'fixed-time', time: '18:00', weekdaysOnly: true },
      from: '2026-08-13T10:10:00',
      next: '2026-08-13T18:00:00',
    },
    {
      text: '每天17:45（工作日），每小时提醒我测试事项丁',
      title: '测试事项丁',
      plan: { type: 'fixed-time', time: '17:45', weekdaysOnly: true },
      from: '2026-08-13T10:10:00',
      next: '2026-08-13T17:45:00',
    },
  ];

  for (const scenario of scenarios) {
    const result = Extractor.extract(scenario.text, 'quick');
    assert.equal(result.title, scenario.title, scenario.text);
    for (const [key, expected] of Object.entries(scenario.plan)) {
      assert.equal(result.reminderPlan?.[key], expected, `${scenario.text}: ${key}`);
    }
    assert.equal(
      ReminderManager.computeNextReminderTime(result, new Date(scenario.from)).toISOString(),
      new Date(scenario.next).toISOString(),
      `${scenario.text}: next reminder`
    );
  }
});

test('one-shot reminders use the reminder keyword and complete after firing', () => {
  const { Extractor } = loadEngines();
  const walk = Extractor.extract('一分钟后提醒我测试事项戊', 'quick');
  assert.equal(walk.title, '测试事项戊');
  assert.equal(walk.reminderPlan, null);
  assert.equal(typeof walk.dueDate?.getTime, 'function');
  const delayMs = walk.dueDate.getTime() - Date.now();
  assert.ok(delayMs > 30_000 && delayMs <= 65_000, `expected about one minute, got ${delayMs}ms`);

  assert.match(html, /todo\.done = true;\s+todo\.completedAt = todo\.completedAt \|\| Date\.now\(\);/);
  assert.match(html, /if \(window\._showReminderModal\) window\._showReminderModal\(live\);/);
  assert.match(main, /const body = '';/);
  assert.doesNotMatch(main, /notifWin\.on\('blur'/);
});

test('completed tasks are hidden after three days but export remains available', () => {
  assert.match(html, /function isVisibleInSmartTodo/);
  assert.match(html, /3 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(html, /function exportHistory/);
  assert.match(html, /smart-todo-history-/);
  assert.match(html, /function compareTodosForDisplay/);
});

test('recurring reminder modal hides Done until the final occurrence', () => {
  assert.match(html, /function shouldShowReminderDoneButton/);
  assert.match(html, /\$btnDoneReminder\.hidden = !shouldShowReminderDoneButton\(todo\);/);
  assert.match(html, /if \(!todo\.recurrence && !todo\.reminderPlan\) return true;/);
  assert.match(html, /function isFinalReminderOccurrence/);
  assert.match(html, /computeNextReminderTime\(todo, afterCurrent\)/);
});

test('minutely reminders stay active and schedule the next occurrence after firing', () => {
  assert.match(html, /case 'minutely': nextTime = addMin\(lastReminder, interval\);/);
  assert.match(html, /if \(!todo\.recurrence && !todo\.reminderPlan\) \{\s+todo\.done = true;/);
  assert.match(html, /scheduleReminder\(todo, nextTime\);/);
});

test('reminder modal has a close action that only dismisses the modal', () => {
  assert.match(html, /id="btnCloseReminder">关闭<\/button>/);
  assert.match(html, /const \$btnCloseReminder = \$\('#btnCloseReminder'\);/);
  assert.match(html, /\$btnCloseReminder\.addEventListener\('click', \(\) => \{/);
  assert.match(html, /\$reminderModal\.classList\.remove\('show'\);\s+currentReminderTodo = null;/);
});

test('reminder popup style can switch to pink or lavender bubbles', () => {
  assert.match(html, /id="reminderStyleSelect"/);
  assert.match(html, /value="pink-bubble">粉色泡泡/);
  assert.match(html, /value="lavender-bubble">香芋紫泡泡/);
  assert.match(html, /function normalizeReminderStyle/);
  assert.match(html, /TodoDB\.setMeta\('reminderStyle', reminderStyle\)/);
  assert.match(html, /popup\.classList\.add\('bubble-style', 'bubble-pink'\)/);
  assert.match(html, /popup\.classList\.add\('bubble-style', 'bubble-lavender'\)/);
  assert.match(html, /style: todo\.reminderStyle \|\| 'default'/);
  assert.match(main, /query: \{ title, body, style \}/);
  assert.match(notification, /card\.classList\.add\('bubble', style\)/);
  assert.match(notification, /\.card\.pink-bubble/);
  assert.match(notification, /\.card\.lavender-bubble/);
});

test('notification window is sandboxed and writes untrusted text with textContent', () => {
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.doesNotMatch(main, /data:text\/html/);
  assert.match(notification, /\.textContent\s*=/);
  assert.doesNotMatch(notification, /innerHTML\s*=/);
});

test('renderer escapes generated suggestion content', () => {
  assert.match(html, /class="sug-text">\$\{escHTML\(s\.text\)\}/);
  assert.doesNotMatch(html, /class="sug-text">\$\{s\.text\}/);
});

test('logs are outside the packaged ASAR and long timers are re-armed', () => {
  assert.match(main, /app\.getPath\('userData'\)/);
  assert.match(main, /setTimeout\(\(\) => armReminder\(todo, timestamp\)/);
  assert.doesNotMatch(main, /appendFileSync\(path\.join\(__dirname/);
});

test('AI credentials stay in the main process encrypted store', () => {
  assert.match(main, /safeStorage\.encryptString/);
  assert.doesNotMatch(html, /aiConfig\.key\s*=\s*\$aiKey/);
  assert.match(main, /AI endpoint must use HTTPS/);
});
