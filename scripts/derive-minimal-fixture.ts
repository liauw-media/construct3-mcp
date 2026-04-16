// scripts/derive-minimal-fixture.ts
// Derive a C3-loadable minimal fixture by pruning a known-good seed project.
//
// Two-stage:
//   Stage 1: drop three third-party addons + their object types + all manifest
//            refs. Proves C3 accepts the pruned output. (~92 MB, slot-IP inside.)
//   Stage 2: drop all object types, all non-Start layouts, all non-MainSheet
//            sheets, clear all image/sound refs, sanitize metadata. Empty-layout
//            fixture suitable for OSS repo.
//
// Usage:
//   npx tsx scripts/derive-minimal-fixture.ts            # Stage 2 (default)
//   npx tsx scripts/derive-minimal-fixture.ts --stage1   # Stage 1 only

import { join } from 'path';
import {
  existsSync, statSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync,
  readdirSync, unlinkSync,
} from 'fs';

import { Construct3ProjectReader } from '../src/construct3/project-reader.js';
import { Construct3ProjectWriter } from '../src/construct3/project-writer.js';
import { IdGenerator } from '../src/construct3/id-generator.js';
import { MockServer } from '../test/mocks/mock-server.js';
import { registerRuntimeTools } from '../src/tools/runtime-tools.js';
import { generatePlaceholderPng } from '../src/construct3/png-generator.js';

const DROPPED_ADDON_IDS = new Set([
  'Gritsenko_Spine',
  'Omnitronix_PlatformConnect',
  'TegaGame_gates_of_olympus',
]);

interface FolderSlice {
  items: string[];
  subfolders: Array<{ name: string; items: string[]; subfolders: unknown[] }>;
}

function pruneFolder(folder: FolderSlice | undefined, dropped: Set<string>): void {
  if (!folder) return;
  if (Array.isArray(folder.items)) {
    folder.items = folder.items.filter(name => !dropped.has(name));
  }
  if (Array.isArray(folder.subfolders)) {
    for (const sub of folder.subfolders) {
      pruneFolder(sub as unknown as FolderSlice, dropped);
    }
  }
}

