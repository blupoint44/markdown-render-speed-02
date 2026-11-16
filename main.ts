// Driver for the markdown-render-speed-02 entry.
//
// Reads every case from cases.json in the input directory (MAKEFUN_INPUT_DIR,
// or /input inside the grading container), renders each case on its own with
// parse() from ./parse.js, and writes the HTML strings, in the cases' order,
// as a JSON array to html.json in the output directory (MAKEFUN_OUTPUT_DIR,
// or /output).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

// Resolve both directories once, up front, so the render loop below does no
// environment or path work per case. Precedence: --input/--output flags,
// then the MAKEFUN_*_DIR environment variables, then the container paths.
function resolveDirs(argv: string[]): { inputDir: string; outputDir: string } {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0 || i + 1 >= argv.length) return undefined;
    // A following token that is itself a flag is not this flag's value:
    // `--input --output /x` means --input was left dangling, and taking
    // '--output' as a directory would surface as a baffling ENOENT later.
    const v = argv[i + 1];
    return v.startsWith('--') ? undefined : v;
  };
  return {
    inputDir: flag('--input') ?? process.env.MAKEFUN_INPUT_DIR ?? '/input',
    outputDir: flag('--output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output',
  };
}

function loadCases(inputDir: string): Case[] {
  const path = join(inputDir, 'cases.json');
  // Strip a UTF-8 BOM if present: JSON.parse rejects it, and harness-side
  // writers have been known to emit one.
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const data: unknown = JSON.parse(raw);
  // Validate the shape up front: a malformed cases file should fail here,
  // naming the file, not as a TypeError deep inside the render loop.
  if (!Array.isArray(data)) {
    throw new Error(`${path}: expected a JSON array of cases`);
  }
  for (const c of data as Case[]) {
    if (typeof c?.id !== 'string' || typeof c?.markdown !== 'string') {
      throw new Error(`${path}: every case needs a string id and markdown`);
    }
  }
  return data as Case[];
}

// Render into a preallocated array: cases are independent, order is the
// input order, and a failure names the offending case instead of surfacing
// as a bare stack from deep inside the renderer.
function renderAll(cases: Case[]): string[] {
  const html = new Array<string>(cases.length);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    try {
      html[i] = parse(c.markdown);
    } catch (err) {
      throw new Error(`failed to render case ${c.id}: ${(err as Error).message}`);
    }
  }
  return html;
}

const { inputDir, outputDir } = resolveDirs(process.argv.slice(2));
const html = renderAll(loadCases(inputDir));
// The output directory is created if needed: the driver should not depend
// on the harness having prepared it.
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
