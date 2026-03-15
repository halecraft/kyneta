import type {
	SchemaNode as SchemaType,
	Ref,
	PendingChange,
	Changeset,
	TreeEvent,
} from "@kyneta/schema";
import {
	Zero,
	interpret,
	createWritableContext,
	readable,
	writable,
	changefeed,
	subscribe,
} from "@kyneta/schema";

export { change, applyChanges, subscribe, subscribeNode } from "@kyneta/schema";

// --- Sync state (per-document version tracking + change log) ---

interface SyncState {
	version: number;
	/** log[i] = batch of PendingChanges from version i → i+1 */
	log: PendingChange[][];
}

const syncStates = new WeakMap<object, SyncState>();

function getSyncState(doc: object): SyncState {
	const state = syncStates.get(doc);
	if (!state) {
		throw new Error(
			"version/delta called on an object without sync state. Use a doc created by createDoc().",
		);
	}
	return state;
}

// --- createDoc ---

// Interface call signature avoids TS2589 on Ref<S> when S is generic.
// Seed is Record<string, unknown> for the same reason — use
// `satisfies Seed<typeof MySchema>` at call sites for type safety.
interface CreateDoc {
	<S extends SchemaType>(schema: S, seed?: Record<string, unknown>): Ref<S>;
}

export const createDoc: CreateDoc = (schema, seed = {}) => {
	const defaults = Zero.structural(schema) as Record<string, unknown>;
	const initial = Zero.overlay(seed, defaults, schema) as Record<
		string,
		unknown
	>;
	const store = { ...initial } as Record<string, unknown>;
	const ctx = createWritableContext(store);

	// Cast to `any` to stay within TS's type-instantiation depth budget (TS2589).
	const doc: any = interpret(schema, ctx)
		.with(readable)
		.with(writable)
		.with(changefeed)
		.done();

	const state: SyncState = { version: 0, log: [] };
	syncStates.set(doc, state);

	// Each changefeed delivery = one flush cycle. Track versions by appending
	// to the log so delta() can compute what a peer has missed.
	subscribe(doc, (changeset: Changeset<TreeEvent>) => {
		const batch: PendingChange[] = changeset.changes.map((event) => ({
			path: event.path,
			change: event.change,
		}));
		state.log.push(batch);
		state.version++;
	});

	return doc as any;
};

// --- Sync primitives ---

/** Current frontier — monotonic integer, increments on each flush cycle. */
export function version(doc: object): number {
	return getSyncState(doc).version;
}

/** All ops applied since `fromVersion`. Returns [] if already up to date. */
export function delta(doc: object, fromVersion: number): PendingChange[] {
	const state = getSyncState(doc);
	if (fromVersion >= state.version) return [];
	return state.log.slice(fromVersion).flat();
}
