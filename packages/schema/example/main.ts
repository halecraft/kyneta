// ═══════════════════════════════════════════════════════════════════════════
//
//   @kyneta/schema — Example Mini-App
//
//   A showcase of the full @kyneta/schema API surface. No local facade —
//   every function used here is a direct library import.
//
//   The architecture decomposes into four composable interpreter layers:
//     1. readable    — callable function-shaped refs with caching
//     2. writable    — adds .set(), .insert(), .increment(), etc.
//     3. changefeed  — adds observation via subscribe / subscribeNode
//
//   Compose them fluently:
//     interpret(schema, ctx).with(readable).with(writable).with(changefeed).done()
//
//   Run with:  npx tsx example/main.ts   (from packages/schema/)
//
// ═══════════════════════════════════════════════════════════════════════════

import {
	// Schema constructors
	Schema,
	Zero,
	describe,
	// Interpreter machinery
	interpret,
	plainSubstrateFactory,
	readable,
	writable,
	changefeed,
	// Facade — the four library-level functions
	change,
	applyChanges,
	subscribe,
	subscribeNode,
	// Observation protocol
	hasChangefeed,
	hasComposedChangefeed,
	hasTransact,
	// Validation
	validate,
	tryValidate,
	SchemaValidationError,
	formatPath,
	// Pure state transitions
	stepText,
	stepSequence,
	stepIncrement,
	textChange,
	sequenceChange,
	incrementChange,
} from "../src/index.js";

import type {
	Ref,
	RRef,
	Seed,
	Schema as SchemaType,
	AnnotatedSchema,
	Changeset,
	Op,
} from "../src/index.js";

import { json, log, section } from "./helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
//
//   1. DEFINE A SCHEMA
//
// ═══════════════════════════════════════════════════════════════════════════

section(1, "Define a Schema");

