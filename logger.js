'use strict';
/**
 * Logger — timestamp + level，写入控制台和按日滚动的日志文件。
 */

const fs   = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile   = path.join(LOG_DIR, `monitor-${new Date().toISOString().slice(0, 10)}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function fmt(level, msg) {
  return `[${new Date().toISOString()}] [${level}] ${msg}`;
}

function info(msg)  { const l = fmt('INFO ', msg); console.log(l);   logStream.write(l + '\n'); }
function warn(msg)  { const l = fmt('WARN ', msg); console.warn(l);  logStream.write(l + '\n'); }
function error(msg) { const l = fmt('ERROR', msg); console.error(l); logStream.write(l + '\n'); }
function debug(msg) {
  if (process.env.DEBUG) {
    const l = fmt('DEBUG', msg);
    console.log(l);
    logStream.write(l + '\n');
  }
}

module.exports = { info, warn, error, debug };
