module.exports = {
    sock: null,
    store: null,
    reconnecting: false,
    reconnectTimer: null,
    reconnectAttempts: 0,
    qrToken: 0,
    qrUpdatedAt: 0,
    lastQrValue: '',
    lastQrUpdateAt: 0,
    qrWatchdogTimer: null,
    scheduledMessagesTimer: null,
    startupTimeSec: Math.floor(Date.now() / 1000),
    totalMessagesHandled: 0,
    totalCommandsHandled: 0,
    sseClients: new Set(),
    presence: new Map(),
    activityLog: [],
    chatHistories: new Map(),
    commandUsage: new Map()
};

function logActivity(type, message) {
    const entry = {
        time: new Date().toISOString(),
        type,
        message
    };
    state.activityLog.push(entry);
    if (state.activityLog.length > 500) {
        state.activityLog = state.activityLog.slice(-500);
    }
}

module.exports.logActivity = logActivity;
