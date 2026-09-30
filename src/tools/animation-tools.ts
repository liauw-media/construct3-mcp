/**
 * Animation tools: add_animation_to_sprite, update_animation_properties,
 * delete_animation, rename_animation, add_frame_to_animation,
 * delete_frame_from_animation, update_frame, replace_sprite_image.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectType, Animation, AnimationFrame } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { findNameClash } from '../construct3/names.js';
import { createAnimation, createAnimationFrame } from '../construct3/templates.js';
import { describeCharacter, getImageFileName, invalidImageNameCharacter } from '../construct3/png-generator.js';
import { resolveProjectPath } from '../construct3/path-utils.js';
import { EntityWriteError } from '../construct3/project-writer.js';
import {
  animationsSharingImageFiles,
  countAnimationNameParameters,
  describeAvailableAnimations,
  everyAnimation,
  familiesContaining,
  findAnimation,
  planFrameImageRenames,
  planFrameImageShift,
  renameInitialAnimation,
} from '../construct3/animation-rename.js';
import type { FrameImageShiftPlan, ImageFileRename } from '../construct3/animation-rename.js';
import {
  checkUnscannedFiles,
  describeUnscannedFile,
  unscannedFields,
  unscannedFilesOf,
  unscannedWarnings,
  type UnscannedFile,
  type UnscannedFileReport,
} from '../construct3/analyzers/unscanned-uses.js';
import { nameTerm } from '../construct3/raw-text-search.js';
import { withProjectSync } from './project-sync.js';

export function registerAnimationTools({ server: mcpServer, reader, writer, idGen }: MutationToolDeps) {
  const server = withProjectSync(mcpServer, reader);
  // Every animation tool reads a Sprite's object file and writes it back, and
  // several rename or write frame image files, whose names hold the frame
  // index: they run one at a time (see withAnimationLock)
  const oneAtATime = <A, R>(handler: (args: A) => Promise<R>) =>
    (args: A): Promise<R> => writer.withAnimationLock(() => handler(args));

  // ─── add_animation_to_sprite ──────────────────────────────

  server.tool(
    'add_animation_to_sprite',
    'Add a new animation to a Sprite object',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name (e.g., "Idle", "Walk", "Jump")'),
      speed: z.number().min(0).optional().default(5).describe('Frames per second (default: 5)'),
      isLooping: z.boolean().optional().default(true).describe('Loop the animation (default: true)'),
      isPingPong: z.boolean().optional().default(false).describe('Ping-pong playback (default: false)'),
      repeatCount: z.number().int().min(1).optional().default(1).describe('Repeat count if not looping (default: 1)'),
      frameCount: z.number().int().min(1).max(100).optional().default(1).describe('Number of blank frames to create (default: 1)'),
      frameWidth: z.number().int().positive().optional().describe('Frame width in pixels (default: existing sprite width)'),
      frameHeight: z.number().int().positive().optional().describe('Frame height in pixels (default: existing sprite height)'),
    },
    oneAtATime(async (args) => {
      try {
        // Read existing object
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        // Verify it's a Sprite
        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is a "${obj['plugin-id']}" plugin, not a Sprite. Only Sprite objects have animations.`);
        }

        // Navigate to animations.items
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure. It may be corrupted.`);
        }
        const animItems = obj.animations.items;
        // Animations in animation folders too: their image file names do not
        // contain the folder, so a new animation of the same name would write
        // its placeholder images over theirs
        const allAnims = everyAnimation<Animation>(obj.animations);

        // Check for a duplicate animation name in any animation folder. The editor
        // compares animation names ignoring case, and image file names are the
        // lowercased object and animation names, so a case variant would write its
        // placeholder images over the existing animation's images
        const nameClash = findNameClash(args.animationName, animationNames(allAnims));
        if (nameClash === args.animationName) {
          return toolError(`Animation "${args.animationName}" already exists on "${args.objectName}". Use update_animation_properties to modify it.`);
        }
        if (nameClash) {
          return toolError(animationCaseClashError(args.objectName, args.animationName, nameClash));
        }
        const nameError = animationNameFileError(args.animationName);
        if (nameError) return toolError(nameError);

        // Determine frame dimensions from existing animation if not specified
        let frameWidth = args.frameWidth ?? 100;
        let frameHeight = args.frameHeight ?? 100;
        if ((!args.frameWidth || !args.frameHeight) && allAnims.length > 0) {
          const existingFrames = Array.isArray(allAnims[0].frames) ? allAnims[0].frames : [];
          if (existingFrames.length > 0) {
            if (!args.frameWidth) frameWidth = existingFrames[0].width ?? 100;
            if (!args.frameHeight) frameHeight = existingFrames[0].height ?? 100;
          }
        }

        // Generate frames with imageSpriteIds and write placeholder PNGs
        const frames: AnimationFrame[] = [];
        const imageFiles: Array<{
          objectName: string;
          animationName: string;
          frameIndex: number;
          pluginId: string;
          width: number;
          height: number;
        }> = [];

        for (let i = 0; i < args.frameCount; i++) {
          const imageSpriteId = await idGen.generateImageSpriteId(reader);
          frames.push(createAnimationFrame(frameWidth, frameHeight, imageSpriteId));
          imageFiles.push({
            objectName: args.objectName,
            animationName: args.animationName,
            frameIndex: i,
            pluginId: 'Sprite',
            width: 1,
            height: 1,
          });
        }

        // Write placeholder PNGs before JSON — abort if image write fails
        await writer.writeImageFiles(imageFiles);

        // Generate SID for the animation
        const animSid = await idGen.generateSid(reader);

        const anim = createAnimation(
          args.animationName,
          animSid,
          args.speed,
          args.isLooping,
          args.isPingPong,
          args.repeatCount,
          frames,
        );

        animItems.push(anim);

        // Write back
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          generatedSid: animSid,
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_animation_to_sprite] failed:', error);
        return toolError(`Error adding animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── update_animation_properties ──────────────────────────

  server.tool(
    'update_animation_properties',
    'Update properties of an existing animation on a Sprite object',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name to modify'),
      speed: z.number().min(0).optional().describe('New speed (frames per second)'),
      isLooping: z.boolean().optional().describe('New loop setting'),
      isPingPong: z.boolean().optional().describe('New ping-pong setting'),
      repeatCount: z.number().int().min(1).optional().describe('New repeat count'),
    },
    oneAtATime(async (args) => {
      try {
        // Read existing object
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        // Verify it's a Sprite
        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is a "${obj['plugin-id']}" plugin, not a Sprite. Only Sprite objects have animations.`);
        }

        // Navigate to animations.items
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        // Find the target animation (in any animation folder)
        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available animations: ${describeAvailableAnimations(obj.animations)}`);
        }

        // Check at least one property is being updated
        if (args.speed === undefined && args.isLooping === undefined && args.isPingPong === undefined && args.repeatCount === undefined) {
          return toolError('No updates provided. Specify at least one of: speed, isLooping, isPingPong, repeatCount.');
        }

        // Apply updates
        if (args.speed !== undefined) anim.speed = args.speed;
        if (args.isLooping !== undefined) anim.isLooping = args.isLooping;
        if (args.isPingPong !== undefined) anim.isPingPong = args.isPingPong;
        if (args.repeatCount !== undefined) anim.repeatCount = args.repeatCount;

        // Warn: isLooping:true + repeatCount>1 is contradictory — C3 ignores repeatCount when looping.
        const warnings: string[] = [];
        const effectiveLooping = args.isLooping !== undefined ? args.isLooping : anim.isLooping;
        const effectiveRepeat = args.repeatCount !== undefined ? args.repeatCount : anim.repeatCount;
        if (effectiveLooping === true && typeof effectiveRepeat === 'number' && effectiveRepeat > 1) {
          const msg = `isLooping is true but repeatCount is ${effectiveRepeat} — C3 ignores repeatCount when looping is enabled. Set isLooping: false to use repeatCount.`;
          console.warn('[update_animation_properties]', msg);
          warnings.push(msg);
        }

        // Write back
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_animation_properties] failed:', error);
        return toolError(`Error updating animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── delete_animation ─────────────────────────────────────

  server.tool(
    'delete_animation',
    'Delete an animation from a Sprite object (must not be the last animation)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name to delete'),
    },
    oneAtATime(async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite. Only Sprite objects have animations.`);
        }

        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        // The animation can be in an animation folder; it is removed from that folder
        const found = findAnimation<Animation>(obj.animations, args.animationName);
        if (!found) {
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${describeAvailableAnimations(obj.animations)}`);
        }

        if (everyAnimation(obj.animations).length <= 1) {
          return toolError(`Cannot delete the last animation on "${args.objectName}". A Sprite must have at least one animation.`);
        }

        found.items.splice(found.items.indexOf(found.animation), 1);

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_animation] failed:', error);
        return toolError(`Error deleting animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── rename_animation ─────────────────────────────────────

  server.tool(
    'rename_animation',
    'Rename an animation on a Sprite object, together with its frame image files and the "initial-animation" of layout instances that start with it. Layouts that could not be parsed (over the 10MB read limit, not valid JSON) cannot be updated: one whose text names the object and the animation (possibly instances that start with it), or that cannot be read at all, refuses the rename without force (update_blocked); with force the rename goes ahead and a warning names them. Event sheets that could not be parsed and possibly name the animation only get a warning. Such files are listed in unscannedFiles',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Current animation name'),
      newName: z.string().min(1).max(200).describe('New animation name'),
      force: z.boolean().optional().default(false).describe('If true, rename even when layouts that could not be parsed possibly have instances that start with the animation (they are NOT updated)'),
    },
    oneAtATime(async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        // On Windows and macOS the object file is found under a name that
        // differs in case, but layout instances and event sheets name the
        // object exactly, so they would be left naming the old animation
        if (typeof obj.name === 'string' && obj.name !== args.objectName) {
          return toolError(`Object "${args.objectName}" is named "${obj.name}" in the project. Object names are case-sensitive: `
            + `use objectName "${obj.name}". Nothing was changed.`);
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite. Only Sprite objects have animations.`);
        }

        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        // The animation can be in an animation folder, where it stays: its frame
        // image file names do not contain the folder
        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${describeAvailableAnimations(obj.animations)}`);
        }

        // Like the editor: another animation's name (in any animation folder, ignoring
        // case) is taken, changing the case of this one is fine (its lowercase image
        // file names stay the same)
        const others = everyAnimation<Animation>(obj.animations).filter(a => a !== anim);
        const nameClash = args.newName === anim.name ? anim.name : findNameClash(args.newName, animationNames(others));
        if (nameClash === args.newName) {
          return toolError(`Animation "${args.newName}" already exists on "${args.objectName}".`);
        }
        if (nameClash) {
          return toolError(animationCaseClashError(args.objectName, args.newName, nameClash));
        }

        // Construct 3 names the frame image files after the animation
        const nameError = animationNameFileError(args.newName);
        if (nameError) return toolError(nameError);

        // Frame image files, layout instances starting with this animation, and
        // event sheet strings naming it (see animation-rename.ts)
        const oldName = anim.name;
        const frames = Array.isArray(anim.frames) ? anim.frames : [];
        const sharing = animationsSharingImageFiles(obj.animations, anim);
        if (sharing.length > 0 && frames.length > 0) {
          return toolError(`Cannot rename "${oldName}" on "${args.objectName}": animation ${sharing.map(n => `"${n}"`).join(', ')} differs from it only in case, `
            + `so both use the same frame image files (images/${getImageFileName(args.objectName, oldName, 0, 'Sprite')}, …), and renaming them would leave `
            + `${sharing.length > 1 ? 'those animations' : 'that animation'} without images. Nothing was changed. `
            + 'Delete the duplicate first (delete_animation leaves the image files in place), then rename.');
        }
        const images = planFrameImageRenames(await writer.listImageFiles(), args.objectName, oldName, args.newName, frames);
        if (images.clashes.length > 0) {
          return toolError(`Cannot rename "${oldName}" to "${args.newName}" on "${args.objectName}": its frame images would be renamed to `
            + `${someOf(images.clashes.map(f => `images/${f}`), 5)}, which already exist(s). Nothing was changed. `
            + 'Choose another name, or check these files and remove them if nothing uses them.');
        }
        const allLayouts = await reader.readAllLayouts();
        const layoutFailures = reader.getReadFailures('layouts');
        const layoutRefs = [...allLayouts]
          .map(([name, layout]) => ({ name, count: renameInitialAnimation(layout, args.objectName, oldName) }))
          .filter(ref => ref.count > 0);
        // Only used for a warning: conditions and actions of the object and of
        // the families it belongs to that name the animation
        let families: string[] = [];
        try {
          families = familiesContaining(args.objectName, await reader.readAllFamilies());
        } catch {
          // Count the object's own parameters only
        }
        const objectClasses = [args.objectName, ...families];
        let sheetRefs: Array<{ name: string; count: number }> = [];
        let skippedSheets: UnscannedFile[] = [];
        try {
          const sheets = await reader.readAllEventSheets();
          const sheetFailures = reader.getReadFailures('eventSheets');
          sheetRefs = [...sheets]
            .map(([name, sheet]) => ({ name, count: countAnimationNameParameters(sheet, objectClasses, oldName) }))
            .filter(ref => ref.count > 0);
          skippedSheets = unscannedFilesOf('eventSheets', await reader.listEventSheets(), sheets, sheetFailures);
        } catch {
          // Only used for a warning
        }
        // Layouts and event sheets that could not be parsed: their instances are not
        // updated and their parameters not counted, so search their text (issue #55)
        const layoutSearch = await checkUnscannedFiles(
          reader,
          unscannedFilesOf('layouts', await reader.listLayouts(), allLayouts, layoutFailures),
          [{ categories: ['layouts'], allOf: [[nameTerm(args.objectName)], [nameTerm(oldName)]] }],
        );
        const sheetSearch = await checkUnscannedFiles(reader, skippedSheets, [
          { categories: ['eventSheets'], allOf: [objectClasses.map(n => nameTerm(n)), [nameTerm(oldName)]] },
        ]);
        // Instances there that start with the animation would be left naming one that no longer exists
        if (!args.force && layoutSearch.some(r => r.textSearch === 'possible-use' || r.textSearch === 'unreadable')) {
          return toolResult({
            success: false,
            entity: args.objectName,
            category: 'object',
            action: 'update_blocked',
            message: `${renameLayoutRefusal(layoutSearch, args.objectName, oldName)} Nothing was changed. ` +
              'Use force=true to rename anyway (instances in these layouts will NOT be updated).',
            ...unscannedFields([...layoutSearch, ...sheetSearch]),
          });
        }

        anim.name = args.newName;
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);

        // Image files first (renamed back by the writer if one fails), then the
        // object and the layouts; a failure there rolls back everything before
        // it, including the file whose write failed if it was already replaced
        await writer.renameImageFiles(images.renames);
        const written: string[] = [];
        let backupPath: string;
        try {
          backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);
          written.push(backupPath);
          for (const ref of layoutRefs) {
            const layout = await reader.readLayout(ref.name);
            renameInitialAnimation(layout, args.objectName, oldName, args.newName);
            written.push(await writer.writeEntityFile('layouts', ref.name, layout, writer.getSubfolderForEntity('layouts', ref.name)));
          }
        } catch (error) {
          if (error instanceof EntityWriteError) written.push(error.backupPath);
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`${cause}. ${await rollBackAnimationRename(writer, written, images.renames)}`);
        }

        const warnings: string[] = [];
        if (images.renames.length > 0) {
          const [first] = images.renames;
          warnings.push(`Renamed ${images.renames.length} frame image file(s) in images/ ("${first.from}" → "${first.to}"${images.renames.length > 1 ? ', …' : ''}).`);
        }
        if (images.missing.length > 0) {
          warnings.push(`No image file in images/ for ${images.missing.length} frame(s) of "${oldName}" (expected ${someOf(images.missing, 3)}); nothing was renamed for them.`);
        }
        if (layoutRefs.length > 0) {
          const count = layoutRefs.reduce((n, ref) => n + ref.count, 0);
          warnings.push(`Set "initial-animation" to "${args.newName}" on ${count} instance(s) of "${args.objectName}" in layout(s): ${layoutRefs.map(ref => ref.name).join(', ')}.`);
        }
        if (sheetRefs.length > 0) {
          const count = sheetRefs.reduce((n, ref) => n + ref.count, 0);
          const owners = families.length > 0
            ? `"${args.objectName}" and its families (${families.map(f => `"${f}"`).join(', ')})`
            : `"${args.objectName}"`;
          warnings.push(`${count} condition/action parameter(s) of ${owners} still name "${oldName}" as a string, in event sheet(s): `
            + `${sheetRefs.map(ref => ref.name).join(', ')}. rename_animation does not change expressions; update them if they should use "${args.newName}". `
            + 'Parameters that compute an animation name are not counted.');
        }
        warnings.push(...renameUnscannedWarnings(layoutSearch, sheetSearch, args.objectName, oldName));

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
          ...unscannedFields([...layoutSearch, ...sheetSearch]),
        };
        return toolResult(result);
      } catch (error) {
        console.error('[rename_animation] failed:', error);
        return toolError(`Error renaming animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── add_frame_to_animation ───────────────────────────────

  server.tool(
    'add_frame_to_animation',
    'Add a new blank frame (placeholder PNG) to a Sprite animation, at an index or at the end. The image files of the frames '
      + 'after the index move one index up with their frames; an unused file in the way is kept as .bak',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      index: z.number().int().min(0).optional().describe('Insert at this frame index, 0 to the frame count (default: append)'),
      width: z.number().int().positive().optional().describe('Frame width in pixels (default: matches first frame)'),
      height: z.number().int().positive().optional().describe('Frame height in pixels (default: matches first frame)'),
      duration: z.number().positive().optional().default(1).describe('Frame duration in seconds (default: 1)'),
    },
    oneAtATime(async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite.`);
        }
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found. Available: ${describeAvailableAnimations(obj.animations)}`);
        }
        const nameError = animationNameFileError(anim.name, true);
        if (nameError) return toolError(nameError);

        const frameCount = anim.frames.length;
        const insertAt = args.index ?? frameCount;
        if (insertAt > frameCount) {
          return toolError(`Frame index ${insertAt} is out of range. Animation "${anim.name}" has ${frameCount} frame(s): `
            + `insert at an index from 0 to ${frameCount}, or leave index out to append. Nothing was changed.`);
        }

        // Frame image files are named by frame index: the images of the frames
        // from insertAt on move one index up (see animation-rename.ts)
        const imageObjectName = storedObjectName(obj, args.objectName);
        const images = planFrameImageShift(await writer.listImageFiles(), imageObjectName, anim.name, anim.frames, { insertAt });
        if (images.clashes.length > 0) {
          return toolError(`Cannot add a frame at index ${insertAt} to "${anim.name}" on "${args.objectName}": the frame image files `
            + `after it cannot be renamed one index up (${someOf(images.clashes, 3)}). Nothing was changed. Check these files in images/.`);
        }

        // Infer dimensions from first existing frame
        const frameWidth = args.width ?? (anim.frames[0]?.width ?? 100);
        const frameHeight = args.height ?? (anim.frames[0]?.height ?? 100);

        const imageSpriteId = await idGen.generateImageSpriteId(reader);

        const newFrame: AnimationFrame = {
          ...createAnimationFrame(frameWidth, frameHeight, imageSpriteId),
          duration: args.duration,
        };
        anim.frames.splice(insertAt, 0, newFrame);
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);

        // Image files first (renamed back by the writer if one fails), then the
        // placeholder PNG in the freed name, then the object; a failure there
        // undoes everything before it
        if (images.renames.length > 0) await writer.renameImageFiles(images.renames);
        let backupPath: string;
        let otherWrite = false;
        try {
          await writer.writeImageFiles([{
            objectName: imageObjectName,
            animationName: anim.name,
            frameIndex: insertAt,
            pluginId: 'Sprite',
            width: 1,
            height: 1,
          }]);
          backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);
        } catch (error) {
          const kept = await frameChangeAfterOtherWrite(reader, args.objectName, anim.name, error,
            frames => frames.length === frameCount + 1 && frames[insertAt]?.imageSpriteId === imageSpriteId);
          if (kept !== true) {
            const cause = error instanceof Error ? error.message : String(error);
            throw new Error(`${cause}. ${await rollBackFrameChange(writer, error, images.renames, {
              newFrameFile: images.newFrameFile, otherWrite: kept === false,
            })}`);
          }
          backupPath = (error as EntityWriteError).backupPath;
          otherWrite = true;
        }

        const warnings = frameImageWarnings(images, anim.name);
        if (otherWrite) warnings.push(otherWriteKeptWarning('the new frame'));
        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[add_frame_to_animation] failed:', error);
        return toolError(`Error adding frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── delete_frame_from_animation ─────────────────────────

  server.tool(
    'delete_frame_from_animation',
    'Delete a frame from a Sprite animation by index (must not be the last frame). Its image file is kept as .bak, and the '
      + 'image files of the frames after it move one index down',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based frame index to delete'),
    },
    oneAtATime(async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite.`);
        }
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found. Available: ${describeAvailableAnimations(obj.animations)}`);
        }

        if (args.frameIndex >= anim.frames.length) {
          return toolError(`Frame index ${args.frameIndex} is out of range. Animation "${args.animationName}" has ${anim.frames.length} frame(s) (indices 0–${anim.frames.length - 1}).`);
        }

        if (anim.frames.length <= 1) {
          return toolError(`Cannot delete the last frame of animation "${args.animationName}". An animation must have at least one frame.`);
        }

        // Frame image files are named by frame index: the deleted frame's image
        // is kept as .bak, the images of the frames after it move one index
        // down (see animation-rename.ts)
        const images = planFrameImageShift(
          await writer.listImageFiles(), storedObjectName(obj, args.objectName), anim.name, anim.frames, { deleteAt: args.frameIndex },
        );
        if (images.clashes.length > 0) {
          return toolError(`Cannot delete frame ${args.frameIndex} of "${anim.name}" on "${args.objectName}": the frame image files `
            + `after it cannot be renamed one index down (${someOf(images.clashes, 3)}). Nothing was changed. Check these files in images/.`);
        }

        const frameCount = anim.frames.length;
        const deletedId = anim.frames[args.frameIndex]?.imageSpriteId;
        anim.frames.splice(args.frameIndex, 1);
        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);

        // Image files first (renamed back by the writer if one fails), then the
        // object; a failure there renames the image files back
        if (images.renames.length > 0) await writer.renameImageFiles(images.renames);
        let backupPath: string;
        let otherWrite = false;
        try {
          backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);
        } catch (error) {
          const kept = await frameChangeAfterOtherWrite(reader, args.objectName, anim.name, error,
            frames => frames.length === frameCount - 1
              && (deletedId === undefined || !frames.some(frame => frame?.imageSpriteId === deletedId)));
          if (kept !== true) {
            const cause = error instanceof Error ? error.message : String(error);
            throw new Error(`${cause}. ${await rollBackFrameChange(writer, error, images.renames, { otherWrite: kept === false })}`);
          }
          backupPath = (error as EntityWriteError).backupPath;
          otherWrite = true;
        }

        const warnings = frameImageWarnings(images, anim.name);
        if (otherWrite) warnings.push(otherWriteKeptWarning('the frame deletion'));
        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[delete_frame_from_animation] failed:', error);
        return toolError(`Error deleting frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── update_frame ─────────────────────────────────────────

  server.tool(
    'update_frame',
    'Update per-frame properties of a Sprite animation frame (duration, dimensions, origin)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based frame index'),
      width: z.number().int().positive().optional().describe('New frame width in pixels'),
      height: z.number().int().positive().optional().describe('New frame height in pixels'),
      duration: z.number().positive().optional().describe('New frame duration in seconds'),
      originX: z.number().min(0).max(1).optional().describe('Horizontal origin 0-1 (0.5 = center)'),
      originY: z.number().min(0).max(1).optional().describe('Vertical origin 0-1 (0.5 = center)'),
    },
    oneAtATime(async (args) => {
      try {
        const hasUpdates = args.width !== undefined || args.height !== undefined ||
          args.duration !== undefined || args.originX !== undefined || args.originY !== undefined;
        if (!hasUpdates) {
          return toolError('No updates provided. Specify at least one of: width, height, duration, originX, originY.');
        }

        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite.`);
        }
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found. Available: ${describeAvailableAnimations(obj.animations)}`);
        }

        if (args.frameIndex >= anim.frames.length) {
          return toolError(`Frame index ${args.frameIndex} is out of range. Animation "${args.animationName}" has ${anim.frames.length} frame(s).`);
        }

        const frame = anim.frames[args.frameIndex];
        if (args.width !== undefined) frame.width = args.width;
        if (args.height !== undefined) frame.height = args.height;
        if (args.duration !== undefined) frame.duration = args.duration;
        if (args.originX !== undefined) frame.originX = args.originX;
        if (args.originY !== undefined) frame.originY = args.originY;

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[update_frame] failed:', error);
        return toolError(`Error updating frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  // ─── replace_sprite_image ─────────────────────────────────

  server.tool(
    'replace_sprite_image',
    'Replace the image for a specific Sprite animation frame with real PNG data (base64-encoded)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based frame index'),
      pngBase64: z.string().max(10_000_000).describe('Base64-encoded PNG image data'),
      width: z.number().int().positive().optional().describe('Image width in pixels (updates frame metadata if provided)'),
      height: z.number().int().positive().optional().describe('Image height in pixels (updates frame metadata if provided)'),
    },
    oneAtATime(async (args) => {
      try {
        let obj: ObjectType;
        try {
          obj = await reader.readObjectType(args.objectName);
        } catch {
          return notFoundError('Object', args.objectName, reader.findNearestName(args.objectName, 'objects'), 'list_objects');
        }

        if (obj['plugin-id'] !== 'Sprite') {
          return toolError(`Object "${args.objectName}" is not a Sprite.`);
        }
        if (!obj.animations || !Array.isArray(obj.animations.items)) {
          return toolError(`Object "${args.objectName}" has no animations structure.`);
        }

        const anim = findAnimation<Animation>(obj.animations, args.animationName)?.animation;
        if (!anim) {
          return toolError(`Animation "${args.animationName}" not found. Available: ${describeAvailableAnimations(obj.animations)}`);
        }
        const nameError = animationNameFileError(anim.name, true);
        if (nameError) return toolError(nameError);

        if (args.frameIndex >= anim.frames.length) {
          return toolError(`Frame index ${args.frameIndex} is out of range. Animation has ${anim.frames.length} frame(s).`);
        }

        const frame = anim.frames[args.frameIndex];

        // Decode and validate PNG
        let pngBuffer: Buffer;
        try {
          pngBuffer = Buffer.from(args.pngBase64, 'base64');
        } catch {
          return toolError('Invalid base64 data in pngBase64.');
        }

        // Minimal PNG header check: first 8 bytes must be PNG signature
        if (pngBuffer.length < 8 ||
          pngBuffer[0] !== 0x89 || pngBuffer[1] !== 0x50 || pngBuffer[2] !== 0x4E || pngBuffer[3] !== 0x47) {
          return toolError('Decoded data does not appear to be a valid PNG (invalid header).');
        }

        // Write the PNG to the correct images/ path using the imageSpriteId from the frame
        const imageSpriteId = frame.imageSpriteId;
        if (imageSpriteId === undefined) {
          return toolError(`Frame ${args.frameIndex} of animation "${args.animationName}" has no imageSpriteId. It may be a corrupted frame.`);
        }

        const fileName = getImageFileName(storedObjectName(obj, args.objectName), args.animationName, args.frameIndex, 'Sprite');
        const filePath = resolveProjectPath(reader.getProjectDir(), 'images', fileName);

        const { mkdir, writeFile } = await import('fs/promises');
        const { dirname } = await import('path');
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, pngBuffer);

        // Update frame metadata if dimensions provided
        if (args.width !== undefined) frame.width = args.width;
        if (args.height !== undefined) frame.height = args.height;

        // The editor picks the image file's extension from the frame's fileType
        // (a JPEG frame's image is "<name>.jpg"), so a frame stored in another
        // format is switched to PNG; otherwise the editor keeps loading the old file
        const warnings = [`Image written to ${filePath}`];
        if (typeof frame.fileType === 'string' && frame.fileType !== 'image/png') {
          const oldFile = frame.fileType === 'image/jpeg' ? ` (images/${fileName.replace(/\.png$/, '.jpg')})` : '';
          warnings.push(`Frame ${args.frameIndex} was stored as "${frame.fileType}"${oldFile}. Its fileType is now "image/png", so Construct 3 loads the new PNG; the old file is no longer used and was left in images/.`);
          frame.fileType = 'image/png';
        }

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings,
        };
        return toolResult(result);
      } catch (error) {
        console.error('[replace_sprite_image] failed:', error);
        return toolError(`Error replacing sprite image: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}

function animationNames(anims: Animation[]): string[] {
  return anims.map(a => a.name).filter((n): n is string => typeof n === 'string');
}

/**
 * Error for an animation name that differs from another animation of the
 * sprite only in case. The editor compares animation names ignoring case, and
 * it names image files "<object>-<animation>-NNN" in lowercase, so both
 * animations would also use the same image files.
 */
