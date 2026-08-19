(function initializeMobileBridge(global) {
  const capacitor = global.Capacitor;
  const plugin = capacitor?.Plugins?.LocalNotifications;
  const native = Boolean(capacitor?.isNativePlatform?.() && plugin);
  const idCache = new Map();
  const storagePrefix = 'smartTodo.nativeReminderIds.';
  const reminderChannelId = 'smart-todo-reminders-v2';

  function hashId(value) {
    const text = String(value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % 2000000000;
  }

  function notificationId(todoId, index = 0) {
    return ((hashId(todoId) + index) % 2147483646) + 1;
  }

  function storageKey(todoId) {
    return `${storagePrefix}${todoId}`;
  }

  function rememberIds(todoId, ids) {
    idCache.set(String(todoId), ids);
    try { global.localStorage?.setItem(storageKey(todoId), JSON.stringify(ids)); } catch (_) {}
  }

  function readIds(todoId) {
    const cached = idCache.get(String(todoId));
    if (cached) return cached;
    try {
      const parsed = JSON.parse(global.localStorage?.getItem(storageKey(todoId)) || '[]');
      if (Array.isArray(parsed)) return parsed.filter(Number.isInteger);
    } catch (_) {}
    return [];
  }

  function forgetIds(todoId) {
    idCache.delete(String(todoId));
    try { global.localStorage?.removeItem(storageKey(todoId)); } catch (_) {}
  }

  function parseClock(value) {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
      ? { hour, minute, total: hour * 60 + minute }
      : null;
  }

  function baseNotification(todo, id, schedule) {
    return {
      id,
      title: todo.title || todo.text || '到时间了',
      body: '',
      schedule: { ...schedule, allowWhileIdle: true },
      channelId: reminderChannelId,
      foreground: true,
      isExactNotification: true,
      extra: { todoId: todo.id, recurrenceEnd: todo.recurrenceEnd || todo.reminderPlan?.until || null },
    };
  }

  function fixedTimeNotifications(todo) {
    const plan = todo.reminderPlan;
    const clock = parseClock(plan?.time);
    if (!clock) return [];
    const weekdays = plan.weekdaysOnly ? [2, 3, 4, 5, 6] : [null];
    return weekdays.map((weekday, index) => baseNotification(
      todo,
      notificationId(todo.id, index),
      { on: { ...(weekday ? { weekday } : {}), hour: clock.hour, minute: clock.minute } },
    ));
  }

  function timeWindowNotifications(todo) {
    const plan = todo.reminderPlan;
    const start = parseClock(plan?.startTime);
    const end = parseClock(plan?.endTime);
    const interval = Math.max(1, Number(plan?.intervalMinutes) || 60);
    if (!start || !end || start.total > end.total) return [];

    const weekdays = plan.weekdaysOnly ? [2, 3, 4, 5, 6] : [null];
    const notifications = [];
    let index = 0;
    for (let minuteOfDay = start.total; minuteOfDay <= end.total; minuteOfDay += interval) {
      const hour = Math.floor(minuteOfDay / 60);
      const minute = minuteOfDay % 60;
      for (const weekday of weekdays) {
        notifications.push(baseNotification(
          todo,
          notificationId(todo.id, index),
          { on: { ...(weekday ? { weekday } : {}), hour, minute } },
        ));
        index += 1;
      }
    }
    return notifications;
  }

  function simpleRecurringNotifications(todo) {
    const every = { minutely: 'minute', hourly: 'hour', daily: 'day', weekly: 'week' }[todo.recurrence];
    if (!every) return [];
    return [baseNotification(todo, notificationId(todo.id), { every })];
  }

  function buildNotifications(todo, reminderTime) {
    if (todo.reminderPlan?.type === 'fixed-time') return fixedTimeNotifications(todo);
    if (todo.reminderPlan?.type === 'time-window') return timeWindowNotifications(todo);
    if (todo.recurrence) return simpleRecurringNotifications(todo);
    return [baseNotification(todo, notificationId(todo.id), { at: new Date(reminderTime) })];
  }

  async function ensurePermission() {
    if (!native) return false;
    const current = await plugin.checkPermissions();
    if (current.display === 'granted') return true;
    const requested = await plugin.requestPermissions();
    return requested.display === 'granted';
  }

  async function cancelReminder(todoId) {
    if (!native) return;
    const ids = readIds(todoId);
    if (ids.length) await plugin.cancel({ notifications: ids.map(id => ({ id })) });
    forgetIds(todoId);
  }

  async function scheduleReminder(todo, reminderTime) {
    if (!native) return false;
    if (!(await ensurePermission())) throw new Error('Android 通知权限未授权');
    await cancelReminder(todo.id);
    const notifications = buildNotifications(todo, reminderTime);
    if (!notifications.length) throw new Error('无法生成 Android 提醒计划');
    for (let index = 0; index < notifications.length; index += 50) {
      await plugin.schedule({ notifications: notifications.slice(index, index + 50) });
    }
    rememberIds(todo.id, notifications.map(item => item.id));
    return true;
  }

  async function rescheduleAll(todos) {
    if (!native) return false;
    for (const todo of todos) {
      if (todo.done || !todo.reminderAt) {
        await cancelReminder(todo.id);
      } else {
        await scheduleReminder(todo, new Date(todo.reminderAt));
      }
    }
    return true;
  }

  function dispatchReminder(notification) {
    const todoId = notification?.extra?.todoId;
    if (todoId == null) return;
    global.dispatchEvent(new CustomEvent('mobile-reminder-fired', { detail: { todoId } }));
  }

  async function initialize() {
    if (!native) return;
    if (capacitor.getPlatform?.() === 'android' && plugin.createChannel) {
      await plugin.createChannel({
        id: reminderChannelId,
        name: '醒目待办提醒',
        description: '使用手机默认通知音，并伴随震动',
        importance: 5,
        visibility: 1,
        vibration: true,
        lights: true,
        lightColor: '#6366F1',
      });
    }
    await plugin.addListener('localNotificationReceived', dispatchReminder);
    await plugin.addListener('localNotificationActionPerformed', event => dispatchReminder(event.notification));
  }

  global.MobileBridge = {
    isNative: native,
    ensurePermission,
    scheduleReminder,
    cancelReminder,
    rescheduleAll,
    initialize,
  };
})(window);
