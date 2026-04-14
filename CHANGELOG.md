# 1.3.0

  - @kyneta/index — new package: Reactive document indexing with Catalog, secondary indexes, joins, and DBSP-grounded algebraic redesign (ZSet, Source,
  Collection, Index)
  - Schema.tree: Full tree CRDT support with navigation, mutation, and observation (Loro-backed)
  - added the [REMOVE] symbol: Structural self-removal for container-child refs in schema
  - Source.flatMap: New combinator + Source.of convenience for the index package
  - Wire fix: Replaced @levischuck/tiny-cbor with internal CBOR codec (UTF-8 string encoding bug)
  - Schema refactors: Generic createDoc, typed [NATIVE] functor, Schema.doc → Schema.struct rename
  - Housekeeping: experimental packages moved to experimental/

# 1.2.0

  - Transport layer — 3 new packages: @kyneta/transport (base), @kyneta/unix-socket-transport (stream-oriented), @kyneta/webrtc-transport (BYODC
  DataChannel)
  - @kyneta/machine: TEA-like state machine--universal Mealy machine with effect interpreter; transport clients rewritten as pure Programs
  - @kyneta/changefeed: Extracted as independent reactive contract package; promoted to developer-facing type
  - Storage: StorageBackend interface + InMemoryStorageBackend + LevelDB persistent backend; storage-first sync
  - Replica / Substrate split: Factored Replica from Substrate; ReplicaFactory for all substrate types; two-phase construction
  - Sync protocol: Structural merge with schema fingerprint verification; document disposition (Interpret / Replicate tiers); version comparison
  - exchange.peers: Peer lifecycle as a Changefeed; duplicate peerId detection
  - Line: Reliable bidirectional message stream between two peers
  - advance(): Universal history trimming across all substrates
  - Schema overhaul: First-class native leaf types, symbol-keyed metadata ([KIND], [TAGS]), json.bind() / loro.bind() namespace API, dissolved LoroSchema
  namespace
  - onDocCreated / onUnresolvedDoc: Exchange lifecycle hooks
  - Example: unix-socket-sync — leaderless TUI config sync over unix sockets with Loro CRDT
