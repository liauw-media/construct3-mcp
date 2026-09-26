# runtime-traps-real fixture

Editor-saved Construct 3 event sheets from two public MIT-licensed projects,
used by `test/construct3/runtime-traps.test.ts` to run `find_runtime_traps`
on real file shapes: System *Signal* / *Wait for signal* across sheets, a
disabled action, array-form script actions with `"language": "javascript"`,
string-form script actions inside function blocks with `functionParameters`,
and an *Imports for events* script listed with
`"script-info": {"purpose": "imports-for-events"}`.

`project.c3proj` was written for this fixture (same layout as
`minimal-project`). It lists only the files below and is not meant to open in
the editor.

| File | Source | Changes |
|------|--------|---------|
| `eventSheets/dialogue.json` | [clausia/quantum_minds](https://github.com/clausia/quantum_minds) `eventSheets/dialogue.json` | none |
| `eventSheets/lab_events.json` | same repo, `eventSheets/lab_events.json` | none |
| `eventSheets/interrogation_text_events.json` | same repo, `eventSheets/interrogation_text_events.json` | none |
| `eventSheets/tomography_control.json` | same repo, `eventSheets/tomography_control.json` | trimmed to 3 of the 4 top-level events that hold script actions (System *On start of layout*, slider_theta *On changing*, and Mouse *On object clicked* accept_button with its sub-events); the slider_phi *On changing* event, whose script duplicates slider_theta's, was left out; kept events are unchanged |
| `eventSheets/c3_json_helper.json` | [el3um4s/construct-demo](https://github.com/el3um4s/construct-demo) `template/001-top-down-shooter-laser-game/source/files/eventSheets/c3_json_helper.json` | none |
| `scripts/importsForEvents.js` | same repo, `javascript/014-c3-typescript-svelte/source/scripts/importsForEvents.js` | none |

## Licenses

### clausia/quantum_minds

MIT License

Copyright (c) 2025 Claudia Zendejas-Morales

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### el3um4s/construct-demo

MIT License

Copyright (c) 2020 Samuele de Tomasi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
