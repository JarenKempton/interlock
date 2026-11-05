import type { LaneRef } from "../model.ts";

export type OperationIdentity = readonly [lane: LaneRef, step: string];