async function main() {
  const src = '_test-luckysharky';
  const work = 'test-outputs/c3-derive-work';
  const outPath = 'test-outputs/c3-minimal-derived.c3p';

  if (!existsSync(join(src, 'project.c3proj'))) {
    console.error(`ERROR: ${src}/project.c3proj not found. Run from repo root.`);
    process.exit(1);
  }

  console.log('== Derive minimal fixture (Stage 1: drop third-party addons) ==');
  console.log(`Source: ${src}/`);
  console.log(`Work:   ${work}/`);

  // ── Fresh working copy ────────────────────────────────────────────────────
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  mkdirSync('test-outputs', { recursive: true });
  cpSync(src, work, { recursive: true });

  // ── Identify dropped objectTypes (those whose plugin-id is dropped) ──────
  const objDir = join(work, 'objectTypes');
  const dropped = new Set<string>();
  for (const fname of readdirSync(objDir)) {
    if (!fname.endsWith('.json')) continue;
    const raw = readFileSync(join(objDir, fname), 'utf-8');
    let j: any;
    try { j = JSON.parse(raw); } catch { continue; }
    const pid = j?.['plugin-id'] ?? j?.pluginId;
    if (typeof pid === 'string' && DROPPED_ADDON_IDS.has(pid)) {
      const name = j?.name ?? fname.replace(/\.json$/, '');
      dropped.add(name);
    }
  }
  console.log(`Dropping ${dropped.size} objectTypes backed by third-party plugins.`);

  // ── Delete dropped objectType JSON files + their animations/image folders ─
  for (const fname of readdirSync(objDir)) {
    if (!fname.endsWith('.json')) continue;
    const base = fname.replace(/\.json$/, '');
    if (dropped.has(base)) {
      unlinkSync(join(objDir, fname));
    }
  }

  // Drop matching image folders (e.g. images/spine_a-default/)
  const imgDir = join(work, 'images');
  if (existsSync(imgDir)) {
    for (const sub of readdirSync(imgDir)) {
      const stat = statSync(join(imgDir, sub));
      if (!stat.isDirectory()) continue;
      // animation folders are named "<objectType>-<animationName>"
      const prefix = sub.split('-')[0];
      if (dropped.has(prefix)) {
        rmSync(join(imgDir, sub), { recursive: true, force: true });
      }
    }
  }

  // Spine file bundles live in files/Spine/ — drop whole folder
  const spineDir = join(work, 'files', 'Spine');
  if (existsSync(spineDir)) {
    console.log('Dropping files/Spine/ tree.');
    rmSync(spineDir, { recursive: true, force: true });
  }

  // ── Rewrite project.c3proj ────────────────────────────────────────────────
  const c3projPath = join(work, 'project.c3proj');
  const c3proj: any = JSON.parse(readFileSync(c3projPath, 'utf-8'));

  // Filter usedAddons
  if (Array.isArray(c3proj.usedAddons)) {
    const before = c3proj.usedAddons.length;
    c3proj.usedAddons = c3proj.usedAddons.filter((a: any) => !DROPPED_ADDON_IDS.has(a?.id));
    console.log(`usedAddons: ${before} → ${c3proj.usedAddons.length}`);
  }

  // Prune objectTypes folder tree
  pruneFolder(c3proj.objectTypes, dropped);

  // Prune rootFileFolders.general for the Spine subfolder (we deleted files/Spine/).
  // C3's loader walks this manifest and errors "missing file path 'files\Spine\ls_a.json'"
  // if we keep the manifest entries without the files.
  const general = c3proj.rootFileFolders?.general;
  if (general?.subfolders) {
    const before = general.subfolders.length;
    general.subfolders = general.subfolders.filter((s: any) =>
      s?.name?.toLowerCase() !== 'spine'
    );
    console.log(`rootFileFolders.general.subfolders: ${before} → ${general.subfolders.length}`);
  }

  // Prune families: drop families whose plugin-id matches, or whose members become empty
  if (c3proj.families && typeof c3proj.families === 'object') {
    const famDir = join(work, 'families');
    const droppedFamilies = new Set<string>();
    if (existsSync(famDir)) {
      for (const fname of readdirSync(famDir)) {
        if (!fname.endsWith('.json')) continue;
        const famPath = join(famDir, fname);
        const fam: any = JSON.parse(readFileSync(famPath, 'utf-8'));
        const pid = fam?.['plugin-id'] ?? fam?.pluginId;
        if (typeof pid === 'string' && DROPPED_ADDON_IDS.has(pid)) {
          droppedFamilies.add(fam?.name ?? fname.replace(/\.json$/, ''));
          unlinkSync(famPath);
          continue;
        }
        // Prune member list
        if (Array.isArray(fam?.members)) {
          const before = fam.members.length;
          fam.members = fam.members.filter((m: string) => !dropped.has(m));
          if (fam.members.length !== before) {
            writeFileSync(famPath, JSON.stringify(fam, null, '\t'), 'utf-8');
          }
          if (fam.members.length === 0) {
            droppedFamilies.add(fam.name ?? fname.replace(/\.json$/, ''));
            unlinkSync(famPath);
          }
        }
      }
    }
    pruneFolder(c3proj.families, droppedFamilies);
    console.log(`Families dropped: ${droppedFamilies.size}`);
  }

  // Walk layouts, filter instances whose type is dropped
  const layDir = join(work, 'layouts');
  let instancesDropped = 0;
  if (existsSync(layDir)) {
    for (const fname of readdirSync(layDir)) {
      if (!fname.endsWith('.json') || fname.endsWith('.uistate.json')) continue;
      const p = join(layDir, fname);
      const lay: any = JSON.parse(readFileSync(p, 'utf-8'));
      let changed = false;
      if (Array.isArray(lay?.layers)) {
        for (const layer of lay.layers) {
          if (Array.isArray(layer?.instances)) {
            const before = layer.instances.length;
            layer.instances = layer.instances.filter((i: any) => !dropped.has(i?.type));
            if (layer.instances.length !== before) {
              changed = true;
              instancesDropped += before - layer.instances.length;
            }
          }
        }
      }
      if (changed) writeFileSync(p, JSON.stringify(lay, null, '\t'), 'utf-8');
    }
  }
  console.log(`Layout instances filtered: ${instancesDropped}`);

  // Event sheets: conditions/actions reference objectClass by name. If any
  // surviving sheet has a condition/action on a dropped type, C3 halts with
  // "cannot find object 'X'". Safest cleanup: empty events[] in every sheet,
  // keeping the file shell (name, sid, kebab-case fields) so the project graph
  // still resolves eventSheets.items references.
  let sheetsCleared = 0;
  const shDir = join(work, 'eventSheets');
  if (existsSync(shDir)) {
    for (const fname of readdirSync(shDir)) {
      if (!fname.endsWith('.json')) continue;
      const p = join(shDir, fname);
      const sh: any = JSON.parse(readFileSync(p, 'utf-8'));
      if (Array.isArray(sh?.events) && sh.events.length > 0) {
        sh.events = [];
        writeFileSync(p, JSON.stringify(sh, null, '\t'), 'utf-8');
        sheetsCleared++;
      }
    }
  }
  console.log(`Event sheets emptied: ${sheetsCleared}`);

  // Containers may list dropped objectTypes as members. Prune.
  if (Array.isArray(c3proj.containers)) {
    let containerMembersRemoved = 0;
    for (const c of c3proj.containers) {
      if (Array.isArray(c?.members)) {
        const before = c.members.length;
        c.members = c.members.filter((m: string) => !dropped.has(m));
        containerMembersRemoved += before - c.members.length;
      }
    }
    if (containerMembersRemoved > 0) {
      console.log(`Container members removed: ${containerMembersRemoved}`);
    }
  }

  // Rename project + sanitize identifying properties
  c3proj.name = 'C3 Minimal Base';
  if (c3proj.properties) {
    c3proj.properties.name = 'C3 Minimal Base';
    c3proj.properties.description = 'Minimal C3 test fixture for construct3-mcp.';
    c3proj.properties.author = 'construct3-mcp';
    c3proj.properties.authorEmail = '';
    c3proj.properties.authorWebsite = '';
    c3proj.properties.appId = 'net.construct3-mcp.minimal';
  }

  // ── Stage 2: aggressive prune for OSS-committable fixture ────────────────
  const stage2 = !process.argv.includes('--stage1');
  if (stage2) {
    console.log('');
    console.log('== Stage 2: aggressive prune (keep only Start + MainSheet) ==');

    const keepLayout = 'Start';
    const keepSheet = 'MainSheet';

    // Drop all objectTypes (recursively — subfolders like objectTypes/Array/
    // hold plugin-type-grouped JSONs in real projects)
    let objectTypesDropped = 0;
    const walkObj = (dir: string): void => {
      for (const fname of readdirSync(dir)) {
        const p = join(dir, fname);
        if (statSync(p).isDirectory()) {
          walkObj(p);
          rmSync(p, { recursive: true, force: true });
        } else if (fname.endsWith('.json')) {
          unlinkSync(p);
          objectTypesDropped++;
        }
      }
    };
    walkObj(objDir);
    console.log(`Dropped ${objectTypesDropped} objectTypes (kept 0)`);
    // Empty objectTypes tree in manifest
    c3proj.objectTypes = { items: [], subfolders: [] };

    // Drop all families
    const famDir = join(work, 'families');
    if (existsSync(famDir)) {
      let famCount = 0;
      for (const fname of readdirSync(famDir)) {
        if (!fname.endsWith('.json')) continue;
        unlinkSync(join(famDir, fname));
        famCount++;
      }
      if (famCount > 0) console.log(`Dropped ${famCount} families`);
    }
    c3proj.families = { items: [], subfolders: [] };

    // Drop all containers
    if (Array.isArray(c3proj.containers) && c3proj.containers.length > 0) {
      console.log(`Dropped ${c3proj.containers.length} containers`);
      c3proj.containers = [];
    }

    // Drop all layouts except keepLayout
    let layoutsRemoved = 0;
    for (const fname of readdirSync(layDir)) {
      const base = fname.replace(/\.uistate\.json$/, '').replace(/\.json$/, '');
      if (base !== keepLayout) {
        unlinkSync(join(layDir, fname));
        if (fname.endsWith('.json') && !fname.endsWith('.uistate.json')) layoutsRemoved++;
      }
    }
    console.log(`Dropped ${layoutsRemoved} layouts (kept: ${keepLayout})`);
    pruneFolder(c3proj.layouts, new Set(
      Array.from({ length: 0 }, () => '')
    ));
    // Replace layouts tree with a keep-list filter
    const keepLayoutsSet = new Set([keepLayout]);
    const filterFolder = (f: any) => {
      if (!f) return;
      if (Array.isArray(f.items)) f.items = f.items.filter((n: string) => keepLayoutsSet.has(n));
      if (Array.isArray(f.subfolders)) f.subfolders.forEach(filterFolder);
    };
    filterFolder(c3proj.layouts);

    // Empty Start layout instances + set viewport to something neutral
    const startPath = join(layDir, `${keepLayout}.json`);
    if (existsSync(startPath)) {
      const start: any = JSON.parse(readFileSync(startPath, 'utf-8'));
      if (Array.isArray(start?.layers)) {
        for (const layer of start.layers) {
          layer.instances = [];
        }
      }
      writeFileSync(startPath, JSON.stringify(start, null, '\t'), 'utf-8');
    }

    // Drop all event sheets except keepSheet
    let sheetsRemoved = 0;
    for (const fname of readdirSync(shDir)) {
      const base = fname.replace(/\.json$/, '');
      if (base !== keepSheet) {
        unlinkSync(join(shDir, fname));
        sheetsRemoved++;
      }
    }
    console.log(`Dropped ${sheetsRemoved} event sheets (kept: ${keepSheet})`);
    const keepSheetsSet = new Set([keepSheet]);
    const filterSheetFolder = (f: any) => {
      if (!f) return;
      if (Array.isArray(f.items)) f.items = f.items.filter((n: string) => keepSheetsSet.has(n));
      if (Array.isArray(f.subfolders)) f.subfolders.forEach(filterSheetFolder);
    };
    filterSheetFolder(c3proj.eventSheets);

    // Strip MainSheet includes (they pointed at dropped sheets)
    const mainPath = join(shDir, `${keepSheet}.json`);
    if (existsSync(mainPath)) {
      const main: any = JSON.parse(readFileSync(mainPath, 'utf-8'));
      main.events = [];
      writeFileSync(mainPath, JSON.stringify(main, null, '\t'), 'utf-8');
    }

    // Drop all timelines (items + files) — none referenced after layout prune
    const tlDir = join(work, 'timelines');
    if (existsSync(tlDir)) {
      rmSync(tlDir, { recursive: true, force: true });
    }
    c3proj.timelines = { items: [], subfolders: [] };

    // Drop all images — nothing references them now
    if (existsSync(imgDir)) {
      rmSync(imgDir, { recursive: true, force: true });
    }

    // Drop all sounds/music/fonts/files content
    for (const dirName of ['sounds', 'music', 'fonts', 'files']) {
      const d = join(work, dirName);
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }

    // Clear all rootFileFolders except icon + script
    const rff = c3proj.rootFileFolders;
    if (rff) {
      for (const key of ['sound', 'music', 'video', 'font', 'general']) {
        if (rff[key]) {
          rff[key].items = [];
          rff[key].subfolders = [];
        }
      }
      // Keep script folder intact — it may have the runtime bridge reference
    }

    // Set firstLayout, drop firstLayout if pointing elsewhere
    if (c3proj.properties) {
      c3proj.properties.firstLayout = keepLayout;
      c3proj.properties.useLoaderLayout = false;
    }

    // Replace icon PNGs with placeholder 1×1 transparent PNGs (icons from the
    // seed project carry slot branding; C3 only needs their presence).
    const icoDir = join(work, 'icons');
    if (existsSync(icoDir)) {
      const placeholder = generatePlaceholderPng(1, 1);
      for (const fname of readdirSync(icoDir)) {
        if (fname.endsWith('.png')) {
          writeFileSync(join(icoDir, fname), placeholder);
        }
      }
      console.log('Icons replaced with 1×1 placeholder PNGs');
    }

    // Remove cruft: .git/, README.md, *.uistate.json (editor cache, C3 regenerates)
    for (const cruft of ['.git', 'README.md', 'project.uistate.json',
                         'objecttypes.uistate.json', 'projectfiles.uistate.json',
                         '.gitignore']) {
      const p = join(work, cruft);
      if (existsSync(p)) {
        const st = statSync(p);
        if (st.isDirectory()) rmSync(p, { recursive: true, force: true });
        else unlinkSync(p);
      }
    }
    // And any .uistate.json under layouts/
    for (const fname of readdirSync(layDir)) {
      if (fname.endsWith('.uistate.json')) unlinkSync(join(layDir, fname));
    }
  }

  writeFileSync(c3projPath, JSON.stringify(c3proj, null, '\t'), 'utf-8');

  // ── Re-read via our Reader to sanity-check, then pack via our Writer ──────
  const reader = new Construct3ProjectReader(c3projPath);
  await reader.loadProject();
  console.log(`Reader OK: project name = "${reader.projectData?.name}"`);
  console.log(`           layouts = ${reader.projectData?.layouts.items.length}`);
  console.log(`           eventSheets = ${reader.projectData?.eventSheets.items.length}`);
  console.log(`           objectTypes = ${reader.projectData?.objectTypes.items.length}`);

  const idGen = new IdGenerator();
  await idGen.initialize(reader);
  const writer = new Construct3ProjectWriter(reader, idGen);
  const server = new MockServer();
  registerRuntimeTools({ server, reader, writer, idGen } as any);

  const packResult = await server.callTool('pack_project', {
    outputPath: outPath,
    injectBridge: false,
  });
  if (packResult.isError) {
    console.error('pack_project FAILED:', packResult.content[0]?.text);
    process.exit(1);
  }
  const parsed = JSON.parse(packResult.content[0].text);
  console.log('');
  console.log('== Pack result ==');
  console.log(JSON.stringify(parsed, null, 2));

  const sz = statSync(outPath);
  console.log('');
  console.log(`Output: ${outPath} (${(sz.size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch(e => {
  console.error('FAILURE:', e);
  process.exit(1);
});
