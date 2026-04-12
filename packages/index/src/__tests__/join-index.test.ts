import { describe, expect, it } from "vitest"
import { json, Schema, createDoc, change } from "@kyneta/schema"
import { Catalog, Index as _Index } from "../index.js"

// Cast to `any` to avoid TS2589 — Ref<S> depth explosion when TypeScript
// tries to verify generic return types through the IndexStatic interface.
const Index = _Index as any
import type { SecondaryIndexChange } from "../secondary-index.js"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const convSchema = Schema.struct({ title: Schema.string() })
const ConvDoc = json.bind(convSchema)

const threadSchema = Schema.struct({
  conversationId: Schema.string(),
  subject: Schema.string(),
})
const ThreadDoc = json.bind(threadSchema)

const orgSchema = Schema.struct({
  name: Schema.string(),
  members: Schema.record(Schema.struct({ role: Schema.string() })),
})
const OrgDoc = json.bind(orgSchema)

const userSchema = Schema.struct({ name: Schema.string() })
const UserDoc = json.bind(userSchema)

/** Create a manual catalog, cast to `any` to sidestep TS2589. */
const createManualCatalog = () => Catalog.collect() as any as [any, any]

/** Create refs as `any` to sidestep TS2589 deep Ref<S> instantiation. */
const makeConvRef = (): any => createDoc(ConvDoc)
const makeThreadRef = (): any => createDoc(ThreadDoc)
const makeOrgRef = (): any => createDoc(OrgDoc)
const makeUserRef = (): any => createDoc(UserDoc)

// ---------------------------------------------------------------------------
// 1:N join — conversations ↔ threads
// ---------------------------------------------------------------------------

describe("JoinIndex — 1:N (conversations ↔ threads)", () => {
  function setup() {
    const [convCatalog, convHandle] = createManualCatalog()
    const [threadCatalog, threadHandle] = createManualCatalog()

    const convRef = makeConvRef()
    change(convRef, (d: any) => {
      d.title.set("General")
    })
    convHandle.set("conv:abc", convRef)

    const t1Ref = makeThreadRef()
    change(t1Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 1")
    })
    threadHandle.set("t1", t1Ref)

    const t2Ref = makeThreadRef()
    change(t2Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 2")
    })
    threadHandle.set("t2", t2Ref)

    const leftIndex = Index.byIdentity(convCatalog)
    const rightIndex = Index.by(threadCatalog, (ref: any) => ref.conversationId)
    const convThreads = Index.join(leftIndex, rightIndex)

    return {
      convCatalog,
      convHandle,
      threadCatalog,
      threadHandle,
      convRef,
      t1Ref,
      t2Ref,
      leftIndex,
      rightIndex,
      convThreads,
    }
  }

  it("lookup returns all threads for a conversation", () => {
    const { convThreads } = setup()
    const results = convThreads.lookup("conv:abc")
    expect(results).toHaveLength(2)
    const keys = results.map((r: any) => r.key).sort()
    expect(keys).toEqual(["t1", "t2"])
  })

  it("reverse returns the conversation for a thread", () => {
    const { convThreads } = setup()
    const results = convThreads.reverse("t1")
    expect(results).toHaveLength(1)
    expect(results[0].key).toBe("conv:abc")
  })
})

// ---------------------------------------------------------------------------
// M:N join — orgs ↔ users
// ---------------------------------------------------------------------------

