import type {
	SchemaNode as SchemaType,
	Ref,
	Op,
	Substrate,
	SubstratePayload,
} from "@kyneta/schema";
import {
	interpret,
	readable,
	writable,
	changefeed,
	plainSubstrateFactory,
	PlainFrontier,
} from "@kyneta/schema";

export { change, applyChanges, subscribe, subscribeNode } from "@kyneta/schema";

// --- Substrate tracking (per-document) ---

const substrates = new WeakMap<object, Substrate<PlainFrontier>>();

function getSubstrate(doc: object): Substrate<PlainFrontier> {
	const s = substrates.get(doc);
	if (!s) {
		throw new Error(
			"version/delta/exportSnapshot called on an object without a substrate. Use a doc created by createDoc() or createDocFromSnapshot().",
		);
	}
	return s;
}

// --- createDoc ---

// Interface call signature avoids TS2589 on Ref<S> when S is generic.
// Seed is Record<string, unknown> for the same reason — use
// `satisfies Seed<typeof MySchema>` at call sites for type safety.
interface CreateDoc {
	<S extends SchemaType>(schema: S, seed?: Record<string, unknown>): Ref<S>;
}

export const createDoc: CreateDoc = (schema, seed = {}) => {
	const substrate = plainSubstrateFactory.create(schema, seed);
	const doc: any = interpret(schema, substrate.context())
		.with(readable)
		.with(writable)
		.with(changefeed)
		.done();
	substrates.set(doc, substrate);
	return doc;
};

// --- createDocFromSnapshot ---

interface CreateDocFromSnapshot {
	<S extends SchemaType>(schema: S, payload: SubstratePayload): Ref<S>;
}

export const createDocFromSnapshot: CreateDocFromSnapshot = (
	schema,
	payload,
) => {
	const substrate = plainSubstrateFactory.fromSnapshot(payload, schema);
	const doc: any = interpret(schema, substrate.context())
		.with(readable)
		.with(writable)
		.with(changefeed)
		.done();
	substrates.set(doc, substrate);
	return doc;
};

// --- Sync primitives ---

/** Current frontier — monotonic integer, increments on each flush cycle. */
export function version(doc: object): number {
	return getSubstrate(doc).frontier().value;
}

/**
 * All ops applied since `fromVersion`. Returns [] if already up to date.
 *
 * This returns raw Op[] for wire compatibility — the live sync protocol
 * uses Op-level granularity. For bulk transfers (SSR, reconnection),
 * use exportSnapshot() instead.
 */
export function delta(doc: object, fromVersion: number): Op[] {
	const substrate = getSubstrate(doc);
	const since = new PlainFrontier(fromVersion);
	const payload = substrate.exportSince(since);
	if (!payload) return [];
	const ops = JSON.parse(payload.data as string) as Op[];
	return ops;
}

/**
 * Export the full substrate snapshot — sufficient for a new peer to
 * reconstruct an equivalent document via createDocFromSnapshot().
 */
export function exportSnapshot(doc: object): SubstratePayload {
	return getSubstrate(doc).exportSnapshot();
}