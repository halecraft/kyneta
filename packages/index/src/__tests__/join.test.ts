import { describe, expect, it } from "vitest"
import { json, Schema, createDoc, change } from "@kyneta/schema"
import { hasChangefeed } from "@kyneta/changefeed"
import { Source } from "../source.js"
import { Collection } from "../collection.js"
import { by } from "../index-impl.js"
import type { IndexChange } from "../index-impl.js"
import { join } from "../join.js"
import { field, keys } from "../key-spec.js"

// ---------------------------------------------------------------------------
// Fixtures
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

const makeConvRef = (): any => createDoc(ConvDoc)
const makeThreadRef = (): any => createDoc(ThreadDoc)
const makeOrgRef = (): any => createDoc(OrgDoc)
const makeUserRef = (): any => createDoc(UserDoc)

// ---------------------------------------------------------------------------
// 1:N join — conversations ↔ threads
// ---------------------------------------------------------------------------

describe("JoinIndex — 1:N (conversations ↔ threads)", () => {
  function setup() {
    const [convSource, convHandle] = Source.create<any>()
    const [threadSource, threadHandle] = Source.create<any>()

    const convRef = makeConvRef()
    change(convRef, (d: any) => { d.title.set("General") })
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

    const convColl = Collection.from(convSource)
    const threadColl = Collection.from(threadSource)

    const leftIndex = by(convColl)
    const rightIndex = by(threadColl, field((ref: any) => ref.conversationId))
    const convThreads = join(leftIndex, rightIndex)

    return { convHandle, threadHandle, convRef, t1Ref, t2Ref, convThreads }
  }

  it("get returns all threads for a conversation", () => {
    const { convThreads } = setup()
    const threads = convThreads.get("conv:abc")
    expect(threads.size).toBe(2)
    expect([...threads.keys()].sort()).toEqual(["t1", "t2"])
  })

  it("reverse returns the conversation for a thread", () => {
    const { convThreads } = setup()
    const convs = convThreads.reverse("t1")
    expect(convs.size).toBe(1)
    expect(convs.has("conv:abc")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// M:N join — orgs ↔ users
// ---------------------------------------------------------------------------

describe("JoinIndex — M:N (orgs ↔ users)", () => {
  function setup() {
    const [orgSource, orgHandle] = Source.create<any>()
    const [userSource, userHandle] = Source.create<any>()

    const orgRef = makeOrgRef()
    change(orgRef, (d: any) => {
      d.name.set("Acme Corp")
      d.members.set("alice", { role: "admin" })
      d.members.set("bob", { role: "member" })
    })
    orgHandle.set("org:acme", orgRef)

    const aliceRef = makeUserRef()
    change(aliceRef, (d: any) => { d.name.set("Alice") })
    userHandle.set("alice", aliceRef)

    const bobRef = makeUserRef()
    change(bobRef, (d: any) => { d.name.set("Bob") })
    userHandle.set("bob", bobRef)

    const orgColl = Collection.from(orgSource)
    const userColl = Collection.from(userSource)

    const leftIndex = by(orgColl, keys((ref: any) => ref.members))
    const rightIndex = by(userColl)
    const orgUsers = join(leftIndex, rightIndex)

    return { orgHandle, userHandle, orgRef, aliceRef, bobRef, orgUsers }
  }

  it("get returns all users in an org", () => {
    const { orgUsers } = setup()
    const users = orgUsers.get("org:acme")
    expect(users.size).toBe(2)
    expect([...users.keys()].sort()).toEqual(["alice", "bob"])
  })

  it("reverse returns the org(s) a user belongs to", () => {
    const { orgUsers } = setup()
    const orgs = orgUsers.reverse("alice")
    expect(orgs.size).toBe(1)
    expect(orgs.has("org:acme")).toBe(true)
  })

  it("user belonging to multiple orgs appears in reverse for each", () => {
    const { orgHandle, orgUsers } = setup()

    const org2Ref = makeOrgRef()
    change(org2Ref, (d: any) => {
      d.name.set("Widgets Inc")
      d.members.set("alice", { role: "member" })
    })
    orgHandle.set("org:widgets", org2Ref)

    const orgs = orgUsers.reverse("alice")
    expect(orgs.size).toBe(2)
    expect([...orgs.keys()].sort()).toEqual(["org:acme", "org:widgets"])
  })
})

// ---------------------------------------------------------------------------
// Incremental updates
// ---------------------------------------------------------------------------

describe("JoinIndex — incremental updates", () => {
  it("adding a thread after join creation appears in get", () => {
    const [convSource, convHandle] = Source.create<any>()
    const [threadSource, threadHandle] = Source.create<any>()

    const convRef = makeConvRef()
    change(convRef, (d: any) => { d.title.set("General") })
    convHandle.set("conv:abc", convRef)

    const convColl = Collection.from(convSource)
    const threadColl = Collection.from(threadSource)

    const leftIndex = by(convColl)
    const rightIndex = by(threadColl, field((ref: any) => ref.conversationId))
    const convThreads = join(leftIndex, rightIndex)

    const threads = convThreads.get("conv:abc")
    expect(threads.size).toBe(0)

    const t1Ref = makeThreadRef()
    change(t1Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 1")
    })
    threadHandle.set("t1", t1Ref)

    expect(threads.size).toBe(1)
    expect(threads.has("t1")).toBe(true)
  })

  it("removing a thread disappears from get", () => {
    const [convSource, convHandle] = Source.create<any>()
    const [threadSource, threadHandle] = Source.create<any>()

    const convRef = makeConvRef()
    change(convRef, (d: any) => { d.title.set("General") })
    convHandle.set("conv:abc", convRef)

    const t1Ref = makeThreadRef()
    change(t1Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 1")
    })
    threadHandle.set("t1", t1Ref)

    const convColl = Collection.from(convSource)
    const threadColl = Collection.from(threadSource)

    const leftIndex = by(convColl)
    const rightIndex = by(threadColl, field((ref: any) => ref.conversationId))
    const convThreads = join(leftIndex, rightIndex)

    const threads = convThreads.get("conv:abc")
    expect(threads.size).toBe(1)

    threadHandle.delete("t1")
    expect(threads.size).toBe(0)
  })

  it("adding a member to an org makes the user appear in get", () => {
    const [orgSource, orgHandle] = Source.create<any>()
    const [userSource, userHandle] = Source.create<any>()

    const orgRef = makeOrgRef()
    change(orgRef, (d: any) => {
      d.name.set("Acme Corp")
      d.members.set("alice", { role: "admin" })
    })
    orgHandle.set("org:acme", orgRef)

    const aliceRef = makeUserRef()
    change(aliceRef, (d: any) => { d.name.set("Alice") })
    userHandle.set("alice", aliceRef)

    const bobRef = makeUserRef()
    change(bobRef, (d: any) => { d.name.set("Bob") })
    userHandle.set("bob", bobRef)

    const orgColl = Collection.from(orgSource)
    const userColl = Collection.from(userSource)

    const leftIndex = by(orgColl, keys((ref: any) => ref.members))
    const rightIndex = by(userColl)
    const orgUsers = join(leftIndex, rightIndex)

    const users = orgUsers.get("org:acme")
    expect(users.size).toBe(1)
    expect(users.has("alice")).toBe(true)

    change(orgRef, (d: any) => {
      d.members.set("bob", { role: "member" })
    })

    expect(users.size).toBe(2)
    expect([...users.keys()].sort()).toEqual(["alice", "bob"])
  })

  it("subscribe receives changes from both underlying indexes", () => {
    const [convSource, convHandle] = Source.create<any>()
    const [threadSource, threadHandle] = Source.create<any>()

    const convColl = Collection.from(convSource)
    const threadColl = Collection.from(threadSource)

    const leftIndex = by(convColl)
    const rightIndex = by(threadColl, field((ref: any) => ref.conversationId))
    const convThreads = join(leftIndex, rightIndex)

    const allChanges: IndexChange[] = []
    convThreads.subscribe(cs => { allChanges.push(...cs.changes) })

    const convRef = makeConvRef()
    change(convRef, (d: any) => { d.title.set("General") })
    convHandle.set("conv:abc", convRef)

    expect(allChanges).toHaveLength(1)
    expect(allChanges[0]).toEqual({
      type: "group-added",
      groupKey: "conv:abc",
      entryKey: "conv:abc",
    })

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
// FK mutation propagates through join
// ---------------------------------------------------------------------------

describe("JoinIndex — FK mutation propagates through join", () => {
  it("mutating a thread's conversationId updates the join's get", () => {
    const [convSource, convHandle] = Source.create<any>()
    const [threadSource, threadHandle] = Source.create<any>()

    const convRef = makeConvRef()
    change(convRef, (d: any) => { d.title.set("Conv A") })
    convHandle.set("conv:a", convRef)

    const conv2Ref = makeConvRef()
    change(conv2Ref, (d: any) => { d.title.set("Conv B") })
    convHandle.set("conv:b", conv2Ref)

    const threadRef = makeThreadRef()
    change(threadRef, (d: any) => {
      d.conversationId.set("conv:a")
      d.subject.set("Thread 1")
    })
    threadHandle.set("t1", threadRef)

    const convColl = Collection.from(convSource)
    const threadColl = Collection.from(threadSource)

    const leftIndex = by(convColl)
    const rightIndex = by(threadColl, field((ref: any) => ref.conversationId))
    const convThreads = join(leftIndex, rightIndex)

    const threadsA = convThreads.get("conv:a")
    const threadsB = convThreads.get("conv:b")

    expect(threadsA.size).toBe(1)
    expect(threadsB.size).toBe(0)

    change(threadRef, (d: any) => {
      d.conversationId.set("conv:b")
    })

    expect(threadsA.size).toBe(0)
    expect(threadsB.size).toBe(1)
    expect(threadsB.has("t1")).toBe(true)

    const reverseT1 = convThreads.reverse("t1")
    expect(reverseT1.size).toBe(1)
    expect(reverseT1.has("conv:b")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("JoinIndex — dispose", () => {
  it("dispose tears down both underlying indexes", () => {
    const [convSource, convHandle] = Source.create<any>()
    const [threadSource, threadHandle] = Source.create<any>()

    const convRef = makeConvRef()
    change(convRef, (d: any) => { d.title.set("General") })
    convHandle.set("conv:abc", convRef)

    const t1Ref = makeThreadRef()
    change(t1Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 1")
    })
    threadHandle.set("t1", t1Ref)

    const convColl = Collection.from(convSource)
    const threadColl = Collection.from(threadSource)

    const leftIndex = by(convColl)
    const rightIndex = by(threadColl, field((ref: any) => ref.conversationId))
    const convThreads = join(leftIndex, rightIndex)

    const allChanges: IndexChange[] = []
    convThreads.subscribe(cs => { allChanges.push(...cs.changes) })

    convThreads.dispose()

    const t2Ref = makeThreadRef()
    change(t2Ref, (d: any) => {
      d.conversationId.set("conv:abc")
      d.subject.set("Thread 2")
    })
    threadHandle.set("t2", t2Ref)

    const conv2Ref = makeConvRef()
    change(conv2Ref, (d: any) => { d.title.set("Random") })
    convHandle.set("conv:xyz", conv2Ref)

    expect(allChanges).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Changefeed protocol
// ---------------------------------------------------------------------------

describe("JoinIndex — changefeed protocol", () => {
  it("hasChangefeed(joinIndex) returns true", () => {
    const [convSource] = Source.create<any>()
    const [threadSource] = Source.create<any>()

    const convColl = Collection.from(convSource)
    const threadColl = Collection.from(threadSource)

    const leftIndex = by(convColl)
    const rightIndex = by(threadColl)
    const joined = join(leftIndex, rightIndex)

    expect(hasChangefeed(joined)).toBe(true)
  })

  it("current is null", () => {
    const [convSource] = Source.create<any>()
    const [threadSource] = Source.create<any>()

    const convColl = Collection.from(convSource)
    const threadColl = Collection.from(threadSource)

    const leftIndex = by(convColl)
    const rightIndex = by(threadColl)
    const joined = join(leftIndex, rightIndex)

    expect(joined.current).toBe(null)
  })
})