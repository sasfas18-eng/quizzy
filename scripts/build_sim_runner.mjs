// node scripts/build_sim_runner.mjs <out-dir>  — the page every simulator link opens (share/sim/index.html on the site): the same for every exam, the exam
// travels in the link's #part. Built from frontend/js/sim_core.js, so the students' page is exactly the simulator the owner's page runs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { pageHtml } = await import(pathToFileURL(join(root, 'frontend/js/sim_core.js')).href);
const out = process.argv[2]; if (!out) { console.error('usage: node scripts/build_sim_runner.mjs <out-dir>'); process.exit(2); }
mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'index.html'), pageHtml('Exam Simulator', null));
writeFileSync(join(out, 'publish.html'), pageHtml('Publish', null, 'publisher'));      // the owner's publish page (short links)
console.log('built', join(out, 'index.html'), join(out, 'publish.html'));
