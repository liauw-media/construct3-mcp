/**
 * A fake Construct HTML5 export for the live browser tests: a page with a
 * canvas, a stand-in for the runtime's scripting interface (runOnStartup,
 * globalVars, objects, layouts with layerToCssPx, the tick event) and the
 * real generated bridge script. The DOM variant runs the runtime on the
 * page; the worker variant runs it in a dedicated worker, as Construct does
 * with "Use worker" on.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBridgeScript } from '../../src/runtime/bridge.js';

const FAKE_RUNTIME = `(function () {
  const g = globalThis;
  const startup = [];
  g.runOnStartup = (cb) => startup.push(cb);
  const listeners = { tick: [] };
  const layer = (name, index) => ({
    name, index, isVisible: true, opacity: 1,
    layerToCssPx(x, y) { return [100 + x / 2, 50 + y / 2]; },
    cssPxToLayer(x, y) { return [(x - 100) * 2, (y - 50) * 2]; },
  });
  const layout = (name) => {
    const layers = [layer('Background', 0), layer('HUD', 1)];
    return { name, width: 1280, height: 720, getAllLayers: () => layers,
      getLayer: (key) => typeof key === 'number' ? layers[key] : layers.find((l) => l.name === key) };
  };
  const player = { x: 10, y: 20, width: 32, height: 32, isVisible: true, opacity: 1, uid: 7, instVars: { hp: 100 }, behaviors: {} };
  const runtime = {
    globalVars: { Score: 0, GameState: 'INIT' },
    objects: { Player: { getFirstInstance: () => player, getAllInstances: () => [player] } },
    layout: layout('Title'),
    tickCount: 0, gameTime: 0, dt: 0.016,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    callFunction(name, ...params) {
      if (name === 'Add') return params[0] + params[1];
      if (name === 'Bonus') { g.__c3bridge.emit('Bonus', { n: params[0] }); return 1; }
      throw new Error('No function ' + name);
    },
    goToLayout(name) { this.layout = layout(name); },
  };
  g.__fakeRuntime = runtime;
  g.__pauseTicks = false;
  const tick = () => {
    if (g.__pauseTicks) return;
    runtime.tickCount++;
    runtime.gameTime += runtime.dt;
    for (const fn of listeners.tick) fn();
  };
  g.__startFake = async () => {
    for (const cb of startup) await cb(runtime);
    if (typeof requestAnimationFrame === 'function') {
      const loop = () => { tick(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    } else {
      setInterval(tick, 16);
    }
  };
})();
`;

const INPUT_LOG = `globalThis.__log = [];
for (const type of ['keydown', 'keyup', 'keypress', 'input', 'pointerdown', 'pointerup', 'click', 'touchstart', 'touchend'])
  addEventListener(type, (e) => __log.push({ type, key: e.key, code: e.code, keyCode: e.keyCode, shiftKey: e.shiftKey, x: e.clientX, y: e.clientY }), true);
const canvas = document.querySelector('canvas');
globalThis.__noise = (w, h) => {
  canvas.width = w; canvas.height = h; canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let o = 0; o < img.data.length; o += 65536) crypto.getRandomValues(img.data.subarray(o, Math.min(o + 65536, img.data.length)));
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  ctx.putImageData(img, 0, 0);
  return img.data.length;
};`;

const STYLE = '<style>body{margin:0} canvas{position:absolute;left:100px;top:50px;width:640px;height:360px}</style>';

export type FakeExportMode = 'dom' | 'worker';

/** Write a fake export to a new temporary folder and return the folder. */
export async function writeFakeExport(mode: FakeExportMode, parent = tmpdir()): Promise<string> {
  const folder = await mkdtemp(join(parent, `c3mcp-fake-export-${mode}-`));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'fake-runtime.js'), FAKE_RUNTIME);
  await writeFile(join(folder, 'bridge.js'), generateBridgeScript());
  if (mode === 'dom') {
    await writeFile(join(folder, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>fake c3 dom</title>${STYLE}</head>
<body><canvas width="640" height="360"></canvas>
<script>${INPUT_LOG}</script>
<script src="fake-runtime.js"></script>
<script src="bridge.js"></script>
<script>__startFake();</script>
</body></html>`);
  } else {
    await writeFile(join(folder, 'worker.js'), `importScripts('fake-runtime.js', 'bridge.js');
__startFake().then(() => postMessage('ready'));
`);
    await writeFile(join(folder, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>fake c3 worker</title>${STYLE}</head>
<body><canvas width="640" height="360"></canvas>
<script>${INPUT_LOG}
globalThis.__worker = new Worker('worker.js');
__worker.onmessage = (e) => { globalThis.__workerMessage = e.data; };</script>
</body></html>`);
  }
  return folder;
}
