/**
 * Animation tools: add_animation_to_sprite, update_animation_properties.
 */

import { z } from 'zod';
import type { MutationToolDeps } from './shared.js';
import type { WriteResult, ObjectType, AnimationFrame } from '../construct3/types.js';
import { toolResult, toolError } from './shared.js';
import { createAnimation, createAnimationFrame } from '../construct3/templates.js';

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
          const suggestions = reader.findNearestName(args.objectName, 'objects');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_objects to see all available names.';
          return toolError(`Object "${args.objectName}" not found.${hint}`);
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
          const suggestions = reader.findNearestName(args.objectName, 'objects');
          const hint = suggestions.length > 0
            ? `\nDid you mean: ${suggestions.join(', ')}?`
            : '\nUse list_objects to see all available names.';
          return toolError(`Object "${args.objectName}" not found.${hint}`);
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
        return toolError(`Error updating animation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
