// Buildless: copy an explicit allowlist from the tested source, never user data.
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const files = ['index.html', 'styles.css', 'app.mjs', 'core.mjs', 'favicon.svg', 'wiki-core.mjs', 'wiki-ui.mjs', 'wiki.css'];
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(root, 'dist', file));
const actual = fs.readdirSync(path.join(root, 'dist'));
if (actual.some((file) => !files.includes(file))) throw Error('Unexpected file in static output; review before publication.');
console.log(`Prepared ${files.length} public static assets; no browser data or test artifacts.`);
