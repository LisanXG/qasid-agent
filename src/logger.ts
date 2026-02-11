// ============================================================================
// QasidAI — Logger
// Simple structured logger with levels
// ============================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) {
    currentLevel = level;
}

function formatTimestamp(): string {
    return new Date().toISOString();
}

function log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>) {
    if (levels[level] < levels[currentLevel]) return;

    const prefix = `[${formatTimestamp()}] [${level.toUpperCase()}] [${component}]`;
    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

    if (data) {
        logFn(`${prefix} ${message}`, JSON.stringify(data, null, 2));
    } else {
        logFn(`${prefix} ${message}`);
    }
}

export function createLogger(component: string) {
    return {
        debug: (msg: string, data?: Record<string, unknown>) => log('debug', component, msg, data),
        info: (msg: string, data?: Record<string, unknown>) => log('info', component, msg, data),
        warn: (msg: string, data?: Record<string, unknown>) => log('warn', component, msg, data),
        error: (msg: string, data?: Record<string, unknown>) => log('error', component, msg, data),
    };
}
