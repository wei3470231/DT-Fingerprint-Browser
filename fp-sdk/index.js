let viewModule = {};
let automationModule = {};
try {
  viewModule = require('./lib/view');
} catch {}
try {
  automationModule = require('./lib/automation');
} catch {}

module.exports = {
  ...viewModule,
  ...require('./lib/fp-generator'),
  ...automationModule,
};
