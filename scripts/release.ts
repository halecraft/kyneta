#!/usr/bin/env bun

/**
 * Release script for Kyneta monorepo.
 *
 * Usage:
 *   bun scripts/release.ts bump <version> [--group core|backends|transport|bindings|all]
 *   bun scripts/release.ts publish [--dry-run]
 *   bun scripts/release.ts status
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { resolve, relative } from "node:path"
import { execSync } from "node:child_process"

// ── Version Groups ──────────────────────────────────────────────────────────

const GROUPS = {
	core: [
		"packages/schema",
		"packages/compiler",
		"packages/exchange",
		"packages/cast",
	],
	backends: ["packages/schema/backends/loro", "packages/schema/backends/yjs"],
	transport: [
		"packages/exchange/wire",
		"packages/exchange/transports/sse",
		"packages/exchange/transports/websocket",
	],
	stores: ["packages/exchange/stores/leveldb"],
	bindings: ["packages/react"],
} as const

type GroupName = keyof typeof GROUPS

const ALL_GROUP_NAMES = Object.keys(GROUPS) as GroupName[]

// Publish tiers — dependency order (tier 0 first, tier 3 last)
const PUBLISH_TIERS: string[][] = [
	// Tier 0: leaf
	["packages/schema"],
	// Tier 1: depends on schema
	[
		"packages/compiler",
		"packages/exchange",
		"packages/schema/backends/loro",
		"packages/schema/backends/yjs",
	],
	// Tier 2: depends on tier 1
	[
		"packages/cast",
		"packages/exchange/wire",
		"packages/exchange/stores/leveldb",
		"packages/react",
	],
	// Tier 3: depends on tier 2
	[
		"packages/exchange/transports/sse",
		"packages/exchange/transports/websocket",
	],
]

// All publishable package directories (flattened from tiers)
const ALL_PACKAGE_DIRS = PUBLISH_TIERS.flat()

// All workspace package.json locations (including non-publishable like tests, examples)
const ALL_WORKSPACE_JSONS = [
	...ALL_PACKAGE_DIRS.map((d) => `${d}/package.json`),
	"packages/perspective/package.json",
	"tests/exchange-websocket/package.json",
	"examples/todo/package.json",
	"examples/todo-react/package.json",
	"examples/bumper-cars/package.json",
]

// ── Helpers ──────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..")

function rootPath(p: string): string {
	return resolve(ROOT, p)
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(rootPath(path), "utf8"))
}

function writeJson(path: string, data: Record<string, unknown>): void {
	writeFileSync(rootPath(path), JSON.stringify(data, null, 2) + "\n")
}

function isValidSemver(v: string): boolean {
	return /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)
}

function getPackageName(dir: string): string {
	const pkg = readJson(`${dir}/package.json`)
	return pkg.name as string
}

function run(cmd: string, opts?: { dryRun?: boolean; cwd?: string }): void {
	if (opts?.dryRun) {
		console.log(`  [dry-run] ${cmd}`)
		return
	}
	console.log(`  $ ${cmd}`)
	execSync(cmd, { cwd: opts?.cwd ?? ROOT, stdio: "inherit" })
}

// ── bump ────────────────────────────────────────────────────────────────────

function bump(version: string, groupNames: GroupName[]): void {
	if (!isValidSemver(version)) {
		console.error(`Invalid semver: ${version}`)
		process.exit(1)
	}

	// Collect directories to bump
	const dirs = groupNames.flatMap((g) => [...GROUPS[g]])

	// Build name → version map for peer dependency updates
	const nameVersionMap = new Map<string, string>()
	for (const dir of dirs) {
		nameVersionMap.set(getPackageName(dir), version)
	}

	// 1. Bump versions in target packages
	console.log(`\nBumping to ${version}:\n`)
	for (const dir of dirs) {
		const pkgPath = `${dir}/package.json`
		const pkg = readJson(pkgPath)
		const oldVersion = pkg.version as string
		pkg.version = version
		writeJson(pkgPath, pkg)
		console.log(`  ${pkg.name}: ${oldVersion} → ${version}`)
	}

	// 2. Update peerDependency ranges across ALL workspace packages
	console.log(`\nUpdating peer dependency ranges:\n`)
	let peerUpdates = 0
	for (const jsonPath of ALL_WORKSPACE_JSONS) {
		if (!existsSync(rootPath(jsonPath))) continue
		const pkg = readJson(jsonPath)
		const peers = pkg.peerDependencies as
			| Record<string, string>
			| undefined
		if (!peers) continue

		let changed = false
		for (const [name, newVersion] of nameVersionMap) {
			if (name in peers) {
				const oldRange = peers[name]
				const newRange = `^${newVersion}`
				if (oldRange !== newRange) {
					peers[name] = newRange
					console.log(
						`  ${relative(ROOT, rootPath(jsonPath))}: ${name} ${oldRange} → ${newRange}`,
					)
					changed = true
					peerUpdates++
				}
			}
		}
		if (changed) {
			writeJson(jsonPath, pkg)
		}
	}

	if (peerUpdates === 0) {
		console.log("  (no peer dependency ranges changed)")
	}

	console.log(
		`\nDone. Bumped ${dirs.length} package(s), updated ${peerUpdates} peer dep range(s).\n`,
	)
}

// ── publish ─────────────────────────────────────────────────────────────────

function checkNpmAuth(): void {
	console.log("Checking npm authentication...\n")
	try {
		const user = execSync("npm whoami", { cwd: ROOT, encoding: "utf8" }).trim()
		console.log(`  Logged in as: ${user}\n`)
	} catch {
		console.error(
			"Error: Not logged in to npm. Run `npm login` first.\n",
		)
		process.exit(1)
	}
}

function publish(dryRun: boolean): void {
	console.log(`\n${dryRun ? "[DRY RUN] " : ""}Publishing Kyneta packages\n`)

	// 0. Preflight — verify npm auth
	checkNpmAuth()

	// 1. Build
	console.log("Step 1/3: Building all packages...\n")
	run("pnpm build")

	// 2. Test
	console.log("\nStep 2/3: Running tests...\n")
	run("pnpm test")

	// 3. Publish in tier order
	console.log("\nStep 3/3: Publishing in dependency order...\n")
	const published: string[] = []
	const failed: string[] = []

	for (let tier = 0; tier < PUBLISH_TIERS.length; tier++) {
		const dirs = PUBLISH_TIERS[tier]
		console.log(`\n── Tier ${tier} ──`)
		for (const dir of dirs) {
			const pkg = readJson(`${dir}/package.json`)
			const name = pkg.name as string
			const version = pkg.version as string
			console.log(`\nPublishing ${name}@${version}...`)
			const dryRunFlag = dryRun ? " --dry-run" : ""
			try {
				run(
					`pnpm publish --access public --no-git-checks${dryRunFlag}`,
					{ cwd: rootPath(dir) },
				)
				published.push(name)
			} catch {
				console.error(`  ✗ Failed to publish ${name}@${version}`)
				failed.push(name)
			}
		}
	}

	// Summary
	console.log(`\n── Summary ──\n`)
	if (published.length > 0) {
		console.log(
			`  ${dryRun ? "[DRY RUN] " : ""}Published (${published.length}): ${published.join(", ")}`,
		)
	}
	if (failed.length > 0) {
		console.log(`  Failed (${failed.length}): ${failed.join(", ")}`)
		process.exit(1)
	}
	console.log()
}

// ── status ──────────────────────────────────────────────────────────────────

async function status(): Promise<void> {
	console.log("\nKyneta Package Status\n")

	for (const groupName of ALL_GROUP_NAMES) {
		const dirs = GROUPS[groupName]
		console.log(`  ${groupName}:`)
		for (const dir of dirs) {
			const pkg = readJson(`${dir}/package.json`)
			const name = pkg.name as string
			const localVersion = pkg.version as string

			let registryVersion: string
			try {
				const resp = await fetch(
					`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
				)
				if (resp.ok) {
					const data = (await resp.json()) as { version: string }
					registryVersion = data.version
				} else {
					registryVersion = "not published"
				}
			} catch {
				registryVersion = "fetch error"
			}

			const marker =
				registryVersion === "not published"
					? "○"
					: localVersion === registryVersion
						? "✓"
						: "↑"
			console.log(
				`    ${marker} ${name.padEnd(42)} local: ${localVersion.padEnd(10)} npm: ${registryVersion}`,
			)
		}
		console.log()
	}
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function usage(): never {
	console.log(`
Usage:
  bun scripts/release.ts bump <version> [--group core|backends|transport|stores|bindings|all]
  bun scripts/release.ts publish [--dry-run]
  bun scripts/release.ts status

Commands:
  bump      Set version for packages in the specified group(s) and update peer dep ranges.
  publish   Build, test, and publish all packages in dependency order.
  status    Show local vs. npm registry versions for all packages.

Groups (for bump):
  core       schema, compiler, exchange, cast (locked versions)
  backends   loro-schema, yjs-schema
  transport  wire, sse-transport, websocket-transport
  stores     leveldb-store
  bindings   react
  all        all of the above (default)
`)
	process.exit(1)
}

const [command, ...rest] = process.argv.slice(2)

switch (command) {
	case "bump": {
		const version = rest.find((a: string) => !a.startsWith("--"))
		if (!version) {
			console.error("Error: version argument required")
			usage()
		}
		const groupFlag = rest.find((a: string) => a.startsWith("--group"))
		let groupNames: GroupName[] = ALL_GROUP_NAMES
		if (groupFlag) {
			// Support --group=core or --group core
			let groupValue: string | undefined
			if (groupFlag.includes("=")) {
				groupValue = groupFlag.split("=")[1]
			} else {
				const idx = rest.indexOf(groupFlag)
				groupValue = rest[idx + 1]
			}
			if (!groupValue) {
				console.error("Error: --group requires a value")
				usage()
			}
			if (groupValue === "all") {
				groupNames = ALL_GROUP_NAMES
			} else if (groupValue in GROUPS) {
				groupNames = [groupValue as GroupName]
			} else {
				console.error(
					`Error: unknown group "${groupValue}". Valid: ${ALL_GROUP_NAMES.join(", ")}, all`,
				)
				process.exit(1)
			}
		}
		bump(version, groupNames)
		break
	}
	case "publish": {
		const dryRun = rest.includes("--dry-run")
		publish(dryRun)
		break
	}
	case "status": {
		await status()
		break
	}
	default:
		if (command) console.error(`Unknown command: ${command}\n`)
		usage()
}