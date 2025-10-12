/**
 * MCP Resources for accessing Construct3 official documentation
 */

export function registerDocsResources(server: any) {
  // Resource: Construct3 documentation manual index
  server.resource({
    uri: 'construct3://docs/index',
    name: 'Construct3 Documentation Index',
    description: 'Index of available Construct3 documentation topics',
    mimeType: 'application/json',
  }, async () => {
    const docIndex = {
      manual: 'https://www.construct.net/en/make-games/manuals/construct-3',
      categories: {
        interface: 'User interface and editor',
        project: 'Project structure and primitives',
        plugins: 'Plugin reference',
        behaviors: 'Behavior reference',
        effects: 'Effect reference',
        scripting: 'JavaScript scripting',
        publishing: 'Exporting and publishing',
      },
      popularTopics: [
        'sprite',
        'text',
        'button',
        'touch',
        'keyboard',
        'mouse',
        'audio',
        'ajax',
        'array',
        'dictionary',
        'json',
        'localstorage',
        'browser',
        'platforminfo',
      ],
    };

    return {
      contents: [{
        uri: 'construct3://docs/index',
        mimeType: 'application/json',
        text: JSON.stringify(docIndex, null, 2),
      }],
    };
  });

  // Resource Template: Specific documentation topic
  server.resource({
    uri: 'construct3://docs/manual/{topic}',
    name: 'Construct3 Manual Topic',
    description: 'Access specific Construct3 documentation topic or plugin reference',
    mimeType: 'text/markdown',
  }, async (params: { topic: string }) => {
    const topic = params.topic.toLowerCase();

    // Map common topics to documentation URLs
    const docUrls: Record<string, string> = {
      // Plugins
      'sprite': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/sprite',
      'text': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/text',
      'button': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/button',
      'tiledbackground': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/tiled-background',
      'ninepatch': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/9-patch',
      'particles': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/particles',
      'spritefont': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/sprite-font',

      // Input
      'touch': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/touch',
      'keyboard': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/keyboard',
      'mouse': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/mouse',
      'gamepad': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/gamepad',

      // Audio
      'audio': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/audio',

      // Data & Storage
      'array': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/array',
      'dictionary': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/dictionary',
      'json': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/json',
      'localstorage': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/local-storage',
      'binarydata': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/binary-data',

      // Web & Platform
      'ajax': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/ajax',
      'browser': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/browser',
      'platforminfo': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/platform-info',
      'webstorage': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/webstorage',

      // Timeline & Animation
      'timeline': 'https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/timeline',
      'tween': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/tween',

      // Behaviors
      'platform': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/platform',
      'bullet': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/bullet',
      'physics': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/physics',
      'pathfinding': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/pathfinding',
      'sine': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/sine',
      'rotate': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/rotate',
      'pin': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/pin',
      'fade': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/fade',
      'timer': 'https://www.construct.net/en/make-games/manuals/construct-3/behavior-reference/timer',

      // General topics
      'eventsheets': 'https://www.construct.net/en/make-games/manuals/construct-3/event-features',
      'layouts': 'https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/layouts',
      'layers': 'https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/layers',
      'objects': 'https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/objects',
      'families': 'https://www.construct.net/en/make-games/manuals/construct-3/project-primitives/families',
      'scripting': 'https://www.construct.net/en/make-games/manuals/construct-3/scripting',
      'publishing': 'https://www.construct.net/en/make-games/manuals/construct-3/overview/publishing-projects',
    };

    const url = docUrls[topic];
    if (!url) {
      // Try constructing a generic URL
      const guessedUrl = `https://www.construct.net/en/make-games/manuals/construct-3/plugin-reference/${topic}`;
      return {
        contents: [{
          uri: `construct3://docs/manual/${topic}`,
          mimeType: 'text/markdown',
          text: `# Construct3 Documentation: ${topic}

Topic "${topic}" not found in known documentation topics.

**Suggested URL**: ${guessedUrl}

**Available topics**: ${Object.keys(docUrls).sort().join(', ')}

**Or browse the manual**: https://www.construct.net/en/make-games/manuals/construct-3

Use \`construct3://docs/index\` to see all available documentation categories.`,
        }],
      };
    }

    return {
      contents: [{
        uri: `construct3://docs/manual/${topic}`,
        mimeType: 'text/markdown',
        text: `# Construct3 Documentation: ${topic}

**Official Documentation URL**: ${url}

Visit the link above for complete documentation on ${topic}.

For the most up-to-date information, always refer to the official Construct3 manual.

**Quick Links**:
- [Full Manual](https://www.construct.net/en/make-games/manuals/construct-3)
- [Tutorials](https://www.construct.net/en/make-games/manuals/construct-3/tutorials)
- [Forums](https://www.construct.net/en/forum/construct-3)

Note: To view the full content, please use Claude's web fetch capability or visit the URL directly.`,
      }],
    };
  });
}
