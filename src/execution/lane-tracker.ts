import { JiraTrackerAdapter, jiraBasicAuthTransport } from "../adapters/trackers/jira.ts";
import { TrackerUnavailableError } from "../domain/contracts.ts";
import type { TicketRef } from "../domain/model.ts";
import { parseRef } from "../domain/reference.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { lookupCredentials, savedSite, trackerSignIns } from "../sign-in/credentials.ts";
import type { LaneTrackerPort } from "./lane.ts";

export function signedInLaneTracker(services: RuntimeServices): LaneTrackerPort {
  const adapter = async (ticket: TicketRef) => {
    const ref = parseRef(ticket);
    if (ref.adapter !== "jira" || !ref.instance || !ref.workspace)
      throw new TrackerUnavailableError(`No signed-in tracker serves ${ticket}`);
    const site = savedSite(services, "jira");
    if (!site || new URL(site).hostname.replace(/\.atlassian\.net$/, "") !== ref.instance)
      throw new TrackerUnavailableError(
        `Not signed in to Jira for ${ref.instance}; run interlock login jira`,
      );
    const transport =
      services.execution?.jira ??
      (await signedInTransport(services, site).catch(() => {
        throw new TrackerUnavailableError(
          `Not signed in to Jira at ${site}; run interlock login jira`,
        );
      }));
    return new JiraTrackerAdapter({ instance: ref.instance, workspace: ref.workspace, transport });
  };
  return {
    available: async (ticket) => {
      await adapter(ticket);
    },
    read: async () => {
      throw new TrackerUnavailableError("Lane tracker readback is not wired");
    },
    link_artifact: async (ticket, url, title) =>
      (await adapter(ticket)).link_artifact(ticket, url, title),
  };
}

async function signedInTransport(services: RuntimeServices, site: string) {
  const { credentials } = await lookupCredentials(
    services,
    "jira",
    trackerSignIns(services).jira.adapter,
    site,
  );
  if (!credentials) throw new Error("missing credentials");
  return jiraBasicAuthTransport({ site, ...credentials }, services.signIn?.http);
}
