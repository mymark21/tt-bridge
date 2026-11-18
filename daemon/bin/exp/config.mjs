// experience/config: shared vocabulary: schema, enums, limits, regex tokens


export const SCHEMA_VERSION = 1;


export const DEFAULT_MISS_THRESHOLD = 2;


export const DEFAULT_CAPTURE_AFTER = 3;


export const STATUSES = ['draft', 'verified', 'stale', 'deprecated'];


export const KINDS = ['text', 'script', 'hybrid'];


export const MATCH_TYPES = ['exact', 'prefix', 'glob'];



export const FRONTMATTER_FIELDS = [
  'schema', 'id', 'host', 'url', 'match', 'kind', 'description',
  'created', 'updated', 'last_verified', 'status', 'confidence',
  'tags', 'preconditions', 'selectors', 'verification', 'attempts',
  'misses', 'source', 'script', 'triggers',
];


export const HOST_RE = /^[a-z0-9][a-z0-9._:-]*$/;


export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;



export const STATUS_SCORE = { verified: 300, draft: 0, stale: -200, deprecated: -1000 };


export const MATCH_BASE = { exact: 4000, glob: 3000, prefix: 2000 };



// Each `tt-bridge <cmd>` is a separate node process, so a per-process session
// id would make every invocation a new "session" and repeat the same hint
// forever. Default to a coarse time bucket: the dedupe TTL then bounds how
// often one trigger can speak, independent of how many processes run.
// Callers can pin an explicit session via --session / TT_BRIDGE_SESSION.
export const SESSION_BUCKET_HOURS = 6;



// Dedupe must survive process exit: every `tt-bridge <cmd>` is a fresh node
// process, so an in-memory Set alone re-shows the same hint on every command —
// the fastest way to teach an agent to ignore hints.
//
// It is an append-only cache, not user data: losing a line costs one repeated
// hint. atomicWrite's fsync costs ~9ms, which would blow the hot-path budget
// for a file that is written on nearly every command.
export const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
