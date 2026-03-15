// ═══════════════════════════════════════════════════════════════════════════
//
//   Seed<S> Prototype Experiment
//
//   Goal: a purpose-built recursive type that gives Partial<Plain<S>>
//   semantics without hitting TS2589 on complex schemas.
//
//   Type-check:  npx tsc --project tsconfig.seed-experiment.json
//   Run:         bun run example/seed-experiment.ts
//
// ═══════════════════════════════════════════════════════════════════════════

import {
	Schema,
} from "../src/index.js";

import type {
	Schema as SchemaType,
	AnnotatedSchema,
	ScalarSchema,
	ProductSchema,
	SequenceSchema,
	MapSchema,
	PositionalSumSchema,
	DiscriminatedSumSchema,
	Plain,
} from "../src/index.js";

// ═══════════════════════════════════════════════════════════════════════════
//
//   Type Definitions
//
// ═══════════════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// Approach A: Full recursive mirror of Plain, with optional keys at products
//
// Mirrors the structure of Plain<S> exactly, but products use `[K]?:` instead
// of `[K]:`. This is the most correct approach — but may hit TS2589 when used
// as a generic parameter because TS must resolve the full recursive conditional.
// ---------------------------------------------------------------------------

type SeedA<S extends SchemaType> =
	// --- Annotated: dispatch on tag ---
	S extends AnnotatedSchema<infer Tag, infer Inner>
		? Tag extends "text"
			? string
			: Tag extends "counter"
				? number
				: Tag extends "doc"
					? Inner extends ProductSchema<infer F>
						? { [K in keyof F]?: SeedA<F[K]> }
						: unknown
					: Tag extends "movable"
						? Inner extends SequenceSchema<infer I>
							? Plain<I>[]
							: unknown
						: Tag extends "tree"
							? Inner extends SchemaType
								? SeedA<Inner>
								: unknown
							: Inner extends SchemaType
								? SeedA<Inner>
								: unknown
		: // --- Scalar ---
			S extends ScalarSchema<infer _K, infer V>
			? V
			: // --- Product ---
				S extends ProductSchema<infer F>
				? { [K in keyof F]?: SeedA<F[K]> }
				: // --- Sequence ---
					S extends SequenceSchema<infer I>
					? Plain<I>[]
					: // --- Map ---
						S extends MapSchema<infer I>
						? { [key: string]: Plain<I> }
						: // --- Sum ---
							S extends PositionalSumSchema<infer V>
							? Plain<V[number]>
							: S extends DiscriminatedSumSchema<infer _D, infer V>
								? Plain<V[number]>
								: unknown

// ---------------------------------------------------------------------------
// Approach B: Flattened conditional dispatch
//
// Fewer nesting levels than A. Uses a helper for annotated leaf types and
// tries to match `AnnotatedSchema<Tag, undefined>` for leaf annotations.
//
// KNOWN ISSUE: The `undefined` match for optional `schema` property is
// unreliable. AnnotatedSchema<"text", undefined> may not match
// `S extends AnnotatedSchema<infer Tag, undefined>` because the `schema`
// field is declared as optional (`schema?: S`). This causes leaf annotations
// (text, counter) to resolve as `unknown` instead of `string`/`number`.
// ---------------------------------------------------------------------------

type AnnotatedLeafValue<Tag extends string> =
	Tag extends "text" ? string
	: Tag extends "counter" ? number
	: never

type SeedB<S extends SchemaType> =
	// Fast path: annotated leaf (text, counter) — no inner schema
	S extends AnnotatedSchema<infer Tag, undefined>
		? AnnotatedLeafValue<Tag>
	// Annotated structural: unwrap and dispatch on inner
	: S extends AnnotatedSchema<"doc", ProductSchema<infer F>>
		? { [K in keyof F]?: SeedB<F[K]> }
	: S extends AnnotatedSchema<"movable", SequenceSchema<infer I>>
		? Plain<I>[]
	: S extends AnnotatedSchema<"tree", infer Inner extends SchemaType>
		? SeedB<Inner>
	: S extends AnnotatedSchema<string, infer Inner extends SchemaType>
		? SeedB<Inner>
	// Scalar — terminal, cheap
	: S extends ScalarSchema<infer _K, infer V>
		? V
	// Product — partial keys, recurse
	: S extends ProductSchema<infer F>
		? { [K in keyof F]?: SeedB<F[K]> }
	// Sequence — use Plain for items
	: S extends SequenceSchema<infer I>
		? Plain<I>[]
	// Map
	: S extends MapSchema<infer I>
		? { [key: string]: Plain<I> }
	// Sum — delegate to Plain
	: S extends PositionalSumSchema<infer V>
		? Plain<V[number]>
	: S extends DiscriminatedSumSchema<infer _D, infer V>
		? Plain<V[number]>
	: unknown

