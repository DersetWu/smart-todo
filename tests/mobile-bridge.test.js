const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBridge() {
  const calls = { schedule: [], cancel: [] };
  const values = new Map();
  const plugin = {
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
    schedule: async options => { calls.schedule.push(options); return { notifications: options.notifications }; },
    cancel: async options => { calls.cancel.push(options); },
    createChannel: async () => {},
    addListener: async () => ({ remove: async () => {} }),
  };
  const window = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: { LocalNotifications: plugin },
    },
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
    dispatchEvent: () => {},
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'mobile-bridge.js'), 'utf8');
  vm.runInNewContext(source, { window, CustomEvent, Date, Map, Math, JSON, Number, String, Boolean, Array, Error });
  return { bridge: window.MobileBridge, calls };
}

test('Android fixed-time workday reminders preserve 18:00 and weekdays', async () => {
  const { bridge, calls } = loadBridge();
  await bridge.scheduleReminder({
    id: 'fixed-workday',
    title: '测试事项',
    reminderPlan: { type: 'fixed-time', time: '18:00', weekdaysOnly: true },
  }, new Date('2026-08-20T18:00:00'));

  const notifications = calls.schedule.flatMap(call => call.notifications);
  assert.equal(notifications.length, 5);
  assert.deepEqual(notifications.map(item => item.schedule.on.weekday), [2, 3, 4, 5, 6]);
  assert.ok(notifications.every(item => item.schedule.on.hour === 18 && item.schedule.on.minute === 0));
  assert.ok(notifications.every(item => item.title === '测试事项'));
});

test('Android half-hour workday window creates every slot from 09:30 through 18:00', async () => {
  const { bridge, calls } = loadBridge();
  await bridge.scheduleReminder({
    id: 'window-workday',
    title: '测试事项',
    reminderPlan: {
      type: 'time-window',
      startTime: '09:30',
      endTime: '18:00',
      intervalMinutes: 30,
      weekdaysOnly: true,
    },
  }, new Date('2026-08-20T10:00:00'));

  const notifications = calls.schedule.flatMap(call => call.notifications);
  assert.equal(notifications.length, 90);
  assert.deepEqual({ ...notifications[0].schedule.on }, { weekday: 2, hour: 9, minute: 30 });
  assert.deepEqual({ ...notifications.at(-1).schedule.on }, { weekday: 6, hour: 18, minute: 0 });
  assert.equal(calls.schedule.length, 2, 'large plans are scheduled in safe batches');
});

test('Android cancellation removes every native alarm belonging to a todo', async () => {
  const { bridge, calls } = loadBridge();
  const todo = {
    id: 'cancel-workday',
    title: '测试事项',
    reminderPlan: { type: 'fixed-time', time: '17:45', weekdaysOnly: true },
  };
  await bridge.scheduleReminder(todo, new Date('2026-08-20T17:45:00'));
  await bridge.cancelReminder(todo.id);
  assert.equal(calls.cancel.at(-1).notifications.length, 5);
});
