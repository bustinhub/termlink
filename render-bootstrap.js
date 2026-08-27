const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, 'src');
const launcher = path.join(srcDir, 'server.js');

fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(
  launcher,
  "// Auto-generated during install for legacy Render start commands.\nrequire('../server.js');\n",
  'utf8'
);

console.log('[render-bootstrap] Created src/server.js compatibility launcher.');
