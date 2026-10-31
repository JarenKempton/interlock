import { JiraTrackerAdapter, jiraBasicAuthTransport } from "../adapters/trackers/jira.ts";
import { TrackerUnavailableError } from "../domain/contracts.ts";
import type { TicketRef } from "../domain/model.ts";
import { parseRef } from "../domain/reference.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { lookupCredentials, savedSite, trackerSignIns } from "../sign-in/credentials.ts";
import type { LaneTrackerPort } from "./lane.ts";
import { jiraRankField } from "./pickup-runtime.ts";

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
    return { instance: ref.instance, workspace: ref.workspace, transport };
  };
  const jira = async (ticket: TicketRef) => new JiraTrackerAdapter(await adapter(ticket));
  const reader = async (ticket: TicketRef) => {
    const options = await adapter(ticket);
    return new JiraTrackerAdapter({
      ...options,
      rankField: await jiraRankField(options.transport),
    });
  };
  return {
    available: async (ticket) => {
      await adapter(ticket);
    },
    read: async (ticket) => (await reader(ticket)).read(ticket),
    transition: async (ticket, status) => (await jira(ticket)).transition(ticket, status),
    link_artifact: async (ticket, url, title) =>
      (await jira(ticket)).link_artifact(ticket, url, title),
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
