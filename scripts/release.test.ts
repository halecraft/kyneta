import { describe, test, expect } from "bun:test"
import { execSync } from "node:child_process"
import { resolve } from "node:path"
import { computePublishTiers, deriveGroup } from "./release"

// ── WorkspacePackage factory ────────────────────────────────────────────────

type WorkspacePackage = Parameters<typeof computePublishTiers>[0][number]

function pkg(
	name: string,
	deps: string[] = [],
	path = `packages/${name}`,
): WorkspacePackage {
	return {
		name: `@kyneta/${name}`,
		version: "1.0.0",
		path,
		private: false,
		internalDeps: deps.map((d) => `@kyneta/${d}`),
		group: deriveGroup(path),
	}
}

// ── deriveGroup ─────────────────────────────────────────────────────────────

describe("deriveGroup", () => {
	test("packages/* → core", () => {
		expect(deriveGroup("packages/schema")).toBe("core")
		expect(deriveGroup("packages/exchange")).toBe("core")
		expect(deriveGroup("packages/changefeed")).toBe("core")
		expect(deriveGroup("packages/machine")).toBe("core")
	})

	test("packages/schema/backends/* → backends", () => {
		expect(deriveGroup("packages/schema/backends/loro")).toBe("backends")
		expect(deriveGroup("packages/schema/backends/yjs")).toBe("backends")
	})

	test("packages/exchange/transports/* → transport", () => {
		expect(deriveGroup("packages/exchange/transports/sse")).toBe("transport")
		expect(deriveGroup("packages/exchange/transports/websocket")).toBe(
			"transport",
		)
		expect(deriveGroup("packages/exchange/transports/webrtc")).toBe(
			"transport",
		)
	})

	test("packages/exchange/stores/* → stores", () => {
		expect(deriveGroup("packages/exchange/stores/leveldb")).toBe("stores")
	})

	test("packages/react → bindings", () => {
		expect(deriveGroup("packages/react")).toBe("bindings")
	})

	test("experimental/* → experimental", () => {
		expect(deriveGroup("experimental/cast")).toBe("experimental")
		expect(deriveGroup("experimental/compiler")).toBe("experimental")
		expect(deriveGroup("experimental/perspective")).toBe("experimental")
	})

	test("unknown top-level dir → dir name", () => {
		expect(deriveGroup("tools/something")).toBe("tools")
	})
})

// ── computePublishTiers ─────────────────────────────────────────────────────

