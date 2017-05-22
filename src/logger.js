/**
 * @class layer.Logger
 * @private
 *
 */
const { DEBUG, INFO, WARN, ERROR, NONE } = require('./const').LOG;

// Pretty arbitrary test that IE/edge fails and others don't.  Yes I could do a more direct
// test for IE/edge but its hoped that MS will fix this around the time they cleanup their internal console object.
// Note that uglifyjs with drop_console=true will throw an error on console.assert.toString().match; so we instead do (console.assert.toString() || "") which drop_console
// on replacing console.assert.toString() with (void 0) will still work
const supportsConsoleFormatting = Boolean(console.assert && (console.assert.toString() || "").match(/assert/));
const LayerCss = 'color: #888; font-weight: bold;';
const Black = 'color: black';
/* istanbulify ignore next */
class Logger {
  log(msg, obj, type, color) {
    /* istanbul ignore else */
    if (typeof msg === 'object') {
      obj = msg;
      msg = '';
    }
    const timestamp = new Date().toLocaleTimeString();
    let op;
    switch (type) {
      case DEBUG:
        op = 'debug';
        break;
      case INFO:
        op = 'info';
        break;
      case WARN:
        op = 'warn';
        break;
      case ERROR:
        op = 'error';
        break;
      default:
        op = 'log';
    }
    if (obj) {
      if (supportsConsoleFormatting) {
        console[op](`%cLayer%c ${op.toUpperCase()}%c [${timestamp}]: ${msg}`, LayerCss, `color: ${color}`, Black, obj);
      } else {
        console[op](`Layer ${op.toUpperCase()} [${timestamp}]: ${msg}`, obj);
      }
    } else if (supportsConsoleFormatting) {
      console[op](`%cLayer%c ${op.toUpperCase()}%c [${timestamp}]: ${msg}`, LayerCss, `color: ${color}`, Black);
    } else {
      console[op](`Layer ${op.toUpperCase()} [${timestamp}]: ${msg}`);
    }
  }


  debug(msg, obj) {
    /* istanbul ignore next */
    if (this.level >= DEBUG) this.log(msg, obj, DEBUG, '#888');
  }

  info(msg, obj) {
    /* istanbul ignore next */
    if (this.level >= INFO) this.log(msg, obj, INFO, 'black');
  }

  warn(msg, obj) {
    /* istanbul ignore next */
    if (this.level >= WARN) this.log(msg, obj, WARN, 'orange');
  }

  error(msg, obj) {
    /* istanbul ignore next */
    if (this.level >= ERROR) this.log(msg, obj, ERROR, 'red');
  }
}

/* istanbul ignore next */
Logger.prototype.level = typeof jasmine === 'undefined' ? ERROR : NONE;

const logger = new Logger();

module.exports = logger;
