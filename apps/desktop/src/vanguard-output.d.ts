// Re-export shim — NOTHING is declared here. Every shape the app reads off the IPC wire is declared
// once, in src/wire.ts (the generated S7 contract), and surfaced here under the import path feature
// code has always used.
//
// The Rust-mirroring shapes (Project, AppConfig, the session/browse shapes) moved into wire.ts with
// the `Commands` catalogue: the catalogue needs a result type for every command, and a second copy
// here would be free to drift from the one the catalogue pins. The TS↔Rust side of those shapes is
// still a hand-mirror of the serde structs in src-tauri — see the note in wire.ts.
export type {
  ActiveRun,
  AgentUsage,
  AppConfig,
  BoardChip,
  Finding,
  ReviewVerdict,
  DirEntry,
  DirListing,
  Project,
  Proof,
  RemoteImport,
  RemoteRun,
  RunDetail,
  RunRecord,
  RunRef,
  RunSource,
  RunSummary,
  SessionRead,
  StageDetail,
  TranscriptEntry,
  VisualProof,
  VisualProofArtifact,
} from './wire';
