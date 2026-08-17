/* ================================================================
   Smart Todo — Preload Script
   Bridges Electron main process APIs to the renderer process
   safely via contextBridge (contextIsolation enabled).
   ================================================================ */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Notification
  showNotification: (options) => ipcRenderer.invoke('show-notification', options),

  // Check if running in Electron
  isElectron: () => ipcRenderer.invoke('get-is-electron'),

  // AI classification
  classifyWithAI: (text, currentCategory) =>
    ipcRenderer.invoke('ai-classify', { text, currentCategory }),
  getAIConfig: () => ipcRenderer.invoke('get-ai-config'),
  saveAIConfig: (config) => ipcRenderer.invoke('save-ai-config', config),
  testAI: (config) => ipcRenderer.invoke('test-ai', config),

  // Reminder scheduling (main process Node.js timers — reliable)
  scheduleReminder: (todo, reminderTime) =>
    ipcRenderer.invoke('schedule-reminder', { todo, reminderTime }),
  cancelReminder: (todoId) =>
    ipcRenderer.invoke('cancel-reminder', todoId),
  rescheduleAll: (todos) =>
    ipcRenderer.invoke('reschedule-all', todos),

  // Listen for reminder fired from main process
  onReminderFired: (callback) => {
    const handler = (_event, todo) => callback(todo);
    ipcRenderer.on('reminder-fired', handler);
    return () => ipcRenderer.removeListener('reminder-fired', handler);
  },

  // Listen for system resume
  onSystemResume: (callback) => {
    ipcRenderer.on('system-resume', () => callback());
    return () => ipcRenderer.removeAllListeners('system-resume');
  },

  // Listen for notification "done" button
  onNotifMarkDone: (callback) => {
    const handler = (_event, todoId) => callback(todoId);
    ipcRenderer.on('notif-mark-done', handler);
    return () => ipcRenderer.removeListener('notif-mark-done', handler);
  },
});
