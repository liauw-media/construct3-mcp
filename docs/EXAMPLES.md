# Examples

Real-world examples of using the Construct3 MCP Server with Claude.

## Table of Contents

- [Getting Started](#getting-started)
- [Project Analysis](#project-analysis)
- [Finding References](#finding-references)
- [Understanding Code](#understanding-code)
- [Documentation Generation](#documentation-generation)
- [Optimization](#optimization)
- [Advanced Workflows](#advanced-workflows)

## Getting Started

### Example 1: First Connection

**Query:**
> "Are you connected to my Construct3 project?"

**Response:**
> Yes! I'm connected to your Construct3 project "Bonny's Fortune" (version 0.2.6). The project has:
> - 442 object types
> - 17 event sheets
> - 7 layouts
> - 14 families
>
> Would you like me to analyze any specific aspect of your project?

---

### Example 2: Quick Project Overview

**Query:**
> "Give me a quick overview of this project"

**Claude uses**: `get_project_summary` tool

**Response:**
> Your project "Bonny's Fortune: Loose Canons" is a slot machine game with:
>
> **Statistics:**
> - 442 objects
> - 17 event sheets
> - 7 layouts including Login-Horizontal, Main-Horizontal, Preloader
> - 30 addons (20 plugins, 8 behaviors, 2 effects)
>
> **Key Plugins:**
> - Omnitronix Platform Connect (custom)
> - Spine animation support
> - Audio, Touch, AJAX for game functionality
>
> The project uses a horizontal and vertical layout system for different screen orientations.

---

## Project Analysis

### Example 3: Analyze Project Structure

**Query:**
> "Analyze the structure and organization of this project"

**Claude uses**: `analyze_project` prompt

**Response:**
> **Project Structure Analysis:**
>
> **Organization Pattern:**
> Your project follows a modular organization with clear separation:
>
> 1. **Event Sheets** are organized by feature:
>    - `SpinMachine` - Core game logic
>    - `AutoSpin`, `FreeSpin`, `BigWin` - Game features
>    - `Menu`, `Paytable`, `History` - UI screens
>    - `MainData`, `SpinCheck` - Data management
>
> 2. **Object Organization**:
>    - Grouped into logical subfolders (Login, Menu, Gui, Symbol, etc.)
>    - Clear naming conventions (e.g., `_omnitronix` suffix for platform-specific)
>
> **Strengths:**
> - Excellent separation of concerns
> - Consistent naming patterns
> - Modular event sheet includes
>
> **Suggestions:**
> - Consider documenting the event sheet hierarchy
> - Some event sheets like `MainData` could be split for clarity

---

### Example 4: Review Game Logic Architecture

**Query:**
> "Review the overall game logic architecture"

**Claude uses**: `review_game_logic` prompt

**Response:**
> **Game Logic Architecture Review:**
>
> **Event Sheet Hierarchy:**
> ```
> MainSheet (root)
>   ├── SpinMachine (core gameplay)
>   ├── SpinCheck (validation)
>   ├── BigWin (win animations)
>   ├── AutoSpin (auto-play feature)
>   ├── FreeSpin (bonus rounds)
>   └── MainData (game state)
> ```
>
> **Layout Flow:**
> Preloader → Login → Main Game
>
> **Architecture Pattern**: **Event-Driven State Machine**
> - Each feature is encapsulated in its own event sheet
> - Loose coupling via global variables and functions
> - UI and logic separated (Menu, Paytable, History for UI)
>
> **Strengths:**
> - Clean modular design
> - Easy to test individual features
> - Maintainable and extensible
>
> **Areas for Improvement:**
> - Consider implementing a formal state manager
> - Document state transitions
> - Add error handling event sheet

---

## Finding References

### Example 5: Find Object Usage

**Query:**
> "Where is the 'spin_btn' object used in this project?"

**Claude uses**: `find_object_usage` prompt + multiple detail queries

**Response:**
> **References to 'spin_btn':**
>
> **Event Sheets:**
> 1. **MainSheet** - Touch events for spinning
> 2. **SpinMachine** - Button state management (enabled/disabled)
> 3. **AutoSpin** - Disabled during auto-spin mode
>
> **Layouts:**
> - **Main-Horizontal** - Positioned at bottom-center
> - **Main-Vertical** - Adjusted position for portrait mode
>
> **Related Objects:**
> - `EffectSpinbtn` - Visual effects for the button
> - `EffectCursorSpinbtn` - Cursor interaction feedback
>
> The spin button is central to the game interaction and properly integrated across different game states.

---

### Example 6: Search for Button Objects

**Query:**
> "List all button objects in the project"

**Claude uses**: `search_objects` with pattern "btn"

**Response:**
> Found 15 button objects:
> - `spin_btn` - Main spin button
> - `start_btn` - Start game
> - `auto_btn` - Auto-spin toggle
> - `BetOption_btn` - Open bet options
> - `menu_btn` - Open menu
> - `BetAdd_btn`, `BetSub_btn` - Adjust bet size
> - `Feature_btn` - Feature panel
> - `totalWinCollectBtn` - Collect winnings
> - Plus 6 more...
>
> Would you like details about any specific button?

---

## Understanding Code

### Example 7: Explain Event Sheet

**Query:**
> "Explain how the SpinMachine event sheet works"

**Claude uses**: `explain_eventsheet` prompt + `get_eventsheet_details`

**Response:**
> **SpinMachine Event Sheet Explanation:**
>
> **Purpose**: Handles the core slot machine spin mechanics
>
> **Key Components:**
> 1. **Spin Initialization**
>    - Validates bet and balance
>    - Disables UI during spin
>    - Triggers reel animations
>
> 2. **Reel Logic**
>    - Each reel stops in sequence
>    - Symbol positions calculated from server response
>    - Anticipation effects for near-wins
>
> 3. **Result Handling**
>    - Checks win conditions
>    - Updates balance
>    - Triggers win animations
>
> **Event Flow:**
> ```
> User clicks spin → Validate → Send to server →
> Animate reels → Stop reels → Check results →
> Show wins → Update balance → Re-enable UI
> ```
>
> **Optimizations Possible:**
> - Cache server responses for smoother playback
> - Pre-load reel symbols to reduce stutter

---

### Example 8: Understand Plugin Usage

**Query:**
> "How is the AJAX plugin used in this project?"

**Claude uses**: `get_object_details` + searches event sheets

**Response:**
> **AJAX Plugin Usage:**
>
> The AJAX object is used for:
>
> 1. **Server Communication:**
>    - Sending spin requests to game server
>    - Receiving game results (symbols, wins, balance)
>    - Requesting game history
>
> 2. **Data Loading:**
>    - Loading bet configuration from JSON
>    - Fetching paytable data
>    - Loading game rules HTML
>
> **Implementation Pattern:**
> ```
> Event: On spin button clicked
>   → AJAX: Request URL with bet data
>   → On AJAX completed: Parse JSON response
>   → Update game state
> ```
>
> **Best Practice**: The project properly handles AJAX errors and timeouts.

---

## Documentation Generation

### Example 9: Document an Object

**Query:**
> "Generate documentation for the Player object" (hypothetical example)

**Claude uses**: `document_object` prompt

**Response:**
> **Player Object Documentation**
>
> **Type**: Sprite
> **Plugin**: Sprite (Scirra)
>
> **Purpose**:
> Represents the player character in the game. Handles movement, collision, and animations.
>
> **Properties:**
> - `maxSpeed`: 200 (pixels/second)
> - `acceleration`: 500
> - `deceleration`: 800
>
> **Behaviors:**
> - Platform Movement - WASD/Arrow key controls
> - Collision Detection - Solid walls and obstacles
> - Health System - Custom behavior
>
> **Instance Variables:**
> - `health` (number) - Player health (0-100)
> - `score` (number) - Current score
> - `powerUpActive` (boolean) - Power-up state
>
> **Animations:**
> - Idle, Walk, Run, Jump, Fall, Attack, Hurt, Die
>
> **Usage:**
> Instantiated in all gameplay layouts. Referenced by enemy AI, collision handlers, and UI updates.
>
> **Dependencies:**
> - `HealthBar` object for display
> - `GameManager` for score tracking

---

### Example 10: Create API Documentation

**Query:**
> "Document all the event sheets and their purposes"

**Claude uses**: `list_eventsheets` + multiple `get_eventsheet_details`

**Response:**
> **Event Sheet Documentation:**
>
> | Event Sheet | Purpose | Dependencies |
> |-------------|---------|--------------|
> | `MainSheet` | Root container, includes all other sheets | All sheets |
> | `SpinMachine` | Core slot machine mechanics | `MainData`, `SpinCheck` |
> | `SpinCheck` | Validation logic for spins | `MainData` |
> | `BigWin` | Win celebration animations | `SpinMachine` |
> | `AutoSpin` | Auto-play functionality | `SpinMachine` |
> | `FreeSpin` | Free spin bonus rounds | `SpinMachine`, `MainData` |
> | `Menu` | Menu UI interactions | None |
> | `Paytable` | Paytable display logic | None |
> | `History` | Game history management | `AJAX` |
> | `MainData` | Global data management | None |
> | `BetOption` | Bet size selection UI | `MainData` |
>
> **Recommended Reading Order:**
> 1. Start with `MainData` (foundation)
> 2. Then `SpinMachine` (core logic)
> 3. Then feature sheets (`BigWin`, `AutoSpin`, etc.)
> 4. Finally UI sheets (`Menu`, `Paytable`, etc.)

---

## Optimization

### Example 11: Get Optimization Suggestions

**Query:**
> "Suggest optimizations for this project"

**Claude uses**: `optimize_project` prompt

**Response:**
> **Optimization Suggestions:**
>
> **1. Performance:**
> - Enable WebGPU for better rendering (currently set to "auto")
> - Consider using Sprite Fonts instead of Text objects for scores
> - Minimize use of effects on mobile devices
>
> **2. Asset Organization:**
> - 500+ image files - consider using sprite sheets
> - Multiple Spine animations - ensure they're not all loaded at once
> - Audio files could benefit from compression
>
> **3. Event Sheet Structure:**
> - `MainSheet` includes 17 sheets - consider lazy loading
> - Some event sheets have deep nesting - flatten for performance
> - Add event groups for better organization
>
> **4. Object Usage:**
> - 442 objects is high - review if all are necessary
> - Some objects appear unused - run cleanup
> - Consider using families more extensively
>
> **5. Best Practices:**
> - Add comments to complex events
> - Use functions for repeated logic
> - Implement object pooling for frequently created objects
>
> **Estimated Impact:**
> - Load time: -30%
> - Runtime performance: +15%
> - Maintainability: Significantly improved

---

## Advanced Workflows

### Example 12: Refactoring Analysis

**Query:**
> "I want to refactor the event sheets. Which ones are most coupled?"

**Response:**
> **Coupling Analysis:**
>
> **High Coupling** (refactor priority):
> 1. **MainSheet** ← Includes everything (central hub)
> 2. **SpinMachine** ← Referenced by BigWin, AutoSpin, FreeSpin
> 3. **MainData** ← Used by almost all sheets for state
>
> **Medium Coupling**:
> - `SpinCheck` ↔ `SpinMachine`
> - `BetOption` ↔ `MainData`
>
> **Low Coupling** (independent):
> - `Menu`, `Paytable`, `History` - UI only
>
> **Refactoring Suggestions:**
> 1. Extract shared logic from MainData into utility functions
> 2. Create event interfaces between SpinMachine and features
> 3. Consider event-driven architecture with custom events
> 4. Move validation logic to separate validator sheet
>
> **Refactoring Order:**
> 1. Start with low-coupling sheets (safe to refactor)
> 2. Create interfaces for high-coupling sheets
> 3. Gradually decouple SpinMachine from features
> 4. Finally refactor MainData

---

### Example 13: Migration Planning

**Query:**
> "I'm upgrading to a new Construct3 version. What should I check?"

**Response:**
> **Migration Checklist:**
>
> **Custom Plugins** (check compatibility):
> - ✓ Omnitronix_PlatformConnect v2.0.22
> - ✓ Gritsenko_Spine v2.9.0
>
> **Deprecated Features** (review release notes):
> - Check if any behaviors changed
> - Review event changes
> - Test AJAX endpoints
>
> **Testing Priority:**
> 1. **Critical Path**: SpinMachine → BigWin flow
> 2. **Platform Integration**: OmnitronixPlatformConnect
> 3. **Animations**: All Spine animations
> 4. **UI**: Menu, History, Paytable screens
> 5. **Data**: Save/load, AJAX communication
>
> **Backup Strategy:**
> - Create full project backup
> - Export event sheets as JSON
> - Document current behavior with screenshots
> - Use version control (git) for rollback
>
> **Post-Migration:**
> - Run through full gameplay loop
> - Test on target devices
> - Check console for warnings
> - Verify analytics still work

---

### Example 14: Debugging Assistance

**Query:**
> "The spin button sometimes doesn't respond. Help me debug this."

**Response:**
> **Debugging: Spin Button Not Responding**
>
> Let me check the spin button implementation...
>
> **Potential Causes Found:**
>
> 1. **Button State Management** (in SpinMachine):
>    - Button disabled during: spin, auto-spin, insufficient balance
>    - Check if button is being re-enabled after spin completes
>
> 2. **Touch/Click Events** (in MainSheet):
>    - Both Touch and Mouse objects registered
>    - Potential conflict on some devices
>
> 3. **Z-Order Issues**:
>    - `black_overlay` or `loading` objects might be covering button
>    - Check layer visibility during spin
>
> **Debugging Steps:**
> 1. Add console log when button clicked
> 2. Check button.isEnabled property
> 3. Verify no overlapping invisible objects
> 4. Test touch vs mouse input separately
> 5. Review AutoSpin disable logic
>
> **Recommended Fix:**
> ```
> Event: On spin complete
>   → Wait 0.1 seconds
>   → Set spin_btn enabled
>   → Set spin_btn visible
>   → Console.log "Button re-enabled"
> ```
>
> Would you like me to check any specific event sheet for this logic?

---

## Tips and Tricks

### Working with Large Projects

**Query:**
> "This project is huge. How can I navigate it efficiently?"

**Response:**
> **Navigation Tips:**
>
> 1. **Start with Summary**: Use `get_project_summary` first
> 2. **Search Before Reading**: Use `search_objects` to find specific items
> 3. **Follow Dependencies**: Check includes in MainSheet to understand hierarchy
> 4. **Use Prompts**: `analyze_project` and `review_game_logic` give big picture
> 5. **Focus on Feature**: Ask about specific event sheets one at a time
>
> **Workflow Example:**
> ```
> 1. "Give me a project summary"
> 2. "List all event sheets"
> 3. "Explain the SpinMachine event sheet"
> 4. "Find all references to AJAX"
> 5. "Document the spin flow"
> ```

---

**Document Version**: 1.0
**Last Updated**: 2025-10-12
