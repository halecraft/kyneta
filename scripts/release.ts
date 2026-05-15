#!/usr/bin/env bun

/**
 * Release script for Kyneta monorepo.
 *
 * All workspace topology is discovered at runtime from pnpm + package.json files.
 * No hardcoded package lists — adding or moving a package requires zero changes here.
 *
 * Usage:
 *   bun scripts/release.ts bump <version> [--group core|backends|transport|stores|bindings|experimental|all]
 *   bun scripts/release.ts publish [--dry-run]
 *   bun scripts/release.ts status
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve, relative } from "node:path"
import { execSync } from "node:child_process"

// ── Types ───────────────────────────────────────────────────────────────────

type WorkspacePackage = {
	name: string
	version: string
	path: string // relative to repo root, e.g. "packages/schema"
	private: boolean
	internalDeps: string[] // @kyneta/* names from dependencies ∪ peerDependencies
	group: string // derived from directory convention
}

type Workspace = {
	all: WorkspacePackage[]
	publishable: WorkspacePackage[]
	groups: Map<string, WorkspacePackage[]>
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..")
const RELEASE_REMOTES = ["origin", "github"]

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

function run(cmd: string, opts?: { dryRun?: boolean; cwd?: string }): void {
	if (opts?.dryRun) {
		console.log(`  [dry-run] ${cmd}`)
		return
	}
	console.log(`  $ ${cmd}`)
	execSync(cmd, { cwd: opts?.cwd ?? ROOT, stdio: "inherit" })
}

// ── Workspace Discovery ─────────────────────────────────────────────────────

/** Derive group from directory convention. Pure function of the relative path. */
export function deriveGroup(relPath: string): string {
	if (relPath.startsWith("experimental/")) return "experimental"
	if (relPath.startsWith("packages/schema/backends/")) return "backends"
	if (relPath.startsWith("packages/exchange/transports/")) return "transport"
	if (relPath.startsWith("packages/exchange/stores/")) return "stores"
	if (relPath === "packages/react") return "bindings"
	if (relPath.startsWith("packages/")) return "core"
	// Fallback for any future top-level directories
	return relPath.split("/")[0]
}

type PnpmListEntry = {
	name: string
	version?: string
	path: string
	private?: boolean
}

function discoverWorkspace(): Workspace {
	const raw = execSync("pnpm ls -r --depth -1 --json", {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	})
	const entries = JSON.parse(raw) as PnpmListEntry[]

	const all: WorkspacePackage[] = []

	for (const entry of entries) {
		// Skip the root workspace package
		if (resolve(entry.path) === ROOT) continue

		const relPath = relative(ROOT, resolve(entry.path))
		const pkgJson = readJson(`${relPath}/package.json`)

		const deps = pkgJson.dependencies as Record<string, string> | undefined
		const peerDeps = pkgJson.peerDependencies as
			| Record<string, string>
			| undefined
		const internalDeps = [
			...new Set([
				...Object.keys(deps ?? {}).filter((k) => k.startsWith("@kyneta/")),
				...Object.keys(peerDeps ?? {}).filter((k) =>
					k.startsWith("@kyneta/"),
				),
			]),
		].sort()

		all.push({
			name: entry.name,
			version: (pkgJson.version as string) ?? "0.0.0",
			path: relPath,
			private: entry.private ?? false,
			internalDeps,
			group: deriveGroup(relPath),
		})
	}

	const publishable = all.filter((p) => !p.private)

	const groups = new Map<string, WorkspacePackage[]>()
	for (const pkg of publishable) {
		const existing = groups.get(pkg.group)
		if (existing) {
			existing.push(pkg)
		} else {
			groups.set(pkg.group, [pkg])
		}
	}
	// Sort each group's packages by name for stable output
	for (const pkgs of groups.values()) {
		pkgs.sort((a, b) => a.name.localeCompare(b.name))
	}

	return { all, publishable, groups }
}

// ── Topological Sort ────────────────────────────────────────────────────────

/**
 * Compute publish tiers via Kahn's algorithm.
 * Each tier contains packages whose dependencies are all in earlier tiers.
 */
