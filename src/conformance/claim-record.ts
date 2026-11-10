import { z } from "zod";
import { lockRecordSchema } from "../adapters/git/claim-lock.ts";
import { claimPropertySchema } from "../adapters/trackers/jira/tracker.ts";
import { CLAIM_RECORD_VERSION } from "../domain/claim/lock.ts";

export function claimRecordContract(): string {
  const options: Parameters<typeof z.toJSONSchema>[1] = {
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema._zod.def.type === "custom") jsonSchema.type = "string";
    },
  };
  return `${JSON.stringify(
    {
      version: CLAIM_RECORD_VERSION,
      lockRecord: z.toJSONSchema(lockRecordSchema, options),
      jiraClaimProperty: z.toJSONSchema(claimPropertySchema, options),
    },
    null,
    2,
  )}\n`;
}
