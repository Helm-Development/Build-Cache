'use strict';

// A stand-in for @actions/core that records what the action reports.
function fakeIO(inputs = {}, state = {}) {
  const log = { outputs: {}, state: { ...state }, info: [], notice: [], warning: [], failed: [], secrets: [] };
  return {
    log,
    all: () => [...log.info, ...log.notice, ...log.warning, ...log.failed].join('\n'),
    getInput: (name, opts = {}) => {
      const v = inputs[name] === undefined ? '' : String(inputs[name]);
      if (opts.required && v.trim() === '') {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return v;
    },
    getBooleanInput: (name) => String(inputs[name] || 'false') === 'true',
    setOutput: (k, v) => { log.outputs[k] = v; },
    saveState: (k, v) => { log.state[k] = v; },
    getState: (k) => log.state[k] || '',
    setSecret: (s) => log.secrets.push(s),
    info: (m) => log.info.push(m),
    notice: (m) => log.notice.push(m),
    warning: (m) => log.warning.push(m),
    setFailed: (m) => log.failed.push(m),
  };
}

module.exports = { fakeIO };
