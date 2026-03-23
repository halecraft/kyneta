export const section = (n: number, title: string) => {
  console.log()
  console.log(`${"═".repeat(68)}`)
  console.log(`  ${n}. ${title}`)
  console.log(`${"═".repeat(68)}`)
  console.log()
}

export const log = (msg: string) => {
  let lines = msg.split("\n")
  if (lines.length > 1 && lines[0]?.trim() === "") lines = lines.slice(1)
  if (lines.length > 1 && lines[lines.length - 1]?.trim() === "")
    lines = lines.slice(0, -1)

  let minIndent = Infinity
  for (const line of lines) {
    if (line.trim() === "") continue
    const match = line.match(/^(\s*)/)
    if (match) minIndent = Math.min(minIndent, match[1]?.length)
  }
  if (!Number.isFinite(minIndent)) minIndent = 0

  for (const line of lines) {
    console.log(`  ${line.slice(minIndent)}`)
  }
}

export const json = (v: unknown) => JSON.stringify(v, null, 2)