describe("JoinIndex — M:N (orgs ↔ users)", () => {
  function setup() {
    const [orgCatalog, orgHandle] = createManualCatalog()
    const [userCatalog, userHandle] = createManualCatalog()

    const orgRef = makeOrgRef()
    change(orgRef, (d: any) => {
      d.name.set("Acme Corp")
      d.members.set("alice", { role: "admin" })
      d.members.set("bob", { role: "member" })
    })
    orgHandle.set("org:acme", orgRef)

    const aliceRef = makeUserRef()
    change(aliceRef, (d: any) => {
      d.name.set("Alice")
    })
    userHandle.set("alice", aliceRef)

    const bobRef = makeUserRef()
    change(bobRef, (d: any) => {
      d.name.set("Bob")
    })
    userHandle.set("bob", bobRef)

    const leftIndex = Index.byKeys(orgCatalog, (ref: any) => ref.members)
    const rightIndex = Index.byIdentity(userCatalog)
    const orgUsers = Index.join(leftIndex, rightIndex)

    return {
      orgCatalog,
      orgHandle,
      userCatalog,
      userHandle,
      orgRef,
      aliceRef,
      bobRef,
      leftIndex,
      rightIndex,
      orgUsers,
    }
  }

  it("lookup returns all users in an org", () => {
    const { orgUsers } = setup()
    const results = orgUsers.lookup("org:acme")
    expect(results).toHaveLength(2)
    const keys = results.map((r: any) => r.key).sort()
    expect(keys).toEqual(["alice", "bob"])
  })

  it("reverse returns the org(s) a user belongs to", () => {
    const { orgUsers } = setup()
    const results = orgUsers.reverse("alice")
    expect(results).toHaveLength(1)
    expect(results[0].key).toBe("org:acme")
  })

  it("user belonging to multiple orgs appears in reverse for each", () => {
    const { orgHandle, orgUsers } = setup()

    const org2Ref = makeOrgRef()
    change(org2Ref, (d: any) => {
      d.name.set("Widgets Inc")
      d.members.set("alice", { role: "member" })
    })
    orgHandle.set("org:widgets", org2Ref)

    const results = orgUsers.reverse("alice")
    expect(results).toHaveLength(2)
    const keys = results.map((r: any) => r.key).sort()
    expect(keys).toEqual(["org:acme", "org:widgets"])
  })
})

// ---------------------------------------------------------------------------
// Incremental updates — changes after join creation
// ---------------------------------------------------------------------------