function animationCaseClashError(objectName: string, requested: string, existing: string): string {
  const file = getImageFileName(objectName, requested, 0, 'Sprite');
  return `"${requested}" differs only in case from the existing animation "${existing}" on "${objectName}". `
    + 'Construct 3 treats animation names that differ only in case as the same name, and it names image files in lowercase '
    + `("images/${file}"), so both animations would use the same image files. Choose a different name.`;
}

/**
 * Why `animationName` cannot be used in frame image file names
 * (images/<object>-<animation>-NNN.png), or undefined when it can. With
 * `existing`, the message is for an animation that already has the name.
 */
function animationNameFileError(animationName: string, existing = false): string | undefined {
  const char = invalidImageNameCharacter(animationName);
  if (char === undefined) return undefined;
  const subject = existing ? `Animation "${animationName}"` : `The animation name "${animationName}"`;
  return `${subject} contains ${describeCharacter(char)}. Construct 3 names the frame image files after the animation `
    + '(images/<object>-<animation>-000.png), and a file name cannot contain a path separator (/ or \\) or a character '
    + 'Windows does not allow in file names (: * ? " < > | or a control character). '
    + (existing ? 'Rename the animation first (rename_animation). Nothing was changed.' : 'Choose another name.');
}

/** The first `max` items, quoted, and how many more there are. */
function someOf(items: string[], max: number): string {
  const shown = items.slice(0, max).map(item => `"${item}"`).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/**
 * Warnings about the image files an add_frame_to_animation or
 * delete_frame_from_animation renamed (see planFrameImageShift).
 */
function frameImageWarnings(images: FrameImageShiftPlan, animationName: string): string[] {
  const warnings: string[] = [];
  const list = (renames: ImageFileRename[]) => {
    const shown = renames.slice(0, 3).map(r => `"images/${r.from}" → "images/${r.to}"`).join(', ');
    return renames.length > 3 ? `${shown} and ${renames.length - 3} more` : shown;
  };
  if (images.shifted.length > 0) {
    const [first] = images.shifted;
    const direction = images.newFrameFile !== undefined ? 'up' : 'down';
    warnings.push(`Renamed ${images.shifted.length} frame image file(s) in images/ one index ${direction}, with their frames `
      + `("${first.from}" → "${first.to}"${images.shifted.length > 1 ? ', …' : ''}).`);
  }
  if (images.parked.length > 0) {
    warnings.push(`The deleted frame's image was kept as a backup: ${list(images.parked)}. No frame uses it; delete it when it is no longer needed.`);
  }
  if (images.backedUp.length > 0) {
    warnings.push(`${images.backedUp.length} file(s) in images/ had the name a frame image needed, but no frame used them (e.g. images a `
      + `deleted frame left behind); they were renamed instead of being replaced: ${list(images.backedUp)}.`);
  }
  if (images.missing.length > 0) {
    warnings.push(`No image file in images/ for ${images.missing.length} frame(s) of "${animationName}" after the changed index `
      + `(expected ${someOf(images.missing, 3)}); nothing was renamed for them.`);
  }
  return warnings;
}

/**
 * The object's name as stored in its file, which the editor names its frame
 * image files after, or `requested` (the objectName a tool was called with)
 * when the file has none. They differ when `requested` reaches the file by
 * another path (e.g. "./Sprite") or in another case.
 */
function storedObjectName(obj: ObjectType, requested: string): string {
  return typeof obj.name === 'string' && obj.name !== '' ? obj.name : requested;
}

/**
 * For an add_frame_to_animation or delete_frame_from_animation whose object
 * write failed because another write to the object file landed during it (the
 * post-write check found other valid JSON there, see
 * EntityWriteError.changedByOtherWrite): whether the file now has this call's
 * frame change, `hasChange` telling from the animation's frames, i.e. the
 * other write was made on top of it. undefined for any other failure and when
 * the file cannot be read; the change is then rolled back as usual.
 */
async function frameChangeAfterOtherWrite(
  reader: MutationToolDeps['reader'],
  objectName: string,
  animationName: string,
  error: unknown,
  hasChange: (frames: ReadonlyArray<{ imageSpriteId?: unknown } | null | undefined>) => boolean,
): Promise<boolean | undefined> {
  if (!(error instanceof EntityWriteError) || !error.changedByOtherWrite) return undefined;
  try {
    const current = await reader.readObjectType(objectName);
    const anim = findAnimation<{ frames?: unknown }>(current.animations, animationName)?.animation;
    return anim !== undefined && Array.isArray(anim.frames) && hasChange(anim.frames);
  } catch {
    return undefined;
  }
}

/** Warning for a frame change that another write kept (frameChangeAfterOtherWrite). */
function otherWriteKeptWarning(change: string): string {
  return `Another write changed the object file right after this one (a tool call running in parallel?). The file still has ${change}, `
    + 'so the image files stay as renamed, but the other write may have been made on older content: re-read the object to check it.';
}

/**
 * Undo an add_frame_to_animation or delete_frame_from_animation whose writes
 * after the image renames failed: put back the object file from its backup
 * when its write failed after replacing it, remove the new frame's
 * placeholder image (`newFrameFile`), then rename the image files back, last
 * first. The placeholder's name was free before the call (see
 * planFrameImageShift), so a file there, also one a failed write left part
 * written, is removed. With `otherWrite`, another write replaced the object
 * file during this one with content that lacks this call's change: the file
 * is left as that write left it, and the image files are renamed back to
 * match it. Returns a sentence for the error message.
 */
async function rollBackFrameChange(
  writer: MutationToolDeps['writer'],
  error: unknown,
  renames: ImageFileRename[],
  options: { newFrameFile?: string; otherWrite?: boolean } = {},
): Promise<string> {
  const failed: string[] = [];
  const restore = error instanceof EntityWriteError && !options.otherWrite;
  if (restore) {
    try {
      await writer.restoreEntityFile(error.backupPath);
    } catch {
      failed.push(error.backupPath.replace(/\.bak$/, ''));
    }
  }
  let placeholderRemoved = false;
  if (options.newFrameFile !== undefined) {
    try {
      placeholderRemoved = await writer.deleteImageFile(options.newFrameFile);
    } catch {
      failed.push(`images/${options.newFrameFile}`);
    }
  }
  if (renames.length > 0) {
    try {
      await writer.renameImageFiles(renames.map(r => ({ from: r.to, to: r.from })).reverse());
    } catch (e) {
      failed.push(`image files (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const otherWrite = options.otherWrite
    ? 'Another write replaced the object file during this one (a tool call running in parallel?) without this call\'s change; '
      + 'the object file was left as that write left it. '
    : '';
  if (failed.length > 0) {
    return `${otherWrite}Rolling back failed for: ${failed.join('; ')}. Check these (the .bak file holds the previous object JSON).`;
  }
  const undone = [
    ...(renames.length > 0 ? ['the image files have their old names again'] : []),
    ...(placeholderRemoved ? ['the placeholder image was removed'] : []),
    ...(restore ? ['the object file was restored from its backup'] : []),
  ];
  return otherWrite + (undone.length === 0
    ? 'Nothing was changed.'
    : `Nothing was changed: ${undone.slice(0, -1).join(', ')}${undone.length > 1 ? ' and ' : ''}${undone[undone.length - 1]}.`);
}

/**
 * Undo a rename_animation whose JSON writes failed part way: put back the
 * entity files written so far and the one whose write failed (it may have been
 * replaced; an unchanged file is left alone), from their backups, newest
 * first, then rename the image files back. Returns a sentence for the error
 * message.
 */
async function rollBackAnimationRename(
  writer: MutationToolDeps['writer'],
  writtenBackups: string[],
  renames: ImageFileRename[],
): Promise<string> {
  const failed: string[] = [];
  for (const backup of [...writtenBackups].reverse()) {
    try {
      await writer.restoreEntityFile(backup);
    } catch {
      failed.push(backup.replace(/\.bak$/, ''));
    }
  }
  try {
    await writer.renameImageFiles(renames.map(r => ({ from: r.to, to: r.from })));
  } catch (error) {
    failed.push(`image files (${error instanceof Error ? error.message : String(error)})`);
  }
  return failed.length === 0
    ? 'The rename was rolled back: the image files have their old names again, and every JSON file it had written or started to write was restored from its backup.'
    : `Rolling back the rename failed for: ${failed.join('; ')}. Check these (the .bak files hold the previous JSON).`;
}

/**
 * Why rename_animation refuses without force: layouts it could not parse
 * whose text names the object and the old animation name (possibly instances
 * that start with it, which it cannot update), or that it could not search.
 */
function renameLayoutRefusal(layouts: UnscannedFileReport[], objectName: string, oldName: string): string {
  const possible = layouts.filter(r => r.textSearch === 'possible-use');
  const unreadable = layouts.filter(r => r.textSearch === 'unreadable');
  const sentences: string[] = [];
  if (possible.length > 0) {
    sentences.push(`Layouts that could not be parsed possibly have instances of "${objectName}" that start with "${oldName}", ` +
      `which the rename cannot update: ${possible.map(describeUnscannedFile).join(', ')}, whose text names "${objectName}" and ` +
      `"${oldName}" (a text search cannot tell an instance from the same names in other strings).`);
  }
  if (unreadable.length > 0) {
    sentences.push(`Layouts that could not be parsed could not be searched for such instances either: ${unreadable.map(describeUnscannedFile).join(', ')}.`);
  }
  return sentences.join(' ');
}

/**
 * The warnings of rename_animation for layouts and event sheets it could not
 * parse (searched as text for the object and the old animation name): layout
 * instances there that may still start with the old name were not updated
 * (it only gets here for those with force), and parameters there were not
 * counted (like the parameters it counts, only a warning).
 */
function renameUnscannedWarnings(
  layouts: UnscannedFileReport[], sheets: UnscannedFileReport[], objectName: string, oldName: string,
): string[] {
  const warnings: string[] = [];
  for (const r of layouts) {
    if (r.textSearch === 'possible-use') {
      warnings.push(`Renamed with force=true: ${describeUnscannedFile(r)} could not be parsed, and its text names "${objectName}" and "${oldName}": instances of `
        + `"${objectName}" there possibly still start with "${oldName}" and were NOT updated. Check them in the Construct 3 editor.`);
    } else if (r.textSearch === 'unreadable') {
      warnings.push(`Renamed with force=true: ${describeUnscannedFile(r)}: instances of "${objectName}" there that start with "${oldName}" could not be `
        + 'checked and were NOT updated.');
    }
  }
  const sheetHits = sheets.filter(r => r.textSearch !== 'no-match');
  if (sheetHits.length > 0) {
    warnings.push(`Event sheet(s) that could not be parsed possibly name "${oldName}" too (not counted above): `
      + `${sheetHits.map(describeUnscannedFile).join(', ')}.`);
  }
  warnings.push(...unscannedWarnings([...layouts, ...sheets].filter(r => r.textSearch === 'no-match'), 'Renamed'));
  return warnings;
}