export function computePublishTiers(
	packages: WorkspacePackage[],
): WorkspacePackage[][] {
	const nameToPackage = new Map(packages.map((p) => [p.name, p]))
	const inDegree = new Map(packages.map((p) => [p.name, 0]))
	const dependents = new Map(packages.map((p) => [p.name, [] as string[]]))

	for (const pkg of packages) {
		for (const dep of pkg.internalDeps) {
			if (nameToPackage.has(dep)) {
				dependents.get(dep)!.push(pkg.name)
				inDegree.set(pkg.name, inDegree.get(pkg.name)! + 1)
			}
		}
	}

	const tiers: WorkspacePackage[][] = []
	let queue = packages
		.filter((p) => inDegree.get(p.name) === 0)
		.sort((a, b) => a.name.localeCompare(b.name))

	while (queue.length > 0) {
		tiers.push(queue)
		const next: WorkspacePackage[] = []
		for (const pkg of queue) {
			for (const child of dependents.get(pkg.name)!) {
				const newDegree = inDegree.get(child)! - 1
				inDegree.set(child, newDegree)
				if (newDegree === 0) {
					next.push(nameToPackage.get(child)!)
				}
			}
		}
		queue = next.sort((a, b) => a.name.localeCompare(b.name))
	}

	// Cycle detection: if any package still has in-degree > 0, there's a cycle
	const stuck = packages.filter((p) => inDegree.get(p.name)! > 0)
	if (stuck.length > 0) {
		const names = stuck.map((p) => p.name).join(", ")
		throw new Error(`Dependency cycle detected among: ${names}`)
	}

	return tiers
}

// ── bump ────────────────────────────────────────────────────────────────────

function bump(version: string, groupNames: string[]): void {
	if (!isValidSemver(version)) {
		console.error(`Invalid semver: ${version}`)
		process.exit(1)
	}

	const workspace = discoverWorkspace()
	const allGroupNames = [...workspace.groups.keys()].sort()

	// Resolve group names to packages
	const resolvedNames =
		groupNames[0] === "all" ? allGroupNames : groupNames
	const dirs: WorkspacePackage[] = []
	for (const g of resolvedNames) {
		const pkgs = workspace.groups.get(g)
		if (!pkgs) {
			console.error(
				`Error: unknown group "${g}". Valid: ${allGroupNames.join(", ")}, all`,
			)
			process.exit(1)
		}
		dirs.push(...pkgs)
	}

	// Bump versions in target packages. Workspace-internal dependents use
	// `workspace:^` everywhere (deps, devDeps, peerDeps), so cross-package
	// ranges resolve to the new version automatically. `pnpm publish`
	// rewrites `workspace:^` to `^<version>` in the published tarball.
	console.log(`\nBumping to ${version}:\n`)
	for (const pkg of dirs) {
		const pkgPath = `${pkg.path}/package.json`
		const pkgJson = readJson(pkgPath)
		const oldVersion = pkgJson.version as string
		pkgJson.version = version
		writeJson(pkgPath, pkgJson)
		console.log(`  ${pkg.name}: ${oldVersion} → ${version}`)
	}

	console.log(`\nDone. Bumped ${dirs.length} package(s).\n`)
}

// ── publish ─────────────────────────────────────────────────────────────────