describe("JoinIndex — incremental updates", () => {
  it("adding a thread after join creation appears in lookup", () => {
    const [convCatalog, convHandle] = createManualCatalog()
    const [threadCatalog, threadHandle] = createManualCatalog()

    const convRef = makeConvRef()
    change(convRef, (d: any) => {
      d.title.set("General")
    })
    convHandle.set("conv:abc", convRef)

    const leftIndex = Index.byIdentity(convCatalog)
    const rightIndex = Index.by(threadCatalog, (ref: any) => ref.conversationId)
    const convThreads = Index.join(leftIndex, rightIndex)

    // Initially no threads
    expect(convThreads.lookup("conv:abc")).toEqual([])

    // Add a thread
    const t1Ref = makeThreadRef()
    change(t1Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 1")
    })
    threadHandle.set("t1", t1Ref)

    // Now it appears
    const results = convThreads.lookup("conv:abc")
    expect(results).toHaveLength(1)
    expect(results[0].key).toBe("t1")
  })

  it("removing a thread after join creation disappears from lookup", () => {
    const [convCatalog, convHandle] = createManualCatalog()
    const [threadCatalog, threadHandle] = createManualCatalog()

    const convRef = makeConvRef()
    change(convRef, (d: any) => {
      d.title.set("General")
    })
    convHandle.set("conv:abc", convRef)

    const t1Ref = makeThreadRef()
    change(t1Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 1")
    })
    threadHandle.set("t1", t1Ref)

    const leftIndex = Index.byIdentity(convCatalog)
    const rightIndex = Index.by(threadCatalog, (ref: any) => ref.conversationId)
    const convThreads = Index.join(leftIndex, rightIndex)

    expect(convThreads.lookup("conv:abc")).toHaveLength(1)

    threadHandle.delete("t1")

    expect(convThreads.lookup("conv:abc")).toEqual([])
  })

  it("adding a member to an org makes the user appear in lookup", () => {
    const [orgCatalog, orgHandle] = createManualCatalog()
    const [userCatalog, userHandle] = createManualCatalog()

    const orgRef = makeOrgRef()
    change(orgRef, (d: any) => {
      d.name.set("Acme Corp")
      d.members.set("alice", { role: "admin" })
    })
    orgHandle.set("org:acme", orgRef)

    const aliceRef = makeUserRef()
    change(aliceRef, (d: any) => {
      d.name.set("Alice")
    })
    userHandle.set("alice", aliceRef)

    const bobRef = makeUserRef()
    change(bobRef, (d: any) => {
      d.name.set("Bob")
    })
    userHandle.set("bob", bobRef)

    const leftIndex = Index.byKeys(orgCatalog, (ref: any) => ref.members)
    const rightIndex = Index.byIdentity(userCatalog)
    const orgUsers = Index.join(leftIndex, rightIndex)

    // Initially only alice
    expect(orgUsers.lookup("org:acme")).toHaveLength(1)
    expect(orgUsers.lookup("org:acme")[0].key).toBe("alice")

    // Add bob as member
    change(orgRef, (d: any) => {
      d.members.set("bob", { role: "member" })
    })

    const results = orgUsers.lookup("org:acme")
    expect(results).toHaveLength(2)
    const keys = results.map((r: any) => r.key).sort()
    expect(keys).toEqual(["alice", "bob"])
  })

  it("subscribe receives changes from both underlying indexes", () => {
    const [convCatalog, convHandle] = createManualCatalog()
    const [threadCatalog, threadHandle] = createManualCatalog()

    const leftIndex = Index.byIdentity(convCatalog)
    const rightIndex = Index.by(threadCatalog, (ref: any) => ref.conversationId)
    const convThreads = Index.join(leftIndex, rightIndex)

    const allChanges: SecondaryIndexChange[] = []
    convThreads.subscribe((cs: any) => {
      allChanges.push(...cs.changes)
    })

    // Add a conversation → left index emits
    const convRef = makeConvRef()
    change(convRef, (d: any) => {
      d.title.set("General")
    })
    convHandle.set("conv:abc", convRef)

    expect(allChanges).toHaveLength(1)
    expect(allChanges[0]).toEqual({
      type: "group-added",
      groupKey: "conv:abc",
      entryKey: "conv:abc",
    })

    // Add a thread → right index emits
    const t1Ref = makeThreadRef()
    change(t1Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 1")
    })
    threadHandle.set("t1", t1Ref)

    expect(allChanges).toHaveLength(2)
    expect(allChanges[1]).toEqual({
      type: "group-added",
      groupKey: "conv:abc",
      entryKey: "t1",
    })
  })
})

// ---------------------------------------------------------------------------
// Dispose — tears down both underlying indexes
// ---------------------------------------------------------------------------

describe("JoinIndex — dispose", () => {
  it("dispose tears down both underlying indexes", () => {
    const [convCatalog, convHandle] = createManualCatalog()
    const [threadCatalog, threadHandle] = createManualCatalog()

    const convRef = makeConvRef()
    change(convRef, (d: any) => {
      d.title.set("General")
    })
    convHandle.set("conv:abc", convRef)

    const t1Ref = makeThreadRef()
    change(t1Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 1")
    })
    threadHandle.set("t1", t1Ref)

    const leftIndex = Index.byIdentity(convCatalog)
    const rightIndex = Index.by(threadCatalog, (ref: any) => ref.conversationId)
    const convThreads = Index.join(leftIndex, rightIndex)

    const allChanges: SecondaryIndexChange[] = []
    convThreads.subscribe((cs: any) => {
      allChanges.push(...cs.changes)
    })

    convThreads.dispose()

    // Catalog mutations after dispose should not emit through the join
    const t2Ref = makeThreadRef()
    change(t2Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 2")
    })
    threadHandle.set("t2", t2Ref)

    const conv2Ref = makeConvRef()
    change(conv2Ref, (d: any) => {
      d.title.set("Random")
    })
    convHandle.set("conv:xyz", conv2Ref)

    expect(allChanges).toEqual([])
  })

})