// ---------------------------------------------------------------------------
// Approach C: Match AnnotatedSchema broadly, dispatch on Tag first
//
// Fixes SeedB's leaf annotation bug. Instead of trying to match
// `AnnotatedSchema<Tag, undefined>` (unreliable with optional fields),
// match `AnnotatedSchema<infer Tag, infer Inner>` once, then dispatch
// on Tag first (string literal check — cheap, no depth cost). Only
// recurse into Inner for structural annotations (doc, movable, tree).
//
// RESULT: Same TS2589 as A — the `Inner extends ProductSchema<infer F>`
// nesting after the Tag dispatch still consumes too much depth budget.
// ---------------------------------------------------------------------------

type SeedC<S extends SchemaType> =
	// --- Annotated: single match, then dispatch on tag ---
	S extends AnnotatedSchema<infer Tag, infer Inner>
		? Tag extends "text" ? string
		: Tag extends "counter" ? number
		: Tag extends "doc"
			? Inner extends ProductSchema<infer F>
				? { [K in keyof F]?: SeedC<F[K]> }
				: unknown
		: Tag extends "movable"
			? Inner extends SequenceSchema<infer I>
				? Plain<I>[]
				: unknown
		: Tag extends "tree"
			? Inner extends SchemaType ? SeedC<Inner> : unknown
		: Inner extends SchemaType ? SeedC<Inner> : unknown
	// --- Scalar ---
	: S extends ScalarSchema<infer _K, infer V>
		? V
	// --- Product ---
	: S extends ProductSchema<infer F>
		? { [K in keyof F]?: SeedC<F[K]> }
	// --- Sequence ---
	: S extends SequenceSchema<infer I>
		? Plain<I>[]
	// --- Map ---
	: S extends MapSchema<infer I>
		? { [key: string]: Plain<I> }
	// --- Sum (delegate to Plain — same depth, only reached for actual sums) ---
	: S extends PositionalSumSchema<infer V>
		? Plain<V[number]>
	: S extends DiscriminatedSumSchema<infer _D, infer V>
		? Plain<V[number]>
	: unknown

// ---------------------------------------------------------------------------
// Approach D: Indexed access on S["tag"] — no conditional inference for annotations
//
// Key insight: TS2589 is driven by *conditional type nesting depth*, not by
// the number of branches. Every `S extends X<infer T> ? ... : ...` adds one
// nesting level. Approaches A and C nest:
//   1. S extends AnnotatedSchema<infer Tag, infer Inner>   (level 1)
//   2.   Tag extends "doc"                                  (level 2)
//   3.     Inner extends ProductSchema<infer F>             (level 3)
//   4.       mapped type over F[K] → recurse SeedC<F[K]>   (level 4+)
//
// Approach D eliminates levels 1-2 by using indexed property access:
//   - `S extends { _kind: "annotated" }` — one cheap structural check
//   - `S["tag"]` — indexed access, NOT a conditional inference
//   - Then a helper `SeedAnnotated<Tag, S>` dispatches on Tag with the
//     inner schema extraction happening only for structural annotations
//
// Additionally, we extract product-field recursion into a helper type
// `SeedFields<F>` to prevent the mapped type from adding depth inside
// the main conditional chain.
// ---------------------------------------------------------------------------

// Helper: resolve product fields with optional keys — isolates the mapped type
type SeedFields<F extends Record<string, SchemaType>> = { [K in keyof F]?: SeedD<F[K]> }

// Helper: resolve an annotated schema given its tag and the full annotated node
type SeedAnnotated<Tag extends string, S extends AnnotatedSchema> =
	Tag extends "text" ? string
	: Tag extends "counter" ? number
	: Tag extends "doc"
		? S extends AnnotatedSchema<any, ProductSchema<infer F>> ? SeedFields<F> : unknown
	: Tag extends "movable"
		? S extends AnnotatedSchema<any, SequenceSchema<infer I>> ? Plain<I>[] : unknown
	: Tag extends "tree"
		? S extends AnnotatedSchema<any, infer Inner extends SchemaType> ? SeedD<Inner> : unknown
	: S extends AnnotatedSchema<any, infer Inner extends SchemaType> ? SeedD<Inner> : unknown