function checkNpmAuth(): void {
	console.log("Checking npm authentication...\n")
	try {
		const user = execSync("npm whoami", {
			cwd: ROOT,
			encoding: "utf8",
		}).trim()
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

	const workspace = discoverWorkspace()
	const tiers = computePublishTiers(workspace.publishable)

	// 0. Preflight — verify npm auth
	checkNpmAuth()

	// 1. Build
	console.log("Step 1/4: Building all packages...\n")
	run("pnpm build")

	// 2. Test
	console.log("\nStep 2/4: Running tests...\n")
	run("pnpm test")

	if (workspace.publishable.length === 0) {
		console.log("No publishable packages found. Nothing to publish.\n")
		return
	}

	const version = workspace.publishable[0].version

	// 3. Publish in tier order
	console.log("\nStep 3/4: Publishing in dependency order...\n")
	const published: string[] = []
	const failed: string[] = []

	for (let tier = 0; tier < tiers.length; tier++) {
		const pkgs = tiers[tier]
		console.log(`\n── Tier ${tier} (${pkgs.map((p) => p.name).join(", ")}) ──`)
		for (const pkg of pkgs) {
			console.log(`\nPublishing ${pkg.name}@${pkg.version}...`)
			const dryRunFlag = dryRun ? " --dry-run" : ""
			try {
				run(
					`pnpm publish --access public --no-git-checks${dryRunFlag}`,
					{ cwd: rootPath(pkg.path) },
				)
				published.push(pkg.name)
			} catch {
				console.error(
					`  ✗ Failed to publish ${pkg.name}@${pkg.version}`,
				)
				failed.push(pkg.name)
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

	// 4. Tag the release
	const tagName = `v${version}`
	console.log(`\nStep 4/4: Tagging release as ${tagName}...\n`)

	if (dryRun) {
		run(`git tag ${tagName}`, { dryRun })
		for (const remote of RELEASE_REMOTES) {
			run(`git push ${remote} ${tagName}`, { dryRun })
		}
	} else {
		const existingTag = execSync(`git tag -l "${tagName}"`, {
			cwd: ROOT,
			encoding: "utf8",
		}).trim()

		if (existingTag) {
			const tagCommit = execSync(`git rev-list -n 1 "${tagName}"`, {
				cwd: ROOT,
				encoding: "utf8",
			}).trim()
			const headCommit = execSync("git rev-parse HEAD", {
				cwd: ROOT,
				encoding: "utf8",
			}).trim()

			if (tagCommit === headCommit) {
				console.log(`  Tag ${tagName} already exists on HEAD, skipping.`)
			} else {
				console.error(
					`Error: tag ${tagName} already exists on commit ${tagCommit.slice(0, 8)}, but HEAD is ${headCommit.slice(0, 8)}.`,
				)
				console.error("Delete the existing tag or use a different version.")
				process.exit(1)
			}
		} else {
			run(`git tag ${tagName}`)
			for (const remote of RELEASE_REMOTES) {
				run(`git push ${remote} ${tagName}`)
			}
		}
	}

	console.log()
}

// ── status ──────────────────────────────────────────────────────────────────

async function status(): Promise<void> {
	console.log("\nKyneta Package Status\n")

	const workspace = discoverWorkspace()

	for (const [groupName, pkgs] of [...workspace.groups.entries()].sort(
		([a], [b]) => a.localeCompare(b),
	)) {
		console.log(`  ${groupName}:`)
		for (const pkg of pkgs) {
			let registryVersion: string
			try {
				const resp = await fetch(
					`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`,
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
					: pkg.version === registryVersion
						? "✓"
						: "↑"
			console.log(
				`    ${marker} ${pkg.name.padEnd(42)} local: ${pkg.version.padEnd(10)} npm: ${registryVersion}`,
			)
		}
		console.log()
	}
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function usage(): never {
	// Discover available groups dynamically
	let groupList: string
	try {
		const workspace = discoverWorkspace()
		groupList = [...workspace.groups.keys()].sort().join("|")
	} catch {
		groupList = "<group>"
	}

	console.log(`
Usage:
  bun scripts/release.ts bump <version> [--group ${groupList}|all]
  bun scripts/release.ts publish [--dry-run]
  bun scripts/release.ts status

Commands:
  bump      Set version for packages in the specified group(s). Workspace-internal
            ranges (deps, devDeps, peerDeps) all use "workspace:^" and follow
            automatically — pnpm publish rewrites them in the tarball.
  publish   Build, test, and publish all packages in dependency order.
  status    Show local vs. npm registry versions for all packages.

Groups are derived from directory convention:
  core          packages/* (top-level packages)
  backends      packages/schema/backends/*
  transport     packages/exchange/transports/*
  stores        packages/exchange/stores/*
  bindings      packages/react
  experimental  experimental/*
  all           all of the above (default)
`)
	process.exit(1)
}

if (!import.meta.main) {
	// Module imported as a library — skip CLI execution
} else {

const [command, ...rest] = process.argv.slice(2)

switch (command) {
	case "bump": {
		const version = rest.find((a: string) => !a.startsWith("--"))
		if (!version) {
			console.error("Error: version argument required")
			usage()
		}
		const groupFlag = rest.find((a: string) => a.startsWith("--group"))
		let groupNames: string[] = ["all"]
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
			groupNames = [groupValue]
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

} // end import.meta.main guard