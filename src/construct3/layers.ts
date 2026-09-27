/**
 * Layer trees of Construct 3 layouts.
 *
 * Editor-saved layouts nest layers: every layer has a "subLayers" array (empty
 * when it has none) whose entries are layers of the same shape (name, sid,
 * instances, subLayers, ...), to any depth. Checked against editor-saved
 * projects: every layer has the "subLayers" array, sub-layers carry the same
 * keys as top-level layers and their instances the same keys as other world
 * instances, and no layer name repeats anywhere in a layout's tree.
 *
 * Everything that looks up, counts, allocates or indexes layers and instances
 * walks the whole tree through these helpers. The walks are iterative, so a
 * deeply nested (hand-edited) file cannot overflow the stack.
 */

import type { Instance, Layer, Layout } from './types.js';
import { nameKey } from './names.js';

/** A layer in a layout's layer tree, with where it sits. */
export interface LayerEntry {
  layer: Layer;
  /** The entry of the layer this one is a sub-layer of; undefined for the layout's own layers */
  parent?: LayerEntry;
  /** 0 for the layout's own layers, 1 for their sub-layers, ... */
  depth: number;
  /** The array that holds the layer (layout.layers or the parent's subLayers) */
  siblings: Layer[];
  /** Position of the layer in `siblings` */
  index: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every layer of a layer tree (pass layout.layers), sub-layers included, in
 * file order: each layer comes before its sub-layers. Entries that are not
 * objects are skipped.
 */
export function layerEntries(layers: unknown): LayerEntry[] {
  const out: LayerEntry[] = [];
  const stack: Array<{ siblings: unknown[]; index: number; parent?: LayerEntry; depth: number }> = [];
  const pushChildren = (siblings: unknown, parent: LayerEntry | undefined, depth: number) => {
    if (!Array.isArray(siblings)) return;
    for (let i = siblings.length - 1; i >= 0; i--) stack.push({ siblings, index: i, parent, depth });
  };
  pushChildren(layers, undefined, 0);
  while (stack.length > 0) {
    const { siblings, index, parent, depth } = stack.pop()!;
    const layer = siblings[index];
    if (!isRecord(layer)) continue;
    const entry: LayerEntry = { layer: layer as Layer, depth, siblings: siblings as Layer[], index };
    if (parent) entry.parent = parent;
    out.push(entry);
    pushChildren(layer.subLayers, entry, depth + 1);
  }
  return out;
}

/** Every layer of a layer tree, sub-layers included (see layerEntries). */
export function allLayers(layers: unknown): Layer[] {
  return layerEntries(layers).map(e => e.layer);
}

/** Layer names from the top-level layer down to this one. */
export function layerPath(entry: LayerEntry): string[] {
  const names: string[] = [];
  for (let e: LayerEntry | undefined = entry; e; e = e.parent) names.push(String(e.layer.name));
  return names.reverse();
}

const pathLabels = new WeakMap<LayerEntry, string>();

/** A layer's position in the tree for messages: "Main > HUD > Buttons" (cached per entry). */
export function layerPathLabel(entry: LayerEntry): string {
  let label = pathLabels.get(entry);
  if (label === undefined) {
    label = layerPath(entry).join(' > ');
    pathLabels.set(entry, label);
  }
  return label;
}

/** The layers with this exact name anywhere in the tree (normally at most one). */
export function findLayersByName(layers: unknown, name: string): LayerEntry[] {
  return layerEntries(layers).filter(e => e.layer.name === name);
}

/**
 * Comparison key for layer names: the shared name key of names.ts
 * (Unicode-normalized, NFC, and lowercased). The editor (projectResources.js of
 * release r495.2) looks layer names up over all layers of a layout, sub-layers
 * included, with normalize().toLowerCase(): it refuses a layer name that another
 * layer of the layout uses ignoring case, and cannot load a layout with two such
 * layers.
 */
export function layerNameKey(name: string): string {
  return nameKey(name);
}

/**
 * The layer anywhere in the tree whose name is `name` or differs from it only
 * in case (an exact match first), leaving out `except`; undefined when the name
 * is free.
 */
export function findLayerNameClash(layers: unknown, name: string, except?: Layer): LayerEntry | undefined {
  const key = layerNameKey(name);
  let clash: LayerEntry | undefined;
  for (const entry of layerEntries(layers)) {
    if (entry.layer === except || typeof entry.layer.name !== 'string') continue;
    if (entry.layer.name === name) return entry;
    if (clash === undefined && layerNameKey(entry.layer.name) === key) clash = entry;
  }
  return clash;
}

/** Groups of two or more layers in the tree whose names are the same ignoring case, in file order. */
export function repeatedLayerNames(layers: unknown): LayerEntry[][] {
  const byKey = new Map<string, LayerEntry[]>();
  for (const entry of layerEntries(layers)) {
    if (typeof entry.layer.name !== 'string') continue;
    const key = layerNameKey(entry.layer.name);
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  return [...byKey.values()].filter(group => group.length > 1);
}

/** The instances directly on one layer (not its sub-layers); entries that are not objects are skipped. */
export function instancesOf(layer: Layer): Instance[] {
  return Array.isArray(layer.instances) ? layer.instances.filter(isRecord) as Instance[] : [];
}

/** Call `visit` for every instance on the given layers and their sub-layers. */
export function forEachLayerInstance(layers: unknown, visit: (instance: Instance, entry: LayerEntry) => void): void {
  for (const entry of layerEntries(layers)) {
    for (const instance of instancesOf(entry.layer)) visit(instance, entry);
  }
}

/** The layout's non-world instances ("nonworld-instances", e.g. Array, Dictionary). */
export function nonWorldInstances(layout: Layout): Instance[] {
  const list = layout['nonworld-instances'];
  return Array.isArray(list) ? list.filter(isRecord) as Instance[] : [];
}

/**
 * Call `visit` for every instance of a layout: on every layer and sub-layer
 * (with its layer entry), then the non-world instances (entry undefined).
 */
export function forEachLayoutInstance(layout: Layout, visit: (instance: Instance, entry: LayerEntry | undefined) => void): void {
  forEachLayerInstance(layout.layers, visit);
  for (const instance of nonWorldInstances(layout)) visit(instance, undefined);
}

/** Number of instances on a layer and all of its sub-layers. */
export function countInstancesInLayerTree(layer: Layer): number {
  let count = 0;
  forEachLayerInstance([layer], () => { count++; });
  return count;
}

/** Where an instance with a given UID sits in a layout. */
export interface InstanceLocation {
  instance: Instance;
  /** The array that holds it (a layer's instances or the non-world instances) */
  list: Instance[];
  index: number;
  /** Its layer; undefined for a non-world instance */
  entry?: LayerEntry;
}

/**
 * The first instance with this UID in a layout: on any layer or sub-layer (in
 * file order), then among the non-world instances.
 */
export function findInstanceByUid(layout: Layout, uid: number): InstanceLocation | undefined {
  for (const entry of layerEntries(layout.layers)) {
    const list = entry.layer.instances;
    if (!Array.isArray(list)) continue;
    const index = list.findIndex(inst => isRecord(inst) && inst.uid === uid);
    if (index !== -1) return { instance: list[index], list, index, entry };
  }
  const nonworld = layout['nonworld-instances'];
  if (Array.isArray(nonworld)) {
    const index = nonworld.findIndex(inst => isRecord(inst) && inst.uid === uid);
    if (index !== -1) return { instance: nonworld[index] as Instance, list: nonworld as Instance[], index };
  }
  return undefined;
}