type SeedD<S extends SchemaType> =
	// --- Annotated: indexed access on tag, delegate to helper ---
	S extends AnnotatedSchema
		? SeedAnnotated<S["tag"], S>
	// --- Scalar ---
	: S extends ScalarSchema<infer _K, infer V>
		? V
	// --- Product ---
	: S extends ProductSchema<infer F>
		? SeedFields<F>
	// --- Sequence ---
	: S extends SequenceSchema<infer I>
		? Plain<I>[]
	// --- Map ---
	: S extends MapSchema<infer I>
		? { [key: string]: Plain<I> }
	// --- Sum (delegate to Plain) ---
	: S extends PositionalSumSchema<infer V>
		? Plain<V[number]>
	: S extends DiscriminatedSumSchema<infer _D, infer V>
		? Plain<V[number]>
	: unknown

// ═══════════════════════════════════════════════════════════════════════════
//
//   Diagnostics: what does AnnotatedSchema<"text", undefined> actually match?
//
// ═══════════════════════════════════════════════════════════════════════════

type _TextSchema = ReturnType<typeof Schema.annotated<"text">>

// Does it match AnnotatedSchema<Tag, undefined>?
type _MatchUndefined = _TextSchema extends AnnotatedSchema<infer Tag, undefined> ? Tag : "no-match"
// Does it match AnnotatedSchema<Tag, infer Inner>?
type _MatchInfer = _TextSchema extends AnnotatedSchema<infer Tag, infer Inner>
	? [tag: Tag, inner: Inner]
	: "no-match"

// Force evaluation (hover in IDE to inspect resolved types)
declare const _d1: _MatchUndefined
declare const _d2: _MatchInfer

// ═══════════════════════════════════════════════════════════════════════════
//
//   Test Schema — same as ProjectSchema from main.ts
//
// ═══════════════════════════════════════════════════════════════════════════

const TestSchema = Schema.doc({
	name: Schema.annotated("text"),
	stars: Schema.annotated("counter"),

	tasks: Schema.list(
		Schema.struct({
			title: Schema.string(),
			done: Schema.boolean(),
			priority: Schema.number(1, 2, 3),
		}),
	),

	settings: Schema.struct({
		darkMode: Schema.boolean(),
		fontSize: Schema.number(),
	}),

	content: Schema.discriminatedUnion("type", [
		Schema.struct({ type: Schema.string("text"), body: Schema.annotated("text") }),
		Schema.struct({
			type: Schema.string("image"),
			url: Schema.string(),
			caption: Schema.annotated("text"),
		}),
	]),

	bio: Schema.nullable(Schema.string()),

	labels: Schema.record(Schema.string()),
});

// ═══════════════════════════════════════════════════════════════════════════
//
//   Direct Type Annotation Tests
//
//   These test Seed<S> when the concrete schema type is known (no generic).
//   All approaches should work here — the question is which also
//   survives generic function parameter resolution.
//
// ═══════════════════════════════════════════════════════════════════════════

// --- Approach A ---

type TestSeedA = SeedA<typeof TestSchema>

const seedA1: TestSeedA = { name: "Hello" }
const seedA2: TestSeedA = { name: "Hello", content: { type: "text" as const, body: "" } }
const seedA3: TestSeedA = {}
const seedA4: TestSeedA = { settings: { darkMode: true } }
const seedA5: TestSeedA = { stars: 42, bio: null }

// Should NOT compile:
const seedA_bad1: TestSeedA = { named: "typo" }           // ← excess property
const seedA_bad2: TestSeedA = { name: 123 }               // ← wrong type
const seedA_bad3: TestSeedA = { stars: "not a number" }   // ← wrong type

// --- Approach B ---

type TestSeedB = SeedB<typeof TestSchema>

const seedB1: TestSeedB = { name: "Hello" }
const seedB2: TestSeedB = { name: "Hello", content: { type: "text" as const, body: "" } }
const seedB3: TestSeedB = {}
const seedB4: TestSeedB = { settings: { darkMode: true } }
const seedB5: TestSeedB = { stars: 42, bio: null }

// Should NOT compile:
const seedB_bad1: TestSeedB = { named: "typo" }           // ← excess property
const seedB_bad2: TestSeedB = { name: 123 }               // ← wrong type (BUT: may pass if name resolves to unknown)
const seedB_bad3: TestSeedB = { stars: "not a number" }   // ← wrong type (BUT: may pass if stars resolves to unknown)

// --- Approach C ---

type TestSeedC = SeedC<typeof TestSchema>

