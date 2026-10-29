import {
  type SubmissionAuthority,
  type SubmissionIdentity,
  SubmissionRefusal,
  sameSubmission,
} from "../../src/domain/submission.ts";

export class FakeSubmissionAuthority implements SubmissionAuthority {
  readonly records = new Map<string, SubmissionIdentity>();
  async reserve(identity: SubmissionIdentity) {
    const key = identity.ticket ?? identity.lane;
    const existing = this.records.get(key);
    if (existing && !sameSubmission(existing, identity))
      throw new SubmissionRefusal("duplicate_artifact", "Another submission owner");
    if (existing) return { mayCreate: false };
    this.records.set(key, identity);
    return { mayCreate: true };
  }
}