describe("computePublishTiers", () => {
	test("leaf packages form tier 0", () => {
		const packages = [pkg("a"), pkg("b"), pkg("c", ["a"])]
		const tiers = computePublishTiers(packages)

		expect(tiers).toHaveLength(2)
		expect(tiers[0].map((p) => p.name).sort()).toEqual([
			"@kyneta/a",
			"@kyneta/b",
		])
		expect(tiers[1].map((p) => p.name)).toEqual(["@kyneta/c"])
	})

	test("linear chain produces one package per tier", () => {
		const packages = [pkg("c", ["b"]), pkg("b", ["a"]), pkg("a")]
		const tiers = computePublishTiers(packages)

		expect(tiers).toHaveLength(3)
		expect(tiers[0][0].name).toBe("@kyneta/a")
		expect(tiers[1][0].name).toBe("@kyneta/b")
		expect(tiers[2][0].name).toBe("@kyneta/c")
	})

	test("diamond dependency resolves correctly", () => {
		//    a
		//   / \
		//  b   c
		//   \ /
		//    d
		const packages = [
			pkg("a"),
			pkg("b", ["a"]),
			pkg("c", ["a"]),
			pkg("d", ["b", "c"]),
		]
		const tiers = computePublishTiers(packages)

		expect(tiers).toHaveLength(3)
		expect(tiers[0].map((p) => p.name)).toEqual(["@kyneta/a"])
		expect(tiers[1].map((p) => p.name).sort()).toEqual([
			"@kyneta/b",
			"@kyneta/c",
		])
		expect(tiers[2].map((p) => p.name)).toEqual(["@kyneta/d"])
	})

	test("dependencies on packages outside the set are ignored", () => {
		// c depends on "external" which is not in the publishable set
		const packages = [
			pkg("a"),
			{
				...pkg("c", []),
				internalDeps: ["@kyneta/a", "@kyneta/external"],
			},
		]
		const tiers = computePublishTiers(packages)

		expect(tiers).toHaveLength(2)
		expect(tiers[0][0].name).toBe("@kyneta/a")
		expect(tiers[1][0].name).toBe("@kyneta/c")
	})

	test("empty input returns empty tiers", () => {
		expect(computePublishTiers([])).toEqual([])
	})

	test("all independent packages form a single tier", () => {
		const packages = [pkg("a"), pkg("b"), pkg("c")]
		const tiers = computePublishTiers(packages)

		expect(tiers).toHaveLength(1)
		expect(tiers[0]).toHaveLength(3)
	})

	test("cycle detection throws", () => {
		const packages = [pkg("a", ["b"]), pkg("b", ["a"])]
		expect(() => computePublishTiers(packages)).toThrow(
			/cycle detected/i,
		)
	})

	test("mirrors real kyneta topology", () => {
		const packages = [
			pkg("changefeed"),
			pkg("machine"),
			pkg("schema", ["changefeed"]),
			pkg("compiler", ["changefeed", "schema"], "experimental/compiler"),
			pkg("index", ["changefeed", "schema"]),
			pkg("loro-schema", ["changefeed", "schema"], "packages/schema/backends/loro"),
			pkg("transport", ["machine", "schema"]),
			pkg("yjs-schema", ["changefeed", "schema"], "packages/schema/backends/yjs"),
			pkg("cast", ["changefeed", "compiler", "schema"], "experimental/cast"),
			pkg("exchange", ["transport", "changefeed", "schema"]),
			pkg("wire", ["transport"], "packages/exchange/wire"),
			pkg("leveldb-store", ["exchange", "schema"], "packages/exchange/stores/leveldb"),
			pkg("react", ["changefeed", "schema", "exchange"]),
			pkg("sse-transport", ["machine", "transport", "wire"], "packages/exchange/transports/sse"),
			pkg("unix-socket-transport", ["transport", "machine", "wire"], "packages/exchange/transports/unix-socket"),
			pkg("webrtc-transport", ["transport", "wire"], "packages/exchange/transports/webrtc"),
			pkg("websocket-transport", ["transport", "machine", "wire"], "packages/exchange/transports/websocket"),
		]

		const tiers = computePublishTiers(packages)

		expect(tiers).toHaveLength(5)

		const tierNames = tiers.map((t) =>
			t.map((p) => p.name).sort(),
		)
		expect(tierNames[0]).toEqual(["@kyneta/changefeed", "@kyneta/machine"])
		expect(tierNames[1]).toEqual(["@kyneta/schema"])
		expect(tierNames[2]).toEqual([
			"@kyneta/compiler",
			"@kyneta/index",
			"@kyneta/loro-schema",
			"@kyneta/transport",
			"@kyneta/yjs-schema",
		])
		expect(tierNames[3]).toEqual([
			"@kyneta/cast",
			"@kyneta/exchange",
			"@kyneta/wire",
		])
		expect(tierNames[4]).toEqual([
			"@kyneta/leveldb-store",
			"@kyneta/react",
			"@kyneta/sse-transport",
			"@kyneta/unix-socket-transport",
			"@kyneta/webrtc-transport",
			"@kyneta/websocket-transport",
		])
	})
})

// ── Integration: status command ─────────────────────────────────────────────

describe("release.ts status (integration)", () => {
	const ROOT = resolve(import.meta.dirname, "..")

	test("exits 0 and lists all publishable packages", () => {
		const output = execSync("bun scripts/release.ts status", {
			cwd: ROOT,
			encoding: "utf8",
			timeout: 30_000,
		})

		const expected = [
			"@kyneta/changefeed",
			"@kyneta/schema",
			"@kyneta/exchange",
			"@kyneta/wire",
			"@kyneta/react",
			"@kyneta/loro-schema",
			"@kyneta/yjs-schema",
			"@kyneta/machine",
			"@kyneta/transport",
			"@kyneta/index",
			"@kyneta/cast",
			"@kyneta/compiler",
			"@kyneta/leveldb-store",
			"@kyneta/sse-transport",
			"@kyneta/websocket-transport",
			"@kyneta/unix-socket-transport",
			"@kyneta/webrtc-transport",
		]

		for (const name of expected) {
			expect(output).toContain(name)
		}

		// Groups should appear as section headers
		for (const group of [
			"core:",
			"backends:",
			"transport:",
			"stores:",
			"bindings:",
			"experimental:",
		]) {
			expect(output).toContain(group)
		}
	})
})