const seedC1: TestSeedC = { name: "Hello" }
const seedC2: TestSeedC = { name: "Hello", content: { type: "text" as const, body: "" } }
const seedC3: TestSeedC = {}
const seedC4: TestSeedC = { settings: { darkMode: true } }
const seedC5: TestSeedC = { stars: 42, bio: null }

// Should NOT compile:
const seedC_bad1: TestSeedC = { named: "typo" }           // ← excess property
const seedC_bad2: TestSeedC = { name: 123 }               // ← wrong type
const seedC_bad3: TestSeedC = { stars: "not a number" }   // ← wrong type

// --- Approach D ---

type TestSeedD = SeedD<typeof TestSchema>

const seedD1: TestSeedD = { name: "Hello" }
const seedD2: TestSeedD = { name: "Hello", content: { type: "text" as const, body: "" } }
const seedD3: TestSeedD = {}
const seedD4: TestSeedD = { settings: { darkMode: true } }
const seedD5: TestSeedD = { stars: 42, bio: null }

// Should NOT compile:
const seedD_bad1: TestSeedD = { named: "typo" }           // ← excess property
const seedD_bad2: TestSeedD = { name: 123 }               // ← wrong type
const seedD_bad3: TestSeedD = { stars: "not a number" }   // ← wrong type

// ═══════════════════════════════════════════════════════════════════════════
//
//   Generic Function Parameter Tests (THE CRITICAL TEST)
//
//   This is where Partial<Plain<S>> and SeedA both hit TS2589.
//   The question: does SeedB or SeedC survive generic instantiation?
//
// ═══════════════════════════════════════════════════════════════════════════

function createDocA<S extends SchemaType>(
	_schema: S,
	_seed?: SeedA<S>,
): void {}

function createDocB<S extends SchemaType>(
	_schema: S,
	_seed?: SeedB<S>,
): void {}

function createDocC<S extends SchemaType>(
	_schema: S,
	_seed?: SeedC<S>,
): void {}

function createDocD<S extends SchemaType>(
	_schema: S,
	_seed?: SeedD<S>,
): void {}

// --- Should compile ---
createDocA(TestSchema, { name: "ok" })
createDocA(TestSchema, { name: "ok", content: { type: "text" as const, body: "" } })
createDocA(TestSchema, {})
createDocA(TestSchema)

createDocB(TestSchema, { name: "ok" })
createDocB(TestSchema, { name: "ok", content: { type: "text" as const, body: "" } })
createDocB(TestSchema, {})
createDocB(TestSchema)

createDocC(TestSchema, { name: "ok" })
createDocC(TestSchema, { name: "ok", content: { type: "text" as const, body: "" } })
createDocC(TestSchema, {})
createDocC(TestSchema)

createDocD(TestSchema, { name: "ok" })
createDocD(TestSchema, { name: "ok", content: { type: "text" as const, body: "" } })
createDocD(TestSchema, {})
createDocD(TestSchema)

// --- Should NOT compile ---
createDocA(TestSchema, { named: "typo" })    // ← excess property
createDocB(TestSchema, { named: "typo" })    // ← excess property
createDocC(TestSchema, { named: "typo" })    // ← excess property
createDocD(TestSchema, { named: "typo" })    // ← excess property
createDocA(TestSchema, { name: 123 })         // ← wrong type
createDocB(TestSchema, { name: 123 })         // ← wrong type
createDocC(TestSchema, { name: 123 })         // ← wrong type
createDocD(TestSchema, { name: 123 })         // ← wrong type

// ═══════════════════════════════════════════════════════════════════════════
//
//   Runtime sanity
//
// ═══════════════════════════════════════════════════════════════════════════

console.log("✓ Seed experiment compiled and ran successfully")
console.log("  Approach A (SeedA): full recursive mirror of Plain with ?:")
console.log("  Approach B (SeedB): flattened with undefined-match for leaves")
console.log("  Approach C (SeedC): broad match + tag dispatch first")
console.log("  Approach D (SeedD): indexed access S['tag'] + helper types")

// Suppress unused variable warnings
void seedA1, seedA2, seedA3, seedA4, seedA5
void seedB1, seedB2, seedB3, seedB4, seedB5
void seedC1, seedC2, seedC3, seedC4, seedC5
void seedD1, seedD2, seedD3, seedD4, seedD5
void seedA_bad1, seedA_bad2, seedA_bad3
void seedB_bad1, seedB_bad2, seedB_bad3
void seedC_bad1, seedC_bad2, seedC_bad3
void seedD_bad1, seedD_bad2, seedD_bad3