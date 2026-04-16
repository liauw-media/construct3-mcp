/**
 * Animation tools: add_animation_to_sprite, update_animation_properties,
 * delete_animation, rename_animation, add_frame_to_animation,
 * delete_frame_from_animation, update_frame, replace_sprite_image.
 */

import { z } from 'zod';
import { readFile } from 'fs/promises';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectType, AnimationFrame } from '../construct3/types.js';
import { toolResult, toolError, notFoundError } from './shared.js';
import { createAnimation, createAnimationFrame } from '../construct3/templates.js';
import { getImageFileName } from '../construct3/png-generator.js';
import { resolveProjectPath } from '../construct3/path-utils.js';

export function registerAnimationTools({ server, reader, writer, idGen }: MutationToolDeps) {
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
    async (args) => {
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

        // Check for duplicate animation name
        if (animItems.some(a => a.name === args.animationName)) {
          return toolError(`Animation "${args.animationName}" already exists on "${args.objectName}". Use update_animation_properties to modify it.`);
        }

        // Determine frame dimensions from existing animation if not specified
        let frameWidth = args.frameWidth ?? 100;
        let frameHeight = args.frameHeight ?? 100;
        if ((!args.frameWidth || !args.frameHeight) && animItems.length > 0) {
          const existingFrames = animItems[0].frames;
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
    }
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
    async (args) => {
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
        const animItems = obj.animations.items;

        // Find the target animation
        const anim = animItems.find(a => a.name === args.animationName);
        if (!anim) {
          const availableNames = animItems.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available animations: ${availableNames}`);
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

        // Write back
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
        console.error('[update_animation_properties] failed:', error);
        return toolError(`Error updating animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_animation ─────────────────────────────────────

  server.tool(
    'delete_animation',
    'Delete an animation from a Sprite object (must not be the last animation)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name to delete'),
    },
    async (args) => {
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
        const animItems = obj.animations.items;

        const animIdx = animItems.findIndex(a => a.name === args.animationName);
        if (animIdx === -1) {
          const available = animItems.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${available}`);
        }

        if (animItems.length <= 1) {
          return toolError(`Cannot delete the last animation on "${args.objectName}". A Sprite must have at least one animation.`);
        }

        animItems.splice(animIdx, 1);

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
    }
  );

  // ─── rename_animation ─────────────────────────────────────

  server.tool(
    'rename_animation',
    'Rename an animation on a Sprite object',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Current animation name'),
      newName: z.string().min(1).max(200).describe('New animation name'),
    },
    async (args) => {
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
        const animItems = obj.animations.items;

        const anim = animItems.find(a => a.name === args.animationName);
        if (!anim) {
          const available = animItems.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found on "${args.objectName}". Available: ${available}`);
        }

        if (animItems.some(a => a.name === args.newName)) {
          return toolError(`Animation "${args.newName}" already exists on "${args.objectName}".`);
        }

        anim.name = args.newName;

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
        console.error('[rename_animation] failed:', error);
        return toolError(`Error renaming animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── add_frame_to_animation ───────────────────────────────

  server.tool(
    'add_frame_to_animation',
    'Add a new blank frame to a Sprite animation',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      index: z.number().int().min(0).optional().describe('Insert at this frame index (default: append)'),
      width: z.number().int().positive().optional().describe('Frame width in pixels (default: matches first frame)'),
      height: z.number().int().positive().optional().describe('Frame height in pixels (default: matches first frame)'),
      duration: z.number().positive().optional().default(1).describe('Frame duration in seconds (default: 1)'),
    },
    async (args) => {
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

        const anim = obj.animations.items.find(a => a.name === args.animationName);
        if (!anim) {
          const available = obj.animations.items.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found. Available: ${available}`);
        }

        // Infer dimensions from first existing frame
        const frameWidth = args.width ?? (anim.frames[0]?.width ?? 100);
        const frameHeight = args.height ?? (anim.frames[0]?.height ?? 100);

        const imageSpriteId = await idGen.generateImageSpriteId(reader);

        // Write placeholder PNG
        await writer.writeImageFiles([{
          objectName: args.objectName,
          animationName: args.animationName,
          frameIndex: args.index ?? anim.frames.length,
          pluginId: 'Sprite',
          width: 1,
          height: 1,
        }]);

        const newFrame: AnimationFrame = {
          ...createAnimationFrame(frameWidth, frameHeight, imageSpriteId),
          duration: args.duration,
        };

        if (args.index !== undefined) {
          anim.frames.splice(args.index, 0, newFrame);
        } else {
          anim.frames.push(newFrame);
        }

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
        console.error('[add_frame_to_animation] failed:', error);
        return toolError(`Error adding frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  // ─── delete_frame_from_animation ─────────────────────────

  server.tool(
    'delete_frame_from_animation',
    'Delete a frame from a Sprite animation by index (must not be the last frame)',
    {
      objectName: z.string().max(200).describe('Sprite object name'),
      animationName: z.string().min(1).max(200).describe('Animation name'),
      frameIndex: z.number().int().min(0).describe('0-based frame index to delete'),
    },
    async (args) => {
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

        const anim = obj.animations.items.find(a => a.name === args.animationName);
        if (!anim) {
          const available = obj.animations.items.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found. Available: ${available}`);
        }

        if (args.frameIndex >= anim.frames.length) {
          return toolError(`Frame index ${args.frameIndex} is out of range. Animation "${args.animationName}" has ${anim.frames.length} frame(s) (indices 0–${anim.frames.length - 1}).`);
        }

        if (anim.frames.length <= 1) {
          return toolError(`Cannot delete the last frame of animation "${args.animationName}". An animation must have at least one frame.`);
        }

        anim.frames.splice(args.frameIndex, 1);

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
        console.error('[delete_frame_from_animation] failed:', error);
        return toolError(`Error deleting frame: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
    async (args) => {
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

        const anim = obj.animations.items.find(a => a.name === args.animationName);
        if (!anim) {
          const available = obj.animations.items.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found. Available: ${available}`);
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
    }
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
    async (args) => {
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

        const anim = obj.animations.items.find(a => a.name === args.animationName);
        if (!anim) {
          const available = obj.animations.items.map(a => a.name).join(', ');
          return toolError(`Animation "${args.animationName}" not found. Available: ${available}`);
        }

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

        const fileName = getImageFileName(args.objectName, args.animationName, args.frameIndex, 'Sprite');
        const filePath = resolveProjectPath(reader.getProjectDir(), 'images', fileName);

        const { mkdir, writeFile } = await import('fs/promises');
        const { dirname } = await import('path');
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, pngBuffer);

        // Update frame metadata if dimensions provided
        if (args.width !== undefined) frame.width = args.width;
        if (args.height !== undefined) frame.height = args.height;

        const subfolder = writer.getSubfolderForEntity('objectTypes', args.objectName);
        const backupPath = await writer.writeEntityFile('objectTypes', args.objectName, obj, subfolder);

        const result: WriteResult = {
          success: true,
          entity: args.objectName,
          category: 'object',
          action: 'updated',
          backupFile: backupPath,
          warnings: [`Image written to ${filePath}`],
        };
        return toolResult(result);
      } catch (error) {
        console.error('[replace_sprite_image] failed:', error);
        return toolError(`Error replacing sprite image: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
