// Structured logging utility — debug, info, warn, error

const isDebug = !!process.env.NEMO_DEBUG;

export function debug(msg) {
  if (isDebug) {
    console.error(`[DEBUG] ${msg}`);
  }
}

export function info(msg) {
  console.log(`[INFO] ${msg}`);
}

export function warn(msg) {
  console.error(`[WARN] ${msg}`);
}

export function error(msg) {
  console.error(`[ERROR] ${msg}`);
}
