const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Journalisation horodatée, sans jamais inclure d'identifiant ou de secret. */
export function createLogger(level = 'info', sink = console) {
  const threshold = LEVELS[level] || LEVELS.info;
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const write = (name, method) => (...args) => {
    if (LEVELS[name] < threshold) return;
    sink[method](`[${stamp()}] ${name.toUpperCase().padEnd(5)}`, ...args);
  };
  return {
    debug: write('debug', 'log'),
    info: write('info', 'log'),
    warn: write('warn', 'warn'),
    error: write('error', 'error'),
  };
}
