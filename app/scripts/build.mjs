// scripts/build.mjs — bundles the renderer and copies the static shell into dist/.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'renderer'), { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'renderer', 'renderer.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outfile: join(out, 'renderer', 'renderer.js'),
  logLevel: 'warning',
});

// Both HTML shells are templates: the CSP nonce is injected at load time by the
// main process, so the pages themselves need no inline code.
for (const file of ['index.html', 'styles.css']) {
  await cp(join(root, 'src', 'renderer', file), join(out, 'renderer', file));
}

// The playback window ships with the app as-is: it is tiny and has no bundling
// needs beyond the preload that the main process already references.
await cp(join(root, 'src', 'audio-window'), join(out, 'audio-window'), { recursive: true });
await cp(join(root, 'src', 'audio-preload.cjs'), join(out, 'audio-preload.cjs'));

console.log('built dist/renderer');