const ProjectSchema = Schema.doc({
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

log(describe(ProjectSchema));

// ═══════════════════════════════════════════════════════════════════════════
//
//   2. CREATE A DOCUMENT
//
// ═══════════════════════════════════════════════════════════════════════════

section(2, "Create a Document");

// Write createDoc once — use it with any schema.
// (note: interface call signature avoids TS infinite recursion)
// (note: seed is Record<string, unknown> because Seed<S> triggers TS2589
//  as a generic parameter. Use `satisfies Seed<typeof MySchema>` at call
//  sites for type-safe seeds — see baseSeed below for an example.)
interface CreateDoc {
	<S extends SchemaType>(schema: S, seed?: Record<string, unknown>): Ref<S>;
}
const createDoc: CreateDoc = (schema, seed = {}) => {
	const substrate = plainSubstrateFactory.create(schema, seed);
	return interpret(schema, substrate.context())
		.with(readable)
		.with(writable)
		.with(changefeed)
		.done() as any;
};

const doc = createDoc(ProjectSchema, {
	name: "Schema Algebra",
	content: { type: "text", body: "A unified recursive grammar" },
});

log(`
    const doc = createDoc(ProjectSchema, { name: "Schema Algebra", ... })

    doc() →
${json(doc())
	.split("\n")
	.map((l: string) => "      " + l)
	.join("\n")}
`);

// ═══════════════════════════════════════════════════════════════════════════
//
//   3. MUTATIONS: FIVE CHANGE TYPES
//
// ═══════════════════════════════════════════════════════════════════════════

section(3, "Mutations: Five Change Types");

// Text — surgical character patch
doc.name.insert(doc.name().length, " v2");
log(`doc.name.insert(end, " v2") → "${doc.name()}"`);

// Counter — delta operation
doc.stars.increment(42);
log(`doc.stars.increment(42) → ${doc.stars()}`);

// Sequence — O(k) list op
doc.tasks.push({ title: "Design the grammar", done: true, priority: 1 });
doc.tasks.push({ title: "Implement catamorphism", done: false, priority: 2 });
log(`doc.tasks.push(...) ×2 → length ${doc.tasks.length}`);

// Replace — whole-value swap (leaf)
doc.settings.darkMode.set(true);
log(`doc.settings.darkMode.set(true) → ${doc.settings.darkMode()}`);

// Map — key-level operation
doc.labels.set("bug", "red");
doc.labels.set("feature", "blue");
log(
	`doc.labels.set("bug", "red") → keys: [${doc.labels
		.keys()
		.map((k: string) => `"${k}"`)
		.join(", ")}]`,
);

// Product .set() — bulk struct replacement in a single ReplaceChange
doc.settings.set({ darkMode: false, fontSize: 16 });
log(`
    doc.settings.set({ darkMode: false, fontSize: 16 })
      → darkMode=${doc.settings.darkMode()}, fontSize=${doc.settings.fontSize()}

    Leaf .set() for surgical edits.
    Product .set() for bulk replacement.
`);

// ═══════════════════════════════════════════════════════════════════════════
//
//   4. WORKING WITH COLLECTIONS
//
// ═══════════════════════════════════════════════════════════════════════════

section(4, "Working with Collections");

log(`
    Lists — .at(i) returns a ref, .get(i) returns a plain value:
      doc.tasks.at(0).title() → "${doc.tasks.at(0)!.title()}"
      doc.tasks.get(0) → ${json(doc.tasks.get(0))}
      doc.tasks.length → ${doc.tasks.length}

    Iteration (yields refs):
    ${[...doc.tasks].map((t) => `  [${t.done() ? "✓" : " "}] ${t.title()} (priority: ${t.priority()})`).join("\n    ")}
`);

doc.tasks.insert(0, { title: "Write tests", done: false, priority: 1 });
log(
	`doc.tasks.insert(0, { title: "Write tests", ... }) → length ${doc.tasks.length}`,
);

doc.tasks.delete(0, 1);
log(`doc.tasks.delete(0, 1) → length ${doc.tasks.length}`);

log(`
    Records — .at(key) returns a ref, .get(key) returns a plain value:
      doc.labels.at("bug")!() → "${doc.labels.at("bug")!()}"
      doc.labels.get("bug") → "${doc.labels.get("bug")}"
      doc.labels.has("bug") → ${doc.labels.has("bug")}
      doc.labels.has("missing") → ${doc.labels.has("missing")}
      doc.labels.size → ${doc.labels.size}
      doc.labels.keys() → [${doc.labels
				.keys()
				.map((k: string) => `"${k}"`)
				.join(", ")}]
`);

// ═══════════════════════════════════════════════════════════════════════════
//
//   5. UNIONS AND NULLABLES
//
// ═══════════════════════════════════════════════════════════════════════════

section(5, "Unions and Nullables");

// doc.content is a proper TypeScript discriminated union of variant ref types.
// The discriminant field (.type) is a raw string literal — not a callable ref.
// This means standard TS control-flow narrowing works natively:
//   if (doc.content.type === "text") { doc.content.body() }  // TS narrows
//   switch (doc.content.type) { case "text": ... }           // exhaustiveness

if (doc.content.type === "text") {
	log(`
    Discriminated union — native narrowing via hybrid discriminant:
      doc.content.type → "${doc.content.type}"  (raw string, not a ref)
      typeof doc.content.type → "${typeof doc.content.type}"
      doc.content.body() → "${doc.content.body()}"  (TS narrows — no cast needed)
`);
}

// Nullable — null by default, set to a value, read, set back
log(`    Nullable:
      doc.bio() → ${doc.bio()}  (null by default)`);

doc.bio.set("Systems engineer");
log(`      doc.bio.set("Systems engineer") → "${doc.bio()}"`);

doc.bio.set(null);
log(`      doc.bio.set(null) → ${doc.bio()}`);

// ═══════════════════════════════════════════════════════════════════════════
//
//   6. TRANSACTIONS WITH change()
//
// ═══════════════════════════════════════════════════════════════════════════

section(6, "Transactions with change()");

log(`
    The library-level change() captures mutations as Op[].
    All five change types in one atomic transaction:
`);

const ops = change(doc, (d) => {
	d.name.insert(0, "✨ "); // text
	d.stars.increment(10); // increment
	d.tasks.push({ title: "Ship it!", done: false, priority: 3 }); // sequence
	d.settings.set({ darkMode: true, fontSize: 20 }); // replace
	d.labels.set("priority", "high"); // map
});

log(`
    const ops = change(doc, d => {
      d.name.insert(0, "✨ ")           // text
      d.stars.increment(10)              // increment
      d.tasks.push({ title: "Ship it!" })  // sequence
      d.settings.set({ darkMode: true })   // replace
      d.labels.set("priority", "high")  // map
    })

    ops.length → ${ops.length}
    Change types: [${ops.map((o: Op) => `"${o.change.type}"`).join(", ")}]
`);

// ═══════════════════════════════════════════════════════════════════════════
//
//   7. OBSERVING CHANGES
//
// ═══════════════════════════════════════════════════════════════════════════

section(7, "Observing Changes");

log(`
    subscribe(ref, cb) — tree-level observation, with relative paths (the default).
    subscribeNode(ref, cb) — node-level observation.
    Both are library imports. Both preserve the Changefeed protocol.
`);

// Leaf subscription
const starChangesets: Changeset[] = [];
const unsub1 = subscribeNode(doc.stars, (cs) => starChangesets.push(cs));

doc.stars.increment(5);

log(`
    subscribeNode(doc.stars, cb)
    doc.stars.increment(5)
    → ${starChangesets.length} Changeset received
    → changeset.changes[0].type = "${starChangesets[0]!.changes[0]!.type}"
`);

unsub1();
doc.stars.increment(1); // not observed
log(`    After unsub → ${starChangesets.length} total (delivery stopped)`);

// Tree subscription — one subscription at the root captures mutations
// anywhere in the document, with relative paths showing exactly where.
const treeEvents: { path: string; type: string }[] = [];
const unsub2 = subscribe(doc, (cs) => {
	for (const event of cs.changes) {
		treeEvents.push({
			path: formatPath(event.path),
			type: event.change.type,
		});
	}
});

doc.tasks.at(2)!.done.set(true); // depth 2: tasks[2].done
doc.tasks.at(1)!.priority.set(3); // depth 2: tasks[1].priority
doc.settings.fontSize.set(14); // depth 1: settings.fontSize

log(`
    subscribe(doc, cb)  ← one subscription on the root
    doc.tasks.at(2)!.done.set(true)
    doc.tasks.at(1)!.priority.set(3)
    doc.settings.fontSize.set(14)
    → ${treeEvents.length} tree events:
    ${treeEvents.map((e) => `  path: ${e.path}, type: ${e.type}`).join("\n    ")}
`);

unsub2();

// ═══════════════════════════════════════════════════════════════════════════
//
//   8. THE ROUND-TRIP: change → applyChanges
//
// ═══════════════════════════════════════════════════════════════════════════

section(8, "The Round-Trip: change → applyChanges");

log(`
    The crown jewel. Capture mutations as ops on one document,
    apply them to a completely separate document.
`);

const baseSeed = {
	name: "Shared Doc",
	content: { type: "text" as const, body: "" },
} satisfies Seed<typeof ProjectSchema>;

const docA = createDoc(ProjectSchema, baseSeed);
const docB = createDoc(ProjectSchema, baseSeed);

// Subscribe to docB BEFORE applying changes — see the origin
const docBChangesets: Changeset[] = [];
subscribeNode(docB.stars, (cs) => docBChangesets.push(cs));

// Capture changes on docA
const roundTripOps = change(docA, (d) => {
	d.name.insert(d.name().length, " v2");
	d.stars.increment(100);
	d.tasks.push({ title: "Review", done: false, priority: 1 });
});

// Apply to docB with origin tagging
applyChanges(docB, roundTripOps, { origin: "sync" });

const aSnapshot = json(docA());
const bSnapshot = json(docB());
const match = aSnapshot === bSnapshot;

log(`
    const roundTripOps = change(docA, d => {
      d.name.insert(end, " v2")
      d.stars.increment(100)
      d.tasks.push({ title: "Review", done: false, priority: 1 })
    })

    applyChanges(docB, roundTripOps, { origin: "sync" })

    docA() deep-equals docB() → ${match} ✓
    docB.stars() → ${docB.stars()}
    docB.name() → "${docB.name()}"

    Subscriber on docB received origin: "${docBChangesets[0]?.origin}"
    This is the sync story — 10 lines.
`);

// ═══════════════════════════════════════════════════════════════════════════
//
//   9. BATCHED NOTIFICATION AND ORIGIN
//
// ═══════════════════════════════════════════════════════════════════════════

section(9, "Batched Notification and Origin");

log(`
    applyChanges delivers ONE Changeset per affected path (not per change).
    Subscribers see fully-applied state when notified.
`);

{
	const batchDoc = createDoc(ProjectSchema, {
		name: "Batch",
		content: { type: "text", body: "" },
	});
	const changesets: Changeset[] = [];
	subscribeNode(batchDoc.stars, (cs) => changesets.push(cs));

	// 3 counter increments applied as one batch
	applyChanges(
		batchDoc,
		[
			{
				path: [{ type: "key" as const, key: "stars" }],
				change: incrementChange(1),
			},
			{
				path: [{ type: "key" as const, key: "stars" }],
				change: incrementChange(2),
			},
			{
				path: [{ type: "key" as const, key: "stars" }],
				change: incrementChange(3),
			},
		],
		{ origin: "undo" },
	);

	log(`
    3 increment changes applied via applyChanges:
      changesets received → ${changesets.length} (batched into one)
      changeset.changes.length → ${changesets[0]!.changes.length} (all 3 changes)
      changeset.origin → "${changesets[0]!.origin}"
      batchDoc.stars() → ${batchDoc.stars()} (fully applied: 1+2+3)
  `);
}

// ═══════════════════════════════════════════════════════════════════════════
//
//   10. PORTABLE REFS
//
// ═══════════════════════════════════════════════════════════════════════════

section(10, "Portable Refs");

log(`
    Refs carry their context in closures — pass them anywhere.
    Functions that know nothing about the document can read and mutate.
`);

// A generic "append tag" function — typed with schema-derived Ref
function tag(ref: Ref<AnnotatedSchema<"text">>, label: string) {
	ref.insert(ref().length, ` [${label}]`);
}

// A generic counter helper
function ensureMinimum(ref: Ref<AnnotatedSchema<"counter">>, min: number) {
	const current = ref();
	if (current < min) ref.increment(min - current);
}

tag(doc.name, "released");
ensureMinimum(doc.stars, 200);

log(`
    function tag(ref: Ref<AnnotatedSchema<"text">>, label: string) { ref.insert(end, " [label]") }
    function ensureMinimum(ref: Ref<AnnotatedSchema<"counter">>, min: number) { ... }

    tag(doc.name, "released") → "${doc.name()}"
    ensureMinimum(doc.stars, 200) → ${doc.stars()}

    Template literal coercion via toPrimitive — no ref() needed:
    \`Stars: \${doc.stars}\` → "Stars: ${doc.stars}"
    \`Name: \${doc.name}\` → "Name: ${doc.name}"
    +doc.stars → ${+doc.stars}
`);

// ═══════════════════════════════════════════════════════════════════════════
//
//   11. VALIDATION
//
// ═══════════════════════════════════════════════════════════════════════════

section(11, "Validation");

log(`
    Same schema — no separate Zod definition.
    validate() returns Plain<S> with full type narrowing.
`);

// Happy path — doc() now includes the discriminant field naturally
const snapshot = doc();
const validated = validate(ProjectSchema, snapshot);
log(`
    validate(schema, doc()) → passes ✓
      validated.name = "${validated.name}"
      validated.stars = ${validated.stars}
`);

// Error collection
const badData = {
	name: "ok",
	stars: "not a number", // ← wrong type
	tasks: [{ title: "task", done: true, priority: 99 }], // ← priority not in [1,2,3]
	settings: { darkMode: false, fontSize: 14 },
	content: { type: "text", body: "" },
	bio: null,
	labels: {},
};

const result = tryValidate(ProjectSchema, badData);
if (!result.ok) {
	const descVal = (v: unknown) =>
		v === null
			? "null"
			: v === undefined
				? "undefined"
				: typeof v === "string"
					? `"${v}"`
					: String(v);

	log(`
    tryValidate(schema, badData) → ${result.errors.length} errors:
    ${result.errors.map((e) => `  ✗ ${e.path}: expected ${e.expected}, got ${descVal(e.actual)}`).join("\n    ")}
  `);
}

// Throws on first error
try {
	validate(ProjectSchema, { ...badData, bio: 42 });
} catch (e) {
	if (e instanceof SchemaValidationError) {
		log(`
    validate() throws SchemaValidationError:
      path: "${e.path}"
      expected: "${e.expected}"
    `);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
//
//   12. THE COMPOSITION ALGEBRA
//
// ═══════════════════════════════════════════════════════════════════════════

section(12, "The Composition Algebra");

log(`
    Five composable layers — each independently useful:

      interpret(schema, ctx)
        .with(readable)    → read-only callable refs
        .with(writable)    → read + mutation
        .with(changefeed)  → read + mutation + observation
        .done()

    Manual composition (equivalent):
      withChangefeed(withWritable(withCaching(withReadable(withNavigation(bottomInterpreter)))))
`);

// Read-only document: just drop the writable and changefeed layers
{
	const roStore = doc() as Record<string, unknown>;
	const roCtx = { store: roStore };
	const roDoc: RRef<typeof ProjectSchema> = interpret(ProjectSchema, roCtx)
		.with(readable)
		.done();

	log(`
    Read-only — remove layers, not permissions:
      const roDoc = interpret(schema, { store }).with(readable).done()
      roDoc.name() → "${roDoc.name()}"
      roDoc.stars() → ${roDoc.stars()}
      roDoc.tasks.at(0)?.title() → "${roDoc.tasks.at(0)!.title()}"

      "set" in roDoc.stars → ${"set" in roDoc.stars}
      "insert" in roDoc.name → ${"insert" in roDoc.name}
      hasChangefeed(roDoc) → ${hasChangefeed(roDoc)}
      hasTransact(roDoc) → ${hasTransact(roDoc)}
  `);
}

log(`
    Referential identity (from withCaching):
      doc.name === doc.name → ${doc.name === doc.name}
      doc.settings === doc.settings → ${doc.settings === doc.settings}

    Namespace isolation:
      Object.keys(doc) → [${Object.keys(doc)
				.map((k) => `"${k}"`)
				.join(", ")}]
`);

log(`
    Symbol-keyed composability hooks:
      [CALL]        — controls what carrier() does
      [INVALIDATE]  — change-driven cache invalidation
      [TRANSACT]    — context discovery from any ref
      [CHANGEFEED]  — observation coalgebra with subscribe / subscribeNode

    hasComposedChangefeed(doc.settings) → ${hasComposedChangefeed(doc.settings)} (product — has subscribe)
    hasComposedChangefeed(doc.name) → ${hasComposedChangefeed(doc.name)} (leaf — subscribeNode only)
`);

// ═══════════════════════════════════════════════════════════════════════════
//
//   13. PURE STATE TRANSITIONS WITH step
//
// ═══════════════════════════════════════════════════════════════════════════

section(13, "Pure State Transitions with step");

log(`
    The change vocabulary works independently of the reactive system.
    step(state, change) → newState — pure functions, no interpreter needed.
`);

const textResult = stepText(
	"Hello",
	textChange([{ retain: 5 }, { insert: " World" }]),
);
log(
	`    stepText("Hello", textChange([retain 5, insert " World"])) → "${textResult}"`,
);

const seqResult = stepSequence(
	[1, 2, 3],
	sequenceChange([{ retain: 1 }, { insert: [10, 20] }, { delete: 1 }]),
);
log(
	`    stepSequence([1,2,3], [retain 1, insert [10,20], delete 1]) → [${seqResult.join(", ")}]`,
);

const counterResult = stepIncrement(42, incrementChange(8));
log(`    stepIncrement(42, incrementChange(8)) → ${counterResult}`);

// ═══════════════════════════════════════════════════════════════════════════
//
//   14. FINAL SNAPSHOT
//
// ═══════════════════════════════════════════════════════════════════════════

section(14, "Final Snapshot");

log(
	`doc() →\n${json(doc())
		.split("\n")
		.map((l: string) => "    " + l)
		.join("\n")}`,
);
