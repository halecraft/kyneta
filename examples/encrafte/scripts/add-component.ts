#!/usr/bin/env bun

import { existsSync } from "node:fs"
import { join } from "node:path"

const UI_DIR = join(import.meta.dir, "../src/components/ui")

const name = Bun.argv[2]
if (!name) {
  console.error("Usage: bun scripts/add-component.ts <component-name>")
  process.exit(1)
}

const pascal = name.replace(/(^|-)(\w)/g, (_, _sep, c) => c.toUpperCase())

const files: Record<string, string> = {
  [`${name}.tsx`]: [
    `import "./${name}.css"`,
    `export { ${pascal} } from "@ark-ui/react/${name}"`,
    "",
  ].join("\n"),

  [`${name}.css`]: `/* ${pascal} — styled wrapper for @ark-ui/react/${name}
 *
 * Docs: https://ark-ui.com/docs/components/${name}
 * See: src/components/ui/${name}.prompt.md for styling guidance
 */

[data-scope="${name}"][data-part="root"] {
  /* TODO: style this component using design tokens from tokens.css */
}
`,

  [`${name}.prompt.md`]: `# Style: ${pascal}

## Component
- Ark UI \`${pascal}\` — https://ark-ui.com/docs/components/${name}
- Import: \`@ark-ui/react/${name}\`

## Styling Method
- Target parts with \`[data-scope="${name}"][data-part="..."]\` CSS selectors
- Target states with \`[data-state="open"]\`, \`[data-state="closed"]\`, etc.

## Design Tokens (from \`tokens.css\`)
### Colors
- Backgrounds: \`--color-bg-canvas\`, \`--color-bg-surface\`, \`--color-bg-subtle\`, \`--color-bg-muted\`
- Foregrounds: \`--color-fg-default\`, \`--color-fg-muted\`, \`--color-fg-subtle\`
- Borders: \`--color-border-default\`, \`--color-border-subtle\`
- Accent (solid): \`--color-accent-solid-bg\`, \`--color-accent-solid-fg\`, \`--color-accent-solid-bg-hover\`
- Accent (subtle): \`--color-accent-subtle-bg\`, \`--color-accent-subtle-fg\`
- Accent (outline): \`--color-accent-outline-border\`, \`--color-accent-outline-fg\`
- Raw scale: \`--violet-1\` to \`--violet-12\`, \`--mauve-1\` to \`--mauve-12\`

### Sizing & Spacing
- Heights: \`--size-xs\` (32px) through \`--size-xl\` (48px)
- Radii: \`--radius-l1\` (4px), \`--radius-l2\` (6px), \`--radius-l3\` (8px), \`--radius-full\`
- Shadows: \`--shadow-xs\` through \`--shadow-xl\`

### Typography
- Font: \`--font-sans\`, \`--font-mono\`
- Sizes: \`--font-size-xs\` (11px) through \`--font-size-xl\` (20px)

## Aesthetic
- Dark theme by default (light also supported via data-theme)
- Minimalist, high-contrast
- Subtle animations: 150ms transitions on opacity, transform, border-color
- Use \`backdrop-filter: blur(4px)\` on overlays
- Consistent 4px/8px/12px/16px/20px/24px spacing increments

## Reference Components
- See \`dialog.css\`, \`tooltip.css\`, \`field.css\` in this directory for examples of the styling pattern
`,
}

const created: string[] = []
const skipped: string[] = []

for (const [filename, content] of Object.entries(files)) {
  const path = join(UI_DIR, filename)
  if (existsSync(path)) {
    skipped.push(filename)
  } else {
    await Bun.write(path, content)
    created.push(filename)
  }
}

// Append barrel export
const barrelPath = join(UI_DIR, "index.ts")
const exportLine = `export { ${pascal} } from "./${name}.js"`
const barrelContent = existsSync(barrelPath)
  ? await Bun.file(barrelPath).text()
  : ""

if (barrelContent.includes(exportLine)) {
  skipped.push("index.ts (export already present)")
} else {
  const sep = barrelContent.length && !barrelContent.endsWith("\n") ? "\n" : ""
  await Bun.write(barrelPath, `${barrelContent + sep + exportLine}\n`)
  created.push("index.ts")
}

console.log(`\n  ✓ ${pascal} component stub\n`)
if (created.length) console.log(`  Created: ${created.join(", ")}`)
if (skipped.length) console.log(`  Skipped: ${skipped.join(", ")}`)
console.log()
